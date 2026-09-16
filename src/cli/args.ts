/**
 * 命令行参数解析。
 *
 * 手写而不引依赖：一共六个 flag，而 CLI 依赖越少启动越快（这是个人人都会反复执行
 * 的命令）。`--flag=value` 与 `--flag value` 两种写法都支持，因为模型和用户都会混用。
 */

export const USAGE = `perf — 代码性能分析与优化

用法:
  perf plan [path]          分析目标项目并生成优化计划，不修改任何代码
  perf run [path]           为计划里的每个步骤生成改动，确认后逐 step 提交到新分支

选项:
  --profile <file>          提供实测 profile（.cpuprofile），基于数据定位热点
  --model <provider/id>     模型标识，如 anthropic/claude-sonnet-5
  --include <glob>          只分析匹配的文件，可重复
  --exclude <glob>          排除匹配的文件，可重复
  --max-rounds <n>          探索轮数上限
  --json                    plan: 把计划以 JSON 打到标准输出
  --by-step                 run: 按步骤展示增量 diff，而非合并 diff
  --emit-patch <file>       run: 把可直接 git apply 的 patch 写到该路径
  --dry-run                 run: 只看不写，绝不修改任何文件
  -y, --yes                 run: 跳过确认直接应用（非交互环境必需）
  -h, --help                显示帮助

配置优先级: 命令行 flag > 环境变量 > .perftoolrc.json > 默认值
环境变量:   PERF_MODEL / PERF_MAX_ROUNDS / PERF_PROFILE

产物:
  .perf/plan.json           优化计划（可人工编辑后再执行）
  .perf/trace.json          探索轨迹，计划不理想时用它诊断模型看了什么

run 的前置条件（不满足会直接拒绝，不会静默降级）:
  - 目标是 git 仓库，且已跟踪文件没有未提交改动（未跟踪文件不影响）
  - 配好了 git user.name / user.email
  - 生成期间这些文件没有被别处改动过

run 会新建分支 perf/<时间戳>-<摘要>，每个步骤一个提交，可单独 revert。
失败时会报告已完成到哪一步，并给出 git reset / branch -D 的回退命令。

退出码:
  0 成功   1 失败   2 用法错误

示例:
  perf plan
  perf plan --profile .perf/app.cpuprofile
  perf run --dry-run                        # 先看看它会改什么
  perf run                                  # 预览后确认，逐 step 提交到新分支
  perf run --emit-patch .perf/changes.patch # 导出 patch 自己 git apply
`

export type CliCommand = 'plan' | 'run' | 'help'

export type CliOptions = {
  command: CliCommand
  /** 位置参数：目标项目路径 */
  target?: string
  profile?: string
  model?: string
  include: string[]
  exclude: string[]
  maxRounds?: number
  json: boolean
  /** `perf run`：按 step 展示增量而非合并 diff */
  byStep: boolean
  /** `perf run`：把可 git apply 的 patch 写到这个路径 */
  emitPatch?: string
  /** `perf run`：只看不写 */
  dryRun: boolean
  /** `perf run`：跳过确认直接应用（非交互环境必需） */
  yes: boolean
}

export type ParseResult = { ok: true; options: CliOptions } | { ok: false; error: string }

const COMMANDS = new Set<CliCommand>(['plan', 'run', 'help'])

/** 需要取值的 flag */
const VALUE_FLAGS = new Set([
  '--profile',
  '--model',
  '--include',
  '--exclude',
  '--max-rounds',
  '--emit-patch',
])
/** 可重复的 flag */
const REPEATABLE = new Set(['--include', '--exclude'])

export const parseArgs = (argv: readonly string[]): ParseResult => {
  const options: CliOptions = {
    command: 'help',
    include: [],
    exclude: [],
    json: false,
    byStep: false,
    dryRun: false,
    yes: false,
  }

  let commandSeen = false
  let i = 0
  while (i < argv.length) {
    const token = argv[i]
    if (token === undefined) break
    i++

    if (token === '-h' || token === '--help') {
      options.command = 'help'
      return { ok: true, options }
    }

    if (token === '--json') {
      options.json = true
      continue
    }

    if (token === '--by-step') {
      options.byStep = true
      continue
    }

    if (token === '--dry-run') {
      options.dryRun = true
      continue
    }

    if (token === '--yes' || token === '-y') {
      options.yes = true
      continue
    }

    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      const name = eq === -1 ? token : token.slice(0, eq)
      let value = eq === -1 ? undefined : token.slice(eq + 1)

      if (!VALUE_FLAGS.has(name)) {
        return { ok: false, error: `未知选项 ${name}。用 --help 查看可用选项` }
      }
      if (value === undefined) {
        value = argv[i]
        if (value === undefined || value.startsWith('--')) {
          return { ok: false, error: `${name} 需要一个值` }
        }
        i++
      }
      // 可重复的选项累积，其余覆盖
      if (REPEATABLE.has(name)) {
        if (name === '--include') options.include.push(value)
        else options.exclude.push(value)
        continue
      }
      switch (name) {
        case '--profile':
          options.profile = value
          break
        case '--model':
          options.model = value
          break
        case '--max-rounds': {
          const n = Number(value)
          if (!Number.isInteger(n) || n < 1) {
            return { ok: false, error: `--max-rounds 需要正整数，收到 ${value}` }
          }
          options.maxRounds = n
          break
        }
        case '--emit-patch':
          options.emitPatch = value
          break
        default:
          break
      }
      continue
    }

    if (token.startsWith('-') && token !== '-') {
      return { ok: false, error: `未知选项 ${token}。用 --help 查看可用选项` }
    }

    // 位置参数
    if (!commandSeen && COMMANDS.has(token as CliCommand)) {
      options.command = token as CliCommand
      commandSeen = true
      continue
    }
    if (options.target === undefined) {
      options.target = token
      continue
    }
    return { ok: false, error: `多余的参数 ${token}` }
  }

  return { ok: true, options }
}
