/**
 * 把 unified diff 应用到一段内容上。
 *
 * 这是 docs/design.md §2.1 里那个纯函数：生成阶段对内存快照跑它，落盘阶段对
 * 磁盘内容跑它，**同一个函数、同一套校验**。因此它必须是纯的——不碰文件系统、
 * 不知道路径、不打印。路径解析与 containment 校验由调用方负责。
 *
 * 它同时是 design.md D2 那 6 条实现要求的落点。这些要求每一条都对应 jsdiff 的
 * 一个真实缺口（见 §2.6 的实测表），**不是防御性编程的冗余**：
 *
 *   | 要求                       | 不做会怎样                                    |
 *   | -------------------------- | --------------------------------------------- |
 *   | recount 前置（normalize）  | 模型写错计数就整条失败，而这是常态            |
 *   | 唯一性预检                 | 重复代码里静默改到错误的那一处                |
 *   | 结果 !== 输入              | 0 个 hunk 时"什么都没改"伪装成"应用成功"      |
 *   | 多文件段拒绝               | applyPatch 直接抛异常                         |
 *   | 两种失败形态都接住         | 抛异常与返回 false 是两条路径                 |
 */
import { applyPatch, type StructuredPatch } from 'diff'

import { normalizePatch } from './normalize.js'

/**
 * 失败原因。分类是为了让调用方知道该怎么办——**其中两类对应完全不同的处置**：
 *
 * - `not-found` / `ambiguous` 是**内容层面的定位失败**，属于常规路径（LLM 的上下文
 *   行常有细微差异，且 fuzzFactor 不可依赖）。处置：带着更多上下文重新生成，
 *   与其他 schema 校验失败共用同一套重试机制。
 * - 其余属于**结构或调用方问题**，重试同一个输入不会有不同结果。处置：修输入，
 *   或按提示分拆处理。
 */
export type ApplyFailureReason =
  /** 规范化后仍无法解析成 diff */
  | 'normalize-failed'
  /** jsdiff 解析抛错（语法/计数层面） */
  | 'parse-failed'
  /** 解析成功但一个 hunk 都没有。**当前不可达**——normalizePatch 的成功契约已保证
   *  至少有一个非空 hunk。保留它是为了契约被破坏时硬失败，而不是掉进 jsdiff
   *  "原样返回源文本"的陷阱。 */
  | 'no-hunks'
  /** 一个 patch 里含多个文件段，调用方需先用 splitByFile 拆开 */
  | 'multi-file'
  /** patch 表达的是新建或删除文件，而非修改已有文件 */
  | 'unsupported-file-op'
  /** 旧侧序列在目标内容中找不到 */
  | 'not-found'
  /** 旧侧序列在目标内容中命中多处，无法确定改哪一处 */
  | 'ambiguous'
  /** 应用成功但内容没有变化 */
  | 'unchanged'

export type ApplyResult =
  | { ok: true; content: string }
  | {
      ok: false
      reason: ApplyFailureReason
      /** 仅供人读的诊断信息，不要据此做分支判断 */
      detail?: string
      /** 旧侧序列在目标中命中的次数，仅在 not-found / ambiguous 时有意义 */
      matches?: number
    }

/** hunk 的「旧侧序列」：前缀为空格（未改动的上下文）或 `-`（删除）的行。
 *  注意 hunk.oldLines 是**计数数字**，不是行数组——行内容在 hunk.lines 里。 */
const oldSideLines = (lines: readonly string[]): string[] =>
  lines.filter((l) => l.startsWith(' ') || l.startsWith('-')).map((l) => l.slice(1))

/** 统计 needle 在 haystack 的行序列中**完全匹配**出现的次数。
 *  完全匹配、不接受 fuzz——实测 fuzzFactor 在这里帮不上忙，而放宽匹配会引入
 *  我们正是想避免的静默错位。 */
const countOccurrences = (haystack: readonly string[], needle: readonly string[]): number => {
  if (needle.length === 0) return 0
  let hits = 0
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let all = true
    for (let k = 0; k < needle.length; k++) {
      if (haystack[i + k] !== needle[k]) {
        all = false
        break
      }
    }
    if (all) hits++
  }
  return hits
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * patch 是否表达"新建文件"或"删除文件"，而不是修改已有文件。
 *
 * jsdiff 从 git 扩展头解析出 `isCreate` / `isDelete`；`/dev/null` 是更通用的写法，
 * 不依赖 git 风格头。两者都要认。
 */
const isFileCreateOrDelete = (file: StructuredPatch): boolean =>
  file.isCreate === true ||
  file.isDelete === true ||
  file.oldFileName === '/dev/null' ||
  file.newFileName === '/dev/null'

/**
 * 把 patch 应用到 content。
 *
 * 校验顺序是刻意的：先做唯一性预检，再交给 applyPatch。理由是 applyPatch 在
 * 定位不唯一时会**静默改第一处**，事后无法察觉；预检是唯一能在动手前拦下它的位置。
 */
export const applyPatchToContent = (content: string, patchText: string): ApplyResult => {
  const normalized = normalizePatch(patchText)
  if (!normalized.ok) return { ok: false, reason: 'normalize-failed', detail: normalized.reason }

  const withHunks = normalized.files.filter((f) => f.hunks.length > 0)
  const first = withHunks[0]
  if (first === undefined) {
    // 契约保证不可达，见 ApplyFailureReason 的说明。这里同时承担类型收窄。
    return { ok: false, reason: 'no-hunks' }
  }
  if (withHunks.length > 1) {
    // 多文件段的 patch 直接交给 applyPatch 会抛异常。这不是重试能解决的，
    // 是调用方该先 splitByFile。
    return {
      ok: false,
      reason: 'multi-file',
      detail: `patch 含 ${withHunks.length} 个文件段`,
    }
  }

  // 新建/删除文件必须先于唯一性预检拦下。新建文件的旧侧是空的，预检会返回
  // 一个"找不到上下文"的 not-found —— 那会让人以为模型写的上下文不对而白重试，
  // 实际原因是这类改动本工具尚不支持。
  if (isFileCreateOrDelete(first)) {
    return {
      ok: false,
      reason: 'unsupported-file-op',
      detail: `patch 表达的是${first.isDelete === true ? '删除' : '新建'}文件，当前不支持`,
    }
  }

  const haystack = content.split('\n')
  for (const hunk of first.hunks) {
    const matches = countOccurrences(haystack, oldSideLines(hunk.lines))
    if (matches === 0) return { ok: false, reason: 'not-found', matches }
    if (matches > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        matches,
        detail: `旧侧序列在目标中命中 ${matches} 处，无法确定改哪一处`,
      }
    }
  }

  let applied: string | false
  try {
    applied = applyPatch(content, normalized.patch)
  } catch (e) {
    // 走到这里说明预检通过但 jsdiff 仍抛错——多半是 hunk 之间的交互，
    // 归到 parse-failed 让调用方重试。
    return { ok: false, reason: 'parse-failed', detail: messageOf(e) }
  }

  if (applied === false) return { ok: false, reason: 'not-found' }

  // 第 5 条不变量：结果是布尔之外的字符串也可能"什么都没改"。
  // 少了这条断言，空改动会伪装成成功并产出一个空 commit。
  if (applied === content) return { ok: false, reason: 'unchanged' }

  return { ok: true, content: applied }
}

export type PatchSection = {
  /** `---` 侧声明的路径，原样返回，未做任何规范化 */
  from: string
  /** `+++` 侧声明的路径，原样返回，未做任何规范化 */
  to: string
  patch: string
}

/**
 * 按文件段拆分 patch。用于"一个 step 触及多个文件"的情况——那种 patch 不能
 * 直接交给 applyPatch（会抛异常），必须先拆开分别应用。
 *
 * 路径**原样返回**，包括 git 风格的 `a/` `b/` 前缀。不要在这里剥前缀：项目里
 * 真有个叫 `a/` 的目录时剥了就是错的。解析成项目相对路径、做 containment 校验，
 * 都是调用方的职责（见 `CLAUDE.md` 安全与边界）。
 *
 * 返回空数组表示 patch 里没有 `--- `/`+++ ` 文件头（只有裸 `@@`）。此时调用方
 * 应按"路径来自上下文"的单文件 patch 处理。
 */
export const splitByFile = (patchText: string): PatchSection[] => {
  const lines = patchText.split('\n')

  const heads: number[] = []
  for (let i = 0; i + 1 < lines.length; i++) {
    if (/^--- /.test(lines[i] ?? '') && /^\+\+\+ /.test(lines[i + 1] ?? '')) heads.push(i)
  }

  const sections: PatchSection[] = []
  for (let k = 0; k < heads.length; k++) {
    const start = heads[k]
    if (start === undefined) continue
    const nextHead = heads[k + 1]
    const end = nextHead ?? lines.length
    sections.push({
      from: (lines[start] ?? '').slice(4).trim(),
      to: (lines[start + 1] ?? '').slice(4).trim(),
      patch: lines.slice(start, end).join('\n'),
    })
  }
  return sections
}
