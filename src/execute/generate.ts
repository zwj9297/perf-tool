/**
 * 逐 step 生成具体改动（D1 派生设计 §2.2、§2.4、§2.8）。
 *
 * 每个 step 单独一次模型调用，改动以 unified diff 提交。生成按序叠加到 overlay 上，
 * 所以 step N 的模型看到的是「前 N-1 步已生效」的内容——这正是设计要的预测态。
 *
 * **失败隔离**：某个 step 生成失败不会带走整个计划（D1 的理由之一）。它记进
 * `skipped`，其余 step 继续。
 *
 * ## 重试是常规路径，不是异常分支
 *
 * `not-found` / `ambiguous` 会**频繁**发生（§2.8）：`fuzzFactor` 不可依赖（实测空白
 * 差异下 1、2 都失败），所以模型的上下文行必须逐字匹配，而 LLM 输出常有细微差异。
 * 因此重试逻辑写在这里，按常规路径的标准做：限次、把失败原因回填、耗尽后有明确降级。
 *
 * ## 已知限制：这一步没有工具
 *
 * 模型只能看到 `step.files` 的内容，不能自己再读别的文件。plan 阶段有完整的只读
 * 工具集，execute 阶段暂时没有——因为它的输出是 diff 而不是探索，多一个循环会让
 * 这块复杂不少。**给 execute 也接上只读工具是自然的下一步增强**，尤其是当 step
 * 需要参考调用点时。
 */
import { Type, type Tool } from '@earendil-works/pi-ai'

import { applyPatchToContent, splitByFile } from '../diff/apply.js'
import type { Plan, Step } from '../plan/schema.js'
import type { Provider, ProviderMessage, ProviderUsage } from '../providers/types.js'

import { createOverlay, resolvePatchPath, type Overlay, type OverlayFile } from './overlay.js'

export const SUBMIT_EDIT = 'submit_edit'
export const SKIP_STEP = 'skip_step'

const MAX_ATTEMPTS = 3
/** 单个文件喂给模型的行数上限。超了要明说，否则模型会在看不到的区域写出错的锚点 */
const MAX_FILE_LINES = 2000

export const submitEditTool: Tool = {
  name: SUBMIT_EDIT,
  description:
    '提交这一步的具体改动，用 unified diff 表达。diff 里的上下文行必须与给定内容**逐字一致**' +
    '（含缩进与空白），否则无法定位。请只改这一步需要的部分，不要顺带改动无关代码。',
  parameters: Type.Object(
    {
      patch: Type.String({
        description:
          'unified diff。以 `--- 路径` 与 `+++ 路径` 开头（路径用相对项目根的形式，不要 a/ b/ 前缀），' +
          '然后是 `@@` 块。上下文行宁可多给几行——少了会在重复代码里定位到错的地方。',
      }),
      note: Type.Optional(Type.String({ description: '可选：这次改动的简要说明' })),
    },
    { additionalProperties: false },
  ),
  constrainedSampling: { type: 'json_schema', strict: 'prefer' },
}

/**
 * 显式的"这一步不用改"。
 *
 * 存在的理由：提示词允许模型判定某个 step 不成立，但**不能用"它回了文本而没调工具"
 * 来推断这件事**——那与"它没按格式输出"无法区分。早先的版本就是那么做的，结果是
 * 模型老老实实解释"这里不需要改"，循环却当成失败去重试，逻辑上自相矛盾。
 *
 * 有了它，三种情形互不混淆：提交 diff / 明确跳过 / 没遵守格式（重试）。
 */
export const skipStepTool: Tool = {
  name: SKIP_STEP,
  description:
    '声明这一步不需要改动，并说明理由。仅在你确实判断这个优化点不成立时使用；' +
    '如果只是暂时写不出正确的 diff，不要用它。',
  parameters: Type.Object(
    { reason: Type.String({ minLength: 1, description: '为什么这一步不需要改动' }) },
    { additionalProperties: false },
  ),
  constrainedSampling: { type: 'json_schema', strict: 'prefer' },
}

export type StepEdit = {
  stepId: string
  title: string
  /** 进 commit message：那是"为什么改"唯一会被长期保留的地方 */
  rationale: string
  patch: string
  files: string[]
  attempts: number
  /**
   * 这一步结束时，它触及的每个文件的内容。
   *
   * 逐 step commit 需要它：overlay 只保留**最终**态，而每个 commit 要的是该步之后
   * 的中间态。若某文件被后面的 step 又改过，最终态就还原不出这一步的样子了。
   */
  snapshot: { rel: string; content: string }[]
}
export type StepSkipped = { stepId: string; title: string; reason: string; attempts: number }

export type GenerateOptions = {
  provider: Provider
  /** **已 realpath 归一化**的项目根 */
  projectRoot: string
  plan: Plan
  maxAttempts?: number
  /** 进度回调，用于 CLI 输出 */
  onProgress?: (text: string) => void
}

export type GenerateResult = {
  edits: StepEdit[]
  skipped: StepSkipped[]
  /** 叠加结束后的最终状态，供预览算「原始 → 最终」 */
  merged: OverlayFile[]
  usage: ProviderUsage
  /** patch 头带了 git 前缀、被自动剥掉的文件（会在报告里提示） */
  strippedPrefixes: string[]
  /** 只有 provider 本身失败时才为真；单步失败不算 */
  providerFailed: boolean
  error?: string
}

const LINE_CAP_NOTE = (rel: string, shown: number, total: number): string =>
  `\n…（${rel} 共 ${total} 行，这里只给了前 ${shown} 行。` +
  `若你要改的部分不在这段里，请说明需要先查看完整文件，不要凭猜测写 diff）`

/** 带行号的文件内容。行号是模型写 diff 时的定位依据 */
const renderFile = (rel: string, content: string): string => {
  const lines = content.split('\n')
  const shown = lines.slice(0, MAX_FILE_LINES)
  const numbered = shown.map((l, i) => `${String(i + 1).padStart(6)}| ${l}`).join('\n')
  const suffix =
    lines.length > MAX_FILE_LINES ? LINE_CAP_NOTE(rel, MAX_FILE_LINES, lines.length) : ''
  return `### ${rel}\n\`\`\`\n${numbered}\n\`\`\`${suffix}`
}

const systemPromptOf = (projectRoot: string): string =>
  [
    `你是代码优化执行者，正在修改位于 ${projectRoot} 的项目。`,
    ``,
    `用户已经审阅并同意了下面的优化计划。你的任务是为**其中指定的那一步**产出具体改动。`,
    ``,
    `要求：`,
    `- 用 \`${SUBMIT_EDIT}\` 提交一个 unified diff。`,
    `- diff 的上下文行必须与给定内容**逐字一致**，包括缩进和空白。`,
    `- 上下文行**宁多勿少**：重复代码里上下文太少会定位到错的位置，那比失败更糟。`,
    `- 只做这一步需要的改动。不要顺带重构、不要修无关的格式。`,
    `- 如果你判断这一步实际上不需要改动（优化点不成立），用 \`${SKIP_STEP}\` 说明理由，不要提交 diff。`,
    `- 二者必须选一个：每次回复都要调用 \`${SUBMIT_EDIT}\` 或 \`${SKIP_STEP}\` 中的一个。`,
  ].join('\n')

const userMessageOf = (plan: Plan, step: Step, overlay: Overlay): string => {
  const rendered = step.files
    .map((f) => {
      try {
        return renderFile(f, overlay.current(f))
      } catch {
        // 文件读不出来（生成期间被删了等），如实说，别让模型对着空内容编 diff
        return `### ${f}\n（读不到这个文件，可能已不存在）`
      }
    })
    .join('\n\n')

  const impact = step.expectedImpact === undefined ? '' : `\n预期收益：${step.expectedImpact}`

  return [
    `计划总述：${plan.summary}`,
    ``,
    `## 要执行的这一步`,
    `标题：${step.title}`,
    `原因：${step.rationale}`,
    `类型：${step.kind} / 风险：${step.risk}${impact}`,
    `涉及文件：${step.files.join('、')}`,
    ``,
    `## 这些文件的当前内容`,
    rendered,
    ``,
    `请针对这一步产出 diff，并用 \`${SUBMIT_EDIT}\` 提交。`,
  ].join('\n')
}

type AttemptOutcome =
  { ok: true; patch: string; files: string[]; stripped: string[] } | { ok: false; reason: string }

/**
 * 试一次：把 patch 拆成按文件段，逐段在**暂存区**上应用，全成功才写回 overlay。
 *
 * 暂存是必须的：多文件段的 patch 若只应用了一半就失败，overlay 会被污染，而后面
 * 每个 step 都基于这个坏状态生成。
 */
const attemptApply = (patchText: string, projectRoot: string, overlay: Overlay): AttemptOutcome => {
  const sections = splitByFile(patchText)
  if (sections.length === 0) {
    return { ok: false, reason: '没有解析出任何文件段（是否缺少 `---` / `+++` 头？）' }
  }

  const staged = new Map<string, string>()
  const stripped: string[] = []

  for (const section of sections) {
    const resolved = resolvePatchPath(projectRoot, section.to)
    if (!resolved.ok) {
      return { ok: false, reason: `路径无法解析：${resolved.detail}` }
    }
    if (resolved.strippedGitPrefix) stripped.push(resolved.rel)

    const base = staged.get(resolved.rel) ?? overlay.current(resolved.rel)
    const applied = applyPatchToContent(base, section.patch)
    if (!applied.ok) {
      const detail = applied.matches === undefined ? '' : `（命中 ${applied.matches} 处）`
      return {
        ok: false,
        reason:
          applied.reason === 'not-found'
            ? `上下文在目标里找不到${detail}。请核对上下文行是否与给定内容逐字一致，并多给几行上下文`
            : applied.reason === 'ambiguous'
              ? `上下文命中多处，无法确定改哪一处${detail}。请增加上下文行，把位置唯一确定下来`
              : `无法应用（${applied.reason}）：${applied.detail ?? ''}`,
      }
    }
    staged.set(resolved.rel, applied.content)
  }

  for (const [rel, content] of staged) overlay.commit(rel, content)
  return { ok: true, patch: patchText, files: [...staged.keys()].sort(), stripped }
}

export const generateEdits = async (options: GenerateOptions): Promise<GenerateResult> => {
  const overlay = createOverlay(options.projectRoot)
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS
  const systemPrompt = systemPromptOf(options.projectRoot)

  const edits: StepEdit[] = []
  const skipped: StepSkipped[] = []
  const strippedPrefixes = new Set<string>()
  let usage: ProviderUsage = { inputTokens: 0, outputTokens: 0 }
  let providerFailed = false
  let error: string | undefined

  for (const [index, step] of options.plan.steps.entries()) {
    options.onProgress?.(`\n[${index + 1}/${options.plan.steps.length}] ${step.title}\n`)

    let done = false
    let attempts = 0
    let lastReason = '未尝试'

    while (!done && attempts < maxAttempts && !providerFailed) {
      attempts++
      const retryNote =
        attempts === 1
          ? ''
          : `\n\n上一次的 diff 无法应用：${lastReason}\n请重新生成，并确保上下文行与上面给出的内容逐字一致、且多给几行以唯一定位。`

      const messages: ProviderMessage[] = [
        { role: 'user', text: `${userMessageOf(options.plan, step, overlay)}${retryNote}` },
      ]

      const turn = await options.provider.turn({
        systemPrompt,
        messages,
        tools: [
          {
            name: submitEditTool.name,
            description: submitEditTool.description,
            parameters: submitEditTool.parameters,
          },
          {
            name: skipStepTool.name,
            description: skipStepTool.description,
            parameters: skipStepTool.parameters,
          },
        ],
      })

      if (turn.kind === 'failed') {
        providerFailed = true
        error = turn.message
        break
      }
      if (turn.usage !== undefined) {
        usage = {
          inputTokens: usage.inputTokens + turn.usage.inputTokens,
          outputTokens: usage.outputTokens + turn.usage.outputTokens,
        }
      }

      const calls = turn.kind === 'tools' ? turn.calls : []

      // 明确跳过：立刻结束这一步，**不重试**。重试只会让模型把同样的理由再说一遍。
      const skip = calls.find((c) => c.name === SKIP_STEP)
      if (skip !== undefined) {
        const reason =
          typeof skip.arguments.reason === 'string' ? skip.arguments.reason : '未说明理由'
        skipped.push({ stepId: step.id, title: step.title, reason, attempts })
        options.onProgress?.(`    模型判定无需改动：${reason}\n`)
        done = true
        break
      }

      const call = calls.find((c) => c.name === SUBMIT_EDIT)
      if (call === undefined) {
        // 既没提交 diff 也没声明跳过 —— 没遵守格式，重试
        lastReason = turn.text.trim() === '' ? '模型没有调用任何工具' : turn.text.trim()
        continue
      }

      const patch = typeof call.arguments.patch === 'string' ? call.arguments.patch : ''
      if (patch.trim() === '') {
        lastReason = '提交的 patch 是空的'
        continue
      }

      const applied = attemptApply(patch, options.projectRoot, overlay)
      if (!applied.ok) {
        lastReason = applied.reason
        options.onProgress?.(`    第 ${attempts} 次尝试失败：${applied.reason}\n`)
        continue
      }

      for (const s of applied.stripped) strippedPrefixes.add(s)
      edits.push({
        stepId: step.id,
        title: step.title,
        rationale: step.rationale,
        patch,
        files: applied.files,
        attempts,
        // 此刻 overlay 正是"这一步做完"的状态
        snapshot: applied.files.map((rel) => ({ rel, content: overlay.current(rel) })),
      })
      options.onProgress?.(`    已生成（${applied.files.join('、')}），第 ${attempts} 次尝试\n`)
      done = true
    }

    if (!done && !providerFailed) {
      skipped.push({ stepId: step.id, title: step.title, reason: lastReason, attempts })
      options.onProgress?.(`    跳过：${lastReason}\n`)
    }
  }

  return {
    edits,
    skipped,
    merged: overlay.changed(),
    usage,
    strippedPrefixes: [...strippedPrefixes].sort(),
    providerFailed,
    ...(error === undefined ? {} : { error }),
  }
}
