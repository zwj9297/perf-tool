/**
 * 提示词构建的测试。
 *
 * 重点是**证据有无带来的行为分叉**（`CLAUDE.md` 的跨模块约束）——它主要落在这里，
 * 所以必须有断言钉住，否则"没证据就不排序"只是一句写在文档里的话。
 */
import { describe, expect, it } from 'vitest'

import type { PerformanceEvidence } from '../../src/evidence/types.js'
import { buildSystemPrompt } from '../../src/plan/prompt.js'

const base = { projectRoot: '/proj', maxRounds: 8 }

const evidence = (over: Partial<PerformanceEvidence> = {}): PerformanceEvidence => ({
  source: 'profile-file',
  unit: 'time',
  totalSampledMs: 500,
  projectShare: 0.9,
  dependencyShare: 0.05,
  engineShare: 0.05,
  hotSpots: [{ file: 'src/hot.ts', line: 42, selfShare: 0.71, precision: 'line', symbol: 'loop' }],
  ...over,
})

describe('没有证据时：静态分析模式', () => {
  const p = buildSystemPrompt(base)

  it('明确要求不给收益排序、不填 expectedImpact', () => {
    expect(p).toContain('不要给出收益排序')
    expect(p).toContain('expectedImpact')
  })

  it('要求把缺依据的判断写进 caveats', () => {
    expect(p).toContain('caveats')
  })

  it('说清"看起来慢 vs 确实慢"的盲区，并要求 rationale 写明判断依据', () => {
    expect(p).toContain('看起来慢')
    expect(p).toContain('rationale')
  })

  it('不出现实测数据小节', () => {
    // 断言必须精确到标题：这一模式的标题是「没有实测数据」，裸查 '实测数据'
    // 会被自己的标题命中，是个很容易写错的近似误判。
    expect(p).not.toContain('## 实测数据')
    expect(p).not.toContain('总采样时长')
  })
})

describe('有证据时：基于数据定位模式', () => {
  const p = buildSystemPrompt({ ...base, evidence: evidence(), language: 'TypeScript' })

  it('列出热点的文件:行号与占比', () => {
    expect(p).toContain('src/hot.ts:42')
    expect(p).toContain('71.0%')
  })

  it('反过来要求按占比排序并给出预期收益', () => {
    expect(p).toContain('按真实耗时占比定位与排序')
    expect(p).toContain('expectedImpact')
    // 关键：不能同时出现"不要排序"那句，否则提示词自相矛盾
    expect(p).not.toContain('不要给出收益排序')
  })

  it('说明行号是权威定位、函数名只是提示（内联会让函数名指错）', () => {
    expect(p).toContain('行号是权威定位')
    expect(p).toContain('内联')
  })

  it('标出只有函数级精度的条目', () => {
    const mixed = buildSystemPrompt({
      ...base,
      evidence: evidence({
        hotSpots: [
          { file: 'src/a.ts', line: 1, selfShare: 0.5, precision: 'function' },
          { file: 'src/b.ts', line: 2, selfShare: 0.3, precision: 'line' },
        ],
      }),
    })
    expect(mixed).toContain('仅函数级精度')
  })

  it('有截断时说明还有多少未列出 —— 不能让列表看起来"就这些"', () => {
    const omitted = buildSystemPrompt({
      ...base,
      evidence: evidence({ hotSpotsOmitted: { count: 12, share: 0.08 } }),
    })
    expect(omitted).toContain('12')
    expect(omitted).toContain('8.0%')
  })

  it('依赖占比高时明确要求不要产出针对依赖内部的 step', () => {
    const dep = buildSystemPrompt({ ...base, evidence: evidence({ dependencyShare: 0.4 }) })
    expect(dep).toContain('不要把依赖里的耗时当作可优化项')
  })

  it('依赖占比低时不出现那段提示（避免无谓的噪音）', () => {
    const p2 = buildSystemPrompt({ ...base, evidence: evidence({ dependencyShare: 0.01 }) })
    expect(p2).not.toContain('不要把依赖里的耗时当作可优化项')
  })

  it('引擎内部占比高时给出线索而非当作可改代码', () => {
    const eng = buildSystemPrompt({ ...base, evidence: evidence({ engineShare: 0.3 }) })
    expect(eng).toContain('GC')
  })
})

describe('两种模式共有的部分', () => {
  it('都要求先探索、用 submit_plan 收尾、并说明轮数预算', () => {
    for (const p of [
      buildSystemPrompt(base),
      buildSystemPrompt({ ...base, evidence: evidence() }),
    ]) {
      expect(p).toContain('submit_plan')
      expect(p).toContain('反向查询')
      expect(p).toContain('8 轮')
      expect(p).toContain('/proj')
    }
  })

  it('都要求"每个独立问题一个 step"，并说明理由（逐 step 提交/回退）', () => {
    for (const p of [
      buildSystemPrompt(base),
      buildSystemPrompt({ ...base, evidence: evidence() }),
    ]) {
      expect(p).toContain('每个独立的问题一个 step')
      expect(p).toContain('逐个回退')
      // 反向也要说清，否则会变成按文件过度拆分
      expect(p).toContain('同一个问题的多处改动应当放在同一个 step 里')
    }
  })

  it('都说明工具是只读的、不能执行命令', () => {
    const p = buildSystemPrompt(base)
    expect(p).toContain('只读')
    expect(p).toContain('不能执行任何命令')
  })
})

describe('视野被裁剪时必须说清（否则"被过滤"会被推断成"不存在"）', () => {
  it('配了 include/exclude 时明确列出规则，并点出"看不到 ≠ 不存在"', () => {
    const p = buildSystemPrompt({ ...base, include: ['src/**'], exclude: ['**/*.test.ts'] })
    expect(p).toContain('你的视野是被裁剪过的')
    expect(p).toContain('src/**')
    expect(p).toContain('**/*.test.ts')
    expect(p).toContain('不等于"它不存在"')
  })

  it('没配过滤时不出这一节（避免无谓的 token 与噪音）', () => {
    const p = buildSystemPrompt(base)
    expect(p).not.toContain('你的视野是被裁剪过的')
  })

  it('只配 include 或只配 exclude 也各自成立', () => {
    expect(buildSystemPrompt({ ...base, include: ['a/**'] })).toContain('白名单')
    expect(buildSystemPrompt({ ...base, exclude: ['b/**'] })).toContain('排除在外')
  })
})
