/**
 * applyPatchToContent 的测试。
 *
 * 组织方式刻意与 docs/design.md D2 的 6 条实现要求一一对应——每条都要有一个
 * 会因"这条没做"而失败的用例。否则那 6 条就只是文档里的承诺。
 *
 * 另外每个危险场景都断言了**与原始 jsdiff 行为的对比**：证明我们确实拦下了
 * 它原本会静默犯的错，而不只是"我们的函数返回了某个值"。
 */
import { applyPatch, createPatch } from 'diff'
import { describe, expect, it } from 'vitest'

import { applyPatchToContent, splitByFile } from '../../src/diff/apply.js'
import { normalizePatch } from '../../src/diff/normalize.js'

const BASE = 'one\ntwo\nthree\nfour\nfive\n'

/** BASE 上 three -> THREE */
const SIMPLE = '--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n'

describe('正常路径', () => {
  it('应用成功并返回新内容', () => {
    const r = applyPatchToContent(BASE, SIMPLE)
    expect(r.ok).toBe(true)
    expect(r.ok && r.content).toBe('one\ntwo\nTHREE\nfour\nfive\n')
  })

  it('接受畸形但结构可修复的 diff（normalize 前置生效）', () => {
    // 计数写错 —— 直接 applyPatch 会抛异常
    const r = applyPatchToContent(
      BASE,
      '--- a/x\n+++ b/x\n@@ -1,9 +1,9 @@\n two\n-three\n+THREE\n four\n',
    )
    expect(r.ok).toBe(true)
    expect(r.ok && r.content).toBe('one\ntwo\nTHREE\nfour\nfive\n')
  })

  it('是纯函数 —— 不修改入参，同样的输入给同样的结果', () => {
    const content = BASE
    const a = applyPatchToContent(content, SIMPLE)
    const b = applyPatchToContent(content, SIMPLE)
    expect(content).toBe(BASE) // 入参未被改动
    expect(a.ok && b.ok && a.content === b.content).toBe(true)
  })
})

describe('要求 2：唯一性预检 —— 拦下 jsdiff 会静默做错的事', () => {
  // 两个函数除名字外相同，改动点距名字 4 行（超出 3 行上下文窗口）
  const body = (n: string) => `function ${n}() {
  const a = 1
  const b = 2
  const b2 = 20
  const c = 1
  const d = 4
  const e = 5
  return a + b + c + d + e
}`
  const ambiguous = `${body('alpha')}\n\n${body('beta')}\n`
  const patch = createPatch(
    'x',
    ambiguous,
    ambiguous.replace('const c = 1', 'const c = 99'),
    undefined,
    undefined,
    { context: 3 },
  )

  it('命中多处时拒绝，且不返回任何内容', () => {
    const r = applyPatchToContent(ambiguous, patch)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('ambiguous')
    expect(r.ok === false && r.matches).toBe(2)
  })

  it('对比：原始 applyPatch 在这种情况下会静默改掉第一处', () => {
    // 这就是为什么预检不能省 —— jsdiff 不报错、无信号
    const naive = applyPatch(ambiguous, patch)
    expect(naive).not.toBe(false)
    expect(naive).toMatch(/function alpha[\s\S]*?const c = 99/)
  })

  it('命中零处时判为 not-found（不是"成功但没改"）', () => {
    const r = applyPatchToContent('completely\ndifferent\ncontent\n', SIMPLE)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('not-found')
    expect(r.ok === false && r.matches).toBe(0)
  })
})

describe('要求 5：结果必须与输入不同 —— 静默无操作陷阱', () => {
  it('0 个 hunk 的 patch 会被规范化救成真 hunk，且内容必须真的变了', () => {
    const zeroHunk = '--- a/x\n+++ b/x\n   @@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n'
    // 先确认这确实是个陷阱：jsdiff 原样放行
    expect(applyPatch(BASE, zeroHunk)).toBe(BASE)

    const r = applyPatchToContent(BASE, zeroHunk)
    // normalize 会把它救成真 hunk，所以这里是成功——但内容必须真的变了
    expect(r.ok).toBe(true)
    expect(r.ok && r.content).not.toBe(BASE)
  })

  it('真正无变化的 hunk 被判为 unchanged', () => {
    // 纯上下文 hunk：旧侧序列存在且唯一，但应用后内容不变
    const noop = '--- a/x\n+++ b/x\n@@ -2,1 +2,1 @@\n two\n'
    const r = applyPatchToContent(BASE, noop)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('unchanged')
  })

  it('只有文件头、没有 hunk 的输入在规范化阶段被拒', () => {
    // 名字不再叫 "no-hunks"：那个 reason 在当前契约下不可达，见下面的契约测试
    const r = applyPatchToContent(BASE, '--- a/x\n+++ b/x\n')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('normalize-failed')
  })
})

describe('normalizePatch 的契约 —— apply 依赖它才不必重复解析', () => {
  const samples = [
    SIMPLE,
    '--- a/x\n+++ b/x\n@@ -1,9 +1,9 @@\n two\n-three\n+THREE\n four\n',
    '--- a/x\n+++ b/x\n@@ -2,3 @@\n two\n-three\n+THREE\n four\n',
    '--- a/x\n+++ b/x\n   @@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n',
    '--- a/x\n+++ b/x\n@@ -2,1 +2,1 @@\n two\n',
  ]

  it('ok 为真时一定有非空 hunk —— 这条契约让 apply 里的 no-hunks 分支不可达', () => {
    for (const text of samples) {
      const n = normalizePatch(text)
      if (n.ok) {
        expect(n.hunkCount).toBeGreaterThan(0)
        expect(n.files.some((f) => f.hunks.length > 0)).toBe(true)
      }
    }
  })

  it('ok 为真且是直接通过时，patch 原样透传、files 就是它的解析结果', () => {
    const n = normalizePatch(SIMPLE)
    expect(n.ok).toBe(true)
    expect(n.ok && n.patch).toBe(SIMPLE)
    expect(n.ok && n.hunkCount).toBe(1)
  })
})

describe('新建 / 删除文件：当前不支持，但原因必须可诊断', () => {
  // 这些检查必须在唯一性预检**之前**。新建文件的旧侧是空的，若让预检先跑，
  // 会返回"找不到上下文"的 not-found —— 那会让人以为模型写的上下文不对，
  // 于是白白重试，而真实原因是这类改动本工具尚不支持。
  it('新建文件 -> unsupported-file-op，而不是误导性的 not-found', () => {
    const create = '--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,1 @@\n+export const x = 1\n'
    const r = applyPatchToContent(BASE, create)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('unsupported-file-op')
  })

  it('删除文件 -> unsupported-file-op', () => {
    const del = '--- a/old.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-export const x = 1\n'
    const r = applyPatchToContent(BASE, del)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('unsupported-file-op')
  })

  it('git 风格的新建文件头（new file mode）同样被拦下', () => {
    const create =
      'diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,1 @@\n+export const x = 1\n'
    const r = applyPatchToContent(BASE, create)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('unsupported-file-op')
  })
})

describe('要求 6：多文件段必须拆开，不能直接应用', () => {
  const multi =
    '--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n' +
    '--- a/y\n+++ b/y\n@@ -1,1 +1,1 @@\n-one\n+ONE\n'

  it('直接应用被拒，原因是 multi-file', () => {
    const r = applyPatchToContent(BASE, multi)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('multi-file')
  })

  it('对比：原始 applyPatch 对多文件段直接抛异常', () => {
    expect(() => applyPatch(BASE, multi)).toThrow()
  })

  it('splitByFile 拆开后各段可独立应用', () => {
    const sections = splitByFile(multi)
    expect(sections).toHaveLength(2)
    expect(sections.map((s) => s.to)).toEqual(['b/x', 'b/y'])

    const first = sections[0]
    const second = sections[1]
    expect(first && second).toBeTruthy()
    if (!first || !second) return

    const r1 = applyPatchToContent(BASE, first.patch)
    expect(r1.ok && r1.content).toBe('one\ntwo\nTHREE\nfour\nfive\n')

    const r2 = applyPatchToContent(BASE, second.patch)
    expect(r2.ok && r2.content).toBe('ONE\ntwo\nthree\nfour\nfive\n')
  })

  it('路径原样返回，不剥 a/ b/ 前缀（项目里可能真有叫 a/ 的目录）', () => {
    const [s] = splitByFile(multi)
    expect(s?.from).toBe('a/x')
    expect(s?.to).toBe('b/x')
  })

  it('没有 ---/+++ 文件头时返回空数组', () => {
    expect(splitByFile('@@ -2,1 +2,1 @@\n-two\n+TWO\n')).toEqual([])
  })
})

describe('要求 4：两种失败形态都要接住', () => {
  it('语法/计数错误 -> 抛异常路径被接住，归为可诊断的失败', () => {
    // 行首缺前缀字符：normalize 拒绝，落到 normalize-failed
    const r = applyPatchToContent(
      BASE,
      '--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@\ntwo\nthree\nTHREE\nfour\n',
    )
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('normalize-failed')
  })

  it('上下文不匹配 -> 返回 false 路径被接住，归为 not-found', () => {
    const r = applyPatchToContent('zzz\nyyy\n', SIMPLE)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('not-found')
  })

  it('拒绝空字符串与纯散文，不抛异常', () => {
    for (const bad of ['', '这个函数可以优化，建议换成 Map。\n', '   ', '\n\n']) {
      const r = applyPatchToContent(BASE, bad)
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.reason).toBe('normalize-failed')
    }
  })
})

describe('所有失败结果都可安全解构（调用方不必先 try/catch）', () => {
  it('任意畸形输入都不会抛出', () => {
    const inputs = [
      '',
      '\n',
      '---',
      '+++',
      '@@',
      '@@ @@',
      '--- a\n+++ b\n@@ -1,1 +1,1 @@\n',
      ' ',
      '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-' + 'x'.repeat(10_000) + '\n+y\n',
    ]
    for (const bad of inputs) {
      expect(() => applyPatchToContent(BASE, bad)).not.toThrow()
      expect(applyPatchToContent(BASE, bad).ok).toBe(false)
    }
  })
})
