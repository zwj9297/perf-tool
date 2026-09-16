/**
 * 畸形 diff 样本测试。
 *
 * 样本取自模型实际会输出的形式（markdown 围栏、前后散文、计数写错、空上下文行
 * 丢前缀……），分三组：
 *
 *   A. jsdiff 本来就吃得下 —— 断言我们**没有**多余地改动它们。
 *      这些用例的价值在于：如果哪天有人"顺手"给这些情况加了修复代码，测试会
 *      因为 patch 被改动而失败。
 *   B. 抛错但结构可无歧义修复 —— 断言修复后能真正应用到目标内容。
 *   C. 必须拒绝 —— 内容层面的问题一律走重试，绝不猜。
 *
 * 另有一组专门锁"静默无操作"这个陷阱。
 */
import { applyPatch, parsePatch } from 'diff'
import { describe, expect, it } from 'vitest'

import { normalizePatch } from '../../src/diff/normalize.js'

const BASE = 'one\ntwo\nthree\nfour\nfive\n'
/** BASE 上 three -> THREE 之后应该长这样 */
const EXPECTED = 'one\ntwo\nTHREE\nfour\nfive\n'

const hunkCount = (text: string): number =>
  parsePatch(text).reduce((n, file) => n + file.hunks.length, 0)

/** 规范化 + 应用的完整链路。返回应用结果，或一个说明卡在哪一步的字符串。 */
const run = (text: string, source = BASE): string | false => {
  const n = normalizePatch(text)
  if (!n.ok) return `normalize拒绝: ${n.reason}`
  const out = applyPatch(source, n.patch)
  return out
}

describe('A. jsdiff 本来就吃得下 —— 不应被改动', () => {
  const cases: Record<string, string> = {
    正常: '--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n',
    'markdown 围栏':
      '```diff\n--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n```\n',
    前后有解释文字:
      '好的，这是改动：\n\n--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n\n这个改动把线性查找换成了 Map。\n',
    'hunk 之后夹解释文字':
      '--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n顺手也改了下面：\n',
    'CRLF 行尾': '--- a/x\r\n+++ b/x\r\n@@ -2,3 +2,3 @@\r\n two\r\n-three\r\n+THREE\r\n four\r\n',
    '\\ No newline at end of file':
      '--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n\\ No newline at end of file\n',
    '省略 ,1 的 @@': '--- a/x\n+++ b/x\n@@ -3 +3 @@\n-three\n+THREE\n',
    '@@ 带函数上下文后缀':
      '--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@ function foo()\n two\n-three\n+THREE\n four\n',
    尾部多个空行: '--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n\n\n\n',
    '---/+++ 无空格': '---a/x\n+++b/x\n@@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n',
    'diff --git 风格':
      'diff --git a/x b/x\nindex 1234567..89abcde 100644\n--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n',
    'hunk 头前是裸路径': 'a/x\nb/x\n@@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n',
  }

  for (const [name, text] of Object.entries(cases)) {
    it(`${name}：原样通过且能应用`, () => {
      const n = normalizePatch(text)
      expect(n.ok).toBe(true)
      // 关键断言：没有被"修复"，原样透传
      expect(n.ok && n.patch).toBe(text)
      expect(run(text)).toBe(EXPECTED)
    })
  }
})

describe('B. 结构可修复 —— 修复后必须能真正应用到目标内容', () => {
  const cases: Record<string, string> = {
    计数写大: '--- a/x\n+++ b/x\n@@ -1,9 +1,9 @@\n two\n-three\n+THREE\n four\n',
    计数写小: '--- a/x\n+++ b/x\n@@ -2,1 +2,1 @@\n two\n-three\n+THREE\n four\n',
    '正文缺尾部上下文（计数与正文不符）':
      '--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@\n two\n-three\n+THREE\n',
    '@@ 缺 + 侧': '--- a/x\n+++ b/x\n@@ -2,3 @@\n two\n-three\n+THREE\n four\n',
    '重复 @@ 头':
      '--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@\n@@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n',
    '@@ 前有多余前导空格': '--- a/x\n+++ b/x\n   @@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n',
  }

  for (const [name, text] of Object.entries(cases)) {
    it(`${name}：修复后应用成功`, () => {
      const n = normalizePatch(text)
      expect(n.ok).toBe(true)
      expect(n.ok && n.hunkCount).toBeGreaterThan(0)
      expect(n.ok && n.patch).toContain('@@ -')
      // 真正的验收标准：结果正确，而不只是"没报错"
      expect(run(text)).toBe(EXPECTED)
    })
  }

  it('这些样本确实需要修复路径 —— jsdiff 直接解析会抛错', () => {
    // 如果哪天 jsdiff 自己会 recount 了，这条会失败，提醒我们可以删掉修复逻辑
    expect(() =>
      hunkCount('--- a/x\n+++ b/x\n@@ -1,9 +1,9 @@\n two\n-three\n+THREE\n four\n'),
    ).toThrow()
    expect(() => hunkCount('--- a/x\n+++ b/x\n@@ -2,3 @@\n two\n-three\n+THREE\n four\n')).toThrow()
    expect(() =>
      hunkCount(
        '--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@\n@@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n',
      ),
    ).toThrow()
  })

  it('源文件确有空白行时，丢前缀的空上下文行也能应用', () => {
    const source = 'one\ntwo\nthree\n\nfive\n'
    const text = '--- a/x\n+++ b/x\n@@ -2,4 +2,4 @@\n two\n-three\n+THREE\n\n five\n'
    expect(run(text, source)).toBe('one\ntwo\nTHREE\n\nfive\n')
  })
})

describe('C. 必须拒绝 —— 内容层面不可无歧义修复，交给重试', () => {
  const cases: Record<string, string> = {
    '缺 +/-/空格 前缀': '--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@\ntwo\nthree\nTHREE\nfour\n',
    '只有 @@ 没有正文': '--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@\n',
    '完全没有 @@ 的散文': '这个函数可以优化，建议把线性查找换成 Map。\n',
    空字符串: '',
    '只有文件头没有 hunk': '--- a/x\n+++ b/x\n',
  }

  for (const [name, text] of Object.entries(cases)) {
    it(`${name}：拒绝而非猜测`, () => {
      const n = normalizePatch(text)
      expect(n.ok).toBe(false)
    })
  }

  it('行前缀缺失无法靠"补空格"救回 —— 因为 -/+/空格 三种意图不可区分', () => {
    // three 到底是"未改动的上下文"还是"要删除的行"？无从判断。
    expect(normalizePatch('--- a/x\n+++ b/x\n@@ -2,1 +2,1 @@\nthree\n').ok).toBe(false)
  })
})

describe('D. 内容不匹配 —— 必须是响亮的定位失败，不是静默成功', () => {
  it('丢前缀的空上下文行若与目标对不上，定位失败并返回 false', () => {
    // BASE 里 three 和 four 之间没有空行，而这个 hunk 声称有一行空上下文
    const text = '--- a/x\n+++ b/x\n@@ -2,4 +2,4 @@\n two\n-three\n+THREE\n\n four\n'
    const n = normalizePatch(text)
    // 规范化本身成功（结构没问题）
    expect(n.ok).toBe(true)
    expect(n.ok && n.hunkCount).toBe(1)
    // 但应用必须失败 —— 不能悄悄少改一行或多改一行
    expect(n.ok ? applyPatch(BASE, n.patch) : undefined).toBe(false)
  })
})

describe('E. 静默无操作陷阱', () => {
  it('0 个 hunk 的 patch 会被 applyPatch 原样放行 —— 这不是失败信号', () => {
    const text = '--- a/x\n+++ b/x\n   @@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n'

    // jsdiff 直接解析：能解析，但一个 hunk 都没有
    expect(hunkCount(text)).toBe(0)
    // 而 applyPatch 返回的是**源文本本身**，不是 false —— 与"应用成功"无法区分
    expect(applyPatch(BASE, text)).toBe(BASE)

    // 所以 normalizePatch 必须把这种情况救成真 hunk，或明确拒绝
    const n = normalizePatch(text)
    expect(n.ok).toBe(true)
    expect(n.ok && n.hunkCount).toBe(1)
    expect(run(text)).toBe(EXPECTED)
  })

  it('应用结果与输入相同必须被当作失败 —— 由调用方断言', () => {
    // 这条不测 normalizePatch，而是把不变量写下来：即便 patch 解析出 hunk，
    // 也要断言 out !== input。src/diff/apply 的实现必须包含这条断言，
    // 否则"什么都没改"会伪装成"应用成功"并产出一个空的 commit。
    const noop = normalizePatch('--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n')
    expect(noop.ok).toBe(true)
    const applied = noop.ok ? applyPatch(BASE, noop.patch) : false
    expect(applied).toBe(EXPECTED)
    expect(applied).not.toBe(BASE)
  })
})
