/**
 * 探索循环的测试。
 *
 * 全部用**脚本化的假 provider + 假 toolbox**，不连任何真实模型、不发一个网络请求。
 * 这正是 design.md §2.5 把循环放在 `plan/` 而不是 `providers/` 换来的好处。
 *
 * 分组对应 design.md §4.2 的硬要求：轮数上限与触顶收窄、重复调用检测、截断告知、
 * 两类失败的分别处置、轨迹完整性。
 */
import { describe, expect, it } from 'vitest'

import type { PerformanceEvidence } from '../../src/evidence/types.js'
import { runPlanLoop } from '../../src/plan/loop.js'
import type {
  Provider,
  ProviderConversation,
  ProviderToolCall,
  ProviderTurn,
} from '../../src/providers/types.js'
import type { Toolbox } from '../../src/tools/types.js'

/**
 * 按脚本依次返回响应，并记下每次收到的对话。
 *
 * **必须深拷一层 `messages`**：循环持有同一个数组并原地 push，直接存引用的话所有
 * 快照看到的都是最终状态，基于 `conversations[i].messages` 的断言会全部失去意义
 * （有的还会"碰巧"通过，更难发现）。
 */
const fakeProvider = (turns: ProviderTurn[]) => {
  const conversations: ProviderConversation[] = []
  let i = 0
  const provider: Provider = {
    turn: async (c) => {
      conversations.push({ ...c, messages: [...c.messages], tools: [...c.tools] })
      const t = turns[i]
      i++
      if (t === undefined) throw new Error(`没有为第 ${i} 个回合准备响应`)
      return t
    },
  }
  return { provider, conversations }
}

const fakeToolbox = (
  behaviour?: (call: ProviderToolCall) => Partial<Awaited<ReturnType<Toolbox['run']>>>,
) => {
  const calls: ProviderToolCall[] = []
  const toolbox: Toolbox = {
    specs: () => [{ name: 'grep', description: '搜索', parameters: { type: 'object' } as never }],
    run: async (call) => {
      calls.push(call)
      return { text: `grep 结果 for ${JSON.stringify(call.arguments)}`, ...behaviour?.(call) }
    },
  }
  return { toolbox, calls }
}

/** 收窄到"带工具调用"的那一支，这样测试里可以再展开加 usage 等字段 */
type ToolTurn = Extract<ProviderTurn, { kind: 'tools' }>

const grepTurn = (pattern = 'foo'): ToolTurn => ({
  kind: 'tools',
  calls: [{ id: `c-${pattern}`, name: 'grep', arguments: { pattern } }],
  text: '',
})

const submitTurn = (args: Record<string, unknown>): ToolTurn => ({
  kind: 'tools',
  calls: [{ id: 'submit-1', name: 'submit_plan', arguments: args }],
  text: '交卷',
})

const stepWithFiles = (files: string[]): Record<string, unknown> => ({
  id: 's1',
  title: '把线性查找换成 Map',
  rationale: '热路径上做 O(n) 查找',
  files,
  kind: 'algorithmic',
  risk: 'low',
})

const goodDraft = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  summary: '优化热路径',
  steps: [stepWithFiles(['src/a.ts'])],
  ...over,
})

const EVIDENCE: PerformanceEvidence = {
  source: 'profile-file',
  unit: 'time',
  totalSampledMs: 500,
  projectShare: 0.9,
  dependencyShare: 0.05,
  engineShare: 0.05,
  hotSpots: [{ file: 'src/a.ts', line: 12, selfShare: 0.7, precision: 'line', symbol: 'hot' }],
}

const baseOptions = (turns: ProviderTurn[], over: Record<string, unknown> = {}) => {
  const { provider, conversations } = fakeProvider(turns)
  const { toolbox, calls } = fakeToolbox()
  return {
    conversations,
    calls,
    options: {
      provider,
      toolbox,
      systemPrompt: 'sys',
      userMessage: '分析这个项目',
      maxRounds: 6,
      target: { root: '/proj', language: 'TypeScript' },
      toolContext: { projectRoot: '/proj' },
      ...over,
    },
  }
}

describe('正常收尾', () => {
  it('探索若干轮后交卷，返回完整 Plan', async () => {
    const { options } = baseOptions([grepTurn(), submitTurn(goodDraft())])
    const r = await runPlanLoop(options)

    expect(r.ok).toBe(true)
    expect(r.ok && r.plan.summary).toBe('优化热路径')
    expect(r.ok && r.plan.target).toEqual({ root: '/proj', language: 'TypeScript' })
    expect(r.rounds).toBe(2)
  })

  it('grounded 由证据是否存在决定，不由模型自称', async () => {
    const noEvidence = await runPlanLoop(baseOptions([submitTurn(goodDraft())]).options)
    expect(noEvidence.ok && noEvidence.plan.grounded).toBe(false)
    expect(noEvidence.ok && noEvidence.plan.evidence).toBeUndefined()

    const withEvidence = await runPlanLoop(
      baseOptions([submitTurn(goodDraft())], { evidence: EVIDENCE }).options,
    )
    expect(withEvidence.ok && withEvidence.plan.grounded).toBe(true)
    expect(withEvidence.ok && withEvidence.plan.evidence).toEqual(EVIDENCE)
  })

  it('usage 逐轮累加', async () => {
    const { options } = baseOptions([
      { ...grepTurn(), usage: { inputTokens: 10, outputTokens: 5 } },
      { ...submitTurn(goodDraft()), usage: { inputTokens: 20, outputTokens: 7 } },
    ])
    const r = await runPlanLoop(options)
    expect(r.usage).toEqual({ inputTokens: 30, outputTokens: 12 })
  })
})

describe('轮数上限与触顶收窄工具集', () => {
  it('第 1 轮暴露工具 + submit_plan', async () => {
    const { options, conversations } = baseOptions([submitTurn(goodDraft())])
    await runPlanLoop(options)
    expect(conversations[0]?.tools.map((t) => t.name)).toEqual(['grep', 'submit_plan'])
  })

  it('触顶后只暴露 submit_plan，并注入提示', async () => {
    // maxRounds=2：第 1、2 轮正常，第 2 轮结束时触顶
    const { options, conversations } = baseOptions(
      [grepTurn('a'), grepTurn('b'), grepTurn('c'), submitTurn(goodDraft())],
      { maxRounds: 2 },
    )
    const r = await runPlanLoop(options)

    expect(conversations[1]?.tools.map((t) => t.name)).toEqual(['grep', 'submit_plan'])
    // 第 3 轮起只剩 submit_plan
    expect(conversations[2]?.tools.map((t) => t.name)).toEqual(['submit_plan'])
    // 触顶时注入的提示进了对话与轨迹
    expect(
      conversations[2]?.messages.some((m) => m.role === 'user' && m.text.includes('预算')),
    ).toBe(true)
    expect(r.ok).toBe(true)
  })

  it('触顶后模型仍调用被收窄掉的工具 → 被拒绝并明说原因', async () => {
    const { options } = baseOptions(
      [grepTurn('a'), grepTurn('b'), grepTurn('c'), submitTurn(goodDraft())],
      {
        maxRounds: 2,
      },
    )
    const r = await runPlanLoop(options)
    const rejected = r.trace.filter((t) => t.kind === 'rejected')
    expect(rejected.length).toBeGreaterThan(0)
    expect(rejected[0]?.kind === 'rejected' && rejected[0].issues).toContain('只能调用')
  })

  it('触顶后坚持不交卷 → rounds-exhausted，且轮数被 WRAP_UP_ROUNDS 钉死', async () => {
    // 给足 10 个响应；循环不该用完（maxRounds=2 + 2 轮收尾 = 最多 4 轮）
    const turns = Array.from({ length: 10 }, (_, i) => grepTurn(`p${i}`))
    const { options } = baseOptions(turns, { maxRounds: 2 })
    const r = await runPlanLoop(options)

    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('rounds-exhausted')
    expect(r.rounds).toBe(4)
  })

  it('预算内不触发收窄', async () => {
    const { options, conversations } = baseOptions([grepTurn('a'), submitTurn(goodDraft())], {
      maxRounds: 6,
    })
    await runPlanLoop(options)
    expect(conversations.every((c) => c.tools.length === 2)).toBe(true)
  })
})

describe('重复工具调用检测', () => {
  it('同一调用第二次命中缓存，且不再真正执行工具', async () => {
    const { options, calls } = baseOptions([grepTurn(), grepTurn(), submitTurn(goodDraft())])
    const r = await runPlanLoop(options)

    expect(calls).toHaveLength(1) // 只真正跑了一次
    const deduped = r.trace.filter((t) => t.kind === 'toolResult' && t.deduped === true)
    expect(deduped).toHaveLength(1)
    expect(deduped[0]?.kind === 'toolResult' && deduped[0].text).toContain('已经查过')
  })

  it('参数键序不同也算同一次调用', async () => {
    const { options, calls } = baseOptions([
      { kind: 'tools', calls: [{ id: 'a', name: 'grep', arguments: { p: 1, q: 2 } }], text: '' },
      { kind: 'tools', calls: [{ id: 'b', name: 'grep', arguments: { q: 2, p: 1 } }], text: '' },
      submitTurn(goodDraft()),
    ])
    const r = await runPlanLoop(options)

    expect(calls).toHaveLength(1)
    expect(r.trace.some((t) => t.kind === 'toolResult' && t.deduped === true)).toBe(true)
  })

  it('参数不同则是不同的调用', async () => {
    const { options, calls } = baseOptions([grepTurn('a'), grepTurn('b'), submitTurn(goodDraft())])
    await runPlanLoop(options)
    expect(calls).toHaveLength(2)
  })
})

describe('截断必须显式告知模型', () => {
  it('工具报 truncated 时，回填文本里带明确提示', async () => {
    const { provider } = fakeProvider([grepTurn(), submitTurn(goodDraft())])
    const toolbox: Toolbox = {
      specs: () => [{ name: 'grep', description: 'g', parameters: { type: 'object' } as never }],
      run: async () => ({ text: '前 100 行...', truncated: true }),
    }
    const r = await runPlanLoop({
      provider,
      toolbox,
      systemPrompt: 's',
      userMessage: 'u',
      maxRounds: 4,
      target: { root: '/proj', language: 'ts' },
      toolContext: { projectRoot: '/proj' },
    })

    const toolResult = r.trace.find((t) => t.kind === 'toolResult')
    expect(toolResult?.kind === 'toolResult' && toolResult.text).toContain('已被截断')
  })
})

describe('两类失败的分别处置', () => {
  it('schema 失败：回填错误让模型自己修，修好即成功', async () => {
    const { options, conversations } = baseOptions([
      submitTurn({ steps: [] }), // 缺 summary
      submitTurn(goodDraft()),
    ])
    const r = await runPlanLoop(options)

    expect(r.ok).toBe(true)
    // 第一次的错误作为 isError 的 toolResult 回填了
    const errored = conversations[1]?.messages.find((m) => m.role === 'toolResult' && m.isError)
    expect(errored?.role === 'toolResult' && errored.text).toContain('未通过校验')
    expect(r.trace.some((t) => t.kind === 'rejected')).toBe(true)
  })

  it('unsafe-path 失败：立即终止，不重试', async () => {
    const { options } = baseOptions([
      submitTurn({ summary: '越界', steps: [stepWithFiles(['../../etc/passwd'])] }),
      submitTurn(goodDraft()), // 准备了第二次，但不该被用到
    ])
    const r = await runPlanLoop(options)

    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('unsafe-path')
    expect(r.rounds).toBe(1) // 一轮就终止，没有重试
  })

  it('provider 失败：原样上报', async () => {
    const { options } = baseOptions([{ kind: 'failed', message: '401 未授权' }])
    const r = await runPlanLoop(options)
    expect(r.ok === false && r.reason).toBe('provider-failed')
    expect(r.ok === false && r.message).toContain('401')
  })
})

describe('不认识的工具名与不说话的模型', () => {
  it('编造的工具名被拒绝，并列出可用工具', async () => {
    const { provider } = fakeProvider([
      { kind: 'tools', calls: [{ id: 'x', name: 'delete_everything', arguments: {} }], text: '' },
      submitTurn(goodDraft()),
    ])
    const { toolbox } = fakeToolbox()
    const r = await runPlanLoop({
      provider,
      toolbox,
      systemPrompt: 's',
      userMessage: 'u',
      maxRounds: 4,
      target: { root: '/proj', language: 'ts' },
      toolContext: { projectRoot: '/proj' },
    })

    const rejected = r.trace.find((t) => t.kind === 'rejected')
    expect(rejected?.kind === 'rejected' && rejected.issues).toContain('没有名为')
    expect(rejected?.kind === 'rejected' && rejected.issues).toContain('grep')
    expect(r.ok).toBe(true) // 被纠正后仍能完成
  })

  it('模型既不调工具也不交卷：催一次，再犯即 no-plan', async () => {
    const { options, conversations } = baseOptions([
      { kind: 'text', text: '我需要更多信息' },
      { kind: 'text', text: '还是不知道' },
    ])
    const r = await runPlanLoop(options)

    expect(r.ok === false && r.reason).toBe('no-plan')
    // 催过一次：第二次的对话里多了那条提示
    expect(conversations[1]?.messages.at(-1)?.role).toBe('user')
    expect(r.trace.some((t) => t.kind === 'note')).toBe(true)
  })

  it('被催之后交卷也算成功', async () => {
    const { options } = baseOptions([{ kind: 'text', text: '嗯' }, submitTurn(goodDraft())])
    const r = await runPlanLoop(options)
    expect(r.ok).toBe(true)
  })
})

describe('轨迹完整性', () => {
  it('每轮、每个工具结果、每次拒绝、每条注入提示都进 trace', async () => {
    const { options } = baseOptions([
      grepTurn('a'),
      grepTurn('a'), // 重复
      { kind: 'tools', calls: [{ id: 'z', name: 'nope', arguments: {} }], text: '' },
      submitTurn(goodDraft()),
    ])
    const r = await runPlanLoop(options)

    const kinds = new Set(r.trace.map((t) => t.kind))
    expect(kinds).toContain('round')
    expect(kinds).toContain('toolResult')
    expect(kinds).toContain('rejected')
    expect(r.trace.filter((t) => t.kind === 'round')).toHaveLength(r.rounds)
  })
})
