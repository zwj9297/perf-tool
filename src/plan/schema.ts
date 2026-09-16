/**
 * `Plan` 的 schema 与校验。
 *
 * ## Plan 分两层，这不是洁癖
 *
 * - **`PlanDraft`**：模型通过 `submit_plan` 提交的东西。只有 `summary` / `caveats` /
 *   `steps`。
 * - **`Plan`**：完整契约，额外带 `target` / `grounded` / `evidence`——这三样**由我们
 *   补全**，不经过模型。
 *
 * 理由：`target` 来自我们对目标项目的探测，`grounded` 与 `evidence` 来自
 * `evidence/` 的解析结果。让模型提交它们，等于让它**编造**它无从知道的事实；而
 * 一个把 `grounded: true` 写在没有证据的计划里的模型，恰好会摧毁这套 evidence
 * 机制的全部可信度——「有数据」和「没数据」的行为分叉（design.md 的跨模块约束）
 * 就此失效。
 *
 * ## 一份 schema 两用
 *
 * `submitPlanTool.parameters` 既是喂给 provider 的工具定义，也是校验用的 schema。
 * 这就是 `CLAUDE.md` 里"同一份 schema 既喂给 provider 也用于运行时校验"的落点。
 */
import { Type, type Static, type Tool, type ToolCall, type TSchema } from '@earendil-works/pi-ai'
import { StringEnum } from '@earendil-works/pi-ai/utils/typebox-helpers'
import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation'

import type { PerformanceEvidence } from '../evidence/types.js'

/** 模型用它交卷。循环的终止条件之一就是「模型调用了它」 */
export const SUBMIT_PLAN = 'submit_plan'

/**
 * 枚举必须用 `StringEnum` 而不是 `Type.Enum`——后者生成 `anyOf` / `const` 结构，
 * Google 的 API 不支持。`as const` 是为了保住字面量类型，否则 `Static` 只会得到
 * `string`，枚举的约束在类型层面就丢了。
 */
export const StepSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    rationale: Type.String({ minLength: 1, description: '为什么这里判定为瓶颈' }),
    files: Type.Array(Type.String(), {
      minItems: 1,
      description: '相对目标项目根的路径',
    }),
    kind: StringEnum(['refactor', 'algorithmic', 'config', 'dependency', 'other'] as const),
    risk: StringEnum(['low', 'medium', 'high'] as const),
    expectedImpact: Type.Optional(
      Type.String({ description: '仅在有实测证据时给出；没有证据时留空' }),
    ),
  },
  { additionalProperties: false },
)

export const PlanDraftSchema = Type.Object(
  {
    summary: Type.String({ minLength: 1 }),
    caveats: Type.Optional(
      Type.Array(Type.String(), {
        description: '哪些判断缺乏依据。探索触顶或信息不足时必填',
      }),
    ),
    steps: Type.Array(StepSchema),
  },
  { additionalProperties: false },
)

export type Step = Static<typeof StepSchema>
export type PlanDraft = Static<typeof PlanDraftSchema>

export type PlanTarget = {
  root: string
  language: string
  buildSystem?: string
}

/** 完整契约。`evidence` / `grounded` / `target` 由我们补全，见文件头说明 */
export type Plan = PlanDraft & {
  target: PlanTarget
  grounded: boolean
  evidence?: PerformanceEvidence
}

export const submitPlanTool: Tool = {
  name: SUBMIT_PLAN,
  description:
    '提交最终的优化计划。探索完成后调用它收尾。计划应只包含能从证据或代码中支撑的判断；' +
    '没有实测数据时不要给出收益排序（省略 expectedImpact），并在 caveats 里说明哪些判断缺乏依据。',
  parameters: PlanDraftSchema,
  // `prefer` 而非 `require`：strict JSON-schema 支持目前限于部分 provider，
  // 而本项目的主要用户可能在用 OpenAI 兼容端点。真正的保证是下面的本地校验。
  constrainedSampling: { type: 'json_schema', strict: 'prefer' },
}

export type PlanValidationFailure =
  { ok: false; kind: 'schema'; issues: string } | { ok: false; kind: 'unsafe-path'; issues: string }

export type PlanValidation = { ok: true; draft: PlanDraft } | PlanValidationFailure

/** 相对路径必须留在项目根内。拒绝绝对路径与 `..` 越界 */
const unsafePathOf = (files: readonly string[]): string | undefined =>
  files.find(
    (f) => f.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(f) || f.split(/[\\/]/).includes('..'),
  )

/**
 * 校验模型提交的 plan。
 *
 * 分两类失败是有意的——调用方对它们的处置不同：
 *
 * - `schema`：结构不合规。把 issues 作为错误回填给模型，让它修。
 * - `unsafe-path`：路径越界。这**不是**模型格式写错了，而是它试图引用项目外的文件，
 *   必须直接拒绝，不能靠重试"祈祷下次不这样"。
 *
 * 也不吞异常：`validateToolArguments` 靠抛错表示失败，这里转成返回值，因为调用方
 * 是循环，不该用 try/catch 做正常流程控制。
 */
export const validatePlanDraft = (rawArguments: unknown): PlanValidation => {
  const call: ToolCall = {
    type: 'toolCall',
    id: 'validate',
    name: SUBMIT_PLAN,
    arguments: (rawArguments ?? {}) as Record<string, unknown>,
  }

  let draft: PlanDraft
  try {
    draft = validateToolArguments(submitPlanTool as Tool<TSchema>, call) as PlanDraft
  } catch (e) {
    return { ok: false, kind: 'schema', issues: e instanceof Error ? e.message : String(e) }
  }

  const unsafe = draft.steps.map((s) => unsafePathOf(s.files)).find((p) => p !== undefined)
  if (unsafe !== undefined) {
    return {
      ok: false,
      kind: 'unsafe-path',
      issues: `step 引用了项目外的路径 ${JSON.stringify(unsafe)}。files 必须是相对项目根且不含 .. 的路径`,
    }
  }

  return { ok: true, draft }
}
