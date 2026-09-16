/**
 * 落盘与 git 提交。
 *
 * **这是整个工具唯一会修改用户源码的地方**，所以三件事必须先做对：
 *
 * 1. **基线没被动过**。overlay 是一份**预测态**——它假设磁盘还停在生成时的样子。
 *    用户在"预览"到"确认"之间改了文件，预测就不成立，写下去会把他的改动覆盖掉。
 *    所以在动手写之前逐个文件比对磁盘与 overlay 记下的原始内容，任何一处不符就拒绝。
 * 2. **git 前置条件成立**。不是仓库、有未提交的改动、没有 git 身份，都会让"能用
 *    `git revert` 精确回退"这个承诺落空——而那正是敢改用户代码的前提。
 * 3. **每步一个 commit**。这样每一步都能单独 revert，而不是一坨。失败中断时也能
 *    明确说出"已完成到哪一步、怎么退回去"。
 *
 * 关于"干净工作区"的判定：只查**已跟踪文件的修改**（`--untracked-files=no`）。
 * 未跟踪文件（包括本工具自己的 `.perf/`）不影响回退能力，而把它们算进来会让
 * `.perf/` 没被 gitignore 的项目每次都拒绝执行——那是常态，不是例外。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { StepEdit } from './generate.js'
import type { OverlayFile } from './overlay.js'

type GitOutcome = { status: number; stdout: string; stderr: string }

const git = (cwd: string, args: string[]): GitOutcome => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return {
    status: r.status ?? 1,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
  }
}

/**
 * 只在命令**成功**时返回 stdout。
 *
 * 必须看退出码：git 在失败时经常仍然往 stdout 写东西——`rev-parse HEAD` 在空仓库里
 * 退出码 128、却把 `HEAD` 原样回显到 stdout。只看输出会把失败读成成功，而这里读错的
 * 后果是前提条件形同虚设（`startSha` 会变成字符串 "HEAD"）。
 */
const gitValue = (cwd: string, args: string[]): string | undefined => {
  const r = git(cwd, args)
  return r.status === 0 ? r.stdout : undefined
}

const SHA_RE = /^[0-9a-f]{40}$/

export type PreconditionFailure =
  'not-a-repo' | 'dirty-worktree' | 'no-git-identity' | 'branch-exists' | 'stale-baseline'

export type Precondition =
  | {
      ok: true
      /** 动手之前的 HEAD，回退用 */
      startSha: string
      /** 动手之前所在的分支；detached HEAD 时为 undefined */
      startBranch?: string
    }
  | { ok: false; reason: PreconditionFailure; message: string }

/** 分支名里的 slug：只保留 ASCII 字母数字，避免中文摘要变成难读的分支名 */
export const slugify = (summary: string, max = 30): string | undefined => {
  const words = summary
    .split(/[^a-zA-Z0-9]+/)
    .filter((w) => w !== '')
    .map((w) => w.toLowerCase())
  if (words.length === 0) return undefined
  const joined = words.join('-')
  return joined.length <= max ? joined : joined.slice(0, max).replace(/-$/, '')
}

const stamp = (now: Date): string => {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  )
}

export const buildBranchName = (summary: string, now: Date): string => {
  const slug = slugify(summary)
  return slug === undefined ? `perf/${stamp(now)}` : `perf/${stamp(now)}-${slug}`
}

export const checkPreconditions = (projectRoot: string, branch: string): Precondition => {
  if (gitValue(projectRoot, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return {
      ok: false,
      reason: 'not-a-repo',
      message: `${projectRoot} 不是 git 仓库。改动需要逐 step 提交到独立分支才能可靠回退，这是敢改你代码的前提。`,
    }
  }

  // 只查已跟踪文件的修改：未跟踪文件不影响回退能力，而把 .perf/ 算进来会让
  // 没把它 gitignore 的项目每次都被拒绝
  const dirty = git(projectRoot, ['status', '--porcelain', '--untracked-files=no'])
  if (dirty.status !== 0) {
    return { ok: false, reason: 'dirty-worktree', message: `无法读取工作区状态：${dirty.stderr}` }
  }
  if (dirty.stdout !== '') {
    return {
      ok: false,
      reason: 'dirty-worktree',
      message:
        `工作区有未提交的改动：\n${dirty.stdout}\n` +
        `请先提交或 stash。否则我们的提交会和你的改动混在一起，revert 时会波及你的工作。`,
    }
  }

  // 没有 git 身份时 commit 会失败，而失败发生在已经 checkout 出新分支之后——
  // 提前查能避免把用户留在一个半成品状态里
  const missing: string[] = []
  if ((gitValue(projectRoot, ['config', 'user.email']) ?? '') === '') missing.push('user.email')
  if ((gitValue(projectRoot, ['config', 'user.name']) ?? '') === '') missing.push('user.name')
  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'no-git-identity',
      message: `git 缺少 ${missing.join(' 和 ')}，无法提交。请先配置（例如 git config user.email "you@example.com"）。`,
    }
  }

  if (
    gitValue(projectRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) !==
    undefined
  ) {
    return {
      ok: false,
      reason: 'branch-exists',
      message: `分支 ${branch} 已存在。请换个时间重试，或先删掉它。`,
    }
  }

  // 空仓库里 `rev-parse HEAD` 退出码非 0，但**仍会把 "HEAD" 打到 stdout**，
  // 所以这里既看退出码也看形状，不能只看输出
  const head = gitValue(projectRoot, ['rev-parse', 'HEAD'])
  if (head === undefined || !SHA_RE.test(head)) {
    return {
      ok: false,
      reason: 'not-a-repo',
      message: '仓库还没有任何提交（HEAD 无效）。请先做一次初始提交。',
    }
  }

  // detached HEAD 时 symbolic-ref 失败——那种情况仍可工作，只是回退提示里没有
  // "切回原分支"这一步
  const startBranch = gitValue(projectRoot, ['symbolic-ref', '--short', 'HEAD'])

  return startBranch === undefined
    ? { ok: true, startSha: head }
    : { ok: true, startSha: head, startBranch }
}

/** 快照里的 rel 是 resolvePatchPath 校验过的；这里再挡一道，因为这是**写**路径 */
const unsafeRel = (rel: string): boolean =>
  rel === '' || rel.startsWith('/') || rel.split(/[\\/]/).includes('..')

export type StaleFile = { rel: string; detail: string }

/**
 * 比对磁盘与 overlay 记下的原始内容。任何一处不符都说明预测态失效了。
 *
 * 这是**唯一**能发现"生成期间用户在另一个终端改了同一个文件"的地方。少了它，
 * 我们会拿一份基于旧内容的 diff 去覆盖他的新内容——而且是静默覆盖。
 */
export const findStaleFiles = (
  projectRoot: string,
  merged: readonly OverlayFile[],
): StaleFile[] => {
  const stale: StaleFile[] = []
  for (const f of merged) {
    let onDisk: string
    try {
      onDisk = readFileSync(join(projectRoot, f.rel), 'utf8')
    } catch {
      stale.push({ rel: f.rel, detail: '文件已不存在' })
      continue
    }
    if (onDisk !== f.original) {
      stale.push({ rel: f.rel, detail: '内容与生成时不一致' })
    }
  }
  return stale
}

export type AppliedCommit = {
  stepId: string
  title: string
  sha: string
  files: string[]
}

export type ApplyResult =
  | {
      ok: true
      branch: string
      startSha: string
      /** 动手之前所在的分支；detached HEAD 时为 undefined */
      startBranch?: string
      commits: AppliedCommit[]
    }
  | {
      ok: false
      reason: PreconditionFailure | 'write-failed' | 'commit-failed' | 'checkout-failed'
      message: string
      branch?: string
      startSha?: string
      startBranch?: string
      commits: AppliedCommit[]
    }

const revertHint = (r: { startSha?: string; startBranch?: string; branch?: string }): string => {
  const lines: string[] = []
  if (r.startBranch !== undefined) lines.push(`  git checkout ${r.startBranch}`)
  if (r.startSha !== undefined) lines.push(`  git reset --hard ${r.startSha}`)
  if (r.branch !== undefined) lines.push(`  git branch -D ${r.branch}`)
  return lines.length === 0 ? '' : `\n回退方式：\n${lines.join('\n')}\n`
}

export type ApplyOptions = {
  projectRoot: string
  edits: readonly StepEdit[]
  /** 生成阶段的最终状态，用来校验基线 */
  merged: readonly OverlayFile[]
  branch: string
  onProgress?: (text: string) => void
}

export const applyEdits = (options: ApplyOptions): ApplyResult => {
  const { projectRoot, edits, merged, branch } = options

  const stale = findStaleFiles(projectRoot, merged)
  if (stale.length > 0) {
    return {
      ok: false,
      reason: 'stale-baseline',
      message:
        `以下文件在生成改动之后被改动过，继续应用会覆盖掉那些改动：\n` +
        stale.map((s) => `  - ${s.rel}（${s.detail}）`).join('\n') +
        `\n请重新运行 \`perf run\` 基于当前内容生成。`,
      commits: [],
    }
  }

  const pre = checkPreconditions(projectRoot, branch)
  if (!pre.ok) return { ok: false, reason: pre.reason, message: pre.message, commits: [] }

  // 从一个已 checkout 到新分支的状态出发，所以回退提示里要带原分支与起始 SHA
  const commits: AppliedCommit[] = []
  const ctx: { branch: string; startSha: string; startBranch?: string } = {
    branch,
    startSha: pre.startSha,
  }
  if (pre.startBranch !== undefined) ctx.startBranch = pre.startBranch
  const fail = (
    reason: PreconditionFailure | 'write-failed' | 'commit-failed' | 'checkout-failed',
    message: string,
    withHint: boolean,
  ): ApplyResult => ({
    ok: false,
    reason,
    message: withHint ? `${message}${revertHint(ctx)}` : message,
    ...ctx,
    commits,
  })

  const checkout = git(projectRoot, ['checkout', '-b', branch])
  if (checkout.status !== 0) {
    return fail('checkout-failed', `创建分支 ${branch} 失败：${checkout.stderr}`, false)
  }
  options.onProgress?.(`已切到分支 ${branch}\n`)

  for (const edit of edits) {
    // 写这一步的快照，而**不是**最终态——后面的 step 可能又改过同一个文件
    for (const snap of edit.snapshot) {
      if (unsafeRel(snap.rel)) {
        return fail('write-failed', `拒绝写入越界路径：${snap.rel}`, true)
      }
      try {
        writeFileSync(join(projectRoot, snap.rel), snap.content, 'utf8')
      } catch (e) {
        return fail(
          'write-failed',
          `写入 ${snap.rel} 失败：${e instanceof Error ? e.message : String(e)}`,
          true,
        )
      }
    }

    const files = edit.snapshot.map((s) => s.rel)
    const add = git(projectRoot, ['add', '--', ...files])
    if (add.status !== 0) return fail('commit-failed', `git add 失败：${add.stderr}`, true)

    // 暂存区与 HEAD 无异 → 这一步实际没产生改动。**跳过提交而不是硬提交**：git 会以
    // "nothing to commit" 失败，而那个失败会中止后面所有 step。理论上生成阶段已经挡掉
    // 了无改动的 step（`unchanged`），但这里是写路径，不值得靠上游的保证。
    if (git(projectRoot, ['diff', '--cached', '--quiet', '--', ...files]).status === 0) {
      options.onProgress?.(`  这一步没有产生改动，跳过提交（${files.join('、')}）\n`)
      continue
    }

    // 只提交这一步的文件。不要 `git add -A` —— 那会把用户的未跟踪文件也裹进来
    const message = `perf: ${edit.title}\n\n${edit.rationale}\n\n步骤 ${edit.stepId}，由 perf-tool 生成`
    const commit = git(projectRoot, ['commit', '-m', message, '--', ...files])
    if (commit.status !== 0) {
      return fail('commit-failed', `提交失败：${commit.stderr || commit.stdout}`, true)
    }

    // 刚提交成功，HEAD 一定有效；用 undefined 兜底只是为了不把 'HEAD' 这种字面量写进结果
    const sha = gitValue(projectRoot, ['rev-parse', 'HEAD']) ?? ''
    commits.push({ stepId: edit.stepId, title: edit.title, sha, files })
    // 带上标题：只报一个 hash 对用户没有意义，他要知道提交的是哪一步
    options.onProgress?.(`  已提交 ${sha.slice(0, 8)}  ${edit.title}（${files.join('、')}）\n`)
  }

  return { ok: true, ...ctx, commits }
}
