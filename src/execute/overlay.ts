/**
 * overlay：生成阶段的内存预测态（design.md §2.2）。
 *
 * 生成 step N 的改动时，step 1..N-1 的改动还没落盘。若每次都读磁盘原始内容，触及
 * 同一文件的多个 step 就会基于互相矛盾的状态生成——第二个 step 的 diff 锚点是在
 * 「第一个 step 已经改了」的前提下写的，但磁盘上并没有。
 *
 * 所以这里维护一份快照：按序生成、逐层叠加。生成 step N 时模型看到的是叠加了前
 * N-1 步的内容。**应用阶段按同样顺序落盘，overlay 的预测就会成真**——这是它能成立
 * 的原因，也是为什么顺序不能乱。
 *
 * 同时保留 `original`：预览要用它算「原始 → 最终」的合并 diff（§2.3），而不是把
 * N 个顺序 diff 拼起来（那样拼不出能 `git apply` 的东西）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { applyPatchToContent, type ApplyResult } from '../diff/apply.js'
import { resolveInsideProject } from '../tools/paths.js'

export type ResolvedPatchPath =
  { ok: true; rel: string; strippedGitPrefix: boolean } | { ok: false; detail: string }

/**
 * 把 diff 头里声明的路径解析成项目根内的相对路径。
 *
 * **会尝试剥掉 git 风格的 `a/` / `b/` 前缀**，但只作为第二选择、且会在结果里标出
 * 来过。理由：这不是"猜另一个文件"，而是 git 自己的约定（`--- a/x` / `+++ b/x`），
 * 模型几乎总会带上。而先试原样路径，所以项目里真有个 `a/` 目录时不会被误剥。
 *
 * 与 `evidence/` 那里的"严格匹配、不猜"并不矛盾：那里的路径来自 profile 的绝对
 * 路径，猜错会指向另一个真实文件；这里的候选只有一个明确约定，且有先后次序。
 */
export const resolvePatchPath = (projectRoot: string, raw: string): ResolvedPatchPath => {
  const exact = resolveInsideProject(projectRoot, raw)
  if (exact.ok) return { ok: true, rel: exact.rel, strippedGitPrefix: false }

  const stripped = raw.replace(/^[ab]\//, '')
  if (stripped !== raw) {
    const viaStrip = resolveInsideProject(projectRoot, stripped)
    if (viaStrip.ok) return { ok: true, rel: viaStrip.rel, strippedGitPrefix: true }
  }
  return { ok: false, detail: exact.detail }
}

/** 已改变的文件。只包含真正变了的，所以没有 `changed: boolean` 这种冗余字段 */
export type OverlayFile = { rel: string; original: string; current: string }

export type Overlay = {
  /** 生成阶段应当看到的当前内容（叠加了此前所有 step） */
  current(rel: string): string
  /** 磁盘原始内容，用于生成合并 diff */
  original(rel: string): string
  /** 应用一个文件的 patch 到快照上。**不碰磁盘** */
  apply(rel: string, patchText: string): ApplyResult
  /**
   * 直接把快照设成给定内容。
   *
   * 存在的理由是**原子性**：一个多文件段的 patch 若只应用了一半就失败，快照会被
   * 污染，而后面所有 step 都基于这个坏状态生成。所以调用方应当先在暂存区把每一段
   * 都试成功（用 `applyPatchToContent`），再逐段 `commit`。不要拿它绕过校验。
   */
  commit(rel: string, content: string): void
  /** 所有已改变的文件，按路径排序 */
  changed(): OverlayFile[]
}

export const createOverlay = (projectRoot: string): Overlay => {
  const originals = new Map<string, string>()
  const currents = new Map<string, string>()

  const load = (rel: string): string => {
    const cached = originals.get(rel)
    if (cached !== undefined) return cached
    // 读不出来就让上层失败（例如文件在生成期间被删了）
    const text = readFileSync(join(projectRoot, rel), 'utf8')
    originals.set(rel, text)
    return text
  }

  return {
    original(rel: string): string {
      return load(rel)
    },

    current(rel: string): string {
      const c = currents.get(rel)
      return c ?? load(rel)
    },

    apply(rel: string, patchText: string): ApplyResult {
      const before = currents.get(rel) ?? load(rel)
      const result = applyPatchToContent(before, patchText)
      if (result.ok) currents.set(rel, result.content)
      return result
    },

    commit(rel: string, content: string): void {
      currents.set(rel, content)
    },

    changed(): OverlayFile[] {
      const out: OverlayFile[] = []
      for (const [rel, current] of currents) {
        const original = originals.get(rel) ?? load(rel)
        if (current !== original) out.push({ rel, original, current })
      }
      out.sort((a, b) => a.rel.localeCompare(b.rel))
      return out
    },
  }
}
