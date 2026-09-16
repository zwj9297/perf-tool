/**
 * jsdiff 行为刻画测试。
 *
 * 这些不是"我们的代码对不对"的测试，而是"我们依赖的第三方行为有没有变"的测试。
 * docs/design.md §2.6 的整节设计建立在下列行为之上；`diff` 升级后若任何一条变了，
 * 这里会直接失败，而不是等到线上静默改错行。
 *
 * 结论汇总见 docs/design.md §2.6 的表格。
 */
import { applyPatch, createPatch, parsePatch } from 'diff'
import { describe, expect, it } from 'vitest'

/** 取 hunk 的「旧侧序列」（前缀为空格或 - 的行），用于唯一性预检。
 *  注意：hunk.oldLines 是计数（数字），不是行数组。 */
const oldSideLines = (lines: string[]): string[] =>
  lines.filter((l) => l.startsWith(' ') || l.startsWith('-')).map((l) => l.slice(1))

/** 统计旧侧序列在目标内容中完全匹配的次数。这正是我们必须在应用前做的预检。 */
const countOccurrences = (source: string, needle: string[]): number => {
  const lines = source.split('\n')
  let hits = 0
  for (let i = 0; i + needle.length <= lines.length; i++) {
    if (needle.every((l, k) => lines[i + k] === l)) hits++
  }
  return hits
}

const BODY = (name: string) => `function ${name}() {
  const a = 1
  const b = 2
  const b2 = 20
  const c = 1
  const d = 4
  const e = 5
  return a + b + c + d + e
}`

/** 两个函数除名字外相同，且改动点距名字 4 行（超出 3 行上下文窗口）——
 *  所以 hunk 的上下文在两处都成立，构成真正的歧义。 */
const ambiguousSource = `${BODY('alpha')}\n\n${BODY('beta')}\n`
const ambiguousPatch = createPatch(
  'x.js',
  ambiguousSource,
  ambiguousSource.replace('const c = 1', 'const c = 99'),
  undefined,
  undefined,
  { context: 3 },
)

describe('行号与定位', () => {
  it('忽略 @@ 的起始行号，按上下文定位（D2 的核心假设）', () => {
    const source = 'line one\nline two\nline three\nline four\nline five\n'
    const patch = createPatch(
      'y.js',
      source,
      'line one\nline two\nCHANGED\nline four\nline five\n',
      undefined,
      undefined,
      { context: 1 },
    )
    // 只改起始行号，保持计数正确（计数错了会走另一条抛异常路径）
    const bogus = patch.replace(/@@ -\d+,(\d+) \+\d+,(\d+) @@/, '@@ -999,$1 +888,$2 @@')
    expect(bogus).toContain('@@ -999,')

    expect(applyPatch(source, bogus)).toBe('line one\nline two\nCHANGED\nline four\nline five\n')
  })

  it('hunk 能匹配多处时静默作用于第一处 —— 没有严格模式可用', () => {
    const out = applyPatch(ambiguousSource, ambiguousPatch)
    expect(out).not.toBe(false)
    // 断言当前这个危险行为：alpha 被改，beta 没动，且没有报错
    expect(out).toMatch(/function alpha[\s\S]*?const c = 99/)
    expect(out).toMatch(/function beta[\s\S]*?const c = 1/)

    // 两个选项都改变不了这个行为 —— 所以我们无法靠配置拿到严格模式
    expect(applyPatch(ambiguousSource, ambiguousPatch, { fuzzFactor: 0 })).not.toBe(false)
    expect(applyPatch(ambiguousSource, ambiguousPatch, { compareLine: () => true })).not.toBe(false)
  })

  it('自己的唯一性预检能识别出歧义（这正是必须补的那一层）', () => {
    const hunks = parsePatch(ambiguousPatch)[0]?.hunks ?? []
    expect(hunks).toHaveLength(1)
    const first = hunks[0]
    expect(first).toBeDefined()

    const needle = oldSideLines(first?.lines ?? [])
    expect(needle.length).toBeGreaterThan(0)
    // 命中 2 处 -> 预检判为歧义，拒绝应用
    expect(countOccurrences(ambiguousSource, needle)).toBe(2)

    // 对照：唯一位置的文件命中 1 处
    const unique = 'aaa\nbbb\nccc\nddd\n'
    const uniquePatch = '--- a\n+++ b\n@@ -2,1 +2,1 @@\n-bbb\n+BBB\n'
    const uniqueNeedle = oldSideLines(parsePatch(uniquePatch)[0]?.hunks[0]?.lines ?? [])
    expect(countOccurrences(unique, uniqueNeedle)).toBe(1)
  })

  it('0 上下文 hunk 在唯一位置成功，在重复位置静默改第一处（最危险的组合）', () => {
    const zeroContext = '--- a\n+++ b\n@@ -2,1 +2,1 @@\n-ccc\n+CCC\n'
    expect(applyPatch('aaa\nbbb\nccc\nddd\n', zeroContext)).toBe('aaa\nbbb\nCCC\nddd\n')
    // 目标行重复两次 -> 静默改第一处，这正是预检要拦住的
    expect(applyPatch('aaa\nccc\nbbb\nccc\n', zeroContext)).toBe('aaa\nCCC\nbbb\nccc\n')
    const needle = oldSideLines(parsePatch(zeroContext)[0]?.hunks[0]?.lines ?? [])
    expect(countOccurrences('aaa\nccc\nbbb\nccc\n', needle)).toBe(2)
  })
})

describe('计数与 recount', () => {
  const source = 'line one\nline two\nline three\nline four\nline five\n'
  const patch = createPatch(
    'y.js',
    source,
    'line one\nline two\nCHANGED\nline four\nline five\n',
    undefined,
    undefined,
    { context: 1 },
  )

  it('计数写大 -> 抛异常（jsdiff 不做 recount）', () => {
    const bogus = patch.replace(/@@ -\d+,\d+ \+\d+,\d+ @@/, '@@ -1,7 +1,7 @@')
    expect(() => applyPatch(source, bogus)).toThrow(/invalid line/)
  })

  it('计数写小 -> 抛异常', () => {
    const bogus = patch.replace(/@@ -\d+,\d+ \+\d+,\d+ @@/, '@@ -2,2 +2,2 @@')
    expect(() => applyPatch(source, bogus)).toThrow(/more lines than expected/)
  })

  it('自己先做 recount 就能应用 —— 缺口可补', () => {
    /**
     * 正式实现应放在 src/diff/。这里内联一份最小版用于刻画"可补"这件事。
     *
     * 注意这个函数本身很容易写错：第一版漏了把 hunk 正文也 push 出去，
     * 结果是"头部计数正确、正文为空"的 patch。所以下面除了断言应用结果，
     * 也断言了 recount 的产物本身 —— 否则错误会被 applyPatch 的失败掩盖成
     * 一个含义不明的报错。
     */
    const recount = (text: string): string => {
      const lines = text.split('\n')
      const out: string[] = []
      let i = 0
      while (i < lines.length) {
        const line = lines[i] ?? ''
        const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
        if (!m) {
          out.push(line)
          i++
          continue
        }
        let oldCount = 0
        let newCount = 0
        let j = i + 1
        while (j < lines.length) {
          const l = lines[j] ?? ''
          const c = l[0]
          if (c === ' ') {
            oldCount++
            newCount++
          } else if (c === '-') {
            oldCount++
          } else if (c === '+') {
            newCount++
          } else break // 空行、下一文件的 Index:、下一个 @@ 都从这里出去
          j++
        }
        out.push(`@@ -${m[1]},${oldCount} +${m[2]},${newCount} @@`)
        for (let k = i + 1; k < j; k++) out.push(lines[k] ?? '')
        i = j
      }
      return out.join('\n')
    }

    const repaired = recount(patch.replace(/@@ -\d+,\d+ \+\d+,\d+ @@/, '@@ -1,7 +1,7 @@'))
    // 先断言 recount 产物本身：头部计数被修正，且正文被完整保留
    expect(repaired).toContain('@@ -1,3 +1,3 @@')
    expect(repaired).toContain('-line three')
    expect(repaired).toContain('+CHANGED')
    // 再断言应用结果
    expect(applyPatch(source, repaired)).toBe('line one\nline two\nCHANGED\nline four\nline five\n')
  })
})

describe('失败与容错边界', () => {
  it('上下文不匹配 -> 返回 false（抛异常只是语法错误的路径）', () => {
    const patch = '--- a\n+++ b\n@@ -1,3 +1,3 @@\n zzz\n-nonexistent\n+replacement\n yyy\n'
    expect(applyPatch('alpha\nbeta\ngamma\n', patch)).toBe(false)
  })

  it('fuzzFactor 不能容忍空白差异 —— 上下文必须精确匹配', () => {
    const source = 'alpha\n   indented line\nomega\n'
    const patch = '--- a\n+++ b\n@@ -1,3 +1,3 @@\n alpha\n-indented line\n+INDENTED LINE\n omega\n'
    expect(applyPatch(source, patch)).toBe(false)
    expect(applyPatch(source, patch, { fuzzFactor: 1 })).toBe(false)
    expect(applyPatch(source, patch, { fuzzFactor: 2 })).toBe(false)
  })

  it('parsePatch：header 层宽容，body 层严格', () => {
    // header 宽容 —— 可以放心把 LLM 的 @@ 头交给它
    expect(() => parsePatch('--- a\n+++ b\n@@ 1,1 1,1 @@\n-old\n+new\n')).not.toThrow()
    expect(() => parsePatch('@@ -1,1 +1,1 @@\n-old\n+new\n')).not.toThrow() // 无 ---/+++ 头
    expect(() => parsePatch('--- a\n+++ b\n@@ -x,y +z,w @@\n-old\n+new\n')).not.toThrow() // 计数非数字

    // body 严格 —— 这两类只能靠重试，不该试图修复
    expect(() => parsePatch('--- a\n+++ b\n@@ -1,1 +1,1 @@\nold\nnew\n')).toThrow()
    expect(() => parsePatch('--- a\n+++ b\n@@ -1,3 +1,3 @@\n')).toThrow()
  })
})
