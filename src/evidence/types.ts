/**
 * 证据域的类型。
 *
 * `PerformanceEvidence` / `HotSpot` 定义在这里而不是 plan/，因为 evidence 是证据域
 * 的拥有者；`Plan` 将来从本模块引用它。权威定义见 docs/design.md §5。
 */

/**
 * V8 CPU profile（Chrome trace / `.cpuprofile`）的**已校验**形状。
 *
 * 只声明我们用到的字段——profile 里还有别的，不需要就不写。注意这是「校验通过之后」
 * 的形状：parse 层从 `unknown` 收窄到这里，所以**不要**用它去断言未校验的 JSON。
 * 格式全貌见 docs/design.md §6.1。
 */
export type CpuProfileNode = {
  id: number
  callFrame: {
    functionName: string
    scriptId: string
    url: string
    /** **0-based**，指向函数声明行。合成节点为 -1。与 positionTicks 的基准不同！ */
    lineNumber: number
    columnNumber: number
  }
  /**
   * 自采样次数。声明为可选，而且**本模块不读它**——耗时一律从 `samples` + `timeDeltas`
   * 累加得到。`hitCount × 名义间隔` 会系统性低估（实测差 24%），原因见 §6.2 发现③。
   * 留在这里只是为了让读代码的人知道这个字段存在且被刻意忽略了。
   */
  hitCount?: number
  children?: number[]
  /** **1-based** 行号。只有部分节点带这个字段，见 §6.2 发现② */
  positionTicks?: { line: number; ticks: number }[]
}

export type CpuProfile = {
  nodes: CpuProfileNode[]
  samples: number[]
  timeDeltas: number[]
}

/** 一条热点。`line` 与 `precision` 的配合是关键，见 design.md §6.2。 */
export type HotSpot = {
  /** 相对目标项目根，POSIX 分隔符 */
  file: string
  /** **1-based**（人读的行号） */
  line: number
  /**
   * 函数名。**只是提示，不是定位依据。**
   *
   * V8 会内联热点函数，此时这个字段是**内联者**的名字，而 `line` 极可能落在被内联
   * 函数的体内。实测：`main` 节点的 331 个 tick 里 268 个落在 `hotLoop` 体内，而
   * symbol 会是 `main`。所以读它的时候要意识到"这里可能是内联"。
   */
  symbol?: string
  /** 自身耗时 / 整个 profile 采样总时长 */
  selfShare: number
  /** 行级（有 positionTicks）还是只有函数级（退化到函数定义行） */
  precision: 'line' | 'function'
}

/**
 * 性能证据。`projectShare + dependencyShare + engineShare` 构成对总时长的**划分**：
 *
 * - 每个采样恰好属于一个节点，每个节点恰好归入一个桶（见 parse.ts 的 classify）
 * - 所以三者之和为 1——**除非** profile 里有采样引用了不存在的节点 id（异常数据），
 *   此时三者之**和小于 1**，差额就是无法归因的部分。绝不会大于 1。
 *
 * 这个恒等式是刻意的，测试里有断言：它让"到底有没有漏算"变成可检验的问题，
 * 而不是靠人肉核对。
 */
export type PerformanceEvidence = {
  source: 'profile-file' // 将来扩展 'benchmark'
  runtime?: string
  unit: 'time' | 'samples' | 'bytes'
  /** 整个 profile 的采样总时长（`timeDeltas` 之和） */
  totalSampledMs: number
  /** 本项目的代码占的 self time 比例 */
  projectShare: number
  /**
   * 非本项目代码占的比例。**包含装在项目根内的 `node_modules`**——那是常态，
   * 不是例外。这一类绝不能进 `hotSpots`：模型看到依赖里的热点会去"优化"一个它
   * 改不了的第三方包。也包含 hoist 到根外的依赖、monorepo 兄弟包，以及转不成
   * 文件路径的 url（`webpack://` 等）。
   */
  dependencyShare: number
  /** 不属于任何用户代码的时间：合成节点（`(program)` 等）与 Node 自身代码（`node:internal/*`） */
  engineShare: number
  /** 非本项目代码里耗时最高的几个，供判断是否该看依赖。绝对路径，仅作诊断 */
  dependencyTop?: string[]
  /** 按 selfShare 降序 */
  hotSpots: HotSpot[]
  /**
   * 被截断掉的部分。**不能省略这个字段**：列表看起来"就这些"会让模型以为热点只有
   * 这些，而实际可能还有一批各占 1% 的没列出来。
   */
  hotSpotsOmitted?: { count: number; share: number }
}
