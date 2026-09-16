import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CONFIG_FILE, defaultMaxRounds, loadConfig, resolveConfig } from '../../src/config/load.js'

const withConfig = (content: string | undefined): { dir: string; clean: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'perf-cfg-'))
  if (content !== undefined) writeFileSync(join(dir, CONFIG_FILE), content)
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) }
}

const load = (
  dir: string,
  over: Parameters<typeof loadConfig>[0] extends infer T ? Partial<T> : never = {},
) => {
  const r = loadConfig({ projectRoot: dir, ...over })
  if (!r.ok) throw new Error(`期望成功，实际失败：${r.detail}`)
  return r
}

describe('优先级：flag > env > 文件 > 默认', () => {
  it('零配置时用默认值（不读文件也不报错）', () => {
    const { dir, clean } = withConfig(undefined)
    try {
      const { config } = load(dir, { env: {} })
      expect(config.model).toBe('anthropic/claude-sonnet-5')
      expect(config.include).toEqual([])
      expect(config.exclude).toEqual([])
      // 未显式配置时 maxRounds 保持 undefined，由 resolveConfig 落定
      expect(config.maxRounds).toBeUndefined()
    } finally {
      clean()
    }
  })

  it('文件能提供全部字段', () => {
    const { dir, clean } = withConfig(
      JSON.stringify({
        model: 'file/model',
        include: ['src/**'],
        exclude: ['**/*.test.ts'],
        maxRounds: 3,
        profile: 'p.cpuprofile',
      }),
    )
    try {
      const { config } = load(dir, { env: {} })
      expect(config).toEqual({
        model: 'file/model',
        include: ['src/**'],
        exclude: ['**/*.test.ts'],
        maxRounds: 3,
        profile: 'p.cpuprofile',
      })
    } finally {
      clean()
    }
  })

  it('env 覆盖文件', () => {
    const { dir, clean } = withConfig(JSON.stringify({ model: 'file/model', maxRounds: 3 }))
    try {
      const { config } = load(dir, { env: { PERF_MODEL: 'env/model', PERF_MAX_ROUNDS: '7' } })
      expect(config.model).toBe('env/model')
      expect(config.maxRounds).toBe(7)
    } finally {
      clean()
    }
  })

  it('flag 覆盖 env 与文件', () => {
    const { dir, clean } = withConfig(JSON.stringify({ model: 'file/model' }))
    try {
      const { config } = load(dir, {
        env: { PERF_MODEL: 'env/model' },
        flags: { model: 'flag/model', include: ['flag/**'] },
      })
      expect(config.model).toBe('flag/model')
      expect(config.include).toEqual(['flag/**'])
    } finally {
      clean()
    }
  })

  it('notes 说明 model 的实际来源', () => {
    const { dir, clean } = withConfig(JSON.stringify({ model: 'file/model' }))
    try {
      expect(load(dir, { env: {} }).notes.join()).toContain(CONFIG_FILE)
      expect(load(dir, { env: { PERF_MODEL: 'e/m' } }).notes.join()).toContain('model←env')
      expect(load(dir, { env: {}, flags: { model: 'f/m' } }).notes.join()).toContain('model←flag')
    } finally {
      clean()
    }
  })

  it('accepts evidence.profile（README 里写的那种形态）', () => {
    const { dir, clean } = withConfig(
      JSON.stringify({ evidence: { profile: '.perf/x.cpuprofile' } }),
    )
    try {
      expect(load(dir, { env: {} }).config.profile).toBe('.perf/x.cpuprofile')
    } finally {
      clean()
    }
  })

  it('env 里的空串被忽略，不会覆盖成空模型名', () => {
    const { dir, clean } = withConfig(JSON.stringify({ model: 'file/model' }))
    try {
      expect(load(dir, { env: { PERF_MODEL: '' } }).config.model).toBe('file/model')
    } finally {
      clean()
    }
  })
})

describe('文件内容非法时要报出人话', () => {
  const cases: Record<string, string> = {
    '不是 JSON': '{ not json',
    不是对象: '"a string"',
    'include 不是数组': JSON.stringify({ include: 'src' }),
    'include 里有非字符串': JSON.stringify({ include: [1] }),
    'model 是空串': JSON.stringify({ model: '' }),
    'maxRounds 不是正整数': JSON.stringify({ maxRounds: 0 }),
    'maxRounds 是小数': JSON.stringify({ maxRounds: 1.5 }),
    'evidence 不是对象': JSON.stringify({ evidence: 'x' }),
    'evidence.profile 是空串': JSON.stringify({ evidence: { profile: '' } }),
  }

  for (const [name, content] of Object.entries(cases)) {
    it(`${name} -> file-invalid 且指出字段`, () => {
      const { dir, clean } = withConfig(content)
      try {
        const r = loadConfig({ projectRoot: dir, env: {} })
        expect(r.ok).toBe(false)
        expect(r.ok === false && r.reason).toBe('file-invalid')
        expect((r.ok === false && r.detail.length) || 0).toBeGreaterThan(0)
      } finally {
        clean()
      }
    })
  }

  it('这是手写校验而非 TypeBox 的原因：`"include": "src"` 必须报错而不是被静默转成数组', () => {
    const { dir, clean } = withConfig(JSON.stringify({ include: 'src' }))
    try {
      const r = loadConfig({ projectRoot: dir, env: {} })
      expect(r.ok).toBe(false)
    } finally {
      clean()
    }
  })
})

describe('轮数默认值取决于有没有证据', () => {
  it('有证据时给得更多（每轮都在回答具体问题，衰减慢）', () => {
    expect(defaultMaxRounds(true)).toBeGreaterThan(defaultMaxRounds(false))
  })

  it('resolveConfig 落定默认值，且不覆盖显式配置', () => {
    const base = { model: 'm', include: [], exclude: [] }
    expect(resolveConfig(base, false).maxRounds).toBe(defaultMaxRounds(false))
    expect(resolveConfig(base, true).maxRounds).toBe(defaultMaxRounds(true))
    expect(resolveConfig({ ...base, maxRounds: 3 }, true).maxRounds).toBe(3)
  })
})
