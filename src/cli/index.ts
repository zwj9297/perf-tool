#!/usr/bin/env node
/**
 * CLI 入口。**只负责**：解析参数、构造真实依赖、设置退出码。
 *
 * 所有逻辑都在别处：参数解析在 `args.ts`，串联在 `plan-command.ts` / `run-command.ts`，
 * 配置在 `config/`，探测在 `context/`。这样那些部分都能不经过命令行被测试。
 */
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { builtinModels } from '@earendil-works/pi-ai/providers/all'

import { loadConfig, resolveConfig, type Config } from '../config/load.js'
import { detectProjectTarget } from '../context/detect.js'
import { loadCpuProfile } from '../evidence/parse.js'
import type { PerformanceEvidence } from '../evidence/types.js'
import { checkPiAuth, createPiProvider } from '../providers/pi.js'
import type { Provider } from '../providers/types.js'
import { createToolbox } from '../tools/toolbox.js'

import { parseArgs, USAGE, type CliOptions } from './args.js'
import { formatFailure, runPlanCommand } from './plan-command.js'
import { checkPlanRoot, loadRunPlan, runRunCommand } from './run-command.js'

const EXIT_OK = 0
const EXIT_FAILURE = 1
const EXIT_USAGE = 2

const out = (text: string): void => {
  process.stdout.write(text)
}
const err = (text: string): void => {
  process.stderr.write(text)
}

/** 把用户给的目标目录解析成 realpath 归一化的绝对路径 */
const resolveProjectRoot = (
  target: string | undefined,
): { ok: true; root: string } | { ok: false; detail: string } => {
  const abs = resolve(target ?? process.cwd())
  if (!existsSync(abs)) return { ok: false, detail: `目录不存在：${abs}` }
  try {
    return { ok: true, root: realpathSync(abs) }
  } catch (e) {
    return { ok: false, detail: `无法解析目录：${e instanceof Error ? e.message : String(e)}` }
  }
}

const resolveProfilePath = (
  projectRoot: string,
  profile: string,
  cwd: string,
): { ok: true; path: string } | { ok: false; detail: string } => {
  // 相对路径先按**当前工作目录**理解，再退回项目根。用户在项目里跑时两者一致；
  // 在外部指定别的项目时（`perf plan ../repo --profile x`）按 cwd 解释更符合直觉。
  const candidates = isAbsolute(profile)
    ? [profile]
    : [resolve(cwd, profile), resolve(projectRoot, profile)]
  const found = candidates.find((p) => existsSync(p))
  if (found === undefined) return { ok: false, detail: `找不到 profile 文件：${profile}` }
  return { ok: true, path: found }
}

type Prepared = {
  ok: true
  root: string
  config: Config
  provider: Provider
}
type PrepareFailure = { ok: false; exitCode: number; message: string }

/** `plan` 与 `run` 共用的准备：项目根、配置、认证预检、provider */
const prepare = async (options: CliOptions): Promise<Prepared | PrepareFailure> => {
  const root = resolveProjectRoot(options.target)
  if (!root.ok) return { ok: false, exitCode: EXIT_USAGE, message: root.detail }

  const loaded = loadConfig({
    projectRoot: root.root,
    flags: {
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
      ...(options.include.length === 0 ? {} : { include: options.include }),
      ...(options.exclude.length === 0 ? {} : { exclude: options.exclude }),
    },
    env: process.env,
  })
  if (!loaded.ok) return { ok: false, exitCode: EXIT_USAGE, message: loaded.detail }

  let models: ReturnType<typeof builtinModels>
  try {
    models = builtinModels()
  } catch (e) {
    return {
      ok: false,
      exitCode: EXIT_FAILURE,
      message: `初始化模型集合失败：${e instanceof Error ? e.message : String(e)}`,
    }
  }

  // 认证预检：不发请求就发现"完全没有凭证"，而不是等第一次调用才失败。
  // 注意它**发现不了"凭证存在但被拒"**——那需要真的发一次请求。
  let auth: Awaited<ReturnType<typeof checkPiAuth>>
  try {
    auth = await checkPiAuth(models, loaded.config.model)
  } catch (e) {
    return {
      ok: false,
      exitCode: EXIT_USAGE,
      message: e instanceof Error ? e.message : String(e),
    }
  }
  if (!auth.ok) return { ok: false, exitCode: EXIT_USAGE, message: auth.detail }
  if (!options.json) err(`认证：${auth.source}\n`)

  return {
    ok: true,
    root: root.root,
    config: loaded.config,
    provider: createPiProvider({ model: loaded.config.model, models }),
  }
}

/**
 * 应用前的确认。
 *
 * 非交互终端里**不猜**：直接返回"不同意"并说明该用什么 flag。若在这里默认成同意，
 * 一次管道调用就会在无人确认的情况下改掉用户的代码——那正是最需要防的。
 */
const makeConfirmPrompt = (): (() => Promise<boolean>) => async () => {
  if (process.stdin.isTTY !== true) {
    err('当前不是交互终端，无法确认。请用 --yes 明确表示同意，或用 --dry-run 只看不写。\n')
    return false
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question('\n确认应用以上改动吗？会新建分支并逐 step 提交。[y/N] ')
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

const runPlan = async (options: CliOptions): Promise<number> => {
  const prepared = await prepare(options)
  if (!prepared.ok) {
    err(`${prepared.message}\n`)
    return prepared.exitCode
  }

  // 先解 profile：轮数的默认值取决于它有没有
  let evidence: PerformanceEvidence | undefined
  if (prepared.config.profile !== undefined) {
    const profilePath = resolveProfilePath(prepared.root, prepared.config.profile, process.cwd())
    if (!profilePath.ok) {
      err(`${profilePath.detail}\n`)
      return EXIT_USAGE
    }
    const parsed = loadCpuProfile(profilePath.path, { projectRoot: prepared.root })
    if (!parsed.ok) {
      err(`profile 解析失败（${parsed.reason}）：${parsed.detail ?? ''}\n`)
      return EXIT_FAILURE
    }
    evidence = parsed.evidence
  }

  const config = resolveConfig(prepared.config, evidence !== undefined)

  const toolbox = createToolbox({
    projectRoot: prepared.root,
    ...(config.include.length === 0 ? {} : { include: config.include }),
    ...(config.exclude.length === 0 ? {} : { exclude: config.exclude }),
  })

  const outcome = await runPlanCommand(
    {
      projectRoot: prepared.root,
      config,
      target: detectProjectTarget(prepared.root),
      ...(evidence === undefined ? {} : { evidence }),
    },
    {
      provider: prepared.provider,
      toolbox,
      // --json 时把进度压掉，否则标准输出混着进度与 JSON，没法喂给别的程序
      write: options.json ? () => {} : out,
    },
  )

  if (outcome.ok) {
    if (options.json) out(`${JSON.stringify(outcome.plan, null, 2)}\n`)
    return EXIT_OK
  }
  err(`${formatFailure(outcome)}\n`)
  return EXIT_FAILURE
}

const runRun = async (options: CliOptions): Promise<number> => {
  const root = resolveProjectRoot(options.target)
  if (!root.ok) {
    err(`${root.detail}\n`)
    return EXIT_USAGE
  }

  // **先查计划，再做认证预检**：没有计划是首次使用最常见的情形，而它比"缺凭证"
  // 更根本、也更便宜（纯本地检查）。顺序反了用户会看到一条无关的 API key 报错。
  const loaded = loadRunPlan(root.root)
  if (!loaded.ok) {
    err(`${loaded.message}\n`)
    return EXIT_USAGE
  }
  const rootCheck = checkPlanRoot(loaded.plan, root.root)
  if (!rootCheck.ok) {
    err(`${rootCheck.message}\n`)
    return EXIT_USAGE
  }
  if (loaded.plan.steps.length === 0) {
    out('\n计划里没有可执行的步骤，无需生成改动。\n')
    return EXIT_OK
  }

  const prepared = await prepare(options)
  if (!prepared.ok) {
    err(`${prepared.message}\n`)
    return prepared.exitCode
  }

  const outcome = await runRunCommand(
    {
      projectRoot: prepared.root,
      plan: loaded.plan,
      byStep: options.byStep,
      mode: options.dryRun ? 'preview' : 'apply',
      ...(options.emitPatch === undefined ? {} : { emitPatch: options.emitPatch }),
      cwd: process.cwd(),
      color: process.stdout.isTTY === true,
      confirm: options.yes ? async () => true : makeConfirmPrompt(),
      now: new Date(),
    },
    { provider: prepared.provider, write: out },
  )

  if (outcome.ok) return EXIT_OK
  err(`\n${outcome.message}\n`)
  return EXIT_FAILURE
}

const main = async (): Promise<number> => {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed.ok) {
    err(`${parsed.error}\n`)
    return EXIT_USAGE
  }

  switch (parsed.options.command) {
    case 'help':
      out(USAGE)
      return EXIT_OK
    case 'plan':
      return runPlan(parsed.options)
    case 'run':
      return runRun(parsed.options)
  }
}

// 用 exitCode 而非 process.exit()：后者会在 stdout 被管道消费时截断输出
process.exitCode = await main()
