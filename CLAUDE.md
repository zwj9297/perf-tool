# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

`@zwj9297/perf-tool` 是一个分析代码性能瓶颈并给出优化方案的 CLI（命令名 `perf`），以**目标项目的开发时依赖**形式安装，在目标项目目录下调用大模型完成分析与优化。

本仓库是工具自身的源码，不是被分析的目标项目——所有读取/修改代码的逻辑，作用于用户当前工作目录下的目标项目，而非本仓库。

架构为 Plan-and-Execute：先由模型产出可审阅的结构化优化计划，再逐步执行并落地改动。

## 已确定的决策

| 维度              | 决策                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| 语言 / 模块       | TypeScript + ESM（`"type": "module"`，发布产物为 ESM）                                              |
| 包名 / 命令       | 包 `@zwj9297/perf-tool`，命令 `perf`                                                                |
| 安装形态          | 目标项目的 devDependency，项目内执行。**不提供全局安装**                                            |
| LLM 接入          | `@earendil-works/pi-ai`。跨 provider 的工具调用与认证由它归一化，我们只写薄适配层，**不自建抽象层** |
| 性能事实来源      | 实测证据优先，静态分析兜底，且两种模式行为**不同**（见下）                                          |
| Plan→Execute 衔接 | 交互确认与全自动两种模式，flag 切换                                                                 |
| 改动落地          | 在目标项目新建 git 分支并逐 step 提交                                                               |
| 工具链            | ESM + `nodenext`、Vitest、ESLint flat config + Prettier、Node 引擎 `>=20`                           |
| TypeScript        | 锁 `^6`。**不要升到 7** —— typescript-eslint 的 peer 范围是 `<6.1.0`，升上去 lint 工具链直接装不上  |
| 设计文档          | [docs/design.md](./docs/design.md) —— 决策理由、派生的关键设计、被否方案                            |

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

**`npm test` 通过不代表代码类型正确**：vitest 只转译不做类型检查，所以类型错误在测试里是看不出来的。改动后 `npm run typecheck` 是必跑项，不能只看测试绿。

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
npx perf --help          # 验证 bin、ESM 加载、以及对 pi-ai 的运行时依赖都能解析
```

想验证得更彻底就跑 `npx perf plan`——但那需要一个可用的模型凭证，所以自动化环境里用
`--help` 做冒烟即可（它能证明模块图完整加载，包括体积最大的那个依赖）。

`npm link` 更快，但它软链源码而非走打包流程，会掩盖 `files` 白名单遗漏和运行时资源路径错误。

两个 tsconfig 的分工不能合并：`tsconfig.json` 只做类型检查（`noEmit`，覆盖 `src` 与 `tests`），`tsconfig.build.json` 负责产出（`rootDir: "src"` → `dist`）。若让一个配置同时 emit 两者，产物会变成 `dist/src` 与 `dist/tests`，`bin` 指向的路径随即失效。所以 `npm run typecheck` 会检查测试文件，而 `npm run build` 不产出它们。

## 架构：两阶段流水线

```text
perf plan [path]                    # 只读，绝不修改目标项目
  1. 解析配置 + 定位目标项目根
  2. 校验 git 前置条件，归一化性能证据 → PerformanceEvidence | null
  3. 只读工具探索循环（read_file / grep / glob / list_dir），有界
     模型通过调用 submit_plan 收尾；触顶则把工具集收缩为只剩它
  4. 计划落盘到 .perf/plan.json，工具轨迹落盘到 .perf/trace.json

perf run                            # 写，逐个 step 提交
  1. 读取 .perf/plan.json（不存在则提示先跑 plan），校验它是为当前项目生成的
  2. 逐 step 生成改动，按序叠加到内存快照（overlay）
  3. 预览「原始 → 最终」的按文件合并 diff
  4. 校验基线未被改动 + git 前置条件（**在问确认之前**，免得用户白确认）
  5. 等待确认；--yes 跳过，--dry-run 到这一步就停
  6. 创建分支 perf/<时间戳>-<摘要>，按序落盘，每个 Step 一次 commit
  7. 汇总报告并给出回退命令；失败时说明已完成到哪一步
```

两个阶段可分开调用是关键设计：`plan` 不碰代码，`run` 能消费**人工编辑过**的 plan。因此两阶段之间只以 `Plan` 这一个契约衔接，不要引入额外的进程内状态传递或隐式全局。

`src/` 模块划分：

- `cli/` — 命令注册、flag 解析、两种模式的分支
- `config/` — 配置 schema 与优先级解析
- `providers/` — pi-ai 适配层（**不是抽象层**）：配置 → Models 构造、认证预检。`types.ts` 是循环依赖的**窄接口（一个回合）**，`pi.ts` 是 pi-ai 实现
- `evidence/` — profile 解析与归一化（`.cpuprofile` → `PerformanceEvidence`）。**已完成**（`parse.ts` + `types.ts`，93 个测试）。**四条硬约束，写错任何一条都会让模型优化错地方**：① 按 `(文件, 行)` 归因而非按函数名（V8 内联会让函数名指向错误的函数，实测真凶行被算到了调用者名下）；② `positionTicks[].line` 是 **1-based** 而 `callFrame.lineNumber` 是 **0-based**；③ 必须累加 `timeDeltas` 而非 `hitCount × 名义间隔`（实测差 24%）；④ 路径含 `node_modules` 段的**一律**算依赖，**不管它在不在项目根内**——只判"是否出根"会让根内的依赖热点进 `hotSpots`，模型就会去优化一个第三方包。详见设计文档 §6
- `context/` — 目标项目探测（语言 / 构建系统），**已完成但比原设计小得多**：D3 选了 agentic 循环之后，"文件发现 / 相关性排序 / 上下文预算"整个不需要了，模型用工具自己发现。忽略规则也不在这里，在 `tools/ignore.ts`（单一来源）
- `tools/` — 只读工具集 **已完成**：`paths.ts`（安全闸门）、`glob.ts`（匹配）、`ignore.ts`（忽略规则）、`toolbox.ts`（四个工具 + 参数校验），37 个测试。四条硬约束：① 所有访问过 `resolveInsideProject`，**先 `realpath` 再判 containment**——指向项目外的软链在字符串上看着完全合法；② **凭证文件必须四个工具一致地不可见也不可读**（只挡 `read_file` 会让 `list_dir` / `grep` / `glob` 泄露它们的存在）；③ 输出上限只在**我们因上限砍掉了本来能返回的内容**时才算 `truncated`——模型自己指定的范围被满足、或被文件末尾截住，都不算，那时提示"请缩小范围"是误导；④ 不 shell、不用 experimental 的 `fs.globSync`，glob 与参数校验全用 JS
- `plan/` — **已完成**：`loop.ts`（有界探索循环）、`prompt.ts`（含证据有无的行为分叉）、`schema.ts`（`PlanDraft` + 校验）。循环只依赖 `providers/types.ts` 与 `tools/types.ts` 的窄接口，所以能用假 provider + 假 toolbox 测完（152 个测试中有 59 个属于这块）
- `diff/` — diff 规范化（`normalize.ts`，只修结构）、应用（`apply.ts`，含唯一性预检与多文件拆分）。基于 `diff` 包，但 **recount 与唯一性检查必须自己写**，失败原因的分类与处置见设计文档 §2.6 ~ §2.8
- `execute/` — **已完成**：`overlay.ts`（预测态快照）、`generate.ts`（逐 step 生成 + 重试）、`preview.ts`（合并 diff 与 patch 导出）、`apply.ts`（**唯一会写用户源码的地方**）。五条硬约束：① 生成按序叠加到 overlay，**step N 必须看到前 N-1 步的结果**（否则同一文件被多步触及时 diff 锚点会互相矛盾）；② 多文件段的 patch 要**先在暂存区全部试成功再写回**，否则半途失败会污染快照、后面每步都基于坏状态；③ 预览用「原始 → 最终」的合并 diff，**不是**把各步增量拼起来（那样拼不出能 `git apply` 的东西）；④ 应用前必须比对磁盘与 overlay 记下的原始内容，任何一处不符就拒绝——overlay 是**预测态**，用户在预览后改了文件，预测就不成立，写下去是**静默覆盖**；⑤ 判断 git 命令的结果必须看**退出码**：`rev-parse HEAD` 在空仓库里退出码 128 却把 `HEAD` 打到了 stdout，只看输出会把失败读成成功，前提条件随之形同虚设
  原设计里还规划过 `git/` 与 `report/` 两个模块。**都没有单独建**：git 的分支/提交/回退逻辑只有 `execute/apply.ts` 一个使用方，拆出去只会多一层无谓的间接；结果汇总目前就是 `cli/` 里的输出，等它长到需要复用再说。

### 五个跨模块约束

**`providers/` 是适配层，不是抽象层。** pi-ai 已经提供了跨 provider 的抽象（工具定义、工具调用、工具结果回填、认证解析全部统一），自建第二层只会造成同一份契约的两份定义。它的职责只有三项：配置 → Models 集合的构造、认证预检（`getAuth` / `checkAuth`）、把 pi-ai 的 API 收敛到一个文件里。

**schema 强制与 schema 校验是两件事，都要做。** provider 侧强制走 `constrainedSampling` 的 `strict: 'prefer'`（支持时 provider 强制，不支持时自动退化为普通工具调用）；本地校验走 `validateToolCall`。**默认用 `'prefer'` 而非 `'require'`**——后者在 provider 不支持时会让请求直接失败，而 strict JSON-schema 支持目前限于 OpenAI / Anthropic / Bedrock / Mistral / Gemini 3，本项目的主要用户很可能在用 DeepSeek、Qwen 这类 OpenAI 兼容端点。本地校验才是真正的保证，provider 强制是加分项。

**工具循环在 `plan/`，不在 `providers/`。** 这样循环可以只靠 `fauxProvider()` 脚本化测完，不需要连任何真实 SDK。循环写在 provider 里，测试就得同时 mock 两家。

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
  caveats?: string[] // 探索触顶或信息不足时，模型标注的不确定判断
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

// PerformanceEvidence / HotSpot 的定义见 docs/design.md §5。
// 这里**不重复一份**：同一契约维护两处定义迟早漂移，
// 与「不引入 zod」是同一条理由。
```

用 **TypeBox** 定义一次（pi-ai 从包内再导出 `Type` / `Static` / `TSchema`）——**不要引入 zod**，混用两套 schema 系统意味着同一份契约要维护两份定义。同一份 schema 既喂给 provider 也用于 `validateToolCall` 运行时校验。

枚举必须用 pi-ai 的 `StringEnum` 而**不是** `Type.Enum`：后者生成的 `anyOf` / `const` 结构 Google API 不支持。`Step.kind` 与 `Step.risk` 都适用这条。

**Plan 分两层：`PlanDraft`（模型只提交 `summary` / `caveats` / `steps`）与 `Plan`（额外带 `target` / `grounded` / `evidence`，由我们补全）。** 后三样属于"我们知道得比模型准"的事实，让它提交等于让它编造。模型的输出 schema 靠 `additionalProperties: false` 堵死——实测硬拦生效，模型无法注入 `grounded` / `evidence`，而后者正是 evidence 机制可信度的基础。

改动这些类型时，prompt、校验、报告输出、落盘的 `plan.json` 四处需同步修改。**类型的权威定义在 [docs/design.md](./docs/design.md) §5**，本文件只列 `Plan` / `Step` 作为速查。schema 定义在 `src/plan/schema.ts`。

**pi-ai 的导入路径与 README 不符**（实测 v0.85.1）：`Type` / `Static` / `TSchema` / `Tool` 从根导入，但 **`StringEnum` 要从 `@earendil-works/pi-ai/utils/typebox-helpers`**、**`validateToolCall` / `validateToolArguments` 要从 `.../utils/validation`**。照 README 写会编译不过。包是 ESM-only。

**本地校验是强制转换式的，不是严格式的。** `validateToolArguments` 会把 `summary: 123` 转成 `"123"` 而不是拒绝；枚举、必填、多余字段这几类是硬拦的。所以"本地校验是真正的保证"只在结构层面成立——**给模型输出的 schema 加数值字段时要自己加检查**，否则字符串会被静默转成数字。

所有来自模型或 profile 文件的路径一律为相对目标项目根的路径，且必须做 containment 校验——拒绝 `..` 越界与绝对路径。profile 文件是外部输入，其内容不比模型输出更可信。

首个支持的 profile 格式为 Chrome trace / `.cpuprofile` JSON（Node `--cpu-prof`、Chrome DevTools 及多数采样器均产出此格式）。解析算法、路径分类规则与已知限制见设计文档 §6。其他格式由用户先行转换，或走通用的「热点函数列表」入口。

## 安全与边界

这个工具会读用户代码、把内容发给模型、再往里写代码，边界规则不是可选项：

- 所有读写操作前对解析后的绝对路径做 containment 校验，必须仍在目标项目根内。**读操作前必须先 `fs.realpath` 解析符号链接再校验**——否则一个指向 `/etc/passwd` 的软链就能绕过。目标项目本身也是不可信输入，不只是模型输出不可信。
- 工具输出必须有大小上限，且截断时要**显式告知模型**"结果被截断，请缩小范围"。模型不知道自己被截断时会基于残缺结果下结论，这比报错更危险。
- 默认跳过 `.env` 与凭证、密钥类文件。
- 除配置的 provider 端点外，不把目标项目内容发往任何地方。
- 不执行目标项目中的任意命令。若后续引入基准能力，必须是独立的显式开关（见待定事项）。
- API key 只从环境变量读，不写入配置文件、不落盘、不进日志。

## 待定事项

以下是与实现相关的未定项。**设计层面的待定项以 [docs/design.md](./docs/design.md) §7 为准**，本节只列与日常开发直接相关的：

- **基准与前后验证**：明确推迟。当前实现不做基准执行，因此**无法验证优化后是否真的变快**——`Step.expectedImpact` 是推断而非实测结论。将来若要补，走 `evidence/` 的 `source: 'benchmark'`，并需处理进程执行、预热与统计显著性。
- **`diff/` 已完成**（`normalize.ts` + `apply.ts`，62 个测试）。下面这些不变量都已落实并各有对应用例，**改动这块时不要删**：结果 `!==` 输入（0 hunk 时 jsdiff 原样返回源文本，"没改"与"成功"无法区分，漏掉会产出空 commit）；多文件段拒绝并靠 `splitByFile` 拆开；定位不唯一必须报错（jsdiff 无严格模式，默认静默改第一处）；抛异常与返回 `false` 两种失败形态都接住。失败分类与处置见 design.md §2.8。
- **`perf plan` 已经端到端可用**：`config/`（`.perftoolrc.json` + flag + env，手写校验）、`context/detect.ts`、`cli/args.ts`、`cli/plan-command.ts`（可注入依赖的串联）、`cli/index.ts`（薄路由）。集成测试用**真 toolbox + 假 provider**跑通整条链，另有真实命令行冒烟。
- **两条命令都端到端可用了**：`perf plan` 与 `perf run`（生成 → 预览 → 确认 → 落盘提交）。集成测试覆盖真 git（含 `git apply --check`）与真文件系统。
- **`tools/` 的已知取舍**：走树时**跳过符号链接**（所以目录软链永远走不出项目根，代价是软链文件不会被枚举），只读**项目根**的 `.gitignore`（嵌套的 `.gitignore` 不生效）。这两条都是刻意的，改动前先想清楚。
- **`execute/` 生成阶段没有工具**。模型只能看到 `step.files` 的内容，不能自己再读调用点，而 plan 阶段有完整只读工具集。**接上是自然的下一步增强**，尤其是 step 需要参考调用者时。
- **新建 / 删除文件的 patch 暂不支持**（`diff/` 返回 `unsupported-file-op`）。模型确实会产出这类 patch（典型如"把这段逻辑抽成新文件"）。要么让 `plan/` 在 prompt 里明确禁止，要么让 `execute/` 跳过并计入报告——**目前两者都还没做**。
- **命令面**：`plan` / `run` 为核心。`init`（写入配置）与 `report`（历史结果与 diff 查看）为后续补充。
- **配置文件**：`.perftoolrc.json`，可选。零配置即可运行，仅靠环境变量。注意 provider 的选型方式因 pi-ai 而简化——不再需要 `provider` + `baseUrl` 的组合，改为模型标识 + pi-ai 的认证解析。
