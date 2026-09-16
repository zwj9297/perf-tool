/**
 * 目标项目探测的测试。
 *
 * 重点在**单仓里语言不能判错**：这条错误事实会直接进提示词，让模型基于错误前提推理。
 * 由来是一次实测——`little-candy-chatbot` 有 68 个 `.ts` 文件、devDependencies 里装着
 * `typescript`，但根目录没有 `tsconfig.json`（每个 workspace 包各有一个），于是被判成
 * JavaScript。所以最后一条用例直接复刻了那个形态。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { detectProjectTarget } from '../../src/context/detect.js'

type Files = Record<string, string>

const withProject = (files: Files): { root: string; clean: () => void } => {
  const root = mkdtempSync(join(tmpdir(), 'perf-detect-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return { root, clean: () => rmSync(root, { recursive: true, force: true }) }
}

const pkg = (fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: 'x', version: '1.0.0', ...fields })

describe('语言探测', () => {
  it('根目录有 tsconfig.json → TypeScript', () => {
    const { root, clean } = withProject({ 'tsconfig.json': '{}', 'package.json': pkg() })
    try {
      expect(detectProjectTarget(root).language).toBe('TypeScript')
    } finally {
      clean()
    }
  })

  it('根目录只有 package.json → JavaScript', () => {
    const { root, clean } = withProject({ 'package.json': pkg() })
    try {
      expect(detectProjectTarget(root).language).toBe('JavaScript')
    } finally {
      clean()
    }
  })

  it('package.json 里装了 typescript（无根 tsconfig）→ TypeScript', () => {
    const { root, clean } = withProject({
      'package.json': pkg({ devDependencies: { typescript: '^5.7.0' } }),
    })
    try {
      expect(detectProjectTarget(root).language).toBe('TypeScript')
    } finally {
      clean()
    }
  })

  it('peerDependencies 里的 typescript 也算', () => {
    const { root, clean } = withProject({
      'package.json': pkg({ peerDependencies: { typescript: '*' } }),
    })
    try {
      expect(detectProjectTarget(root).language).toBe('TypeScript')
    } finally {
      clean()
    }
  })

  it('单仓：包目录里有 tsconfig.json → TypeScript（packages / apps 都认）', () => {
    for (const dir of ['packages', 'apps']) {
      const { root, clean } = withProject({
        'package.json': pkg(),
        [`${dir}/a/tsconfig.json`]: '{}',
      })
      try {
        expect(detectProjectTarget(root).language).toBe('TypeScript')
      } finally {
        clean()
      }
    }
  })

  it('复刻实测形态：单仓 + typescript 依赖 + 无根 tsconfig → TypeScript，不是 JavaScript', () => {
    const { root, clean } = withProject({
      'package.json': pkg({
        workspaces: ['packages/shared', 'packages/server', 'packages/client'],
        devDependencies: { typescript: '^5.7.0', concurrently: '^9.1.0' },
      }),
      'packages/shared/tsconfig.json': '{}',
      'packages/server/tsconfig.json': '{}',
      'packages/client/tsconfig.json': '{}',
      'packages/server/src/a.ts': 'export const x = 1\n',
    })
    try {
      expect(detectProjectTarget(root).language).toBe('TypeScript')
    } finally {
      clean()
    }
  })

  it('其它语言按各自的标记文件识别', () => {
    const cases: Record<string, string> = {
      'go.mod': 'Go',
      'Cargo.toml': 'Rust',
      'pyproject.toml': 'Python',
      'requirements.txt': 'Python',
      'pom.xml': 'Java',
      Gemfile: 'Ruby',
      'composer.json': 'PHP',
      'CMakeLists.txt': 'C/C++',
    }
    for (const [file, language] of Object.entries(cases)) {
      const { root, clean } = withProject({ [file]: 'x' })
      try {
        expect(detectProjectTarget(root).language).toBe(language)
      } finally {
        clean()
      }
    }
  })

  it('什么都没有时是 unknown，而不是编一个', () => {
    const { root, clean } = withProject({})
    try {
      expect(detectProjectTarget(root).language).toBe('unknown')
    } finally {
      clean()
    }
  })

  it('tsconfig.json 的优先级仍高于 typescript 依赖（根上有就用根上的）', () => {
    const { root, clean } = withProject({
      'tsconfig.json': '{}',
      'package.json': pkg({ devDependencies: { typescript: '^5' } }),
    })
    try {
      expect(detectProjectTarget(root).language).toBe('TypeScript')
    } finally {
      clean()
    }
  })

  it('package.json 损坏/不可解析时不抛异常，也不误判', () => {
    const { root, clean } = withProject({ 'package.json': '{ 坏掉的 json' })
    try {
      expect(detectProjectTarget(root).language).toBe('JavaScript')
    } finally {
      clean()
    }
  })
})

describe('构建系统探测', () => {
  it('按锁文件判断，package.json 兜底 npm', () => {
    const cases: Record<string, string> = {
      'pnpm-lock.yaml': 'pnpm',
      'yarn.lock': 'yarn',
      'package-lock.json': 'npm',
      'Cargo.toml': 'cargo',
      'go.mod': 'go',
    }
    for (const [file, buildSystem] of Object.entries(cases)) {
      const { root, clean } = withProject({ 'package.json': pkg(), [file]: 'x' })
      try {
        expect(detectProjectTarget(root).buildSystem).toBe(buildSystem)
      } finally {
        clean()
      }
    }
  })

  it('没有任何标记时 buildSystem 省略（而不是编一个）', () => {
    const { root, clean } = withProject({ 'src/a.ts': '' })
    try {
      expect(detectProjectTarget(root).buildSystem).toBeUndefined()
    } finally {
      clean()
    }
  })
})
