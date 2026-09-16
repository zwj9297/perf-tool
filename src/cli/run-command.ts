/**
 * `perf run` 的串联逻辑：生成改动 → 预览 → 确认 → 落盘提交。
 *
 * `--dry-run` 时到预览为止，绝不碰文件；`--emit-patch` 可以只导出补丁由用户自己应用。
 *
 * 流程里有一处顺序是刻意的：**所有"会拒绝"的检查都在问确认之前做完**（见下方注释），
 * 否则用户读完 diff 点了 y 才被告知工作区是脏的，那次确认白问。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
import type { VerifyOutcome } from '../execute/apply.js'
import type { Plan } from '../plan/schema.js'
import type { Provider } from '../providers/types.js'

import { OUTPUT_DIR, PLAN_FILE } from './plan-command.js'

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
   * 逐 step 验证的命令（如 `npm run typecheck && npm test`），在项目根下执行。
   *
   * **只有调用方显式武装时才该传进来**（CLI 层由 `--verify` 控制）。配置里写了命令
   * 不等于用户同意执行它——`.perftoolrc.json` 会随仓库一起被克隆。
   */
  verifyCommand?: string
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

export const RUN_TRACE_FILE = 'run-trace.json'

/** 每个 step 在这一次运行里的结局。诊断时要回答的第一个问题就是"它到底走到哪一步" */
export type StepTrace = {
  id: string
  title: string
  status: 'committed' | 'verify-failed' | 'generated' | 'skipped' | 'not-generated'
  attempts: number
  files: string[]
  sha?: string
  reason?: string
}

export type RunTrace = {
  plan: { summary: string; steps: number; grounded: boolean }
  mode: 'apply' | 'preview'
  verify?: string
  branch?: string
  usage?: { inputTokens: number; outputTokens: number }
  steps: StepTrace[]
  outcome: { ok: boolean; reason?: string }
  /** 验证未通过时的原始输出（截断后的），失败原因通常就在其中 */
  verifyOutput?: string
}

const buildStepTraces = (
  plan: Plan,
  generated: GenerateResult | undefined,
  applied: { commits: readonly { stepId: string; sha: string; files: string[] }[] } | undefined,
): StepTrace[] => {
  const commitByStep = new Map((applied?.commits ?? []).map((c) => [c.stepId, c]))
  const editByStep = new Map((generated?.edits ?? []).map((e) => [e.stepId, e]))
  const skippedByStep = new Map((generated?.skipped ?? []).map((s) => [s.stepId, s]))

  return plan.steps.map((step) => {
    const base = { id: step.id, title: step.title }
    const commit = commitByStep.get(step.id)
    if (commit !== undefined) {
      return {
        ...base,
        status: 'committed' as const,
        attempts: editByStep.get(step.id)?.attempts ?? 0,
        files: [...commit.files],
        sha: commit.sha,
      }
    }
    const edit = editByStep.get(step.id)
    if (edit !== undefined) {
      // 生成了却没提交，只可能是验证未通过（applyEdits 一遇失败就停）；
      // 或者本次是 preview 模式，压根没走应用
      const isVerifyFailure = applied !== undefined
      return {
        ...base,
        status: isVerifyFailure ? ('verify-failed' as const) : ('generated' as const),
        attempts: edit.attempts,
        files: [...edit.files],
        ...(isVerifyFailure ? { reason: '未通过逐 step 验证' } : {}),
      }
    }
    const skipped = skippedByStep.get(step.id)
    if (skipped !== undefined) {
      return {
        ...base,
        status: 'skipped' as const,
        attempts: skipped.attempts,
        files: [],
        reason: skipped.reason,
      }
    }
    return { ...base, status: 'not-generated' as const, attempts: 0, files: [] }
  })
}

/**
 * 落轨迹。
 *
 * `plan` 一直都有跑道迹，而 `run` 没有——代价是我为了拿到"每个 step 重试了几次"
 * 不得不**重跑一次生成**（多花了一轮 token）。诊断要回答的问题（哪一步失败、
 * 重试几次、为什么、验证输出了什么）本来就都在内存里，写下来几乎不要成本。
 */
const persistRunTrace = (projectRoot: string, trace: RunTrace): string => {
  const dir = join(projectRoot, OUTPUT_DIR)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, RUN_TRACE_FILE)
  writeFileSync(path, `${JSON.stringify(trace, null, 2)}\n`, 'utf8')
  return path
}

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

/** 验证命令的超时。跑测试可能慢，但不能无限等 */
const VERIFY_TIMEOUT_MS = 600_000
/** 报告里保留的验证输出长度。**取尾部**：tsc 与测试框架都把失败摘要打在最后 */
const VERIFY_OUTPUT_TAIL = 4000

const tailOf = (text: string): string =>
  text.length <= VERIFY_OUTPUT_TAIL
    ? text
    : `…（前 ${text.length - VERIFY_OUTPUT_TAIL} 字符已略）\n${text.slice(-VERIFY_OUTPUT_TAIL)}`

/**
 * 逐 step 验证的执行器。
 *
 * 用 `shell: true` 是因为验证命令天然是 shell 形态（`a && b`）。这也意味着它是
 * **任意代码执行**——所以它在 CLI 层必须由 `--verify` 显式武装，不能只靠配置文件。
 */
const makeVerify =
  (projectRoot: string, command: string, write: (text: string) => void) =>
  (step: { stepId: string; title: string; files: readonly string[] }): VerifyOutcome => {
    write(`  验证中（${step.stepId}）：${command}\n`)
    const r = spawnSync(command, {
      cwd: projectRoot,
      shell: true,
      encoding: 'utf8',
      timeout: VERIFY_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    })
    if (r.error !== undefined && r.error !== null) {
      const e = r.error as NodeJS.ErrnoException
      const kind =
        e.code === 'ETIMEDOUT' ? `超时（超过 ${VERIFY_TIMEOUT_MS / 1000} 秒）` : e.message
      return {
        ok: false,
        output: `${kind}\n${tailOf([r.stdout, r.stderr].filter(Boolean).join('\n'))}`,
      }
    }
    if (r.status === 0) return { ok: true }
    const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim()
    return {
      ok: false,
      output: out === '' ? `命令以退出码 ${String(r.status)} 结束，没有输出` : tailOf(out),
    }
  }

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

  const traceBase = {
    plan: {
      summary: input.plan.summary,
      steps: input.plan.steps.length,
      grounded: input.plan.grounded,
    },
    mode: input.mode,
    ...(input.verifyCommand === undefined ? {} : { verify: input.verifyCommand }),
    usage: result.usage,
  }
  const writeTrace = (
    applied:
      | {
          commits: readonly { stepId: string; sha: string; files: string[] }[]
          branch?: string
          verifyOutput?: string
        }
      | undefined,
    outcome: { ok: boolean; reason?: string },
  ): string =>
    persistRunTrace(input.projectRoot, {
      ...traceBase,
      ...(applied?.branch === undefined ? {} : { branch: applied.branch }),
      steps: buildStepTraces(input.plan, result, applied),
      outcome,
      ...(applied?.verifyOutput === undefined ? {} : { verifyOutput: applied.verifyOutput }),
    })

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
    const tracePath = writeTrace(undefined, { ok: true, reason: 'preview-only' })
    deps.write(`轨迹已写入 ${tracePath}\n`)
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
    ...(input.verifyCommand === undefined
      ? {}
      : { verify: makeVerify(input.projectRoot, input.verifyCommand, deps.write) }),
  })

  if (!applied.ok) {
    const tracePath = writeTrace(applied, { ok: false, reason: applied.reason })
    deps.write(`\n应用失败（${applied.reason}）：${applied.message}\n`)
    if (applied.commits.length > 0) {
      deps.write(`\n已完成的提交（${applied.commits.length} 个）：\n`)
      for (const c of applied.commits) {
        deps.write(`  ${c.sha.slice(0, 8)}  ${c.title}\n`)
      }
    }
    // 失败时尤其要给出轨迹位置：那里面记着每个 step 的结局与验证输出
    deps.write(`轨迹已写入 ${tracePath}\n`)
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
  const tracePath = writeTrace(applied, { ok: true })
  deps.write(`轨迹已写入 ${tracePath}\n`)

  return {
    ok: true,
    ...summary,
    applied: true,
    branch: applied.branch,
    commits: applied.commits,
  }
}
