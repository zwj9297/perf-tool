# @zwj9297/perf-tool

在项目里调用大模型，分析代码性能瓶颈并给出可执行的优化方案。作为开发时依赖安装，版本随项目锁定。

> **状态**：两项都可用。
>
> - `perf plan` — 分析项目并生成优化计划，**不修改任何代码**。
> - `perf run` — 为每个步骤生成改动、**预览 diff**，确认后新建分支并**逐 step 提交**；
>   也可以只导出 patch 由你自己 `git apply`，或加 `--dry-run` 只看不写。

## 它怎么工作

采用 Plan-and-Execute 两阶段架构，两阶段可以分开调用：

1. **Plan（只读）** — 大模型用一组**只读工具**（读文件、正则搜索、目录遍历）自主探索你的代码，结合你提供的性能数据（可选），产出一份结构化的优化计划：每个优化点包含原因、涉及文件、改动类型和风险等级。计划会落盘，**你可以在执行前审阅甚至手工编辑它**。
2. **Execute（写入）** — 为计划里的每个步骤生成具体改动，**预览的是「原始状态 → 最终状态」的合并 diff**（不是把各步增量拼起来）。确认后新建分支、**逐 step 提交**，每条优化点一个 commit，方便逐个 review、单独 revert；也可以只导出 patch 由你自己 `git apply`。

`plan` 阶段不碰你的代码一个字，这让「先看看它想干什么」变成零成本的默认动作。

## 安装

作为开发时依赖装进你的项目：

```bash
npm i -D @zwj9297/perf-tool
```

非 Node 项目（Python、Go、Rust 等）不必往包里塞一个 npm 依赖，用 `npx` 一次性调用即可：

```bash
cd your-repo && npx @zwj9297/perf-tool plan
```

> 注意：**只有已经装为依赖之后**才能用裸命令 `npx perf`。本地找不到时，`npx` 会去 npm registry 拉一个同名包来执行。不确定时请用完整包名。

## 快速开始

```bash
cd your-project
npx perf plan              # 分析并生成优化计划，不修改任何代码
npx perf run               # 生成改动、预览 diff，确认后逐 step 提交到新分支
npx perf run --dry-run     # 只看不写
npx perf run --emit-patch .perf/changes.patch   # 导出 patch，你自己 git apply
```

`plan` 会把结果写进 `.perf/plan.json`（可人工编辑）和 `.perf/trace.json`（探索轨迹，
计划不理想时用它看模型读了什么）。

建议在 `package.json` 里加上 script，省去每次输入：

```json
{
  "scripts": {
    "perf:plan": "perf plan",
    "perf:run": "perf run"
  }
}
```

配置 API key（二选一，取决于你用哪家模型）：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# 或
export OPENAI_API_KEY=sk-...
```

## 两类事实来源，两种行为

这是理解本工具输出的关键。

**提供了性能数据时** —— 工具基于实测热点定位瓶颈，按真实耗时占比排序，每个优化点给出预期收益。这是推荐用法，结论可信。

**没有提供时** —— 工具退化为静态代码分析：只报告能从代码本身判定的问题（给定数据规模下的算法复杂度、N+1 查询、热路径上的同步 IO、重复计算等）。此时它**不会给出收益排序**，因为无从判断哪处更值得改。编造的排序比没有排序更糟——它会让你先优化错的地方。

静态分析能发现真问题，但它有一个可预测的盲区：**它会优化「看起来慢」的而不是「确实慢」的**。同一个 O(n²) 循环跑在 10 个元素上无关痛痒，藏在百万级热循环里就是灾难，而代码长得一样。真正吃掉 60% 时间的也可能是某个依赖或 IO 等待，而代码里最丑的那段只占 3%。想要可信结论，请提供 profile 数据。

### 提供 profile 数据

Node 项目直接产出：

```bash
node --cpu-prof --cpu-prof-dir=.perf ./your-benchmark.js
npx perf plan --profile .perf/<生成的>.cpuprofile
```

其他语言用各自采样器产出 profile 后，转成 Chrome trace / `.cpuprofile` JSON 格式即可（Node `--cpu-prof`、Chrome DevTools 及多数采样器都产出此格式）。也可以直接在配置里指定路径，省去每次传参。

同一仓库跑两次会得到不同的探索路径和不同的计划——模型是自主探索的，不是固定流水线。`.perf/trace.json` 记录了它读了什么，计划不理想时从这里看起。

## 命令

| 命令               | 说明                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `perf plan [path]` | 分析目标项目并生成优化计划，写入 `.perf/plan.json`。不修改代码。                              |
| `perf run [path]`  | 为每个步骤生成改动并预览 diff，确认后新建分支、逐 step 提交。默认修改文件，`--dry-run` 只看。 |

`perf plan` 的 flag（均已实现）：

```bash
perf plan --profile .perf/profile.cpuprofile   # 提供实测数据，进入"基于数据定位"模式
perf plan --model anthropic/claude-sonnet-5    # 临时指定模型
perf plan --include 'src/**' --include 'lib/**' # 只分析匹配的文件（可重复）
perf plan --exclude '**/*.test.ts'             # 排除匹配的文件（可重复）
perf plan --max-rounds 20                      # 探索轮数上限
perf plan --max-tokens 400000                  # 累计未缓存输入 token 上限
perf plan --json                               # 把计划以 JSON 打到标准输出（便于脚本消费）
perf plan ../other-repo                        # 不在当前目录时指定目标
```

环境变量：`PERF_MODEL` / `PERF_MAX_ROUNDS` / `PERF_MAX_TOKENS` / `PERF_PROFILE`。

**两个成本上限互补，谁先到取决于仓库规模。** `--max-rounds` 限制交换轮数；`--max-tokens` 限制**未命中缓存的输入** token。小仓库上每轮新内容少，轮数会先到；大仓库上每轮读进来的文件更大，token 预算会先到。

（为什么量"未缓存输入"而不是"总上下文"：prompt 的前缀会被 provider 缓存，缓存命中那部分便宜得多，不该按全价计入成本。副作用是不支持缓存的供应商会更早用尽——那是安全的方向。）

`perf run` 的 flag：

```bash
perf run --dry-run                             # 只看不写，绝不修改任何文件
perf run -y                                    # 跳过确认直接应用（非交互环境必需）
perf run --emit-patch .perf/changes.patch      # 导出可直接 git apply 的 patch
perf run --by-step                             # 按步骤看增量 diff（默认看合并 diff）
perf run ../other-repo                         # 不在当前目录时指定目标
```

`perf run` 的流程是**生成 → 预览 → 等你确认 → 才动文件**。确认之前它会先查完所有会拒绝的条件（见下），所以不会出现"读完 diff 点了 y 才说不满足前提"。

导出的 patch 是相对**真实基线**算的合并 diff——不是把各步骤的增量拼起来（那样拼不出能 `git apply` 的东西），所以可以直接 `git apply`。

**前置条件**（不满足直接拒绝，不会静默降级）：

- 目标是 git 仓库，且**已跟踪文件没有未提交改动**（未跟踪文件不影响，所以 `.perf/` 无需 gitignore）
- 配好了 `user.name` / `user.email`
- 生成期间这些文件没有被别处改动过——预览之后你在另一个终端改了同一个文件，工具会拒绝而不是覆盖你的改动

**非交互终端里不猜**：不设 `--yes` 时会拒绝执行并提示，而不是默认同意。

## 配置

零配置即可运行。需要定制时，在项目根目录放一个 `.perftoolrc.json`：

```json
{
  "model": "anthropic/claude-sonnet-5",
  "include": ["src/**/*.ts"],
  "exclude": ["**/*.test.ts", "dist/**"],
  "maxTokens": 400000,
  "evidence": {
    "profile": ".perf/profile.cpuprofile"
  }
}
```

切换供应商只需换模型标识，用哪家、怎么认证都由底层自动解析（Anthropic、OpenAI、DeepSeek、Gemini、Groq、Mistral、OpenRouter、Bedrock，以及任意 OpenAI 兼容端点如 Ollama、vLLM、LM Studio）：

```json
{
  "model": "deepseek/deepseek-chat"
}
```

配置优先级：命令行 flag > 环境变量 > `.perftoolrc.json` > 默认值。

**API key 只能通过环境变量提供**，不接受写进配置文件，也不会被落盘。各家用各自的标准变量名（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`DEEPSEEK_API_KEY`、`GEMINI_API_KEY` 等）。

## 安全与回滚

`plan` 全程只读；`run` 在**你确认之后**才会动文件。边界是明确的：

- 执行前要求工作区干净（已跟踪文件），改动落在新分支 `perf/<时间戳>-<摘要>` 上，不污染你当前的分支。
- 每条优化点独立 commit，`git revert` 或 `git reset` 可以精确回退到任意一步。
- 失败中断时会报告已完成到哪一步，并给出 `git checkout <原分支>` / `git reset --hard <起始SHA>` / `git branch -D` 的回退命令。
- 预览之后文件被别处改动过，会**拒绝应用**并指出是哪些文件，而不是覆盖你的改动。
- 所有读写都经过路径校验（**含符号链接解析**），不会触及项目根目录之外的文件。
- `plan` 阶段的工具全部只读，且不会执行你项目里的任何命令。
- 默认跳过 `.env` 与凭证类文件——而且对四个工具**一致地不可见**，不只是读不到。
- 代码内容只会发送到你自己配置的模型端点。
- 不想让工具碰代码：`perf run --dry-run` 或 `--emit-patch <file>`。

彻底放弃一次运行：切回原分支，删掉 `perf/` 开头的分支即可。

## 已知限制

**行号指向构建产物，不是 TypeScript 源码。** 工具不解析 source map。对 TS 项目，热点行号是编译后 JS 的行号，需要你自己对照 source map。这是 v1 明确接受的限制——代价是 TS 项目体验打折，换来的是避开构建产物缺失、outDir 布局多样等一串降级问题。

**部分热点只有函数级精度。** CPU profile 里只有一部分函数携带行级采样分布（`positionTicks`）。没有这些数据的函数只能定位到定义行，工具会明确标出哪些条目是函数级精度，不会让你误以为全部精确到行。

**不替你采集数据，也不跑基准。** 你需要自己提供 profile 文件。工具不会运行你的代码，因此也**无法验证优化后是否真的变快**——计划里的预期收益是基于实测耗时占比的推断，不是前后对比的结论。请以你自己项目的基准测试为准。

**profile 必须在当前项目目录下采集。** 工具对路径做严格匹配（会先做 realpath 归一化，所以经软链接访问的项目也能对上），不做模糊匹配。匹配不上会直接报错并提示你在项目根重新采集，而不是猜一个可能错的文件——**匹配到错的文件比没有热点更糟**，模型会去优化一个根本不热的地方。

## 开发

见 [CLAUDE.md](./CLAUDE.md)。
