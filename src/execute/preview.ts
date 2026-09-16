/**
 * 预览与 patch 导出（design.md §2.3）。
 *
 * 预览展示**「原始 → 最终」的按文件合并 diff**，不是 N 个顺序 diff。两个理由：
 *
 * 1. 审阅者关心的是终态（"这个文件最后变成什么样"），不是中间过程。
 * 2. 合并 diff 是对**真实基线**算的，所以它能直接 `git apply`。而 N 个顺序 diff
 *    拼起来不行——后面的 hunk 是针对前面已应用的中间态算的。
 *
 * `--by-step` 想看每步增量时才渲染顺序 diff，并且要**明确标注它不能当 patch 用**。
 */
import { createTwoFilesPatch } from 'diff'

import type { OverlayFile } from './overlay.js'

export type FileDiff = {
  rel: string
  /** 对**磁盘原始内容**算出的 diff，可直接 git apply */
  patch: string
  added: number
  removed: number
}

const countChanges = (patch: string): { added: number; removed: number } => {
  let added = 0
  let removed = 0
  for (const line of patch.split('\n')) {
    // 文件头本身以 --- / +++ 开头，别把它们算成增删
    if (line.startsWith('---') || line.startsWith('+++')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

export const buildMergedDiffs = (files: readonly OverlayFile[]): FileDiff[] =>
  files.map((f) => {
    // 带 a/ b/ 前缀：`git apply` 默认 -p1 会剥掉第一段，没有前缀反而会出错
    const patch = createTwoFilesPatch(`a/${f.rel}`, `b/${f.rel}`, f.original, f.current)
    return { rel: f.rel, patch, ...countChanges(patch) }
  })

/** 可直接落盘、供用户自己 `git apply` 的完整 patch */
export const renderPatchText = (diffs: readonly FileDiff[]): string =>
  diffs.map((d) => d.patch).join('\n')

const header = (text: string): string => `\n${text}\n${'─'.repeat(Math.min(text.length + 8, 72))}`

export type RenderPreviewOptions = {
  /** 是否给 diff 行加上 ANSI 色（TTY 下更易读） */
  color?: boolean
}

const colorize = (patch: string, color: boolean): string => {
  if (!color) return patch
  return patch
    .split('\n')
    .map((l) => {
      if (l.startsWith('+++') || l.startsWith('---')) return `\x1b[1m${l}\x1b[0m`
      if (l.startsWith('@@')) return `\x1b[36m${l}\x1b[0m`
      if (l.startsWith('+')) return `\x1b[32m${l}\x1b[0m`
      if (l.startsWith('-')) return `\x1b[31m${l}\x1b[0m`
      return l
    })
    .join('\n')
}

/** 按文件展示合并 diff */
export const renderPreview = (
  diffs: readonly FileDiff[],
  options: RenderPreviewOptions = {},
): string => {
  if (diffs.length === 0) return '\n没有任何改动。\n'

  const color = options.color ?? false
  const parts: string[] = []
  const totalAdded = diffs.reduce((n, d) => n + d.added, 0)
  const totalRemoved = diffs.reduce((n, d) => n + d.removed, 0)

  parts.push(header(`将要改动 ${diffs.length} 个文件，+${totalAdded} / -${totalRemoved}`))
  for (const d of diffs) {
    parts.push(header(`${d.rel}  +${d.added} / -${d.removed}`))
    parts.push(colorize(d.patch, color))
  }
  return `${parts.join('\n')}\n`
}

export type StepDiffInput = {
  stepId: string
  title: string
  patch: string
  files: readonly string[]
  attempts: number
}

/** 按 step 展示增量。**明确标注不能当 patch 用**，否则用户会拿去 git apply 然后困惑 */
export const renderStepDiffs = (steps: readonly StepDiffInput[]): string => {
  if (steps.length === 0) return '\n没有任何改动。\n'

  const parts: string[] = [
    header('按 step 的增量改动'),
    '注意：这些是**顺序 diff**——后面的 hunk 是针对前面已应用的中间态算出来的，',
    '所以不能拼起来当 patch 用（要 patch 请用合并 diff 导出）。\n',
  ]
  for (const [i, s] of steps.entries()) {
    parts.push(header(`step ${i + 1}/${steps.length}：${s.title}（尝试 ${s.attempts} 次）`))
    parts.push(`文件：${s.files.join('、')}`)
    parts.push(s.patch)
  }
  return `${parts.join('\n')}\n`
}
