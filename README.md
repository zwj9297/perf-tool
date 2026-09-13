# @zwj9297/perf-tool

在项目里调用大模型，分析代码性能瓶颈并给出可执行的优化方案。作为开发时依赖安装，版本随项目锁定。

> **状态**：设计阶段。当前仓库只有文档，尚未实现。

## 它怎么工作

采用 Plan-and-Execute 两阶段架构，两阶段可以分开调用：

1. **Plan（只读）** — 采集目标项目的代码上下文，结合你提供的性能数据（可选），交给大模型分析，产出一份结构化的优化计划：每个优化点包含原因、涉及文件、改动类型和风险等级。计划会落盘，**你可以在执行前审阅甚至手工编辑它**。
2. **Execute（写入）** — 逐条执行计划。每条优化点单独一次 commit，方便逐个 review、单独 revert。

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
npx perf run               # 审阅确认后逐条执行
```

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

支持的格式与各语言采样器的具体用法会在实现时补齐。

## 命令

| 命令               | 说明                                                               |
| ------------------ | ------------------------------------------------------------------ |
| `perf plan [path]` | 分析目标项目并生成优化计划，写入 `.perf/plan.json`。不修改代码。   |
| `perf run`         | 读取计划并执行。计划不存在时先自动生成。默认展示计划并等待你确认。 |

常用 flag：

```bash
perf plan --profile .perf/profile.cpuprofile   # 提供实测数据
perf plan --model claude-opus-5                # 临时指定模型
perf run --yes                                 # 跳过确认，直接执行（适合脚本/CI）
perf run --dry-run                             # 只展示将要做什么，绝不写文件
```

`--yes` 与 `--dry-run` 是给全自动场景准备的。无人值守地改代码有风险，建议先在 `--dry-run` 下确认计划内容。

## 配置

零配置即可运行。需要定制时，在项目根目录放一个 `.perftoolrc.json`：

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-5",
  "include": ["src/**/*.ts"],
  "exclude": ["**/*.test.ts", "dist/**"],
  "maxContextFiles": 40,
  "evidence": {
    "profile": ".perf/profile.cpuprofile"
  }
}
```

接入 OpenAI 兼容端点（DeepSeek、Qwen、本地 vLLM 等）：

```json
{
  "provider": "openai-compatible",
  "model": "deepseek-chat",
  "baseUrl": "https://api.deepseek.com/v1"
}
```

配置优先级：命令行 flag > 环境变量 > `.perftoolrc.json` > 默认值。

**API key 只能通过环境变量提供**，不接受写进配置文件。

## 安全与回滚

这个工具会修改你的源码，所以边界是明确的：

- 执行前要求工作区干净，改动落在新分支 `perf/<timestamp>-<slug>` 上，不污染你当前的分支。
- 每条优化点独立 commit，`git revert` 或 `git reset` 可以精确回退到任意一步。
- 所有文件写入都经过路径校验，不会写到项目根目录之外。
- 默认跳过 `.env` 与凭证类文件。
- 代码内容只会发送到你自己配置的模型端点。
- 不会执行你项目里的任何命令。

想彻底放弃一次运行：切回原分支，删掉 `perf/` 开头的分支即可。

## 开发

见 [CLAUDE.md](./CLAUDE.md)。
