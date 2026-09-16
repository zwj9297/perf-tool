/**
 * 探索阶段的提示词构建。
 *
 * 单独成模块而不是塞进循环，因为**证据的有无必须改变行为**（`CLAUDE.md` 的跨模块
 * 约束）——这个分叉主要就落在这里，它值得被单独测试，而不是淹没在控制流里。
 */
import type { PerformanceEvidence } from '../evidence/types.js'

export type PromptInput = {
  /** 目标项目根，用于告诉模型路径基准 */
  projectRoot: string
  language?: string
  buildSystem?: string
  /** 有实测证据则进入"基于数据定位"模式；没有则进入"只报静态可判定问题"模式 */
  evidence?: PerformanceEvidence
  maxRounds: number
  /**
   * 生效中的 include / exclude 规则。
   *
   * 必须告诉模型，否则它会**把"被过滤掉"推断成"不存在"**——实测发生过：一次用
   * include 白名单限定了源码目录的 plan 里，模型看到 glob/list_dir 列不出 package.json
   * 与 tsconfig.json，就在计划摘要里写下"项目根目录下没有 package.json / tsconfig.json
   * / tests 内容，所以构建配置与测试基线这几类判断我无法核实"。它基于一个错误前提
   * 做了自我限制，而那完全是我们静默过滤造成的。
   */
  include?: readonly string[]
  exclude?: readonly string[]
}

/** 视野被裁剪时必须说清——这是"静默过滤"那一类问题的模型侧对策 */
const renderFilterSection = (include: readonly string[], exclude: readonly string[]): string => {
  const lines: string[] = ['## 你的视野是被裁剪过的']
  if (include.length > 0) lines.push(`只分析匹配以下白名单的文件：${include.join('、')}`)
  if (exclude.length > 0) lines.push(`以下模式被排除在外：${exclude.join('、')}`)
  lines.push('')
  lines.push(
    '工具只在这些范围内返回内容，项目自带的忽略规则（如 `.gitignore`、`node_modules`）也同时生效。',
  )
  lines.push(
    '**所以"看不到某个文件"不等于"它不存在"。** 如果你要判断的东西（构建配置、依赖清单、测试、某段调用方）看起来缺失，请在结论里说明"它可能被过滤规则挡住了"或"我无法确认"，**不要基于"文件不存在"往下推理**。',
  )
  return lines.join('\n')
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`

const renderHotSpots = (e: PerformanceEvidence): string => {
  const lines = e.hotSpots.map((s, i) => {
    const parts = [
      `${i + 1}. ${s.file}:${s.line}`,
      pct(s.selfShare),
      s.precision === 'line' ? '行级精度' : '⚠️ 仅函数级精度（该函数没有行级采样分布）',
    ]
    if (s.symbol !== undefined) parts.push(`采样归属函数 ${s.symbol}`)
    return parts.join(' | ')
  })
  const omitted =
    e.hotSpotsOmitted === undefined
      ? ''
      : `\n还有 ${e.hotSpotsOmitted.count} 处更小的热点未列出，合计占 ${pct(e.hotSpotsOmitted.share)}。`
  return lines.join('\n') + omitted
}

const renderEvidenceSection = (e: PerformanceEvidence): string => {
  const parts = [`## 实测数据（来自一份 CPU profile，总采样时长 ${e.totalSampledMs.toFixed(0)}ms）`]

  parts.push(
    `时间分布：本项目代码 ${pct(e.projectShare)}，非本项目代码（依赖等）${pct(e.dependencyShare)}，运行时与引擎内部 ${pct(e.engineShare)}。`,
  )

  if (e.dependencyShare > 0.05) {
    parts.push(
      `**不要把依赖里的耗时当作可优化项**——你改不了第三方包。若依赖占比可观，可以在计划里指出"这部分应通过换依赖、缓存或减少调用次数解决"，但不要产出针对依赖内部代码的 step。`,
    )
  }
  if (e.engineShare > 0.05) {
    parts.push(
      `运行时与引擎内部占了 ${pct(e.engineShare)}，这部分不属于任何源码，通常意味着 GC 压力或框架开销，可作为线索但无法直接改。`,
    )
  }

  parts.push(`\n按自身耗时占比降序的热点：\n${renderHotSpots(e)}`)
  parts.push(
    `\n读这些数据时注意两点：\n` +
      `- **行号是权威定位，函数名只是提示。** V8 会内联热点函数，此时"采样归属函数"是内联者的名字，而行号极可能落在被内联函数的体内。请以行号为准去读代码。\n` +
      `- 标了"仅函数级精度"的条目只能定位到函数定义行，需要你自己读该函数找出具体是哪几行。`,
  )
  parts.push(
    `\n**有实测数据时，按真实耗时占比定位与排序，并在每个 step 的 expectedImpact 里给出基于该占比的预期收益。**`,
  )

  return parts.join('\n')
}

const renderNoEvidenceSection = (): string =>
  [
    `## 没有实测数据`,
    `这次没有提供 CPU profile。你必须进入**静态分析**模式，行为与有数据时**不同**：`,
    ``,
    `- 只报告**能从代码本身判定**的问题：给定数据规模下的算法复杂度、N+1 查询、热路径上的同步 IO、重复计算、不必要的分配。`,
    `- **不要给出收益排序，不要填 expectedImpact。** 没有实测占比就没有排序依据，编造的排序比没有排序更糟——它会让人先优化错的地方。`,
    `- **必须在 caveats 里说明哪些判断缺乏依据**，尤其是你无法确定数据规模或调用频率的地方。`,
    ``,
    `静态分析能发现真问题，但有个可预测的盲区：它会优化"看起来慢"的而不是"确实慢"的。同一个 O(n²) 循环跑在 10 个元素上无关痛痒，藏在百万级热循环里就是灾难，而代码长得一样。**你要在 rationale 里写清你的判断依据是什么**（比如"这个函数在循环里被调用，而调用点的数据量来自分页接口"），让读者能自己判断这个推断有多可靠。`,
  ].join('\n')

export const buildSystemPrompt = (input: PromptInput): string => {
  const sections: string[] = []

  sections.push(
    [
      `你是代码性能分析专家，正在分析一个位于 ${input.projectRoot} 的项目。`,
      input.language === undefined ? '' : `项目主要语言：${input.language}。`,
      input.buildSystem === undefined ? '' : `构建系统：${input.buildSystem}。`,
      ``,
      `你的任务是产出一份**可执行的优化计划**：找出值得改的性能问题，说明每处的成因与依据。不要输出完整的改动代码，只要说清楚改什么、为什么。`,
      ``,
      `你有若干**只读**工具可以自主探索这个项目。**先探索再下结论**：性能问题的判断高度依赖上下文（数据量级、调用频率、是否在热路径上），只看单个文件很容易猜错。`,
      `尤其要主动做**反向查询**——"谁在调用这个函数"、"这个数组的数据量级从哪来"。这类信息是静态阅读单个文件时最容易漏掉的，而它往往决定一个改动值不值得做。`,
      ``,
      `探索完成后调用 \`submit_plan\` 交卷。**不要在没有调用它的情况下结束**。`,
      ``,
      `边界：你只能读取项目内的文件（工具会拒绝越界路径），也不能执行任何命令。`,
      `你有约 ${input.maxRounds} 轮探索预算，另外还有一个总成本上限——两者任一用尽，工具都会被收窄到只剩 \`submit_plan\`。届时请基于已掌握的信息立即交卷，并在 caveats 里说明哪些判断因此缺依据。`,
    ]
      .filter((l) => l !== '')
      .join('\n'),
  )

  const include = input.include ?? []
  const exclude = input.exclude ?? []
  if (include.length > 0 || exclude.length > 0) {
    sections.push(renderFilterSection(include, exclude))
  }

  sections.push(
    input.evidence === undefined
      ? renderNoEvidenceSection()
      : renderEvidenceSection(input.evidence),
  )

  return sections.join('\n\n')
}
