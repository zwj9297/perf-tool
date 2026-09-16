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
 * | 成本上有上限 | `maxTokens`（未命中缓存的输入）与 `maxRounds` 互补，谁先到取决于仓库规模 |
 * | 触顶把工具集收缩为只剩 submit_plan | `wrapUp`；收尾额度 `WRAP_UP_ROUNDS` 轮，**从触发那一刻算起** |
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
  /** 预算用完（轮数或 token，哪一个先到）且模型仍未交卷 */
  | 'budget-exhausted'
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
  /**
   * 探索轮数上限。**这是廉价兜底，不是主要上限**——主要上限是 `maxTokens`。
   *
   * 一个失败得很便宜的模型（每次都只读几行、上下文很小）需要它来兜住；但正常情况
   * 下 token 会先到顶。
   */
  maxRounds: number
  /**
   * 累计**输入** token 上限。
   *
   * **这里的「输入」是未命中缓存的那部分。** pi-ai 的 `usage.input` 不含 cacheRead
   * （缓存部分另计）。实测佐证：一次 18 轮运行里每轮的 input 是
   * 1545 / 307 / 10016 / … / 169 / 160 / 258——**非单调、且末轮极小**。若它是"重发的
   * 累积上下文"，就该单调递增。所以前缀被 provider 缓存了，只有新内容算作 input。
   *
   * 这反而让它更适合当成本上限：它量的是**新读进来的内容**。缓存命中的部分便宜得多，
   * 不该按全价计入。副作用是同一个预算在不支持缓存的 provider 上会更早用尽（那里
   * input 就是完整 prompt）——而那恰好是安全的方向。
   *
   * **它与 `maxRounds` 是互补的，谁先到取决于仓库**：小仓库上每轮新内容少，轮数兜底
   * 会先到；大仓库上每轮读进来的文件更大，token 预算会先到。不要把它想成"token 总是
   * 主上限"——那要看规模。（这一点我最初写错了：我以为 input 是总上下文、随轮数平方
   * 增长，于是推出"token 必然先到"。实测否掉了这个推论。）
   */
  maxTokens: number
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
  /** 是哪一条上限触发的收尾。进提示、进轨迹、也进最终失败原因 */
  let wrapUpReason: 'rounds' | 'tokens' | undefined
  /** 收尾从第几轮开始。收尾额度从那一刻算起，见 roundLimit */
  let wrapUpRound: number | undefined
  let nudged = false

  /**
   * 本轮之后还能不能再跑。
   *
   * **收尾额度必须从触发收尾那一刻算起，不能写成 `maxRounds + WRAP_UP_ROUNDS`。**
   * 那个写法在轮数触发时恰好等价（`maxRounds + 2` 就是收尾额度），但 token 提前
   * 触顶时就成了「最多再跑 maxRounds 轮」——例如 maxRounds=50 而 token 在第 2 轮
   * 就用尽，收尾阶段能拖到第 52 轮。这是加 token 触发时引出的真 bug。
   */
  const roundLimit = (): number =>
    wrapUpRound === undefined ? options.maxRounds + WRAP_UP_ROUNDS : wrapUpRound + WRAP_UP_ROUNDS

  const beginWrapUp = (reason: 'rounds' | 'tokens'): void => {
    wrapUp = true
    wrapUpReason = reason
    wrapUpRound = rounds
    const note =
      reason === 'rounds'
        ? `探索轮数已达上限（${options.maxRounds} 轮）。从现在起只能调用 \`${SUBMIT_PLAN}\`。` +
          `请基于已掌握的信息立即提交计划，并在 caveats 里说明哪些判断因此缺乏依据。`
        : `本次探索的成本已达上限（累计输入约 ${Math.round(options.maxTokens / 1000)}k token）。` +
          `从现在起只能调用 \`${SUBMIT_PLAN}\`。` +
          `请基于已掌握的信息立即提交计划，并在 caveats 里说明哪些判断因此缺乏依据。`
    trace.push({ kind: 'note', round: rounds, text: note })
    messages.push({ role: 'user', text: note })
  }

  const fail = (reason: PlanLoopFailure, message: string): PlanLoopResult => ({
    ok: false,
    reason,
    message,
    trace,
    rounds,
    usage,
  })

  while (rounds < roundLimit()) {
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
        return fail(
          'budget-exhausted',
          `探索预算已用完（${wrapUpReason === 'tokens' ? 'token' : '轮数'}先到顶），且模型没有交卷`,
        )
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

    if (!wrapUp) {
      // 轮数是廉价兜底，token 才是主要上限——两者都查，谁先到算谁
      if (rounds >= options.maxRounds) beginWrapUp('rounds')
      else if (usage.inputTokens >= options.maxTokens) beginWrapUp('tokens')
    }
  }

  return fail(
    'budget-exhausted',
    wrapUpReason === 'tokens'
      ? `成本上限已用完（累计输入超过 ${Math.round(options.maxTokens / 1000)}k token，另给了 ${WRAP_UP_ROUNDS} 轮收尾）`
      : `探索轮数已用完（上限 ${options.maxRounds} 轮，另给了 ${WRAP_UP_ROUNDS} 轮收尾）`,
  )
}
