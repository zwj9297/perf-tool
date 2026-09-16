/**
 * 工具域的类型。工具的**实现**在 `tools/` 下（尚未实现）。
 *
 * 循环只依赖这里的接口，所以整个探索循环可以只靠一个脚本化的假 toolbox 测完。
 */
import type { ProviderToolCall, ProviderToolSpec } from '../providers/types.js'

export type ToolResult = {
  /** 回填给模型的文本 */
  text: string
  /**
   * 结果被截断时为 true。
   *
   * **必须显式告诉模型**（design.md §4.2 第 1 条）：模型不知道自己被截断时，会基于
   * 残缺结果下结论，而这比直接报错更难发现。循环会把这个标记写成一句明确的提示。
   */
  truncated?: boolean
  isError?: boolean
}

export type ToolContext = {
  /**
   * 目标项目根，**已 realpath 归一化**。
   *
   * 工具用它做路径 containment 校验，且必须先 `fs.realpath` 解析符号链接再校验——
   * 否则一个指向 `/etc/passwd` 的软链就能读出去（design.md §4.2 第 2 条）。
   */
  projectRoot: string
}

export interface Toolbox {
  /** 暴露给模型的工具定义。循环由此推导"认识哪些工具" */
  specs(): readonly ProviderToolSpec[]
  /**
   * 执行一次调用。
   *
   * 实现方负责：输出上限、符号链接解析、按 JS 实现而非 shell 出去、跳过 `.env`
   * 与凭证类文件。循环只负责转发结果与记录轨迹。
   */
  run(call: ProviderToolCall, ctx: ToolContext): Promise<ToolResult>
}
