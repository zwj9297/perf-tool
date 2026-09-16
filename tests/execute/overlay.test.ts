/**
 * overlay 的测试。
 *
 * 除了基本行为（叠加、original/current 分离），重点在**读取路径的安全校验**：
 * `step.files` 来自一个**允许人工编辑**的 plan 文件，而它的内容会被读出来送进模型
 * prompt。所以越界路径与凭证文件必须在这里就被拒绝。
 *
 * 这组用例的由来是一次真实的读写不对称：写路径一直有 containment 校验，读路径曾经
 * 是裸的 `readFileSync`——一份被改过的 plan 只要写上 `.env`，就能把凭证发到模型端点。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { checkFilesAreSafe, createOverlay } from '../../src/execute/overlay.js'

const V1 = 'alpha\nbravo\n'

const OUTSIDE_SECRET = 'TOP SECRET OUTSIDE\n'

const makeProject = () => {
  const base = mkdtempSync(join(tmpdir(), 'perf-ovl-'))
  const dir = join(base, 'proj')
  const outside = join(base, 'outside')
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(dir, 'src', 'a.txt'), V1)
  writeFileSync(join(dir, '.env'), 'API_KEY=verysecret\n')
  writeFileSync(join(outside, 'secret.txt'), OUTSIDE_SECRET)
  // 一个指向项目外的软链：字符串上看着完全在项目内
  symlinkSync(outside, join(dir, 'link-out'), 'dir')
  return { base, dir, clean: () => rmSync(base, { recursive: true, force: true }) }
}

describe('读取路径必须过与写路径同样的校验', () => {
  it('越界路径被拒绝，且报出真实原因', () => {
    const { dir, clean } = makeProject()
    try {
      const overlay = createOverlay(dir)
      expect(() => overlay.current('../../etc/passwd')).toThrow(/拒绝访问/)
      expect(() => overlay.current('/etc/passwd')).toThrow(/拒绝访问/)
      expect(() => overlay.original('../outside/secret.txt')).toThrow(/拒绝访问/)
    } finally {
      clean()
    }
  })

  it('软链指向项目外时被拒绝 —— 只有 realpath 之后才看得出越界', () => {
    const { dir, clean } = makeProject()
    try {
      const overlay = createOverlay(dir)
      // 字符串上 'link-out/secret.txt' 完全在项目内
      expect(() => overlay.current('link-out/secret.txt')).toThrow(/拒绝访问/)
      // 内容确实读不到（而它读得到的话就会被送进 prompt）
      expect(OUTSIDE_SECRET).toContain('TOP SECRET')
    } finally {
      clean()
    }
  })

  it('凭证文件被拒绝 —— 这是对外承诺的「跳过 .env」在读取路径上的落实', () => {
    const { dir, clean } = makeProject()
    try {
      const overlay = createOverlay(dir)
      expect(() => overlay.current('.env')).toThrow(/凭证/)
    } finally {
      clean()
    }
  })

  it('commit 也走同一校验（写进快照的 key 必须合法）', () => {
    const { dir, clean } = makeProject()
    try {
      const overlay = createOverlay(dir)
      expect(() => overlay.commit('../evil.txt', 'x')).toThrow(/拒绝访问/)
    } finally {
      clean()
    }
  })

  it('checkFilesAreSafe 给出是哪个文件不合法（便于报错指路）', () => {
    const { dir, clean } = makeProject()
    try {
      expect(checkFilesAreSafe(dir, ['src/a.txt']).ok).toBe(true)
      const bad = checkFilesAreSafe(dir, ['src/a.txt', '../../x'])
      expect(bad.ok).toBe(false)
      expect(bad.ok === false && bad.file).toBe('../../x')
      expect(checkFilesAreSafe(dir, ['.env']).ok).toBe(false)
    } finally {
      clean()
    }
  })
})

describe('基本行为', () => {
  it('original 是磁盘内容，current 随 apply 变化', () => {
    const { dir, clean } = makeProject()
    try {
      const overlay = createOverlay(dir)
      expect(overlay.original('src/a.txt')).toBe(V1)
      expect(overlay.current('src/a.txt')).toBe(V1)

      const patch = '--- src/a.txt\n+++ src/a.txt\n@@ -1,2 +1,2 @@\n-alpha\n+ALPHA\n bravo\n'
      expect(overlay.apply('src/a.txt', patch).ok).toBe(true)
      expect(overlay.current('src/a.txt')).toContain('ALPHA')
      // original 保持不动，预览要靠它算「原始 → 最终」
      expect(overlay.original('src/a.txt')).toBe(V1)
    } finally {
      clean()
    }
  })

  it('changed 只报真正变了的文件', () => {
    const { dir, clean } = makeProject()
    try {
      const overlay = createOverlay(dir)
      overlay.current('src/a.txt') // 只读不算改动
      expect(overlay.changed()).toEqual([])

      overlay.commit('src/a.txt', 'changed\n')
      expect(overlay.changed().map((f) => f.rel)).toEqual(['src/a.txt'])
    } finally {
      clean()
    }
  })

  it('apply 失败时快照不变（失败不留半成品）', () => {
    const { dir, clean } = makeProject()
    try {
      const overlay = createOverlay(dir)
      const bad = '--- src/a.txt\n+++ src/a.txt\n@@ -1,2 +1,2 @@\n-alpha\n+NOPE\n nothere\n'
      expect(overlay.apply('src/a.txt', bad).ok).toBe(false)
      expect(overlay.current('src/a.txt')).toBe(V1)
      expect(overlay.changed()).toEqual([])
    } finally {
      clean()
    }
  })

  it('软链指向项目内时照常工作，并归一到真实路径', () => {
    const { dir, clean } = makeProject()
    try {
      symlinkSync(join(dir, 'src', 'a.txt'), join(dir, 'alias.txt'))
      const overlay = createOverlay(dir)
      expect(overlay.current('alias.txt')).toBe(V1)
      overlay.commit('alias.txt', 'changed\n')
      // 同一个真实文件经两个路径写进来，应当归到同一个 key
      expect(overlay.changed().map((f) => f.rel)).toEqual(['src/a.txt'])
    } finally {
      clean()
    }
  })
})
