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

/**
 * 校验一组待读/待写的路径全部合法。
 *
 * 存在的理由是一次真实的读写不对称：**写路径**（`attemptApply` → `resolvePatchPath`
 * → `resolveInsideProject`）一直有 containment 与凭证黑名单校验，而**读路径**曾经是
 * 裸的 `readFileSync`。而 `step.files` 来自 `.perf/plan.json`——那是个**被设计成允许
 * 人工编辑**的文件。于是一份被改过、或随仓库分发过来的 plan，只要写上
 * `step.files: ['../../../../.ssh/id_rsa']` 或 `['.env']`，就能把该文件的内容**发到
 * 模型端点去**。第二条尤其严重：它直接推翻了「默认跳过凭证类文件」这个对外承诺。
 *
 * `resolveInsideProject` 同时负责三件事：拒绝绝对路径与 `..`、`fs.realpath` 之后
 * 判 containment（软链绕过）、以及凭证黑名单。
 */
export const checkFilesAreSafe = (
  projectRoot: string,
  files: readonly string[],
): { ok: true } | { ok: false; file: string; detail: string } => {
  for (const f of files) {
    const r = resolveInsideProject(projectRoot, f)
    if (!r.ok) return { ok: false, file: f, detail: r.detail }
  }
  return { ok: true }
}

export const createOverlay = (projectRoot: string): Overlay => {
  const originals = new Map<string, string>()
  const currents = new Map<string, string>()

  /**
   * 解析成规范相对路径。**这是读取的唯一入口**——把校验放在这里（而非只放在调用方），
   * 任何未来的调用方都不会因为忘了校验而绕过它。
   *
   * 它同时把软链解析成真实路径，所以同一文件经不同路径写进来会归一到同一个 key。
   */
  const canonical = (rel: string): string => {
    const r = resolveInsideProject(projectRoot, rel)
    if (!r.ok) throw new Error(`拒绝访问 ${JSON.stringify(rel)}：${r.detail}`)
    return r.rel
  }

  const load = (rel: string): string => {
    const key = canonical(rel)
    const cached = originals.get(key)
    if (cached !== undefined) return cached
    // 读不出来就让上层失败（例如文件在生成期间被删了）
    const text = readFileSync(join(projectRoot, key), 'utf8')
    originals.set(key, text)
    return text
  }

  return {
    original(rel: string): string {
      return load(rel)
    },

    current(rel: string): string {
      const key = canonical(rel)
      const c = currents.get(key)
      return c ?? load(key)
    },

    apply(rel: string, patchText: string): ApplyResult {
      const key = canonical(rel)
      const before = currents.get(key) ?? load(key)
      const result = applyPatchToContent(before, patchText)
      if (result.ok) currents.set(key, result.content)
      return result
    },

    commit(rel: string, content: string): void {
      currents.set(canonical(rel), content)
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
