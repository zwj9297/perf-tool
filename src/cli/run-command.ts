/**
 * `perf run` 的串联逻辑。
 *
 * **当前只做三件事：生成改动 → 预览 → 可选导出 patch。绝不修改用户代码。**
 *
 * 这是刻意的半步。`execute/` 是整个工具里唯一会动用户源码的部分，所以先只做只读的
 * 那一半：真正落盘与 git 提交（分支、逐 step commit、失败回滚）留到第二步。这样
 * 危险面小得多，而且用户已经能拿到可直接 `git apply` 的 patch 自己动手。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import {
  applyEdits,
  buildBranchName,
  checkPreconditions,
  findStaleFiles,
} from '../execute/apply.js'
import { generateEdits, type GenerateResult } from '../execute/generate.js'
import { checkFilesAreSafe } from '../execute/overlay.js'
import {
  buildMergedDiffs,
  renderPatchText,
  renderPreview,
  renderStepDiffs,
} from '../execute/preview.js'
import { OUTPUT_DIR, PLAN_FILE } from './plan-command.js'
import type { Plan } from '../plan/schema.js'
import type { Provider } from '../providers/types.js'

export type RunCommandInput = {
  /** **已 realpath 归一化**的项目根 */
  projectRoot: string
  /** 已加载并校验过的计划 */
  plan: Plan
  byStep: boolean
  /**
   * `apply`：预览后等确认，确认了才落盘提交。
   * `preview`：只预览，绝不碰文件（`--dry-run`）。
   */
  mode: 'apply' | 'preview'
  /** 相对项目根或 cwd 的 patch 输出路径 */
  emitPatch?: string
  cwd: string
  /** 是否给 diff 上色（TTY 下更易读） */
  color: boolean
  /**
   * 应用前的确认。**回调注入**，这样本模块仍可被测试，而真实的交互提示留在
   * CLI 层——那里才知道是不是 TTY、该怎么读标准输入。
   */
  confirm: () => Promise<boolean>
  /** 分支名里要带时间戳；注入以便测试确定化 */
  now: Date
}

export type RunCommandDeps = {
  provider: Provider
  write: (text: string) => void
}

export type RunCommandOutcome =
  | {
      ok: true
      files: string[]
      added: number
      removed: number
      patchPath?: string
      skipped: number
      /** 是否真的改了文件 */
      applied: boolean
      branch?: string
      commits?: { stepId: string; title: string; sha: string; files: string[] }[]
      cancelled?: boolean
    }
  | { ok: false; reason: string; message: string }

export type PlanLoad = { ok: true; plan: Plan } | { ok: false; reason: string; message: string }

/**
 * 读取并校验 `.perf/plan.json`。
 *
 * **单独成函数是为了让调用方先做这一步再做认证预检**：没有计划是首次使用最常见的
 * 情形，而它比"缺凭证"更根本、也更便宜（纯本地检查，不发任何请求）。若顺序反了，
 * 用户会在该被告知"先跑 perf plan"的时候看到一条关于 API key 的报错。
 */
export const loadRunPlan = (projectRoot: string): PlanLoad => {
  const path = join(projectRoot, OUTPUT_DIR, PLAN_FILE)
  if (!existsSync(path)) {
    return {
      ok: false,
      reason: 'no-plan',
      message: `找不到 ${path}。先运行 \`perf plan\` 生成计划。`,
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    return {
      ok: false,
      reason: 'plan-invalid',
      message: `${path} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
    }
  }
  const plan = raw as Plan
  if (!Array.isArray(plan.steps)) {
    return { ok: false, reason: 'plan-invalid', message: `${path} 里没有 steps 数组` }
  }
  // 计划是给人编辑的，所以它可能被改坏
  if (plan.target === undefined || typeof plan.target.root !== 'string') {
    return { ok: false, reason: 'plan-invalid', message: `${path} 缺少 target.root` }
  }

  // **每条 step 的 files 都必须合法。**
  //
  // 这不是多余的：`step.files` 的内容会被读出来送进模型 prompt，而这个文件**被设计成
  // 允许人工编辑**——所以一份被改过、或随仓库分发过来的 plan，只要写上
  // `['../../../../.ssh/id_rsa']` 或 `['.env']`，就能把该文件内容发到模型端点去。
  // 在这里挡住比在下游挡好：用户拿到的是"哪个 step 引用了哪个非法路径"，而不是生成到
  // 一半才失败。（`overlay` 内部也做了同样的校验，那是为了任何绕过本函数的调用方。）
  for (const step of plan.steps) {
    const files = Array.isArray(step?.files) ? step.files : []
    const safety = checkFilesAreSafe(projectRoot, files)
    if (!safety.ok) {
      return {
        ok: false,
        reason: 'unsafe-path',
        message:
          `${path} 里步骤 ${step?.id ?? '(无 id)'} 引用了非法路径 ` +
          `${JSON.stringify(safety.file)}：${safety.detail}\n` +
          `step.files 必须是项目根内的相对路径，且不得是凭证类文件。`,
      }
    }
  }

  return { ok: true, plan }
}

/** 计划是不是为**另一个项目**生成的。基线不同，diff 会指向错误的行 */
export const checkPlanRoot = (
  plan: Plan,
  projectRoot: string,
): { ok: true } | { ok: false; message: string } => {
  if (plan.target.root === projectRoot) return { ok: true }
  return {
    ok: false,
    message:
      `计划是为 ${plan.target.root} 生成的，但当前项目是 ${projectRoot}。` +
      `请在正确的项目里运行，或重新生成计划。`,
  }
}

const resolveEmitPath = (projectRoot: string, cwd: string, p: string): string =>
  isAbsolute(p) ? p : resolve(cwd, p)

export const runRunCommand = async (
  input: RunCommandInput,
  deps: RunCommandDeps,
): Promise<RunCommandOutcome> => {
  const rootCheck = checkPlanRoot(input.plan, input.projectRoot)
  if (!rootCheck.ok) {
    return { ok: false, reason: 'plan-root-mismatch', message: rootCheck.message }
  }

  if (input.plan.steps.length === 0) {
    deps.write('\n计划里没有可执行的步骤，无需生成改动。\n')
    return { ok: true, files: [], added: 0, removed: 0, skipped: 0, applied: false }
  }

  deps.write(`计划：${input.plan.summary}\n`)
  deps.write(`共 ${input.plan.steps.length} 个步骤，逐个生成改动…\n`)

  const result: GenerateResult = await generateEdits({
    provider: deps.provider,
    projectRoot: input.projectRoot,
    plan: input.plan,
    onProgress: deps.write,
  })

  if (result.providerFailed) {
    return {
      ok: false,
      reason: 'provider-failed',
      message: result.error ?? '模型调用失败',
    }
  }

  const diffs = buildMergedDiffs(result.merged)

  if (input.byStep && result.edits.length > 0) {
    deps.write(renderStepDiffs(result.edits))
  } else {
    deps.write(
      renderPreview(diffs, {
        color: input.color,
      }),
    )
  }

  if (result.skipped.length > 0) {
    deps.write(`\n以下 ${result.skipped.length} 个步骤没有生成改动：\n`)
    for (const s of result.skipped) {
      deps.write(`  - ${s.title}（尝试 ${s.attempts} 次）：${s.reason}\n`)
    }
  }

  if (result.strippedPrefixes.length > 0) {
    deps.write(
      `\n注意：以下文件在 diff 头里带了 git 风格前缀，已自动剥掉——若与预期不符请检查计划：\n` +
        result.strippedPrefixes.map((p) => `  - ${p}\n`).join(''),
    )
  }

  let patchPath: string | undefined
  if (input.emitPatch !== undefined) {
    const target = resolveEmitPath(input.projectRoot, input.cwd, input.emitPatch)
    writeFileSync(target, renderPatchText(diffs), 'utf8')
    patchPath = target
    deps.write(`\npatch 已写入 ${target}\n`)
    deps.write('它是相对真实基线算的合并 diff，可以直接 `git apply`。\n')
  }

  const added = diffs.reduce((n, d) => n + d.added, 0)
  const removed = diffs.reduce((n, d) => n + d.removed, 0)
  const summary = {
    files: diffs.map((d) => d.rel),
    added,
    removed,
    skipped: result.skipped.length,
    ...(patchPath === undefined ? {} : { patchPath }),
  }

  const nothingToApply = result.edits.length === 0 || diffs.length === 0

  if (input.mode === 'preview' || nothingToApply) {
    deps.write(
      `\n本次**没有修改任何文件**。\n` +
        (nothingToApply
          ? '没有可应用的改动。\n'
          : '想应用：去掉 `--dry-run`。想自己动手：加 `--emit-patch <文件>` 后 `git apply`。\n'),
    )
    return { ok: true, ...summary, applied: false }
  }

  const branch = buildBranchName(input.plan.summary, input.now)

  // **先把所有"会拒绝"的情况查完，再问确认。** 否则用户读了半天 diff、点了 y，
  // 才被告知工作区是脏的——那次确认完全白问。applyEdits 内部还会再查一遍（写路径
  // 不该依赖调用方的检查），这里查是为了**别让人白确认**。
  const stale = findStaleFiles(input.projectRoot, result.merged)
  if (stale.length > 0) {
    const message =
      `以下文件在生成改动之后被改动过，继续应用会覆盖掉那些改动：\n` +
      stale.map((s) => `  - ${s.rel}（${s.detail}）`).join('\n') +
      `\n请重新运行 \`perf run\` 基于当前内容生成。`
    deps.write(`\n${message}\n`)
    return { ok: false, reason: 'stale-baseline', message }
  }
  const pre = checkPreconditions(input.projectRoot, branch)
  if (!pre.ok) {
    deps.write(`\n${pre.message}\n`)
    return { ok: false, reason: pre.reason, message: pre.message }
  }

  const ok = await input.confirm()
  if (!ok) {
    deps.write('\n已取消，没有修改任何文件。\n')
    return { ok: true, ...summary, applied: false, cancelled: true }
  }

  deps.write('\n')
  const applied = applyEdits({
    projectRoot: input.projectRoot,
    edits: result.edits,
    merged: result.merged,
    branch,
    onProgress: deps.write,
  })

  if (!applied.ok) {
    deps.write(`\n应用失败（${applied.reason}）：${applied.message}\n`)
    if (applied.commits.length > 0) {
      deps.write(`\n已完成的提交（${applied.commits.length} 个）：\n`)
      for (const c of applied.commits) {
        deps.write(`  ${c.sha.slice(0, 8)}  ${c.title}\n`)
      }
    }
    return { ok: false, reason: applied.reason, message: applied.message }
  }

  deps.write(`\n已应用 ${applied.commits.length} 个提交，分支 ${applied.branch}\n`)
  for (const c of applied.commits) {
    deps.write(`  ${c.sha.slice(0, 8)}  ${c.title}\n`)
  }
  deps.write(
    `\n回退方式：\n` +
      (applied.startBranch === undefined ? '' : `  git checkout ${applied.startBranch}\n`) +
      `  git reset --hard ${applied.startSha.slice(0, 8)}\n` +
      `  git branch -D ${applied.branch}\n`,
  )

  return {
    ok: true,
    ...summary,
    applied: true,
    branch: applied.branch,
    commits: applied.commits,
  }
}
