/**
 * 逐 step 改动生成的测试。
 *
 * 最要紧的两组：
 *
 * ① **overlay 叠加**——step 2 的模型必须看到 step 1 已生效的内容。这是 §2.2 的
 *    全部意义，也是"生成阶段维护预测态"这个设计唯一能被验证的地方。
 * ② **暂存原子性**——多文件段的 patch 若只应用了一半就失败，快照会被污染，而后面
 *    每个 step 都基于这个坏状态生成。这类 bug 不会当场报错，只会让后续 diff 全是错的。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { generateEdits } from '../../src/execute/generate.js'
import type { Plan } from '../../src/plan/schema.js'
import type { Provider, ProviderConversation, ProviderTurn } from '../../src/providers/types.js'

const A = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].join('\n')

const makeProject = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'perf-gen-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, rel), content)
  }
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) }
}

const plan = (steps: Partial<Plan['steps'][number]>[]): Plan => ({
  summary: '优化',
  steps: steps.map((s, i) => ({
    id: s.id ?? `s${i + 1}`,
    title: s.title ?? `步骤 ${i + 1}`,
    rationale: s.rationale ?? '因为热',
    files: s.files ?? ['src/a.txt'],
    kind: s.kind ?? 'algorithmic',
    risk: s.risk ?? 'low',
  })),
  target: { root: '/x', language: 'X' },
  grounded: false,
})

/** 把每个 hunk 体的旧侧序列拼成 needle，用于写测试里的 patch 字面量 */
const patchFor = (rel: string, old: string, next: string, context = 2): string => {
  const lines = old.split('\n')
  const at = lines.indexOf(next)
  const from = Math.max(0, at - context)
  const to = Math.min(lines.length, at + 1 + context)
  const ctx = lines.slice(from, to)
  const hunk = ctx.map((l) => (l === next ? `-${l}\n+CHANGED-${l}` : ` ${l}`)).join('\n')
  return `--- ${rel}\n+++ ${rel}\n@@ -${from + 1},${ctx.length} +${from + 1},${ctx.length} @@\n${hunk}\n`
}

const scripted = (turns: ProviderTurn[]) => {
  const conversations: ProviderConversation[] = []
  let i = 0
  const provider: Provider = {
    turn: async (c) => {
      conversations.push(c)
      const t = turns[i]
      i++
      if (t === undefined) throw new Error(`没有为第 ${i} 个回合准备响应`)
      return t
    },
  }
  return { provider, conversations }
}

/** 收窄到"带工具调用"那一支，这样测试里可以再展开加 usage */
type ToolTurn = Extract<ProviderTurn, { kind: 'tools' }>

const editTurn = (patch: string, note?: string): ToolTurn => ({
  kind: 'tools',
  calls: [
    {
      id: 'e1',
      name: 'submit_edit',
      arguments: note === undefined ? { patch } : { patch, note },
    },
  ],
  text: '',
})

const skipTurn = (reason: string): ToolTurn => ({
  kind: 'tools',
  calls: [{ id: 'k1', name: 'skip_step', arguments: { reason } }],
  text: '',
})

const textTurn = (text: string): ProviderTurn => ({ kind: 'text', text })

const run = async (
  dir: string,
  turns: ProviderTurn[],
  steps: Partial<Plan['steps'][number]>[],
  over: { maxAttempts?: number } = {},
) => {
  const { provider, conversations } = scripted(turns)
  const progress: string[] = []
  const result = await generateEdits({
    provider,
    projectRoot: dir,
    plan: plan(steps),
    onProgress: (t) => progress.push(t),
    ...over,
  })
  return { result, conversations, progress }
}

describe('overlay 叠加：step 2 必须看到 step 1 的改动', () => {
  it('第 2 个 step 的提示词里是 step 1 改过的内容', async () => {
    const { dir, clean } = makeProject({ 'src/a.txt': A })
    try {
      const p1 = patchFor('src/a.txt', A, 'alpha')
      // 关键：step 2 的 diff 必须针对**叠加后的**内容写。真实的模型正是这样——它的
      // 提示词里给的就是改过的内容。若这里仍按原文生成，锚点对不上会一直重试，
      // 那反倒证明 overlay 生效了（下面另有一条用例专门验证这一点）。
      const afterStep1 = A.replace('alpha', 'CHANGED-alpha')
      const p2 = patchFor('src/a.txt', afterStep1, 'bravo')

      const { result, conversations } = await run(
        dir,
        [editTurn(p1), editTurn(p2)],
        [
          { id: 's1', title: '改 alpha' },
          { id: 's2', title: '改 bravo' },
        ],
      )

      expect(result.edits).toHaveLength(2)
      // 第 1 次对话给的是原文
      const first = conversations[0]?.messages[0]
      expect(first?.role === 'user' && first.text).toContain('alpha')
      expect(first?.role === 'user' && first.text).not.toContain('CHANGED-alpha')
      // 第 2 次对话必须带上 step 1 的结果
      const second = conversations[1]?.messages[0]
      expect(second?.role === 'user' && second.text).toContain('CHANGED-alpha')

      // 最终状态两个改动都在
      expect(result.merged).toHaveLength(1)
      expect(result.merged[0]?.current).toContain('CHANGED-alpha')
      expect(result.merged[0]?.current).toContain('CHANGED-bravo')
      expect(result.merged[0]?.original).toBe(A)
    } finally {
      clean()
    }
  })

  it('两个 step 各自改不同文件时互不干扰', async () => {
    const { dir, clean } = makeProject({ 'src/a.txt': A, 'src/b.txt': A })
    try {
      const { result } = await run(
        dir,
        [editTurn(patchFor('src/a.txt', A, 'alpha')), editTurn(patchFor('src/b.txt', A, 'echo'))],
        [
          { id: 's1', files: ['src/a.txt'] },
          { id: 's2', files: ['src/b.txt'] },
        ],
      )
      expect(result.merged.map((f) => f.rel)).toEqual(['src/a.txt', 'src/b.txt'])
    } finally {
      clean()
    }
  })
})

describe('暂存原子性：部分失败不能污染快照', () => {
  it('多文件段里有一段应用失败 → 整个尝试失败，快照不变', async () => {
    const { dir, clean } = makeProject({ 'src/a.txt': A, 'src/b.txt': A })
    try {
      const good = patchFor('src/a.txt', A, 'alpha')
      const bad = patchFor('src/b.txt', A, 'nonexistent-line')
      const twoFiles = `${good}${bad}`

      // 第 1 次给坏的（有一段对不上），第 2 次给只改 a 的好 patch
      const { result } = await run(
        dir,
        [editTurn(twoFiles), editTurn(good)],
        [{ id: 's1', title: '多文件' }],
      )

      expect(result.edits).toHaveLength(1)
      expect(result.edits[0]?.attempts).toBe(2)
      // 关键：坏 patch 的 a 段**没有**被留下来
      expect(result.merged.map((f) => f.rel)).toEqual(['src/a.txt'])
      expect(result.merged[0]?.current).toContain('CHANGED-alpha')
      // b 完全没被动过
      expect(result.merged.some((f) => f.rel === 'src/b.txt')).toBe(false)
    } finally {
      clean()
    }
  })
})

describe('重试是常规路径', () => {
  it('上下文找不到 → 回填原因并重试，第二次成功', async () => {
    const { dir, clean } = makeProject({ 'src/a.txt': A })
    try {
      const bad = patchFor('src/a.txt', A, 'nowhere')
      const good = patchFor('src/a.txt', A, 'bravo')
      const { result, conversations, progress } = await run(
        dir,
        [editTurn(bad), editTurn(good)],
        [{ id: 's1' }],
      )

      expect(result.edits[0]?.attempts).toBe(2)
      // 第 2 次的提示词里带上了失败原因与"多给上下文"的指示
      const retry = conversations[1]?.messages[0]
      expect(retry?.role === 'user' && retry.text).toContain('无法应用')
      expect(retry?.role === 'user' && retry.text).toContain('上下文')
      expect(progress.join('')).toContain('第 1 次尝试失败')
    } finally {
      clean()
    }
  })

  it('歧义（命中多处）也走重试，并提示需要更多上下文', async () => {
    const dup = ['same', 'same', 'same'].join('\n')
    const { dir, clean } = makeProject({ 'src/d.txt': dup })
    try {
      // 0 上下文 → 命中三处
      const ambiguous = '--- src/d.txt\n+++ src/d.txt\n@@ -1,1 +1,1 @@\n-same\n+CHANGED\n'
      const { result, conversations, progress } = await run(
        dir,
        [editTurn(ambiguous), editTurn(ambiguous), editTurn(ambiguous)],
        [{ id: 's1', files: ['src/d.txt'] }],
        { maxAttempts: 3 },
      )

      expect(result.edits).toHaveLength(0)
      expect(result.skipped[0]?.reason).toContain('命中多处')
      expect(result.skipped[0]?.attempts).toBe(3)
      expect(progress.join('')).toContain('命中多处')
      expect(conversations).toHaveLength(3)
    } finally {
      clean()
    }
  })

  it('重试耗尽后跳过该 step，但不影响其它 step', async () => {
    const { dir, clean } = makeProject({ 'src/a.txt': A, 'src/b.txt': A })
    try {
      const bad = patchFor('src/a.txt', A, 'nowhere')
      const good = patchFor('src/b.txt', A, 'echo')
      const { result } = await run(
        dir,
        // s1 三次都失败
        [editTurn(bad), editTurn(bad), editTurn(bad), editTurn(good)],
        [
          { id: 's1', files: ['src/a.txt'], title: '注定失败' },
          { id: 's2', files: ['src/b.txt'], title: '会成功' },
        ],
        { maxAttempts: 3 },
      )

      expect(result.edits).toHaveLength(1)
      expect(result.edits[0]?.stepId).toBe('s2')
      expect(result.skipped).toHaveLength(1)
      expect(result.skipped[0]?.stepId).toBe('s1')
      // 失败隔离：s2 的改动照常落进快照
      expect(result.merged.map((f) => f.rel)).toEqual(['src/b.txt'])
      expect(result.providerFailed).toBe(false)
    } finally {
      clean()
    }
  })

  it('模型用 skip_step 明确声明跳过 → 立刻结束，不重试', async () => {
    const { dir, clean } = makeProject({ 'src/a.txt': A })
    try {
      const { result, conversations, progress } = await run(
        dir,
        [skipTurn('该函数不在热路径上，改了没有收益')],
        [{ id: 's1' }],
      )
      expect(result.edits).toHaveLength(0)
      expect(result.skipped[0]?.reason).toContain('不在热路径')
      expect(result.skipped[0]?.attempts).toBe(1)
      // 只问了一次：重试只会让模型把同样的理由再说一遍
      expect(conversations).toHaveLength(1)
      expect(progress.join('')).toContain('无需改动')
    } finally {
      clean()
    }
  })

  it('显式跳过与"没遵守格式"必须区分开', async () => {
    // 早先的版本把"回了文本而没调工具"当成"这一步不需要改"，于是模型老老实实
    // 解释不需要改，循环却当成失败去重试——逻辑上自相矛盾。这条钉住现在的区分。
    const { dir, clean } = makeProject({ 'src/a.txt': A })
    try {
      const textOnly = await run(
        dir,
        [textTurn('嗯'), textTurn('嗯'), textTurn('嗯')],
        [{ id: 's1' }],
      )
      expect(textOnly.conversations).toHaveLength(3) // 重试了
      expect(textOnly.result.skipped[0]?.attempts).toBe(3)

      const explicit = await run(dir, [skipTurn('不需要改')], [{ id: 's1' }])
      expect(explicit.conversations).toHaveLength(1) // 没重试
    } finally {
      clean()
    }
  })

  it('空的 patch 被当作失败而不是成功', async () => {
    const { dir, clean } = makeProject({ 'src/a.txt': A })
    try {
      const { result } = await run(
        dir,
        [editTurn('   '), editTurn('   '), editTurn('   ')],
        [{ id: 's1' }],
      )
      expect(result.edits).toHaveLength(0)
      expect(result.skipped[0]?.reason).toContain('空的')
    } finally {
      clean()
    }
  })
})

describe('路径处理', () => {
  it('git 风格的 a/ b/ 前缀被自动剥掉，并记录下来提示用户', async () => {
    const { dir, clean } = makeProject({ 'src/a.txt': A })
    try {
      const withPrefix = patchFor('a/src/a.txt', A, 'alpha').replace(
        '+++ a/src/a.txt',
        '+++ b/src/a.txt',
      )
      const { result } = await run(dir, [editTurn(withPrefix)], [{ id: 's1' }])

      expect(result.edits).toHaveLength(1)
      expect(result.edits[0]?.files).toEqual(['src/a.txt'])
      expect(result.strippedPrefixes).toEqual(['src/a.txt'])
    } finally {
      clean()
    }
  })

  it('指向项目外的路径被拒绝，且当成可重试的失败', async () => {
    const { dir, clean } = makeProject({ 'src/a.txt': A })
    try {
      const evil = '--- ../../etc/passwd\n+++ ../../etc/passwd\n@@ -1,1 +1,1 @@\n-same\n+CHANGED\n'
      const good = patchFor('src/a.txt', A, 'alpha')
      const { result } = await run(dir, [editTurn(evil), editTurn(good)], [{ id: 's1' }])

      expect(result.edits[0]?.attempts).toBe(2)
      expect(result.strippedPrefixes).toEqual([])
    } finally {
      clean()
    }
  })

  it('没有 ---/+++ 文件头的 patch 被拒绝（内容非空，不落进"空 patch"那条分支）', async () => {
    const { dir, clean } = makeProject({ 'src/a.txt': A })
    try {
      const headerless = '@@ -1,1 +1,1 @@\n-alpha\n+CHANGED\n'
      const { result } = await run(
        dir,
        [editTurn(headerless), editTurn(headerless), editTurn(headerless)],
        [{ id: 's1' }],
      )
      expect(result.skipped[0]?.reason).toContain('文件段')
    } finally {
      clean()
    }
  })

  it('step 2 的 diff 若针对旧内容写，会因锚点对不上而失败 —— 反证 overlay 生效', async () => {
    const { dir, clean } = makeProject({ 'src/a.txt': A })
    try {
      const p1 = patchFor('src/a.txt', A, 'alpha')
      const stale = patchFor('src/a.txt', A, 'bravo') // 按**原始**内容写，但 overlay 已改过
      const { result } = await run(
        dir,
        [editTurn(p1), editTurn(stale), editTurn(stale), editTurn(stale)],
        [{ id: 's1' }, { id: 's2' }],
        { maxAttempts: 3 },
      )

      expect(result.edits).toHaveLength(1)
      expect(result.skipped[0]?.stepId).toBe('s2')
      expect(result.skipped[0]?.reason).toContain('找不到')
    } finally {
      clean()
    }
  })
})

describe('provider 失败与用量', () => {
  it('provider 挂掉时立刻停止，后续 step 不再尝试', async () => {
    const { dir, clean } = makeProject({ 'src/a.txt': A })
    try {
      const { result, conversations } = await run(
        dir,
        [{ kind: 'failed', message: '429 限流' }],
        [{ id: 's1' }, { id: 's2' }],
      )
      expect(result.providerFailed).toBe(true)
      expect(result.error).toContain('429')
      expect(conversations).toHaveLength(1)
      expect(result.edits).toHaveLength(0)
    } finally {
      clean()
    }
  })

  it('usage 逐次累加', async () => {
    const { dir, clean } = makeProject({ 'src/a.txt': A })
    try {
      const t1: ProviderTurn = {
        ...editTurn(patchFor('src/a.txt', A, 'alpha')),
        usage: { inputTokens: 10, outputTokens: 4 },
      }
      // step 2 的 diff 要针对叠加后的内容（同"overlay 叠加"那组的原因）
      const t2: ProviderTurn = {
        ...editTurn(patchFor('src/a.txt', A.replace('alpha', 'CHANGED-alpha'), 'bravo')),
        usage: { inputTokens: 20, outputTokens: 6 },
      }
      const { result } = await run(dir, [t1, t2], [{ id: 's1' }, { id: 's2' }])
      expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 10 })
    } finally {
      clean()
    }
  })

  it('step 引用的文件不合法/不存在时**直接跳过**，根本不问模型', async () => {
    // 早先的行为是把"读不到这个文件"告诉模型，让它自行判断。现在在生成前就跳过：
    // 对着一个看不见的文件让模型写 diff，等于请它编——而这里还有一种更硬的原因，
    // 见 overlay 的读取校验（越界路径 / 凭证文件）。
    const { dir, clean } = makeProject({ 'src/a.txt': A })
    try {
      const { result, conversations } = await run(
        dir,
        [], // 一个响应都不准备：若它仍去问模型，测试会因"没有响应"而失败
        [{ id: 's1', files: ['src/missing.txt'] }],
      )
      expect(conversations).toHaveLength(0)
      expect(result.edits).toHaveLength(0)
      expect(result.skipped[0]?.reason).toContain('不存在')
      expect(result.skipped[0]?.attempts).toBe(0)
    } finally {
      clean()
    }
  })

  it('越界路径的 step 被隔离，其它 step 照常生成', async () => {
    const { dir, clean } = makeProject({ 'src/a.txt': A, 'src/b.txt': A })
    try {
      const { result, conversations } = await run(
        dir,
        [editTurn(patchFor('src/b.txt', A, 'echo'))],
        [
          { id: 's1', title: '越界', files: ['../../etc/passwd'] },
          { id: 's2', title: '正常', files: ['src/b.txt'] },
        ],
      )
      // 违规的 step 一次模型调用都没产生
      expect(conversations).toHaveLength(1)
      expect(result.skipped[0]?.stepId).toBe('s1')
      expect(result.skipped[0]?.reason).toContain('非法路径')
      expect(result.edits.map((e) => e.stepId)).toEqual(['s2'])
    } finally {
      clean()
    }
  })
})

describe('"没提交 diff"这条失败路径也要有进度输出', () => {
  it('每次都把失败原因打出来（否则用户只看到"3 次尝试"而不知为何）', async () => {
    // 由来：一次真实 run 里某步用了 3 次尝试，日志里却只有 1 条失败原因——因为
    // "模型没调 submit_edit"这条路径当时只设了 lastReason 给重试用，没有输出。
    const { dir, clean } = makeProject({ 'src/a.txt': A })
    try {
      const { result, progress } = await run(
        dir,
        [
          textTurn('我需要更多信息'),
          textTurn('还是不知道'),
          editTurn(patchFor('src/a.txt', A, 'bravo')),
        ],
        [{ id: 's1' }],
      )
      const joined = progress.join('')
      expect(joined).toContain('第 1 次尝试失败')
      expect(joined).toContain('第 2 次尝试失败')
      expect(result.edits).toHaveLength(1) // 第 3 次交卷成功
    } finally {
      clean()
    }
  })

  it('模型回的长文本被截断，不淹没进度行', async () => {
    const long = 'x'.repeat(500)
    const { dir, clean } = makeProject({ 'src/a.txt': A })
    try {
      const { progress } = await run(
        dir,
        [textTurn(long), textTurn(long), textTurn(long)],
        [{ id: 's1' }],
      )
      const line = progress.find((l) => l.includes('次尝试失败')) ?? ''
      expect(line).toContain('共 500 字符')
      expect(line.length).toBeLessThan(300)
    } finally {
      clean()
    }
  })
})
