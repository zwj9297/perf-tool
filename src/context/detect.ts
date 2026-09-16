/**
 * 目标项目探测：填 `Plan.target` 用。
 *
 * **这一块比原设计小得多，原因是 D3。** 原设计里 `context/` 还要做文件发现、相关性
 * 排序、上下文预算裁剪——但选了 agentic 循环之后，**模型通过只读工具自己做发现**，
 * 那些工作整个不需要了。这里只剩"语言与构建系统"这种我们从文件名一眼能看出、
 * 而模型要花一轮工具调用才能问出来的元信息。
 *
 * 忽略规则也不在这里：它在 `tools/ignore.ts`，单一来源，不要另写一套。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type ProjectTarget = {
  root: string
  language: string
  buildSystem?: string
}

/** 按优先级排列：命中第一个即为准。多语言仓库取优先级最高的那个。 */
const LANGUAGE_MARKERS: { file: string; language: string }[] = [
  { file: 'tsconfig.json', language: 'TypeScript' },
  { file: 'go.mod', language: 'Go' },
  { file: 'Cargo.toml', language: 'Rust' },
  { file: 'pyproject.toml', language: 'Python' },
  { file: 'setup.py', language: 'Python' },
  { file: 'requirements.txt', language: 'Python' },
  { file: 'pom.xml', language: 'Java' },
  { file: 'build.gradle', language: 'Java' },
  { file: 'build.gradle.kts', language: 'Kotlin' },
  { file: 'Gemfile', language: 'Ruby' },
  { file: 'composer.json', language: 'PHP' },
  { file: 'CMakeLists.txt', language: 'C/C++' },
  { file: 'package.json', language: 'JavaScript' },
]

/** 同样按优先级：先看更具体的锁文件，`package.json` 兜底 */
const BUILD_SYSTEM_MARKERS: { file: string; buildSystem: string }[] = [
  { file: 'pnpm-lock.yaml', buildSystem: 'pnpm' },
  { file: 'yarn.lock', buildSystem: 'yarn' },
  { file: 'bun.lockb', buildSystem: 'bun' },
  { file: 'bun.lock', buildSystem: 'bun' },
  { file: 'package-lock.json', buildSystem: 'npm' },
  { file: 'Cargo.toml', buildSystem: 'cargo' },
  { file: 'go.mod', buildSystem: 'go' },
  { file: 'pyproject.toml', buildSystem: 'pyproject' },
  { file: 'pom.xml', buildSystem: 'maven' },
  { file: 'build.gradle', buildSystem: 'gradle' },
  { file: 'build.gradle.kts', buildSystem: 'gradle' },
  { file: 'package.json', buildSystem: 'npm' },
]

const firstExisting = <T extends { file: string }>(
  root: string,
  markers: readonly T[],
): T | undefined => {
  for (const m of markers) {
    if (existsSync(join(root, m.file))) return m
  }
  return undefined
}

/**
 * 尽力而为的探测，**不是权威判断**。
 *
 * 判不出来时 `language` 是 `'unknown'` 而不是编一个——这个字段会进提示词，
 * 编错会让模型基于错误前提推理（比如把 Rust 项目当 TypeScript 建议用 Map）。
 */
export const detectProjectTarget = (projectRoot: string): ProjectTarget => {
  const language = firstExisting(projectRoot, LANGUAGE_MARKERS)?.language ?? 'unknown'
  const buildSystem = firstExisting(projectRoot, BUILD_SYSTEM_MARKERS)?.buildSystem

  return buildSystem === undefined
    ? { root: projectRoot, language }
    : { root: projectRoot, language, buildSystem }
}
