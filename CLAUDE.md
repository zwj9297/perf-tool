# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

`@zwj9297/perf-tool` 是一个分析代码性能瓶颈并给出优化方案的 CLI（命令名 `perf`），以**目标项目的开发时依赖**形式安装，在目标项目目录下调用大模型完成分析与优化。

本仓库是工具自身的源码，不是被分析的目标项目——所有读取/修改代码的逻辑，作用于用户当前工作目录下的目标项目，而非本仓库。

架构为 Plan-and-Execute：先由模型产出可审阅的结构化优化计划，再逐步执行并落地改动。

## 已确定的决策

| 维度              | 决策                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| 语言 / 模块       | TypeScript + ESM（`"type": "module"`，发布产物为 ESM）                                             |
| 包名 / 命令       | 包 `@zwj9297/perf-tool`，命令 `perf`                                                               |
| 安装形态          | 目标项目的 devDependency，项目内执行。**不提供全局安装**                                           |
| LLM 接入          | 抽象 provider 层，同时支持 Anthropic 与 OpenAI 兼容端点，可配置                                    |
| 性能事实来源      | 实测证据优先，静态分析兜底，且两种模式行为**不同**（见下）                                         |
| Plan→Execute 衔接 | 交互确认与全自动两种模式，flag 切换                                                                |
| 改动落地          | 在目标项目新建 git 分支并逐 step 提交                                                              |
| 工具链            | ESM + `nodenext`、Vitest、ESLint flat config + Prettier、Node 引擎 `>=20`                          |
| TypeScript        | 锁 `^6`。**不要升到 7** —— typescript-eslint 的 peer 范围是 `<6.1.0`，升上去 lint 工具链直接装不上 |

安装形态决定了命令的引用方式：文档与错误提示中一律用 `npx perf` 或包内 script，**不要**写成需要全局安装的形式。同时注意未安装时 `npx perf` 会去 registry 拉取同名包执行——对外文档在使用裸 `npx perf` 前必须先确认已安装，否则用完整包名 `npx @zwj9297/perf-tool`。

改动落地方式决定了两个硬性前置条件，实现时必须校验并在不满足时给出明确报错而非静默降级：目标项目是 git 仓库，且执行前工作区干净。

## 常用命令

```bash
npm install
npm run build          # tsc 构建到 dist/（发布产物）
npm run typecheck      # tsc --noEmit
npm test               # vitest run，单次全量
npm run test:watch     # vitest 监听模式
npm run lint
npm run dev -- plan    # tsx 直接执行 CLI 源码，无需构建
```

跑单个测试：

```bash
npx vitest run tests/plan/parser.test.ts                 # 单个文件
npx vitest run -t "rejects step with path escaping root" # 单个用例
```

验证打包形态。改动 `bin`、`files`、入口路径或任何依赖运行时文件位置（如 prompt 模板）的代码后必须走一遍——它同时验证源码里按路径读取的资源在打包后仍然存在：

```bash
npm run build
npm pack                                              # 产出 zwj9297-perf-tool-<version>.tgz
cd /tmp/scratch-project && npm i -D /path/to/zwj9297-perf-tool-*.tgz
npx perf plan --dry-run
```

`npm link` 更快，但它软链源码而非走打包流程，会掩盖 `files` 白名单遗漏和运行时资源路径错误。

两个 tsconfig 的分工不能合并：`tsconfig.json` 只做类型检查（`noEmit`，覆盖 `src` 与 `tests`），`tsconfig.build.json` 负责产出（`rootDir: "src"` → `dist`）。若让一个配置同时 emit 两者，产物会变成 `dist/src` 与 `dist/tests`，`bin` 指向的路径随即失效。所以 `npm run typecheck` 会检查测试文件，而 `npm run build` 不产出它们。

## 架构：两阶段流水线

```text
perf plan [path]                    # 只读，绝不修改目标项目
  1. 解析配置 + 定位目标项目根
  2. 校验 git 前置条件，采集上下文（文件发现、语言/构建系统探测）
  3. 归一化性能证据 → PerformanceEvidence | null
  4. 按有无证据分叉构建 prompt → provider 结构化输出 → 校验为 Plan
  5. 计划落盘到 .perf/plan.json，打印给人看

perf run                            # 写，逐个 step 提交
  1. 读取 .perf/plan.json（不存在则先自动走一次 plan）
  2. 交互模式：展示计划，等待确认；--yes 跳过
  3. 校验 git 前置条件，创建分支 perf/<timestamp>-<slug>
  4. 逐个 Step 执行 → 每个 Step 一次 commit
  5. 汇总报告；失败时说明已完成到哪一步、如何回退
```

两个阶段可分开调用是关键设计：`plan` 不碰代码，`run` 能消费**人工编辑过**的 plan。因此两阶段之间只以 `Plan` 这一个契约衔接，不要引入额外的进程内状态传递或隐式全局。

`src/` 模块划分：

- `cli/` — 命令注册、flag 解析、两种模式的分支
- `config/` — 配置 schema 与优先级解析
- `providers/` — LLM 抽象层与各家实现
- `evidence/` — profile 数据解析与归一化
- `context/` — 目标项目上下文采集与裁剪
- `plan/` — prompt 构建、结构化输出解析与校验
- `execute/` — step 执行器、文件改写
- `git/` — 分支、提交、回滚
- `report/` — 结果汇总输出

### 四个跨模块约束

**provider 抽象不承担 schema 校验。** 两家的结构化输出能力不对等：Anthropic 可走 tool-use 强制 schema；OpenAI 兼容端点对 `response_format: json_schema` 的支持参差不齐，需降级为「prompt 中给出 schema + 解析 + 校验 + 重试」。因此 provider 接口只承诺 `generate(messages, schema) => Promise<unknown>`，**校验一律在 `plan/` 层做**。这保证换模型或换供应商不改变解析路径，也意味着不能把「返回的一定合法」当成 provider 的契约来依赖。

**上下文采集是有预算的。** 大仓库塞不进上下文窗口，文件发现必须可裁剪，采集范围受配置 include/exclude 与目标项目 `.gitignore` 共同约束。新增采集来源时都要想清楚它如何参与裁剪。

**证据的有无必须改变行为，而不只是改变 prompt 措辞。** 有实测证据时，按真实耗时占比定位并排序；无证据时，只报能静态判定的问题，且**不产出收益排序**（`expectedImpact` 省略）。编造的排序比没有排序更糟——它会让人先优化错的东西。这个分叉要在 `plan/` 层显式实现，不能靠模型自觉。

**`evidence/` 是将来接入基准能力的唯一入口。** 用户提供的 profile 文件与（后续可能实现的）工具自跑基准，都必须归一化成同一个 `PerformanceEvidence` 再进入 prompt。不要在 `plan/` 里直接读 profile 原始格式——否则将来加基准会产生第二条并行路径。

## 核心数据契约

```ts
type Plan = {
  summary: string
  target: { root: string; language: string; buildSystem?: string }
  grounded: boolean // 是否基于实测证据
  evidence?: PerformanceEvidence // grounded 为 true 时存在
  steps: Step[]
}

type Step = {
  id: string
  title: string
  rationale: string // 为什么这里判定为瓶颈
  files: string[] // 一律相对目标项目根
  kind: 'refactor' | 'algorithmic' | 'config' | 'dependency' | 'other'
  risk: 'low' | 'medium' | 'high'
  expectedImpact?: string // 仅在有实测证据时给出，见上
}

type PerformanceEvidence = {
  source: 'profile-file' // 将来扩展 'benchmark'
  runtime?: string // 如 node@20.11
  unit: 'time' | 'samples' | 'bytes'
  hotSpots: HotSpot[] // 按占比降序
}

type HotSpot = {
  file: string // 相对目标项目根
  range?: [number, number] // 行范围
  symbol?: string // 函数名
  selfShare: number // 自身耗时占比，0..1
  totalShare?: number
}
```

用 zod（或同类）定义一次，同一份 schema 既喂给 provider 也用于运行时校验。改动这些类型时，prompt、校验、报告输出、落盘的 `plan.json` 四处需同步修改。

所有来自模型或 profile 文件的路径一律为相对目标项目根的路径，且必须做 containment 校验——拒绝 `..` 越界与绝对路径。profile 文件是外部输入，其内容不比模型输出更可信。

首个支持的 profile 格式为 Chrome trace / `.cpuprofile` JSON（Node `--cpu-prof`、Chrome DevTools 及多数采样器均产出此格式）。其他格式由用户先行转换，或走通用的「热点函数列表」入口。

## 安全与边界

这个工具会读用户代码、把内容发给模型、再往里写代码，边界规则不是可选项：

- 所有写操作前对解析后的绝对路径做 containment 校验，必须仍在目标项目根内。
- 默认跳过 `.env` 与凭证、密钥类文件。
- 除配置的 provider 端点外，不把目标项目内容发往任何地方。
- 不执行目标项目中的任意命令。若后续引入基准能力，必须是独立的显式开关（见待定事项）。
- API key 只从环境变量读，不写入配置文件、不落盘、不进日志。

## 待定事项

以下几项尚未最终确认，当前文档与代码按推荐方案推进，确定后需回改本文件：

- **基准与前后验证**：明确推迟。当前实现不做基准执行，因此**无法验证优化后是否真的变快**——`Step.expectedImpact` 是推断而非实测结论。将来若要补，走 `evidence/` 的 `source: 'benchmark'`，并需处理进程执行、预热与统计显著性。
- **命令面**：`plan` / `run` 为核心。`init`（写入配置）与 `report`（历史结果与 diff 查看）为后续补充。
- **配置文件**：`.perftoolrc.json`，可选。零配置即可运行，仅靠环境变量。
