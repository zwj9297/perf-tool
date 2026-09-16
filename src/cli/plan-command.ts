/**
 * `perf plan` 的串联逻辑。
 *
 * 依赖全部**可注入**（provider / toolbox / 输出流），所以集成这一层本身也能被测试
 * ——否则"五块代码接起来"这件事就只能靠手动跑 CLI 验证，而手动验证不会覆盖失败
 * 分支。
 *
 * `index.ts` 只负责解析参数、构造真实依赖、设置退出码。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Config } from '../config/load.js'
import type { ProjectTarget } from '../context/detect.js'
import type { PerformanceEvidence } from '../evidence/types.js'
import { runPlanLoop, type PlanLoopResult, type TraceEntry } from '../plan/loop.js'
import { buildSystemPrompt } from '../plan/prompt.js'
import type { Plan } from '../plan/schema.js'
import type { Provider } from '../providers/types.js'
import type { Toolbox } from '../tools/types.js'

export const OUTPUT_DIR = '.perf'
export const PLAN_FILE = 'plan.json'
export const TRACE_FILE = 'trace.json'

export type PlanCommandDeps = {
  provider: Provider
  toolbox: Toolbox
  write: (text: string) => void
}

export type PlanCommandInput = {
  /** **已 realpath 归一化**的项目根 */
  projectRoot: string
  /** 已落定默认值的配置 */
  config: Config
  target: ProjectTarget
  evidence?: PerformanceEvidence
}

export type PlanCommandOutcome =
  | { ok: true; plan: Plan; planPath: string; tracePath: string; rounds: number }
  | { ok: false; reason: string; message: string; tracePath?: string }

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`

/** 落盘。`rounds` / `usage` 等信息放 trace，plan 本身保持干净、可人工编辑 */
const persist = (
  projectRoot: string,
  plan: Plan,
  trace: TraceEntry[],
  meta: Record<string, unknown>,
): { planPath: string; tracePath: string } => {
  const dir = join(projectRoot, OUTPUT_DIR)
  mkdirSync(dir, { recursive: true })
  const planPath = join(dir, PLAN_FILE)
  const tracePath = join(dir, TRACE_FILE)
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
  writeFileSync(tracePath, `${JSON.stringify({ ...meta, trace }, null, 2)}\n`, 'utf8')
  return { planPath, tracePath }
}

const userMessageOf = (hasEvidence: boolean): string =>
  hasEvidence
    ? '请结合系统提示里的实测热点，探索这个项目并找出值得改的性能问题，然后用 submit_plan 交卷。'
    : '请探索这个项目并找出值得改的性能问题，然后用 submit_plan 交卷。没有实测数据时不要编造收益排序。'

const reportPlan = (write: (t: string) => void, plan: Plan, rounds: number): void => {
  write(`\n计划摘要：${plan.summary}\n`)
  if (!plan.grounded) {
    write('证据：无实测数据，本次为静态分析结论，未按收益排序\n')
  }
  write(`优化点：${plan.steps.length} 个（探索 ${rounds} 轮）\n`)

  const byRisk = { low: 0, medium: 0, high: 0 }
  for (const s of plan.steps) byRisk[s.risk]++
  write(`风险分布：低 ${byRisk.low} / 中 ${byRisk.medium} / 高 ${byRisk.high}\n`)

  if (plan.steps.length > 0) {
    write('\n')
    for (const [i, s] of plan.steps.entries()) {
      write(`${i + 1}. [${s.risk}] ${s.title}\n`)
      write(`   ${s.rationale}\n`)
      write(`   文件：${s.files.join('、')}\n`)
      if (s.expectedImpact !== undefined) write(`   预期收益：${s.expectedImpact}\n`)
    }
  }

  if (plan.caveats !== undefined && plan.caveats.length > 0) {
    write(`\n注意（模型自己标注的不确定之处）：\n`)
    for (const c of plan.caveats) write(`  - ${c}\n`)
  }

  if (plan.evidence !== undefined) {
    const e = plan.evidence
    write(
      `\n实测数据：总采样 ${e.totalSampledMs.toFixed(0)}ms，` +
        `项目代码 ${pct(e.projectShare)}，依赖 ${pct(e.dependencyShare)}，运行时 ${pct(e.engineShare)}\n`,
    )
    const top = e.hotSpots.slice(0, 3)
    for (const h of top) {
      write(`  热点 ${h.file}:${h.line} 占 ${pct(h.selfShare)}\n`)
    }
  }
}

const failureHintOf = (reason: string): string => {
  switch (reason) {
    case 'provider-failed':
      return '模型调用失败。检查认证（各家的 API key 环境变量）与网络。'
    case 'unsafe-path':
      return '模型提交的计划引用了项目外的文件，已直接终止。这可能是提示被带偏的信号，建议看一下 trace。'
    case 'budget-exhausted':
      return (
        '探索预算用完但模型没有交卷。可以用 --max-tokens / --max-rounds 放宽，' +
        '或用 --model 换一个更守规矩的模型。'
      )
    case 'no-plan':
      return '模型既没调工具也没交卷。换个模型试试。'
    default:
      return '查看 trace 了解模型看了什么。'
  }
}

export const runPlanCommand = async (
  input: PlanCommandInput,
  deps: PlanCommandDeps,
): Promise<PlanCommandOutcome> => {
  const hasEvidence = input.evidence !== undefined

  const systemPrompt = buildSystemPrompt({
    projectRoot: input.projectRoot,
    language: input.target.language,
    ...(input.target.buildSystem === undefined ? {} : { buildSystem: input.target.buildSystem }),
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    maxRounds: input.config.maxRounds,
  })

  deps.write(
    `分析 ${input.target.language} 项目（${input.target.buildSystem ?? '构建系统未知'}）：${input.projectRoot}\n`,
  )
  deps.write(
    `模型 ${input.config.model}，探索上限 ${input.config.maxRounds} 轮 / ` +
      `成本上限 ${Math.round(input.config.maxTokens / 1000)}k 输入 token，` +
      `证据：${hasEvidence ? '有实测 profile' : '无（静态分析）'}\n`,
  )
  deps.write('\n正在探索…\n')

  const result: PlanLoopResult = await runPlanLoop({
    provider: deps.provider,
    toolbox: deps.toolbox,
    systemPrompt,
    userMessage: userMessageOf(hasEvidence),
    maxRounds: input.config.maxRounds,
    maxTokens: input.config.maxTokens,
    target: input.target,
    toolContext: { projectRoot: input.projectRoot },
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
  })

  const meta = {
    model: input.config.model,
    rounds: result.rounds,
    usage: result.usage,
    ok: result.ok,
    ...(result.ok ? {} : { reason: result.reason, message: result.message }),
  }

  const paths = persist(
    input.projectRoot,
    // 失败时也写一份（空的 steps + 说明），让用户能直接看到发生了什么
    result.ok
      ? result.plan
      : {
          summary: `探索未完成：${result.message}`,
          steps: [],
          target: input.target,
          grounded: false,
        },
    result.trace,
    meta,
  )

  if (result.ok) {
    reportPlan(deps.write, result.plan, result.rounds)
    deps.write(`\n计划已写入 ${paths.planPath}\n`)
    deps.write(`轨迹已写入 ${paths.tracePath}\n`)
    deps.write('计划可人工编辑后再执行。\n')
    return {
      ok: true,
      plan: result.plan,
      planPath: paths.planPath,
      tracePath: paths.tracePath,
      rounds: result.rounds,
    }
  }

  return {
    ok: false,
    reason: result.reason,
    message: result.message,
    tracePath: paths.tracePath,
  }
}

export const formatFailure = (outcome: Extract<PlanCommandOutcome, { ok: false }>): string =>
  [
    `\n探索失败（${outcome.reason}）：${outcome.message}`,
    failureHintOf(outcome.reason),
    outcome.tracePath === undefined ? '' : `轨迹：${outcome.tracePath}`,
  ]
    .filter((l) => l !== '')
    .join('\n')
