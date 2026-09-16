import { describe, expect, it } from 'vitest'

import { parseArgs } from '../../src/cli/args.js'

const parse = (...argv: string[]) => {
  const r = parseArgs(argv)
  if (!r.ok) throw new Error(`期望解析成功，实际失败：${r.error}`)
  return r.options
}

describe('命令与位置参数', () => {
  it('无参数时显示帮助', () => {
    expect(parse().command).toBe('help')
  })

  it('识别三个命令', () => {
    expect(parse('plan').command).toBe('plan')
    expect(parse('run').command).toBe('run')
    expect(parse('help').command).toBe('help')
  })

  it('位置参数作为目标目录', () => {
    expect(parse('plan', '../other-repo').target).toBe('../other-repo')
  })

  it('flag 在命令前也能识别', () => {
    const o = parse('--model', 'x/y', 'plan')
    expect(o.command).toBe('plan')
    expect(o.model).toBe('x/y')
  })

  it('多余的位置参数报错', () => {
    const r = parseArgs(['plan', 'a', 'b'])
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('多余的参数')
  })

  it('不认识的命令被当成目标目录（不是错误）', () => {
    // `perf ../repo` 这类写法里 ../repo 是路径，命令缺省为 help
    const o = parse('../repo')
    expect(o.command).toBe('help')
    expect(o.target).toBe('../repo')
  })
})

describe('选项', () => {
  it('--flag value 与 --flag=value 都支持', () => {
    expect(parse('plan', '--model', 'a/b').model).toBe('a/b')
    expect(parse('plan', '--model=a/b').model).toBe('a/b')
  })

  it('--include / --exclude 可重复累积', () => {
    const o = parse('plan', '--include', 'src/**', '--include=lib/**', '--exclude', '**/*.test.ts')
    expect(o.include).toEqual(['src/**', 'lib/**'])
    expect(o.exclude).toEqual(['**/*.test.ts'])
  })

  it('--max-rounds 要求正整数', () => {
    expect(parse('plan', '--max-rounds', '5').maxRounds).toBe(5)
    expect(parse('plan', '--max-rounds=12').maxRounds).toBe(12)
    for (const bad of ['0', '-1', '1.5', 'abc']) {
      const r = parseArgs(['plan', '--max-rounds', bad])
      expect(r.ok).toBe(false)
    }
  })

  it('--json 是布尔开关', () => {
    expect(parse('plan', '--json').json).toBe(true)
    expect(parse('plan').json).toBe(false)
  })

  it('-h / --help 立刻返回帮助，忽略其余参数', () => {
    expect(parse('plan', '--help').command).toBe('help')
    expect(parse('-h').command).toBe('help')
  })
})

describe('错误处理', () => {
  it('未知选项报错并提示查看帮助', () => {
    const r = parseArgs(['plan', '--nope'])
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('未知选项')
    expect(r.ok === false && r.error).toContain('--help')
  })

  it('缺少值的选项报错', () => {
    for (const flag of ['--model', '--profile', '--include', '--max-rounds']) {
      const r = parseArgs(['plan', flag])
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.error).toContain('需要一个值')
    }
  })

  it('值前面是另一个 flag 时也算缺值（避免把 --json 当成 model 的值）', () => {
    const r = parseArgs(['plan', '--model', '--json'])
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('需要一个值')
  })

  it('单个连字符不是选项（允许 - 表示 stdin 之类的惯例）', () => {
    expect(parse('plan', '-').target).toBe('-')
  })
})
