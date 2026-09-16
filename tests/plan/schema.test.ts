/**
 * `Plan` schema 与校验的测试。
 *
 * 重点不是"能通过"（那容易），而是**该拦的有没有拦住**。`additionalProperties: false`
 * 与枚举约束都依赖 pi-ai 底层的 TypeBox 校验真的生效——typecheck 通过完全不能说明
 * 这一点，所以这里逐条打。
 */
import { describe, expect, it } from 'vitest'

import { PlanDraftSchema, submitPlanTool, validatePlanDraft } from '../../src/plan/schema.js'

const step = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 's1',
  title: '把线性查找换成 Map',
  rationale: '这个函数在热路径上做了 O(n) 查找',
  files: ['src/lookup.ts'],
  kind: 'algorithmic',
  risk: 'low',
  ...over,
})

const draft = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  summary: '减少热路径上的线性查找',
  steps: [step()],
  ...over,
})

describe('合格输入', () => {
  it('合法 draft 通过，且字段原样保留', () => {
    const r = validatePlanDraft(draft())
    expect(r.ok).toBe(true)
    expect(r.ok && r.draft.steps[0]?.id).toBe('s1')
    expect(r.ok && r.draft.summary).toBe('减少热路径上的线性查找')
  })

  it('expectedImpact 与 caveats 都是可选的', () => {
    const r = validatePlanDraft(draft({ caveats: ['无法确认数据量级'] }))
    expect(r.ok).toBe(true)
    expect(r.ok && r.draft.steps[0]?.expectedImpact).toBeUndefined()
    expect(r.ok && r.draft.caveats).toEqual(['无法确认数据量级'])
  })

  it('steps 可以为空（模型判定没有可改的地方）', () => {
    const r = validatePlanDraft(draft({ steps: [] }))
    expect(r.ok).toBe(true)
  })

  it('提交工具的名字与 schema 一致，且开启 strict（prefer）', () => {
    expect(submitPlanTool.name).toBe('submit_plan')
    expect(submitPlanTool.parameters).toBe(PlanDraftSchema)
    expect(submitPlanTool.constrainedSampling).toEqual({ type: 'json_schema', strict: 'prefer' })
  })
})

describe('结构不合规必须拦下（kind: schema）', () => {
  const bad: Record<string, string> = {
    '缺 summary': JSON.stringify({ steps: [step()] }),
    'summary 是空串': JSON.stringify({ summary: '', steps: [step()] }),
    不是对象: JSON.stringify('nope'),
    'steps 缺失': JSON.stringify({ summary: 'x' }),
    'step 缺 id': JSON.stringify({ summary: 'x', steps: [step({ id: undefined })] }),
    'kind 不在枚举内': JSON.stringify(draft({ steps: [step({ kind: 'micro-optimize' })] })),
    'risk 不在枚举内': JSON.stringify(draft({ steps: [step({ risk: 'critical' })] })),
    'files 是空数组': JSON.stringify(draft({ steps: [step({ files: [] })] })),
    多余的顶层字段: JSON.stringify(draft({ unknownField: 1 })),
    'step 里多余字段': JSON.stringify(draft({ steps: [step({ extra: true })] })),
  }

  for (const [name, payload] of Object.entries(bad)) {
    it(name, () => {
      const r = validatePlanDraft(JSON.parse(payload))
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.kind).toBe('schema')
      expect(r.ok === false && r.issues.length).toBeGreaterThan(0)
    })
  }

  it('caveats 是数字数组时**不会**被拦下 —— 见下面的强制转换说明', () => {
    // 这条原本断言"应被拒绝"，实测发现不成立。原因见下面那组测试。
    const r = validatePlanDraft(draft({ caveats: [1, 2] }))
    expect(r.ok).toBe(true)
    expect(r.ok && r.draft.caveats).toEqual(['1', '2'])
  })
})

describe('校验是「强制转换」式的，不是严格式的（实测行为，必须知道）', () => {
  /**
   * pi-ai 的 `validateToolArguments` 底层用 TypeBox 的 **Value.Convert**：它把标量
   * **转成**目标类型，而不是拒绝。所以 `summary: 123` 会变成 `"123"` 通过。
   *
   * 为什么这对我们仍然可接受：危险的那几类恰好是硬拦的——枚举（`kind`/`risk`）、
   * 必填、以及 `additionalProperties: false` 带来的"多余字段"。最后一条尤其关键：
   * 它让模型**无法注入 `grounded` / `evidence`**，而一个把 `grounded: true` 写进
   * 没证据的计划里的模型，会直接摧毁 evidence 机制的可信度。
   *
   * 但这条性质必须写下来。以后若给 schema 加数值字段（比如"预期收益百分比"），
   * 字符串会被**静默转成数字**而不是报错——那时就不能再指望这层校验兜底了。
   */
  it('标量类型被强制转换后通过', () => {
    const r = validatePlanDraft(draft({ summary: 123, caveats: [1, 2] }))
    expect(r.ok).toBe(true)
    expect(r.ok && r.draft.summary).toBe('123')
    expect(r.ok && r.draft.caveats).toEqual(['1', '2'])
  })

  it('files 里的数字也被转成字符串，之后的路径校验照样生效', () => {
    const r = validatePlanDraft(draft({ steps: [step({ files: [42] })] }))
    expect(r.ok).toBe(true)
    expect(r.ok && r.draft.steps[0]?.files).toEqual(['42'])
  })

  it('真正要紧的东西是硬拦的：枚举、必填、以及模型无法注入 grounded / evidence', () => {
    expect(validatePlanDraft(draft({ steps: [step({ kind: 'nope' })] })).ok).toBe(false)
    expect(validatePlanDraft({ steps: [step()] }).ok).toBe(false)
    expect(validatePlanDraft(draft({ grounded: true })).ok).toBe(false)
    expect(validatePlanDraft(draft({ evidence: { hotSpots: [] } })).ok).toBe(false)
  })
})

describe('路径越界必须直接拒绝（kind: unsafe-path）', () => {
  // 这一类和 schema 错误处置不同：不是"格式写错了让它重试"，而是它试图引用项目外
  // 的文件，必须拒绝，不能靠重试祈祷下次不这样。
  const unsafe: Record<string, string[]> = {
    绝对路径: ['/etc/passwd'],
    上跳一级: ['../outside.ts'],
    上跳多级: ['src/../../outside.ts'],
    上跳在中间: ['src/../..//x.ts'],
    'Windows 绝对路径': ['C:\\Windows\\system32\\drivers\\etc\\hosts'],
  }

  for (const [name, files] of Object.entries(unsafe)) {
    it(name, () => {
      const r = validatePlanDraft(draft({ steps: [step({ files })] }))
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.kind).toBe('unsafe-path')
    })
  }

  it('合法相对路径不被误伤', () => {
    const r = validatePlanDraft(draft({ steps: [step({ files: ['src/a/b.ts', 'index.js'] })] }))
    expect(r.ok).toBe(true)
  })

  it('文件名含两个点但不是上跳（如 a..b.ts）不被误伤', () => {
    const r = validatePlanDraft(draft({ steps: [step({ files: ['src/a..b.ts'] })] }))
    expect(r.ok).toBe(true)
  })

  it('第二个 step 越界也要被拦下', () => {
    const r = validatePlanDraft(
      draft({ steps: [step({ id: 's1' }), step({ id: 's2', files: ['../../x.ts'] })] }),
    )
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.kind).toBe('unsafe-path')
  })
})
