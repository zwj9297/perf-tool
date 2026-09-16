/**
 * 只读工具集：`read_file` / `grep` / `glob` / `list_dir`。
 *
 * 对照 design.md §4.2 的硬要求：
 *
 * | 要求 | 在这里 |
 * | --- | --- |
 * | 输出上限，超限时告知 | 每个工具都有 cap，超限返回 `truncated: true`（循环负责写成明确提示） |
 * | 符号链接 containment | 全部走 `resolveInsideProject` |
 * | 重复调用检测 | **不在这里**——循环负责（工具的返回值与调用次数无关） |
 * | 轨迹落盘 | **不在这里**——循环负责 |
 * | 跳过凭证文件 | `resolveInsideProject` + 走树时也过一遍 |
 * | 用 JS 实现不 shell 出去 | 全程 `node:fs` + 自写的正则/glob，不碰命令行 |
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { Type, type Tool, type TSchema } from '@earendil-works/pi-ai'
import { validateToolCall } from '@earendil-works/pi-ai/utils/validation'

import type { ProviderToolCall, ProviderToolSpec } from '../providers/types.js'
import { matchesGlob } from './glob.js'
import { loadIgnore, type IgnoreSet } from './ignore.js'
import { isCredentialFile, resolveInsideProject, type PathFailure } from './paths.js'
import type { ToolContext, ToolResult, Toolbox } from './types.js'

export type Caps = {
  /** `read_file` 未指定范围时最多返回多少行 */
  readLines: number
  /** 单行超过这么多字节就截断（压过的文件一行几十万字符） */
  maxLineBytes: number
  grepMatches: number
  /** grep 最多扫多少个文件，防病态仓库 */
  grepFilesScanned: number
  globResults: number
  listEntries: number
  /** 走树的总条目上限 */
  walkEntries: number
  /** 超过这个大小的文件不 grep / 不匹配 */
  maxFileBytes: number
}

const DEFAULT_CAPS: Caps = {
  readLines: 400,
  maxLineBytes: 2000,
  grepMatches: 100,
  grepFilesScanned: 5000,
  globResults: 200,
  listEntries: 200,
  walkEntries: 20_000,
  maxFileBytes: 2_000_000,
}

export type ToolboxOptions = {
  projectRoot: string
  include?: readonly string[]
  exclude?: readonly string[]
  caps?: Partial<Caps>
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const truncateLine = (line: string, max: number): string =>
  line.length > max ? `${line.slice(0, max)}…[本行已截断]` : line

/** 二进制判断：前 8KB 有 NUL 就当成二进制 */
const isBinary = (buf: Buffer): boolean => buf.subarray(0, 8192).includes(0)

const pathErrorText = (f: PathFailure): string => {
  switch (f.reason) {
    case 'escapes':
      return `路径越界：${f.detail}。只能访问项目根内的相对路径`
    case 'denied-credential':
      return `${f.detail}。这是刻意的限制`
    case 'not-found':
      return `${f.detail}。可以用 glob 或 list_dir 确认路径`
  }
}

const joinRel = (dir: string, name: string): string =>
  dir === '.' || dir === '' ? name : `${dir}/${name}`

type WalkResult = { files: string[]; truncated: boolean }

/**
 * 深度优先收集文件（相对路径）。
 *
 * **跳过符号链接**（`entry.isFile()` 对软链为 false）。这有两个后果，都是刻意的：
 * ① 永远不可能通过一个目录软链走出项目根；② 软链指向的文件不会被枚举出来。
 * 单个软链文件仍然可以用 `read_file` 直接读——那条路走 `resolveInsideProject`，
 * 会 realpath 后再判 containment。
 *
 * **也跳过凭证类文件**。它们必须**不可见也不可读**：只挡住 `read_file` 而让
 * `list_dir` / `grep` / `glob` 把它们列出来，等于文档承诺的"跳过 .env"只兑现了
 * 一半，而且工具之间自相矛盾。
 */
const walkFiles = (root: string, ig: IgnoreSet, cap: number): WalkResult => {
  const files: string[] = []
  const stack: string[] = ['']

  while (stack.length > 0) {
    const dir = stack.pop()
    if (dir === undefined) continue
    let entries
    try {
      entries = readdirSync(dir === '' ? root : join(root, dir), { withFileTypes: true })
    } catch {
      continue // 权限不足等，跳过
    }

    // 排序让输出稳定（测试可断言，读起来也顺）
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const rel = joinRel(dir, entry.name)
      const isDir = entry.isDirectory()
      if (ig.ignored(rel, isDir)) continue
      if (isCredentialFile(rel)) continue
      if (isDir) {
        stack.push(rel)
        continue
      }
      if (!entry.isFile()) continue
      if (files.length >= cap) return { files, truncated: true }
      files.push(rel)
    }
  }
  return { files, truncated: false }
}

// ---------------------------------------------------------------- 工具定义

const readFileSpec: ProviderToolSpec = {
  name: 'read_file',
  description:
    '读取项目内某个文件的文本。可用 start/end 只读一段行范围（1-based，含两端），返回内容带行号。' +
    '文件很大时请配合热点行号只读附近的一段。',
  parameters: Type.Object(
    {
      path: Type.String({ description: '相对项目根的路径' }),
      start: Type.Optional(Type.Integer({ minimum: 1, description: '起始行，1-based，含' })),
      end: Type.Optional(Type.Integer({ minimum: 1, description: '结束行，1-based，含' })),
    },
    { additionalProperties: false },
  ),
}

const grepSpec: ProviderToolSpec = {
  name: 'grep',
  description:
    '按正则搜索项目内文件内容，返回「文件:行号: 内容」。用于反向查询——谁调用了这个函数、' +
    '这个值从哪来。这类信息是只读单个文件最容易漏掉的。',
  parameters: Type.Object(
    {
      pattern: Type.String({ description: 'JavaScript 正则源码，不要加斜杠' }),
      glob: Type.Optional(Type.String({ description: '限定文件路径模式，如 **/*.ts' })),
    },
    { additionalProperties: false },
  ),
}

const globSpec: ProviderToolSpec = {
  name: 'glob',
  description: '按 glob 模式列出项目内的文件路径。`*` 不跨目录，跨目录要用 `**`。',
  parameters: Type.Object({ pattern: Type.String() }, { additionalProperties: false }),
}

const listDirSpec: ProviderToolSpec = {
  name: 'list_dir',
  description: '列出项目内某个目录的直接子项。目录名以 / 结尾。不传 path 就是项目根。',
  parameters: Type.Object(
    { path: Type.Optional(Type.String({ description: '相对项目根的目录，默认项目根' })) },
    { additionalProperties: false },
  ),
}

// ---------------------------------------------------------------- 实现

const doReadFile = (args: Record<string, unknown>, ctx: ToolContext, caps: Caps): ToolResult => {
  const path = String(args.path ?? '')
  const resolved = resolveInsideProject(ctx.projectRoot, path)
  if (!resolved.ok) return { text: pathErrorText(resolved), isError: true }

  let size: number
  try {
    const st = statSync(resolved.abs)
    if (st.isDirectory()) {
      return { text: `${resolved.rel} 是目录。列目录请用 list_dir`, isError: true }
    }
    size = st.size
  } catch (e) {
    return { text: `读取失败：${messageOf(e)}`, isError: true }
  }

  let buf: Buffer
  try {
    buf = readFileSync(resolved.abs)
  } catch (e) {
    return { text: `读取失败：${messageOf(e)}`, isError: true }
  }
  if (isBinary(buf)) {
    return {
      text: `${resolved.rel} 看起来是二进制文件（${size} 字节），无法作为文本读取`,
      isError: true,
    }
  }

  const lines = buf.toString('utf8').split('\n')
  const total = lines.length

  const requestedStart = typeof args.start === 'number' ? Math.max(1, Math.floor(args.start)) : 1
  const requestedEnd = typeof args.end === 'number' ? Math.floor(args.end) : Number.MAX_SAFE_INTEGER

  if (requestedStart > total) {
    return { text: `${resolved.rel} 只有 ${total} 行，起始行 ${requestedStart} 超出范围` }
  }

  const capEnd = requestedStart + caps.readLines - 1
  const end = Math.min(requestedEnd, capEnd, total)
  const slice = lines.slice(requestedStart - 1, end)

  let lineCut = 0
  const body = slice
    .map((line, i) => {
      const t = truncateLine(line, caps.maxLineBytes)
      if (t !== line) lineCut++
      return `${String(requestedStart + i).padStart(6)}| ${t}`
    })
    .join('\n')

  const notes: string[] = []
  if (lineCut > 0) notes.push(`${lineCut} 行因过长被截断`)
  const header =
    `文件 ${resolved.rel} 共 ${total} 行，以下为第 ${requestedStart}-${end} 行` +
    (notes.length > 0 ? `（${notes.join('；')}）` : '')

  // 只有**我们**因为上限砍掉了本来可以返回的内容，才算 truncated。
  // 模型自己指定了范围、或被文件末尾截住，都不是截断——那时提示"请缩小范围"是误导。
  const truncated = end < Math.min(requestedEnd, total) && end === capEnd

  return { text: `${header}\n${body}`, truncated }
}

const doGrep = (
  args: Record<string, unknown>,
  ctx: ToolContext,
  ig: IgnoreSet,
  caps: Caps,
): ToolResult => {
  const pattern = String(args.pattern ?? '')
  let re: RegExp
  try {
    re = new RegExp(pattern)
  } catch (e) {
    return { text: `正则不合法：${messageOf(e)}。请修正后重试`, isError: true }
  }
  const glob = typeof args.glob === 'string' && args.glob !== '' ? args.glob : undefined

  const walked = walkFiles(ctx.projectRoot, ig, caps.walkEntries)
  const hits: string[] = []
  let scanned = 0
  let capped = false

  for (const rel of walked.files) {
    if (glob !== undefined && !matchesGlob(glob, rel)) continue
    scanned++
    if (scanned > caps.grepFilesScanned) {
      capped = true
      break
    }
    const abs = join(ctx.projectRoot, rel)
    let buf: Buffer
    try {
      if (statSync(abs).size > caps.maxFileBytes) continue
      buf = readFileSync(abs)
    } catch {
      continue
    }
    if (isBinary(buf)) continue

    const lines = buf.toString('utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (!re.test(line)) continue
      if (hits.length >= caps.grepMatches) {
        capped = true
        break
      }
      hits.push(`${rel}:${i + 1}: ${truncateLine(line.trim(), caps.maxLineBytes)}`)
    }
    if (capped) break
  }

  if (hits.length === 0) {
    const suffix = walked.truncated ? '（注意：文件列表本身已被上限截断）' : ''
    return { text: `没有匹配 ${JSON.stringify(pattern)} 的内容${suffix}` }
  }
  return {
    text: `匹配 ${hits.length} 处（扫描 ${scanned} 个文件）：\n${hits.join('\n')}`,
    truncated: capped || walked.truncated,
  }
}

const doGlob = (
  args: Record<string, unknown>,
  ctx: ToolContext,
  ig: IgnoreSet,
  caps: Caps,
): ToolResult => {
  const pattern = String(args.pattern ?? '')
  if (pattern === '') return { text: 'pattern 不能为空', isError: true }

  const walked = walkFiles(ctx.projectRoot, ig, caps.walkEntries)
  const matched: string[] = []
  let capped = false
  for (const rel of walked.files) {
    if (!matchesGlob(pattern, rel)) continue
    if (matched.length >= caps.globResults) {
      capped = true
      break
    }
    matched.push(rel)
  }

  if (matched.length === 0) {
    return { text: `没有文件匹配 ${JSON.stringify(pattern)}` }
  }
  return {
    text: `${matched.length} 个文件匹配 ${JSON.stringify(pattern)}：\n${matched.join('\n')}`,
    truncated: capped || walked.truncated,
  }
}

const doListDir = (
  args: Record<string, unknown>,
  ctx: ToolContext,
  ig: IgnoreSet,
  caps: Caps,
): ToolResult => {
  const input = typeof args.path === 'string' && args.path !== '' ? args.path : '.'
  const resolved = resolveInsideProject(ctx.projectRoot, input)
  if (!resolved.ok) return { text: pathErrorText(resolved), isError: true }

  let entries
  try {
    if (!statSync(resolved.abs).isDirectory()) {
      return { text: `${resolved.rel} 不是目录。读文件请用 read_file`, isError: true }
    }
    entries = readdirSync(resolved.abs, { withFileTypes: true })
  } catch (e) {
    return { text: `列出目录失败：${messageOf(e)}`, isError: true }
  }

  const kept: string[] = []
  for (const entry of entries) {
    const rel = joinRel(resolved.rel, entry.name)
    const isDir = entry.isDirectory()
    if (ig.ignored(rel, isDir)) continue
    // 与走树保持一致：凭证类文件不可见。只挡 read_file 会让这里泄露它们的存在
    if (isCredentialFile(rel)) continue
    kept.push(isDir ? `${entry.name}/` : entry.name)
  }
  kept.sort((a, b) => a.localeCompare(b))

  const capped = kept.length > caps.listEntries
  const shown = capped ? kept.slice(0, caps.listEntries) : kept
  const suffix = capped ? `\n…还有 ${kept.length - shown.length} 项未列出` : ''
  return {
    text: `目录 ${resolved.rel}（${kept.length} 项）：\n${shown.join('\n')}${suffix}`,
    truncated: capped,
  }
}

// ---------------------------------------------------------------- 对外

const SPECS: ProviderToolSpec[] = [readFileSpec, grepSpec, globSpec, listDirSpec]

export const createToolbox = (options: ToolboxOptions): Toolbox => {
  const ig = loadIgnore({
    projectRoot: options.projectRoot,
    ...(options.include === undefined ? {} : { include: options.include }),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
  })
  const caps: Caps = { ...DEFAULT_CAPS, ...options.caps }

  return {
    specs: () => SPECS,
    run: async (call: ProviderToolCall, ctx: ToolContext): Promise<ToolResult> => {
      // 参数校验必须在**这里**：provider 层只校验 submit_plan（那发生在循环里），
      // 普通工具的 arguments 是模型自由生成的。不校验的话，模型少给一个字段就会
      // 让实现读到 undefined —— 而 undefined 会一路静默传下去。
      let args: Record<string, unknown>
      try {
        args = validateToolCall(SPECS as Tool<TSchema>[], {
          type: 'toolCall',
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        }) as Record<string, unknown>
      } catch (e) {
        return { text: `参数不合法：${messageOf(e)}`, isError: true }
      }

      switch (call.name) {
        case readFileSpec.name:
          return doReadFile(args, ctx, caps)
        case grepSpec.name:
          return doGrep(args, ctx, ig, caps)
        case globSpec.name:
          return doGlob(args, ctx, ig, caps)
        case listDirSpec.name:
          return doListDir(args, ctx, ig, caps)
        default:
          // 循环在派发前已经拒过不认识的工具名，走到这里说明两边不一致
          return { text: `没有实现名为 ${call.name} 的工具`, isError: true }
      }
    },
  }
}
