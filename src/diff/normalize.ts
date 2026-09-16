/**
 * 畸形 unified diff 的规范化。
 *
 * 模型输出的 diff 有两类问题：结构与内容。本模块**只修结构**——`@@` 头、计数、
 * 空 hunk——因为结构的正确写法是唯一的。内容层面（行前缀缺失、正文与声明不符）
 * 一律拒绝，交给 `plan/` 的重试机制，**绝不猜**。猜错会静默改错位置，而拒绝只
 * 是多花一轮。
 *
 * 策略是两轮，不是一轮：
 *
 *   1. 直接交给 jsdiff。它的 header 层本来就宽容——markdown 围栏、前后散文、
 *      CRLF、`\ No newline at end of file`、省略 `,1`、`@@ ... @@ function foo()`
 *      后缀、`diff --git` 风格头，实测都能吃下。为这些写代码是白写，还会引入
 *      与 jsdiff 自身行为的冲突。
 *   2. 只有第 1 轮抛错时才做结构修复。
 *
 * 实测依据见 docs/design.md §2.6，行为由 tests/diff/jsdiff-behavior.test.ts 锁定。
 */
import { parsePatch, type StructuredPatch } from 'diff'

/** 容忍前导空格，`+` 侧整体可缺，`,N` 可缺（`@@ -3 +3 @@`）。 */
const HEADER = /^\s*@@ -(\d+)(?:,(\d+))?(?:\s*\+(\d+)(?:,(\d+))?)? @@/
const FENCE = /^\s*```/
const NO_NEWLINE = /^\\ No newline at end of file\s*$/
/** 只保留真正的文件头。裸 `---`（markdown 分隔线）不算。 */
const FILE_HEADER = /^(--- |\+\+\+ |diff --git |index )/

/**
 * 成功时连解析结果一起返回，而不是只回一个计数。
 *
 * 这样调用方不必再 `parsePatch` 一遍——重复解析除了浪费，还会逼调用方写一堆
 * "规范化成功了但重新解析却失败"的防御分支，而那些分支**在本契约下不可达**。
 * 不可达的分支既无法测试、又会误导后来的人以为它们有用。
 *
 * 因此成功结果的契约是明确的：`hunkCount >= 1`，且 `files` 里至少有一个
 * hunks 非空的文件段。调用方可以放心依赖。
 */
export type NormalizeResult =
  | { ok: true; patch: string; files: StructuredPatch[]; hunkCount: number }
  | { ok: false; reason: string }

const parseOrNull = (text: string): StructuredPatch[] | null => {
  try {
    return parsePatch(text)
  } catch {
    // jsdiff 对计数不符、行首缺前缀字符都是抛异常
    return null
  }
}

const countHunks = (files: readonly StructuredPatch[]): number =>
  files.reduce((n, file) => n + file.hunks.length, 0)

export const normalizePatch = (text: string): NormalizeResult => {
  const direct = parseOrNull(text)
  if (direct !== null) {
    const hunkCount = countHunks(direct)
    // `hunkCount === 0` 落进修复分支：那是"能解析但一个 hunk 都没有"，
    // 它比抛错更危险，因为 applyPatch 会原样返回源文本而不报错，看起来像成功。
    if (hunkCount > 0) return { ok: true, patch: text, files: direct, hunkCount }
  }

  const repaired = repair(text)
  const files = parseOrNull(repaired)
  if (files === null) return { ok: false, reason: '修复后仍无法解析' }
  const hunkCount = countHunks(files)
  if (hunkCount === 0) return { ok: false, reason: '不含任何 hunk' }
  return { ok: true, patch: repaired, files, hunkCount }
}

/**
 * 结构修复。调用方应只在直接解析失败后走这里。
 */
const repair = (text: string): string => {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''

    if (FENCE.test(line) || NO_NEWLINE.test(line)) {
      i++
      continue
    }

    const header = HEADER.exec(line)
    if (header === null) {
      if (FILE_HEADER.test(line)) out.push(line)
      i++
      continue
    }

    // 连续多个 @@ 头：正文跟在最后一个之后，所以保留最后一个。
    // 保留哪个不影响结果，因为计数马上会照正文重算。
    let last = header
    let j = i + 1
    while (j < lines.length) {
      const next = HEADER.exec(lines[j] ?? '')
      if (next === null) break
      last = next
      j++
    }

    const body = collectBody(lines, j)
    j = body.next

    // 空 hunk 直接丢弃；若全部被丢弃，上层会因为 hunkCount === 0 而拒绝。
    // 不能留一个空 hunk 下去——那正是"静默无操作"的入口。
    if (body.lines.length === 0) {
      i = j
      continue
    }

    let oldCount = 0
    let newCount = 0
    for (const l of body.lines) {
      const c = l[0]
      if (c === ' ' || c === '-') oldCount++
      if (c === ' ' || c === '+') newCount++
    }

    const oldStart = last[1] ?? '1'
    // `+` 侧缺失时按同号合成：这是唯一无歧义的补法
    const newStart = last[3] ?? oldStart
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    out.push(...body.lines)
    i = j
  }

  return out.join('\n')
}

/** 从 `from` 起，下一个非空行是否仍是 hunk 正文（前缀为空格 / - / +）。 */
const hasMoreBody = (lines: string[], from: number): boolean => {
  for (let k = from; k < lines.length; k++) {
    const l = lines[k] ?? ''
    if (l.trim() === '') continue
    const c = l[0]
    return c === ' ' || c === '-' || c === '+'
  }
  return false
}

/** 收集 hunk 正文直到下一个 header / 围栏 / 散文，返回正文与下一个扫描位置。 */
const collectBody = (lines: string[], start: number): { lines: string[]; next: number } => {
  const body: string[] = []
  let j = start

  while (j < lines.length) {
    const l = lines[j] ?? ''
    if (HEADER.test(l) || FENCE.test(l)) break

    const c = l[0]
    if (c === ' ' || c === '-' || c === '+') {
      body.push(l)
      j++
      continue
    }
    if (l.trim() === '') {
      // 真空行只有在**后面还有本 hunk 正文**时，才可能是"丢了前缀的空上下文行"
      // （模型很常这样输出）。否则它只是分隔符：文件末尾的空串、或散文前的空行。
      //
      // 这个条件不能省。`split(/\r?\n/)` 对以换行结尾的文本会产生一个末尾空串，
      // 无条件转换会给每个 hunk 的旧侧序列尾部加上一条幽灵行，让定位必然失败。
      //
      // 拿不准时宁可少一条上下文行：少上下文只降低命中率（响亮失败），多一条
      // 幽灵行则凭空改变旧侧序列。
      if (!hasMoreBody(lines, j + 1)) break
      body.push(' ')
      j++
      continue
    }
    if (NO_NEWLINE.test(l)) {
      j++
      continue
    }
    break // 散文，或下一个文件的头
  }

  return { lines: body, next: j }
}
