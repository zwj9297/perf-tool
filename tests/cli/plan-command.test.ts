/**
 * `perf plan` 的集成测试。
 *
 * 用**真实文件系统 + 真实 toolbox + 假 provider**跑通整条链：探测 → 提示词 →
 * 循环 → 工具 → 落盘。假 provider 是唯一被替掉的部件，所以这里能验证"五块代码
 * 接起来了"这件事——而不只是各块单独能跑。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { runPlanCommand, type PlanCommandOutcome } from '../../src/cli/plan-command.js'
import { detectProjectTarget } from '../../src/context/detect.js'
import type { PerformanceEvidence } from '../../src/evidence/types.js'
import type { Provider, ProviderTurn } from '../../src/providers/types.js'
import { createToolbox } from '../../src/tools/toolbox.js'

const makeProject = () => {
  const dir = mkdtempSync(join(tmpdir(), 'perf-plan-'))
  writeFileSync(join(dir, 'package.json'), '{"name":"demo"}\n')
  writeFileSync(join(dir, 'tsconfig.json'), '{}\n')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'hot.ts'), 'export function hot(n: number) {\n  return n * 2\n}\n')
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) }
}

const scripted = (
  turns: ProviderTurn[],
): { provider: Provider; conversations: { tools: string[] }[] } => {
  const conversations: { tools: string[] }[] = []
  let i = 0
  return {
    conversations,
    provider: {
      turn: async (c) => {
        conversations.push({ tools: c.tools.map((t) => t.name) })
        const t = turns[i]
        i++
        if (t === undefined) throw new Error(`没有为第 ${i} 个回合准备响应`)
        return t
      },
    },
  }
}

const toolTurn = (
  calls: { id: string; name: string; arguments: Record<string, unknown> }[],
): ProviderTurn => ({
  kind: 'tools',
  calls,
  text: '',
})

const GOOD_STEP = {
  id: 's1',
  title: '去掉重复计算',
  rationale: '热路径上每次调用都重算同一个值',
  files: ['src/hot.ts'],
  kind: 'algorithmic',
  risk: 'low',
}

const submit = (args: Record<string, unknown>): ProviderTurn =>
  toolTurn([{ id: 'sub', name: 'submit_plan', arguments: args }])

const config = (over: Record<string, unknown> = {}) => ({
  model: 'test/model',
  include: [] as string[],
  exclude: [] as string[],
  maxRounds: 5,
  maxTokens: 1_000_000,
  ...over,
})

const readJson = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>

const run = async (
  dir: string,
  turns: ProviderTurn[],
  opts: { evidence?: PerformanceEvidence; config?: Record<string, unknown> } = {},
): Promise<{
  outcome: PlanCommandOutcome
  output: string
  conversations: { tools: string[] }[]
}> => {
  const { provider, conversations } = scripted(turns)
  const chunks: string[] = []
  const outcome = await runPlanCommand(
    {
      projectRoot: dir,
      config: config(opts.config),
      target: detectProjectTarget(dir),
      ...(opts.evidence === undefined ? {} : { evidence: opts.evidence }),
    },
    {
      provider,
      toolbox: createToolbox({ projectRoot: dir }),
      write: (t) => chunks.push(t),
    },
  )
  return { outcome, output: chunks.join(''), conversations }
}

describe('跑通整条链', () => {
  it('真实工具被调用 → 交卷 → 计划与轨迹落盘', async () => {
    const { dir, clean } = makeProject()
    try {
      const { outcome, output } = await run(dir, [
        toolTurn([{ id: 'c1', name: 'read_file', arguments: { path: 'src/hot.ts' } }]),
        submit({ summary: '优化 hot', steps: [GOOD_STEP] }),
      ])

      expect(outcome.ok).toBe(true)

      // 计划落盘，且 target 来自真实探测
      const plan = readJson(join(dir, '.perf', 'plan.json'))
      expect(plan.summary).toBe('优化 hot')
      expect(plan.target).toEqual({ root: dir, language: 'TypeScript', buildSystem: 'npm' })
      expect(plan.grounded).toBe(false)
      expect(plan.evidence).toBeUndefined()

      // 轨迹落盘，且**真实 toolbox 的执行结果**在里面
      const trace = readJson(join(dir, '.perf', 'trace.json'))
      expect(trace.rounds).toBe(2)
      expect(trace.ok).toBe(true)
      const entries = trace.trace as { kind: string; text?: string }[]
      expect(entries.some((e) => e.kind === 'round')).toBe(true)
      // 工具真的读到了文件内容——这条证明真 toolbox 接进来了
      expect(entries.some((e) => e.kind === 'toolResult' && e.text?.includes('return n * 2'))).toBe(
        true,
      )

      expect(output).toContain('计划摘要：优化 hot')
      expect(output).toContain('plan.json')
    } finally {
      clean()
    }
  })

  it('探测结果进提示词：TS 项目的语言与构建系统被识别', async () => {
    const { dir, clean } = makeProject()
    try {
      const { output, conversations } = await run(dir, [submit({ summary: 's', steps: [] })])
      expect(output).toContain('TypeScript')
      expect(output).toContain('npm')
      // 第 1 轮就暴露了工具箱 + submit_plan
      expect(conversations[0]?.tools).toEqual([
        'read_file',
        'grep',
        'glob',
        'list_dir',
        'submit_plan',
      ])
    } finally {
      clean()
    }
  })

  it('有证据时 grounded 为真，evidence 原样进计划并写进输出', async () => {
    const { dir, clean } = makeProject()
    const evidence: PerformanceEvidence = {
      source: 'profile-file',
      unit: 'time',
      totalSampledMs: 500,
      projectShare: 0.9,
      dependencyShare: 0.05,
      engineShare: 0.05,
      hotSpots: [{ file: 'src/hot.ts', line: 2, selfShare: 0.8, precision: 'line' }],
    }
    try {
      const { outcome, output } = await run(dir, [submit({ summary: 's', steps: [] })], {
        evidence,
      })
      expect(outcome.ok).toBe(true)
      const plan = readJson(join(dir, '.perf', 'plan.json'))
      expect(plan.grounded).toBe(true)
      expect((plan.evidence as PerformanceEvidence).hotSpots).toHaveLength(1)
      expect(output).toContain('热点 src/hot.ts:2')
      expect(output).toContain('实测数据')
    } finally {
      clean()
    }
  })

  it('无证据时输出明确说明是静态分析、未排序', async () => {
    const { dir, clean } = makeProject()
    try {
      const { output } = await run(dir, [submit({ summary: 's', steps: [GOOD_STEP] })], {
        config: { maxRounds: 5 },
      })
      expect(output).toContain('静态分析')
      expect(output).toContain('未按收益排序')
    } finally {
      clean()
    }
  })
})

describe('失败路径也要留下可诊断的产物', () => {
  it('循环失败时仍写 plan.json（说明未完成）与 trace.json', async () => {
    const { dir, clean } = makeProject()
    try {
      const { outcome } = await run(dir, [{ kind: 'failed', message: '401 未授权' }])
      expect(outcome.ok).toBe(false)
      expect(outcome.ok === false && outcome.reason).toBe('provider-failed')

      const plan = readJson(join(dir, '.perf', 'plan.json'))
      expect(plan.summary).toContain('探索未完成')
      expect(plan.steps).toEqual([])

      const trace = readJson(join(dir, '.perf', 'trace.json'))
      expect(trace.ok).toBe(false)
      expect(trace.reason).toBe('provider-failed')
    } finally {
      clean()
    }
  })

  it('路径越界时立刻失败，且 trace 里能看出是模型提交了什么', async () => {
    const { dir, clean } = makeProject()
    try {
      const { outcome } = await run(dir, [
        submit({ summary: 'x', steps: [{ ...GOOD_STEP, files: ['../../etc/passwd'] }] }),
      ])
      expect(outcome.ok).toBe(false)
      expect(outcome.ok === false && outcome.reason).toBe('unsafe-path')
      const trace = readJson(join(dir, '.perf', 'trace.json'))
      const entries = trace.trace as { kind: string; issues?: string }[]
      expect(entries.some((e) => e.kind === 'rejected' && e.issues?.includes('项目外'))).toBe(true)
    } finally {
      clean()
    }
  })

  it('失败时也报告 trace 路径，不让人无从下手', async () => {
    const { dir, clean } = makeProject()
    try {
      const { outcome } = await run(dir, [{ kind: 'failed', message: 'boom' }])
      expect(outcome.ok === false && outcome.tracePath).toContain('.perf')
    } finally {
      clean()
    }
  })
})

describe('计划的落到输出里的呈现', () => {
  it('按风险统计、列出每个 step 与文件、带上模型自标的不确定之处', async () => {
    const { dir, clean } = makeProject()
    try {
      const { output } = await run(dir, [
        submit({
          summary: 's',
          caveats: ['无法确认调用频率'],
          steps: [
            { ...GOOD_STEP, id: 'a', risk: 'low' },
            { ...GOOD_STEP, id: 'b', risk: 'high', title: '换掉 O(n²)' },
          ],
        }),
      ])
      expect(output).toContain('风险分布：低 1 / 中 0 / 高 1')
      expect(output).toContain('换掉 O(n²)')
      expect(output).toContain('src/hot.ts')
      expect(output).toContain('无法确认调用频率')
    } finally {
      clean()
    }
  })
})
