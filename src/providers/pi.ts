/**
 * `@earendil-works/pi-ai` 适配层。
 *
 * **这是适配层，不是抽象层。** pi-ai 已经提供了跨 provider 的抽象（工具定义、工具
 * 调用、工具结果回填、认证解析全部统一），自建第二层只会造成同一份契约的两份定义。
 * 本文件的职责仅有三项：配置 → Models 集合的构造、认证预检、把 pi-ai 的 API
 * 收敛到一个文件里。
 *
 * ## 与 README 的出入（实测 v0.85.1）
 *
 * pi-ai 的 README 示例在这个版本**部分不成立**，照抄会编译不过：
 *
 * - `Type` / `Static` / `TSchema` 确实从根导出 ✓
 * - `StringEnum` **不在根**，得从 `@earendil-works/pi-ai/utils/typebox-helpers` 引
 * - `validateToolCall` **不在根**，得从 `@earendil-works/pi-ai/utils/validation` 引
 *
 * 包是 **ESM-only**（没有 CJS 出口），`require()` 会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
 */
import {
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type Tool,
  type ToolCall,
} from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'

import type {
  Provider,
  ProviderConversation,
  ProviderMessage,
  ProviderToolCall,
  ProviderTurn,
  ProviderUsage,
} from './types.js'

type ModelsCollection = ReturnType<typeof builtinModels>

/** pi-ai 的 `Usage` 比我们需要的丰富，只取两个数 */
const toUsage = (msg: AssistantMessage): ProviderUsage | undefined => {
  const u = msg.usage
  if (u === undefined) return undefined
  return { inputTokens: u.input, outputTokens: u.output }
}

const toToolCall = (c: ToolCall): ProviderToolCall => ({
  id: c.id,
  name: c.name,
  arguments: c.arguments,
})

/** 助手消息可能同时带文本与工具调用，这里只取文本部分 */
const textOf = (msg: AssistantMessage): string =>
  msg.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')

const fromAssistant = (msg: AssistantMessage): ProviderTurn => {
  const usage = toUsage(msg)

  if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
    return { kind: 'failed', message: msg.errorMessage ?? `模型返回 ${msg.stopReason}` }
  }

  const text = textOf(msg)
  const calls = msg.content.filter((b): b is ToolCall => b.type === 'toolCall').map(toToolCall)
  if (calls.length > 0) return { kind: 'tools', calls, text, usage, raw: msg }
  return { kind: 'text', text, usage, raw: msg }
}

const toPiMessages = (messages: readonly ProviderMessage[]): Message[] =>
  messages.map((m): Message => {
    if (m.role === 'user') {
      return { role: 'user', content: m.text, timestamp: Date.now() }
    }
    if (m.role === 'toolResult') {
      return {
        role: 'toolResult',
        toolCallId: m.toolCallId,
        toolName: m.toolName,
        content: [{ type: 'text', text: m.text }],
        isError: m.isError,
        timestamp: Date.now(),
      }
    }
    // assistant 必须回放 pi-ai 的原始消息：`AssistantMessage` 要求 api / provider /
    // model / usage / stopReason，我们无法凭空重建一个合法的。硬凑一个占位值会发出
    // 一条**悄悄错误**的请求，比直接报错难查得多。
    if (m.raw === undefined) {
      throw new Error(
        'pi-ai 适配层要求 assistant 消息带 raw（由上一次 turn 返回）。缺失说明调用方自己构造了助手消息',
      )
    }
    return m.raw as AssistantMessage
  })

/** 解析 `provider/modelId`，失败时给出可操作的报错 */
export const resolvePiModel = (models: ModelsCollection, spec: string): Model<Api> => {
  const slash = spec.indexOf('/')
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(`模型标识应形如 "provider/modelId"，实际收到 ${JSON.stringify(spec)}`)
  }
  const provider = spec.slice(0, slash)
  const id = spec.slice(slash + 1)
  const model = models.getModel(provider, id)
  if (model === undefined) {
    throw new Error(`找不到模型 ${provider}/${id}。用 pi-ai 的模型目录确认 provider 与 id`)
  }
  return model
}

export type PiProviderOptions = {
  /** 形如 `anthropic/claude-sonnet-5`。斜杠前是 pi-ai 的 provider id */
  model: string
  /** 注入自定义的 Models 集合（测试或自建 provider），默认用全部内置 provider */
  models?: ModelsCollection
}

export const createPiProvider = (options: PiProviderOptions): Provider => {
  const models = options.models ?? builtinModels()
  const model = resolvePiModel(models, options.model)

  return {
    turn: async (conversation: ProviderConversation): Promise<ProviderTurn> => {
      const tools: Tool[] = conversation.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }))

      let response: AssistantMessage
      try {
        response = await models.complete(model, {
          systemPrompt: conversation.systemPrompt,
          messages: toPiMessages(conversation.messages),
          tools,
        })
      } catch (e) {
        // 认证缺失、网络、限流都从这里出来。包装成 failed 而不是让异常穿出去，
        // 循环才能统一处置（design.md §2.8 的两类失败）。
        return { kind: 'failed', message: e instanceof Error ? e.message : String(e) }
      }
      return fromAssistant(response)
    },
  }
}

export type AuthCheck = { ok: true; source: string } | { ok: false; detail: string }

/**
 * 认证预检。**不发请求**，缺 key 时给出明确报错而不是等到第一次调用才失败。
 *
 * 对应 `CLAUDE.md` 里"硬性前置条件不满足时要明确报错而非静默降级"那条。返回
 * 判别结果而不是字符串，调用方才能据此设退出码——从字符串里认关键字是脆的。
 *
 * 模型标识本身非法时直接抛错（那是用法错误，不是运行期状态）。
 */
export const checkPiAuth = async (models: ModelsCollection, spec: string): Promise<AuthCheck> => {
  const model = resolvePiModel(models, spec)
  const auth = await models.getAuth(model)
  if (auth === undefined) {
    return {
      ok: false,
      detail:
        `模型 ${spec} 未配置认证。请提供该 provider 对应的环境变量` +
        `（如 ANTHROPIC_API_KEY、OPENAI_API_KEY、DEEPSEEK_API_KEY）`,
    }
  }
  // `source` 是可选的：有些 provider 解析到了认证但不报来源
  return { ok: true, source: auth.source ?? 'provider 默认解析' }
}
