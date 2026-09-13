#!/usr/bin/env node

/*
 * 占位实现，仅用于验证构建、打包与 bin 链路是否打通。
 * 真正的子命令路由、配置解析与 Plan/Execute 流水线尚未开始，
 * 见 CLAUDE.md「架构」一节。
 */

const USAGE = `perf — 代码性能分析与优化

用法:
  perf plan [path]          分析并生成优化计划，不修改代码
  perf run                  读取计划并逐条执行

选项:
  --profile <file>          提供实测 profile 数据
  --model <name>            临时指定模型
  --dry-run                 只展示将要做什么，不写文件
  --yes                     跳过确认
  -h, --help                显示帮助
`

const command = process.argv[2]

if (command === undefined || command === '-h' || command === '--help') {
  console.log(USAGE)
} else {
  console.error(`perf: 子命令 "${command}" 尚未实现`)
  // 用 exitCode 而非 process.exit()：后者会在 stdout 被管道消费时截断输出
  process.exitCode = 1
}
