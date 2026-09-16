/**
 * LLM 的窄接口：**一个回合**。
 *
 * 循环写在 `plan/`，不在这里（design.md §2.5）。这条分层的实际价值是：整个探索
 * 循环可以只靠一个脚本化的假 provider 测完，**不需要连任何真实 SDK**。
 *
 * 这些形状是照着 pi-ai 的词汇设计的（`toolCall` / `toolResult` / `stopReason` 的
 * 语义），所以 `providers/pi.ts` 的适配是机械的。但本文件**不 import pi-ai 除了
 * `TSchema` 类型以外的东西**——它必须能在没有 pi-ai 的情况下被测试引用。
 */
import type { TSchema } from '@earendil-works/pi-ai'

export type ProviderToolSpec = {
  name: string
  description: string
  parameters: TSchema
}

export type ProviderToolCall = {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/**
 * `raw` 是给 provider 自己回放用的不透明字段。
 *
 * 存在的理由：pi-ai 的 `AssistantMessage` 带 `api` / `provider` / `model` / `usage` /
 * `stopReason` 等字段，我们**无法从归一化形式凭空重建**一个合法的助手消息。所以
 * 把它原样透传回来，适配层回放时直接用。
 *
 * 假 provider 忽略它；循环只需要原样存回去，不需要理解它。
 */
export type ProviderMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; calls: ProviderToolCall[]; raw?: unknown }
  | { role: 'toolResult'; toolCallId: string; toolName: string; text: string; isError: boolean }

export type ProviderConversation = {
  systemPrompt: string
  messages: ProviderMessage[]
  tools: ProviderToolSpec[]
}

export type ProviderUsage = { inputTokens: number; outputTokens: number }

export type ProviderTurn =
  /** 模型要调工具，循环继续 */
  | { kind: 'tools'; calls: ProviderToolCall[]; text: string; usage?: ProviderUsage; raw?: unknown }
  /** 模型没有要调的工具了（说了话或直接收尾） */
  | { kind: 'text'; text: string; usage?: ProviderUsage; raw?: unknown }
  /** 调用本身失败（网络、认证、限流……），不是模型说了什么 */
  | { kind: 'failed'; message: string }

export interface Provider {
  turn(conversation: ProviderConversation): Promise<ProviderTurn>
}
