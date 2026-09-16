/**
 * `.cpuprofile` → `PerformanceEvidence`。
 *
 * 算法见 docs/design.md §6.3，三条决定性发现见 §6.2。这里只重复最容易写错的那条：
 * **必须按 (文件, 行) 归因，不能按函数名**——V8 内联会让函数名指向错误的函数，
 * 实测真凶行被算到了调用者名下。
 *
 * 分两层是为了可测：`parseCpuProfile` 是纯函数（收已解析的 JSON），
 * `loadCpuProfile` 才碰文件系统。
 */
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CpuProfile, CpuProfileNode, HotSpot, PerformanceEvidence } from './types.js'

export type EvidenceFailureReason =
  | 'read-failed'
  | 'invalid-json'
  | 'unsupported-format'
  /** `samples` 与 `timeDeltas` 长度不等 —— 无法把采样对应到耗时 */
  | 'samples-mismatch'
  /** 没有采样，或所有 timeDelta 都是 0 */
  | 'no-samples'
  /** 没有任何采样落在项目根内。这才是"拿错 profile / 项目根不对"的信号 */
  | 'no-project-code'

export type ParseOutcome =
  | { ok: true; evidence: PerformanceEvidence }
  | { ok: false; reason: EvidenceFailureReason; detail?: string }

export type ParseOptions = {
  /**
   * 项目根绝对路径。
   *
   * **调用方必须先用 `realpath` 归一化**：profile 里的 url 是 realpath（因为 V8 解析
   * 脚本路径时就是这么拿到的），不归一化的话在 macOS（`/tmp` → `/private/tmp`）或任何
   * 经软链访问的项目上必然匹配失败。`loadCpuProfile` 会替调用方做这件事。
   */
  projectRoot: string
  /** hotSpots 上限，超出的记录在 `hotSpotsOmitted` 里。默认 20 */
  maxHotSpots?: number
}

const DEFAULT_MAX_HOT_SPOTS = 20
/** `dependencyTop` 列出几个 */
const DEPENDENCY_TOP_N = 5

// ---------------------------------------------------------------- 运行时校验

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const asNumberArray = (v: unknown): number[] | null =>
  Array.isArray(v) && v.every(isFiniteNumber) ? v : null

const asPositionTicks = (v: unknown): { line: number; ticks: number }[] | null => {
  if (!Array.isArray(v)) return null
  const out: { line: number; ticks: number }[] = []
  for (const t of v) {
    if (!isRecord(t)) return null
    const { line, ticks } = t
    if (!isFiniteNumber(line) || !isFiniteNumber(ticks)) return null
    out.push({ line, ticks })
  }
  return out
}

const asNode = (v: unknown): CpuProfileNode | null => {
  if (!isRecord(v)) return null
  const { id, callFrame, children, positionTicks } = v
  if (!isFiniteNumber(id) || !isRecord(callFrame)) return null

  const { functionName, scriptId, url, lineNumber, columnNumber } = callFrame
  // functionName 允许是空串（实测匿名/模块顶层节点就是空串）
  if (typeof functionName !== 'string') return null
  if (typeof scriptId !== 'string') return null
  if (typeof url !== 'string') return null
  if (!isFiniteNumber(lineNumber) || !isFiniteNumber(columnNumber)) return null

  const node: CpuProfileNode = {
    id,
    callFrame: { functionName, scriptId, url, lineNumber, columnNumber },
    // hitCount 我们不读（见 types.ts），缺失也不影响
    hitCount: 0,
  }
  if (isFiniteNumber(v.hitCount)) node.hitCount = v.hitCount
  if (Array.isArray(children) && children.every(isFiniteNumber)) node.children = children
  const ticks = asPositionTicks(positionTicks)
  if (ticks !== null && ticks.length > 0) node.positionTicks = ticks
  return node
}

const asCpuProfile = (raw: unknown): CpuProfile | null => {
  if (!isRecord(raw)) return null
  const samples = asNumberArray(raw.samples)
  const timeDeltas = asNumberArray(raw.timeDeltas)
  if (samples === null || timeDeltas === null) return null
  if (!Array.isArray(raw.nodes)) return null

  const nodes: CpuProfileNode[] = []
  for (const n of raw.nodes) {
    const node = asNode(n)
    if (node === null) return null
    nodes.push(node)
  }
  return { nodes, samples, timeDeltas }
}

// ---------------------------------------------------------------- 路径分类

type Classification =
  /** 合成节点（`(root)` / `(program)` / `(idle)`）或 Node 自身代码（`node:internal/*`） */
  | { kind: 'engine' }
  /** 落在项目根内且不是依赖，`file` 是相对根的 POSIX 路径 */
  | { kind: 'project'; file: string }
  /** 非本项目代码：依赖（含根内的 node_modules）、根外路径 */
  | { kind: 'dependency'; label: string }
  /** 转不成文件路径（`webpack://`、`data:`、相对路径等） */
  | { kind: 'unmatched'; label: string }

const toPosix = (p: string): string => p.split('\\').join('/')

/**
 * 依赖目录名。命中即视为非本项目代码，**不管它在不在项目根内**。
 *
 * 只看"是否落在项目根外"是不够的：`./node_modules` 就在根内，会被错误地算成项目
 * 代码，于是依赖里的热点进了 `hotSpots`，模型就会去"优化"一个它改不了的第三方包。
 */
const DEPENDENCY_DIRS = ['node_modules']

const hasDependencySegment = (file: string): boolean =>
  toPosix(file)
    .split('/')
    .some((seg) => DEPENDENCY_DIRS.includes(seg))

const classify = (url: string, projectRoot: string): Classification => {
  // 合成节点：实测 (root) 与 (program) 的 url 就是空串
  if (url === '') return { kind: 'engine' }
  // node:internal/*、node:fs … 是 Node 自身代码，同样不归用户
  if (url.startsWith('node:')) return { kind: 'engine' }

  let file: string
  if (url.startsWith('file://')) {
    try {
      file = fileURLToPath(url)
    } catch {
      return { kind: 'unmatched', label: url }
    }
  } else if (isAbsolute(url)) {
    // 少数 profile 直接写绝对路径，不带 file:// 前缀
    file = url
  } else {
    return { kind: 'unmatched', label: url }
  }

  if (hasDependencySegment(file)) return { kind: 'dependency', label: file }

  const rel = relative(projectRoot, file)
  // rel === '' 表示 file 就是项目根本身，那是目录不是文件，不算项目代码
  const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  return inside ? { kind: 'project', file: toPosix(rel) } : { kind: 'dependency', label: file }
}

// ---------------------------------------------------------------- 主体

type LineAcc = {
  file: string
  line: number
  precision: 'line' | 'function'
  symbol: string | undefined
  us: number
  /** 贡献 symbol 的那个节点的 us，用来在多节点落到同一行时选出主要归属者 */
  symbolUs: number
}

const lineKey = (file: string, line: number): string => `${file}\u0000${line}`

/**
 * 纯函数：收**已解析**的 JSON。
 *
 * `options.projectRoot` 必须是 realpath 归一化过的绝对路径，见 `ParseOptions`。
 */
export const parseCpuProfile = (raw: unknown, options: ParseOptions): ParseOutcome => {
  const profile = asCpuProfile(raw)
  if (profile === null) {
    return { ok: false, reason: 'unsupported-format', detail: '缺少 nodes / samples / timeDeltas' }
  }
  const { nodes, samples, timeDeltas } = profile

  if (samples.length !== timeDeltas.length) {
    return {
      ok: false,
      reason: 'samples-mismatch',
      detail: `samples=${samples.length} timeDeltas=${timeDeltas.length}`,
    }
  }

  // timeDeltas 累加而不是 hitCount × 名义间隔 —— 实测差 24%，见 §6.2 发现③
  let totalUs = 0
  for (const d of timeDeltas) totalUs += d
  if (totalUs <= 0) return { ok: false, reason: 'no-samples', detail: '采样总时长为 0' }

  // 每个节点的 self time：把采样按其间隔累加给它
  const selfByNode = new Map<number, number>()
  const nodeById = new Map<number, CpuProfileNode>()
  for (const n of nodes) nodeById.set(n.id, n)

  for (let i = 0; i < samples.length; i++) {
    const id = samples[i]
    if (id === undefined) continue
    const delta = timeDeltas[i] ?? 0
    // 采样指向不存在的节点属于异常数据。直接跳过，让三个份额之和**小于** 1 ——
    // 差额就是无法归因的部分。不要把它塞进某个桶里：那会让恒等式失真却看不出来。
    if (!nodeById.has(id)) continue
    selfByNode.set(id, (selfByNode.get(id) ?? 0) + delta)
  }

  const projectRoot = options.projectRoot
  const lines = new Map<string, LineAcc>()
  const dependencyByLabel = new Map<string, number>()
  let projectUs = 0
  let dependencyUs = 0
  let engineUs = 0
  let projectNodeCount = 0

  for (const node of nodes) {
    const us = selfByNode.get(node.id) ?? 0
    const { url, functionName, lineNumber } = node.callFrame
    const classification = classify(url, projectRoot)

    if (classification.kind === 'engine') {
      engineUs += us
      continue
    }
    if (classification.kind === 'dependency' || classification.kind === 'unmatched') {
      // 转不成路径的时间同样是"非本项目代码"，归入依赖桶并留下标签便于诊断
      dependencyUs += us
      const label = classification.label
      dependencyByLabel.set(label, (dependencyByLabel.get(label) ?? 0) + us)
      continue
    }

    // 项目代码
    projectNodeCount++
    projectUs += us
    if (us <= 0) continue

    const symbol = functionName === '' ? undefined : functionName
    const ticks = node.positionTicks
    if (ticks !== undefined) {
      let totalTicks = 0
      for (const t of ticks) totalTicks += t.ticks
      if (totalTicks > 0) {
        for (const t of ticks) {
          // ticks 之和精确等于 hitCount（实测三个节点全等），所以按比例摊分是精确的
          addLine(lines, classification.file, t.line, 'line', symbol, (us * t.ticks) / totalTicks)
        }
        continue
      }
    }
    // 没有 positionTicks：只能退化到函数定义行。lineNumber 是 0-based，+1 成人读的行号。
    // lineNumber 为负时不落行——盲目 +1 会算出第 0 行这种不存在的行号。
    // 合成节点的 lineNumber 是 -1，但那种走不到这里（url 为空 → engine）；
    // 这个守卫是防真文件上出现异常值。
    if (lineNumber >= 0) {
      addLine(lines, classification.file, lineNumber + 1, 'function', symbol, us)
    }
  }

  if (projectUs <= 0) {
    return {
      ok: false,
      reason: 'no-project-code',
      detail:
        projectNodeCount === 0
          ? `profile 里没有任何代码落在项目根内（${projectRoot}）——请确认 profile 是在这个项目目录下采集的`
          : '项目代码没有任何采样',
    }
  }

  const sorted = [...lines.values()].sort((a, b) => b.us - a.us)
  const cap = options.maxHotSpots ?? DEFAULT_MAX_HOT_SPOTS
  const kept = sorted.slice(0, cap)
  const dropped = sorted.slice(cap)
  const droppedUs = dropped.reduce((n, d) => n + d.us, 0)

  const hotSpots: HotSpot[] = kept.map((l) => {
    const spot: HotSpot = {
      file: l.file,
      line: l.line,
      selfShare: l.us / totalUs,
      precision: l.precision,
    }
    if (l.symbol !== undefined) spot.symbol = l.symbol
    return spot
  })

  const evidence: PerformanceEvidence = {
    source: 'profile-file',
    unit: 'time',
    totalSampledMs: totalUs / 1000,
    projectShare: projectUs / totalUs,
    dependencyShare: dependencyUs / totalUs,
    engineShare: engineUs / totalUs,
    hotSpots,
  }

  const dependencyTop = [...dependencyByLabel.entries()]
    .filter(([, us]) => us > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, DEPENDENCY_TOP_N)
    .map(([label]) => label)
  if (dependencyTop.length > 0) evidence.dependencyTop = dependencyTop

  if (dropped.length > 0) {
    evidence.hotSpotsOmitted = { count: dropped.length, share: droppedUs / totalUs }
  }

  return { ok: true, evidence }
}

const addLine = (
  lines: Map<string, LineAcc>,
  file: string,
  line: number,
  precision: 'line' | 'function',
  symbol: string | undefined,
  us: number,
): void => {
  const key = lineKey(file, line)
  const existing = lines.get(key)
  if (existing === undefined) {
    lines.set(key, { file, line, precision, symbol, us, symbolUs: us })
    return
  }
  existing.us += us
  // 精度取更好的那个：同一行既有行级又有函数级贡献时，行级更可信
  if (precision === 'line') existing.precision = 'line'
  // symbol 取贡献最大的那个节点
  if (symbol !== undefined && us > existing.symbolUs) {
    existing.symbol = symbol
    existing.symbolUs = us
  }
}

/** 碰文件系统的入口。会替调用方做 realpath 归一化。 */
export const loadCpuProfile = (filePath: string, options: ParseOptions): ParseOutcome => {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (e) {
    return { ok: false, reason: 'read-failed', detail: e instanceof Error ? e.message : String(e) }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, reason: 'invalid-json', detail: e instanceof Error ? e.message : String(e) }
  }

  let projectRoot = options.projectRoot
  try {
    projectRoot = realpathSync(projectRoot)
  } catch {
    // 根不存在时保持原样，让下游的"没有代码落在根内"报错去说明问题
  }

  return parseCpuProfile(raw, { ...options, projectRoot })
}
