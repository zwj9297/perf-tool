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
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type ProjectTarget = {
  root: string
  language: string
  buildSystem?: string
}

/**
 * 按优先级排列：命中第一个即为准。多语言仓库取优先级最高的那个。
 *
 * **这里刻意不含 `package.json`**：它只说明"这是个 npm 包"，说明不了语言。实测过
 * 一次误判——`little-candy-chatbot` 有 68 个 `.ts` 文件、devDependencies 里装着
 * `typescript`，但根目录没有 `tsconfig.json`（每个 workspace 包各有一个），于是被
 * 判成 JavaScript，而这条错误事实会被写进提示词。所以它放到最后，且先看下面两个
 * 更具体的信号。
 */
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
]

/** 单仓里包目录的常见命名。只探一层——再深就该靠 `context/` 的正式发现了 */
const WORKSPACE_DIRS = ['packages', 'apps', 'workspaces']

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
/**
 * 根目录的标记文件看不出来时，再用两个更具体的信号判断是不是 TypeScript 项目。
 *
 * 存在的理由是一次实测误判：单仓的 `tsconfig.json` 分散在每个包里，只看根就会把
 * 整个 TypeScript 单仓判成 JavaScript。而 `language` 会进提示词——喂错它会让模型
 * 基于错误前提推理（比如建议一个 JS 项目用 TS 的类型技巧）。
 */
const hasTypeScriptSignal = (projectRoot: string): boolean => {
  // 信号 1：装了 typescript。`tsc --checkJs` 这类只做类型检查的 JS 项目也会命中，
  // 但那种项目本来就在用 TS 工具链，标成 TypeScript 远比标成 JavaScript 接近事实。
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
    if (typeof pkg === 'object' && pkg !== null) {
      const p = pkg as Record<string, unknown>
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        const deps = p[field]
        if (typeof deps === 'object' && deps !== null && 'typescript' in deps) return true
      }
    }
  } catch {
    // 没有 package.json 或读不了：不是错误，继续看下一个信号
  }

  // 信号 2：某个包目录里有 tsconfig.json（单仓的典型形态）
  for (const dir of WORKSPACE_DIRS) {
    let entries: string[]
    try {
      entries = readdirSync(join(projectRoot, dir))
    } catch {
      continue
    }
    for (const name of entries) {
      if (existsSync(join(projectRoot, dir, name, 'tsconfig.json'))) return true
    }
  }

  return false
}

const detectLanguage = (projectRoot: string): string => {
  const byMarker = firstExisting(projectRoot, LANGUAGE_MARKERS)?.language
  if (byMarker !== undefined) return byMarker
  if (hasTypeScriptSignal(projectRoot)) return 'TypeScript'
  // 到这里还看不出语言的 npm 包，就当 JavaScript
  if (existsSync(join(projectRoot, 'package.json'))) return 'JavaScript'
  return 'unknown'
}

export const detectProjectTarget = (projectRoot: string): ProjectTarget => {
  const language = detectLanguage(projectRoot)
  const buildSystem = firstExisting(projectRoot, BUILD_SYSTEM_MARKERS)?.buildSystem

  return buildSystem === undefined
    ? { root: projectRoot, language }
    : { root: projectRoot, language, buildSystem }
}
