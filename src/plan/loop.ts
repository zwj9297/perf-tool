/**
 * 有界的只读探索循环（design.md D3）。
 *
 * 这个模块只管**控制流**。工具的实现在 `tools/`，提示词在 `prompt.ts`，provider
 * 在 `providers/`——所以循环可以只靠一个脚本化的假 provider + 假 toolbox 测完，
 * 不连任何真实 SDK。
 *
 * 四条控制流对应 design.md §4.2 的硬要求：
 *
 * | 要求 | 在这里 |
 * | --- | --- |
 * | 轮数上限随有无证据而变 | 上限由调用方传入（有证据时问题更具体，可以多给） |
 * | 触顶把工具集收缩为只剩 submit_plan | `wrapUp`，且额外留 `WRAP_UP_ROUNDS` 轮收尾 |
 * | 重复工具调用检测与提示 | `seen`，命中即回填缓存并明说"你已经查过" |
 * | 完整轨迹落盘 | 每次回合、工具结果、拒绝、注入的提示都进 `trace` |
 */
import type { PerformanceEvidence } from '../evidence/types.js'
import type {
  Provider,
  ProviderMessage,
  ProviderToolCall,
  ProviderUsage,
} from '../providers/types.js'
import type { ToolContext, ToolResult, Toolbox } from '../tools/types.js'

import {
  SUBMIT_PLAN,
  submitPlanTool,
  validatePlanDraft,
  type Plan,
  type PlanTarget,
} from './schema.js'

/**
 * 触顶后额外给几轮收尾。
 *
 * 没有这个上限，一个不交卷的模型可以让循环转满 `maxRounds + WRAP_UP_ROUNDS` 次之后
 * 才失败；有了它，触顶后的行为是「最多再两轮，不然就判失败」，把成本钉死。
 */
const WRAP_UP_ROUNDS = 2

export type TraceEntry =
  | {
      kind: 'round'
      round: number
      assistantText: string
      calls: ProviderToolCall[]
      usage?: ProviderUsage
    }
  | {
      kind: 'toolResult'
      toolCallId: string
      toolName: string
      text: string
      isError: boolean
      /** 这次是重复调用，命中了缓存 */
      deduped?: boolean
    }
  | { kind: 'rejected'; toolCallId: string; toolName: string; issues: string }
  | { kind: 'note'; round: number; text: string }

export type PlanLoopFailure =
  /** provider 本身失败（网络、认证、限流），不是模型说了什么 */
  | 'provider-failed'
  /** 模型试图引用项目外的文件。**不重试**，见下方说明 */
  | 'unsafe-path'
  /** 预算用完且模型仍未交卷 */
  | 'rounds-exhausted'
  /** 模型不调工具也不交卷（催过一次仍然如此） */
  | 'no-plan'

export type PlanLoopResult =
  | { ok: true; plan: Plan; trace: TraceEntry[]; rounds: number; usage: ProviderUsage }
  | {
      ok: false
      reason: PlanLoopFailure
      message: string
      trace: TraceEntry[]
      rounds: number
      usage: ProviderUsage
    }

export type PlanLoopOptions = {
  provider: Provider
  toolbox: Toolbox
  systemPrompt: string
  /** 首条用户消息 */
  userMessage: string
  /** 探索轮数上限。调用方按有无证据决定 */
  maxRounds: number
  /** 补全 `Plan` 用；不作为模型输出的一部分，见 schema.ts 的说明 */
  target: PlanTarget
  toolContext: ToolContext
  evidence?: PerformanceEvidence
}

/** 参数键序无关的稳定序列化，否则同一调用换个键序就不算重复 */
const stableStringify = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(',')}}`
}

const dedupeKeyOf = (call: ProviderToolCall): string =>
  `${call.name}(${stableStringify(call.arguments)})`

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const runPlanLoop = async (options: PlanLoopOptions): Promise<PlanLoopResult> => {
  const toolSpecs = options.toolbox.specs()
  const knownTools = new Set(toolSpecs.map((t) => t.name))
  const submitSpec = {
    name: submitPlanTool.name,
    description: submitPlanTool.description,
    parameters: submitPlanTool.parameters,
  }

  const messages: ProviderMessage[] = [{ role: 'user', text: options.userMessage }]
  const trace: TraceEntry[] = []
  /** 去重缓存：调用签名 → 上次的结果文本 */
  const seen = new Map<string, string>()
  let usage: ProviderUsage = { inputTokens: 0, outputTokens: 0 }
  let rounds = 0
  let wrapUp = false
  let nudged = false

  const fail = (reason: PlanLoopFailure, message: string): PlanLoopResult => ({
    ok: false,
    reason,
    message,
    trace,
    rounds,
    usage,
  })

  while (rounds < options.maxRounds + WRAP_UP_ROUNDS) {
    rounds++

    const turn = await options.provider.turn({
      systemPrompt: options.systemPrompt,
      messages,
      // 触顶后把工具集收缩为只剩 submit_plan。这比追加一句自然语言提示更强硬，
      // 且不依赖任何 provider 特性（design.md §3.2）。
      tools: wrapUp ? [submitSpec] : [...toolSpecs, submitSpec],
    })

    if (turn.kind === 'failed') return fail('provider-failed', turn.message)

    if (turn.usage !== undefined) {
      usage = {
        inputTokens: usage.inputTokens + turn.usage.inputTokens,
        outputTokens: usage.outputTokens + turn.usage.outputTokens,
      }
    }

    // 先收窄：`kind: 'text'` 没有 calls 字段，直接用 turn.calls 过不了类型检查
    const calls = turn.kind === 'tools' ? turn.calls : []

    trace.push({
      kind: 'round',
      round: rounds,
      assistantText: turn.text,
      calls,
      usage: turn.usage,
    })

    // raw 原样透传：pi-ai 的 AssistantMessage 带 api/provider/model 等字段，
    // 我们重建不出一个合法的，硬凑会发出一条悄悄错误的请求。
    messages.push({ role: 'assistant', text: turn.text, calls, raw: turn.raw })

    if (calls.length === 0) {
      if (wrapUp) {
        return fail('rounds-exhausted', `探索预算（${options.maxRounds} 轮）用完，且模型没有交卷`)
      }
      if (nudged) {
        return fail('no-plan', `模型连续两轮既没调用工具也没调用 ${SUBMIT_PLAN}`)
      }
      nudged = true
      const note = `请调用 \`${SUBMIT_PLAN}\` 提交计划；如果你还需要信息，也可以继续用工具。`
      trace.push({ kind: 'note', round: rounds, text: note })
      messages.push({ role: 'user', text: note })
      continue
    }

    let submitted: Plan | undefined

    for (const call of calls) {
      if (call.name === SUBMIT_PLAN) {
        const validation = validatePlanDraft(call.arguments)
        if (validation.ok) {
          const draft = validation.draft
          submitted = {
            ...draft,
            target: options.target,
            // grounded 由证据是否存在决定，不由模型自称
            grounded: options.evidence !== undefined,
          }
          if (options.evidence !== undefined) submitted.evidence = options.evidence
          break // 同一轮里 submit 之后的调用不再处理，也不需要回填：循环到此结束
        }

        trace.push({
          kind: 'rejected',
          toolCallId: call.id,
          toolName: call.name,
          issues: validation.issues,
        })

        // 路径越界**不重试**：这不是"格式写错了"，而是模型在引用项目外的文件。
        // 重试只是祈祷它下次不这样，而它可能是被提示注入之类的东西带偏了。
        if (validation.kind === 'unsafe-path') return fail('unsafe-path', validation.issues)

        messages.push({
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          text: `计划未通过校验：${validation.issues}`,
          isError: true,
        })
        continue
      }

      if (wrapUp) {
        const note = `探索预算已用完，现在只能调用 \`${SUBMIT_PLAN}\`。请立即提交计划。`
        trace.push({ kind: 'rejected', toolCallId: call.id, toolName: call.name, issues: note })
        messages.push({
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          text: note,
          isError: true,
        })
        continue
      }

      if (!knownTools.has(call.name)) {
        const note = `没有名为 ${call.name} 的工具。可用的有：${[...knownTools, SUBMIT_PLAN].join('、')}`
        trace.push({ kind: 'rejected', toolCallId: call.id, toolName: call.name, issues: note })
        messages.push({
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          text: note,
          isError: true,
        })
        continue
      }

      const key = dedupeKeyOf(call)
      const cached = seen.get(key)
      if (cached !== undefined) {
        const note = `你已经查过这个（${call.name}），结果同上，不再重复返回：\n${cached}`
        trace.push({
          kind: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          text: note,
          isError: false,
          deduped: true,
        })
        messages.push({
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          text: note,
          isError: false,
        })
        continue
      }

      let result: ToolResult
      try {
        result = await options.toolbox.run(call, options.toolContext)
      } catch (e) {
        result = { text: `工具执行失败：${messageOf(e)}`, isError: true }
      }

      const isError = result.isError === true
      // 截断必须显式告诉模型：它不知道自己被截断时会基于残缺结果下结论，
      // 这比报错更难发现（design.md §4.2 第 1 条）。
      const text =
        result.truncated === true
          ? `${result.text}\n\n[结果已被截断，这里只有开头部分。请缩小范围或改用更精确的查询。]`
          : result.text

      seen.set(key, text)
      trace.push({ kind: 'toolResult', toolCallId: call.id, toolName: call.name, text, isError })
      messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        text,
        isError,
      })
    }

    if (submitted !== undefined) {
      return { ok: true, plan: submitted, trace, rounds, usage }
    }

    if (!wrapUp && rounds >= options.maxRounds) {
      wrapUp = true
      const note =
        `探索预算（${options.maxRounds} 轮）已用完。从现在起只能调用 \`${SUBMIT_PLAN}\`。` +
        `请基于已掌握的信息立即提交计划，并在 caveats 里说明哪些判断因此缺乏依据。`
      trace.push({ kind: 'note', round: rounds, text: note })
      messages.push({ role: 'user', text: note })
    }
  }

  return fail(
    'rounds-exhausted',
    `探索预算用完（上限 ${options.maxRounds} 轮 + ${WRAP_UP_ROUNDS} 轮收尾）`,
  )
}
