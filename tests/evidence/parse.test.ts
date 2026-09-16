/**
 * `.cpuprofile` 解析的测试。
 *
 * 组织方式与 design.md §6.2 的三条决定性发现有对应关系——每条发现都要有一个
 * **会因"没按它做"而失败**的用例，否则那三条就只是文档里的说法：
 *
 *   ① 内联让函数名归因失真 → 必须按 (文件, 行) 归因
 *   ② positionTicks.line 是 1-based，callFrame.lineNumber 是 0-based
 *   ③ 必须累加 timeDeltas，不能用 hitCount × 名义间隔
 *
 * 另外每条路径分类规则、划分恒等式、以及各种失败路径都有用例。
 */
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { loadCpuProfile, parseCpuProfile, type ParseOptions } from '../../src/evidence/parse.js'

const ROOT = '/proj'
const OPTS: ParseOptions = { projectRoot: ROOT }

type NodeSpec = {
  id: number
  url?: string
  fn?: string
  /** 0-based 函数声明行 */
  line?: number
  hitCount?: number
  ticks?: { line: number; ticks: number }[]
  children?: number[]
}

/** `url` 默认空串（合成节点），`line` 默认 -1（合成节点的实测值） */
const node = (s: NodeSpec): Record<string, unknown> => ({
  id: s.id,
  callFrame: {
    functionName: s.fn ?? '',
    scriptId: '1',
    url: s.url ?? '',
    lineNumber: s.line ?? -1,
    columnNumber: 0,
  },
  ...(s.hitCount === undefined ? {} : { hitCount: s.hitCount }),
  ...(s.ticks === undefined ? {} : { positionTicks: s.ticks }),
  ...(s.children === undefined ? {} : { children: s.children }),
})

const profile = (
  nodes: Record<string, unknown>[],
  samples: number[],
  timeDeltas?: number[],
): Record<string, unknown> => ({
  nodes,
  samples,
  timeDeltas: timeDeltas ?? samples.map(() => 1000),
})

/** 取成功的 evidence，失败直接让测试炸掉并带上原因 */
const mine = (raw: unknown, opts = OPTS) => {
  const r = parseCpuProfile(raw, opts)
  if (!r.ok) throw new Error(`期望成功，实际失败于 ${r.reason}: ${r.detail ?? ''}`)
  return r.evidence
}

describe('发现①：必须按 (文件, 行) 归因，不能按函数名', () => {
  /**
   * 源文件（1-based，与真实实验里的 hot.js 同构）：
   *   1 function hotLoop(n) {
   *   2   let s = 0
   *   3   for (let i = 0; i < n; i++) s += i * i     ← 真正的热行
   *   4   return s
   *   5 }
   *   6 function main() {
   *   7   return hotLoop(1000)                      ← main 自己的行
   *   8 }
   *
   * `main` 的 positionTicks 里 300/400 的 tick 落在**第 3 行**（hotLoop 体内）——
   * 这就是内联。main 自己的第 7 行只有 100/400。
   */
  const fixture = () =>
    profile(
      [
        node({
          id: 1,
          url: 'file:///proj/hot.js',
          fn: 'main',
          line: 5,
          hitCount: 400,
          ticks: [
            { line: 3, ticks: 300 },
            { line: 7, ticks: 100 },
          ],
        }),
        node({
          id: 2,
          url: 'file:///proj/hot.js',
          fn: 'hotLoop',
          line: 0,
          hitCount: 100,
          ticks: [{ line: 3, ticks: 100 }],
        }),
      ],
      // node1 采到 3 次（3000µs），node2 采到 1 次（1000µs），共 4000µs
      [1, 1, 1, 2],
    )

  it('热点落在被内联函数的行上，而不是内联者自己的行', () => {
    const spots = mine(fixture()).hotSpots
    // 3250µs / 4000µs = 0.8125，来自 main 的 2250 + hotLoop 的 1000
    expect(spots[0]?.line).toBe(3)
    expect(spots[0]?.selfShare).toBeCloseTo(0.8125, 6)
  })

  it('对比：按函数名归因会把 main 自己的行当成热点 —— 这正是要避免的', () => {
    const spots = mine(fixture()).hotSpots
    const ownLine = spots.find((s) => s.line === 7)
    // main 自己的行只占 750µs / 4000µs = 0.1875，却被"按函数名"算成 416ms 那种量级
    expect(ownLine?.selfShare).toBeCloseTo(0.1875, 6)
    // 热行是它的 4 倍多；按函数名归因会把注意力引到这一行上
    expect(spots[0]?.selfShare).toBeGreaterThan((ownLine?.selfShare ?? 0) * 4)
  })

  it('symbol 只是提示，与 line 不保证属于同一函数（内联的证据）', () => {
    const spots = mine(fixture()).hotSpots
    const hot = spots.find((s) => s.line === 3)
    // 第 3 行在 hotLoop 体内，但这个热点的主要贡献者是 main（因为内联），
    // 所以 symbol 会是 'main'。数据如实反映这一点，不做粉饰。
    expect(hot?.symbol).toBe('main')
  })

  it('无 positionTicks 时退化到函数定义行，并标为函数级精度', () => {
    const spots = mine(
      profile([node({ id: 1, url: 'file:///proj/a.js', fn: 'foo', line: 41 })], [1, 1]),
    )
    expect(spots.hotSpots[0]?.line).toBe(42) // 0-based 41 → 1-based 42
    expect(spots.hotSpots[0]?.precision).toBe('function')
  })
})

describe('发现②：positionTicks.line 是 1-based，callFrame.lineNumber 是 0-based', () => {
  it('positionTicks 的行号原样使用，不加也不减', () => {
    // 若误按 0-based 处理（+1），会得到 4；若整体偏移，会得到 2
    const spots = mine(
      profile(
        [
          node({
            id: 1,
            url: 'file:///proj/a.js',
            fn: 'f',
            line: 0,
            ticks: [{ line: 3, ticks: 10 }],
          }),
        ],
        [1],
      ),
    )
    expect(spots.hotSpots[0]?.line).toBe(3)
    expect(spots.hotSpots[0]?.precision).toBe('line')
  })

  it('callFrame.lineNumber 需要 +1 —— 两个字段基准不同', () => {
    const spots = mine(profile([node({ id: 1, url: 'file:///proj/a.js', fn: 'f', line: 0 })], [1]))
    // lineNumber 0 表示函数在第一行；若不加 1 会得到第 0 行这种不存在的行号
    expect(spots.hotSpots[0]?.line).toBe(1)
  })

  it('lineNumber 为负时不产出任何行（防第 0 行）', () => {
    const spots = mine(profile([node({ id: 1, url: 'file:///proj/a.js', fn: 'f', line: -1 })], [1]))
    expect(spots.hotSpots).toEqual([])
    // 时间仍然算进项目份额，只是没有行可落
    expect(spots.projectShare).toBe(1)
  })
})

describe('发现③：必须累加 timeDeltas，不能用 hitCount × 名义间隔', () => {
  it('两个节点给出互相矛盾的信号时，以 timeDeltas 为准', () => {
    const spots = mine(
      profile(
        [
          node({
            id: 1,
            url: 'file:///proj/a.js',
            fn: 'a',
            line: 0,
            hitCount: 500,
            ticks: [{ line: 1, ticks: 1 }],
          }),
          node({
            id: 2,
            url: 'file:///proj/b.js',
            fn: 'b',
            line: 0,
            hitCount: 1,
            ticks: [{ line: 1, ticks: 1 }],
          }),
        ],
        // node1 被采到 2 次，node2 只有 1 次 —— hitCount 会说 a.js 是热点
        [1, 1, 2],
        // 但 node2 那一次采样间隔是 9800µs，占了绝大部分真实耗时
        [100, 100, 9800],
      ),
    )
    expect(spots.hotSpots[0]?.file).toBe('b.js')
    expect(spots.hotSpots[0]?.selfShare).toBeCloseTo(9800 / 10000, 6)
    expect(spots.hotSpots[1]?.file).toBe('a.js')
  })

  it('totalSampledMs 来自 timeDeltas 之和，不是 hitCount × 间隔', () => {
    const spots = mine(
      profile([node({ id: 1, url: 'file:///proj/a.js', fn: 'f', line: 0 })], [1, 1], [1000, 3000]),
    )
    expect(spots.totalSampledMs).toBeCloseTo(4, 6)
  })
})

describe('划分恒等式：三个份额之和为 1', () => {
  it('各类节点齐全时三者之和精确为 1', () => {
    const spots = mine(
      profile(
        [
          node({ id: 1, url: 'file:///proj/src/a.js', fn: 'a', line: 0 }),
          node({ id: 2, url: 'file:///proj/node_modules/dep/index.js', fn: 'd', line: 0 }),
          node({ id: 3, url: 'file:///other/sibling/src/x.js', fn: 's', line: 0 }),
          node({ id: 4, url: 'node:internal/modules/cjs/loader', fn: 'l', line: 0 }),
          node({ id: 5, url: '', fn: '(program)', line: -1 }),
          node({ id: 6, url: 'webpack:///./src/b.js', fn: 'w', line: 0 }),
        ],
        [1, 2, 3, 4, 5, 6],
      ),
    )
    // 各 1/6：项目 1 个、非项目 3 个（依赖/兄弟包/webpack）、引擎 2 个
    expect(spots.projectShare).toBeCloseTo(1 / 6, 6)
    expect(spots.dependencyShare).toBeCloseTo(3 / 6, 6)
    expect(spots.engineShare).toBeCloseTo(2 / 6, 6)
    expect(spots.projectShare + spots.dependencyShare + spots.engineShare).toBeCloseTo(1, 9)
  })

  it('采样指向不存在的节点时，之和小于 1 而不是被塞进某个桶里', () => {
    const spots = mine(
      profile([node({ id: 1, url: 'file:///proj/a.js', fn: 'a', line: 0 })], [1, 999]),
    )
    const sum = spots.projectShare + spots.dependencyShare + spots.engineShare
    expect(sum).toBeCloseTo(0.5, 6)
    expect(sum).toBeLessThan(1)
  })
})

describe('路径分类：依赖不能进 hotSpots', () => {
  const spots = () =>
    mine(
      profile(
        [
          node({ id: 1, url: 'file:///proj/src/a.js', fn: 'mine', line: 0 }),
          node({ id: 2, url: 'file:///proj/node_modules/dep/index.js', fn: 'theirs', line: 0 }),
          node({
            id: 3,
            url: 'file:///proj/node_modules/.pnpm/x/node_modules/y/i.js',
            fn: 'deep',
            line: 0,
          }),
        ],
        [1, 2, 3],
      ),
    )

  it('根内 node_modules 是依赖，不是项目代码', () => {
    const e = spots()
    // 这一条是本次实现中发现的设计漏洞：只看"是否落在项目根外"会把根内的
    // node_modules 算成项目代码，于是依赖的热点进了 hotSpots，
    // 模型就会去"优化"一个它改不了的第三方包。
    expect(e.hotSpots.map((s) => s.file)).toEqual(['src/a.js'])
    expect(e.dependencyShare).toBeCloseTo(2 / 3, 6)
  })

  it('嵌套的 node_modules 同样被识别', () => {
    expect(spots().dependencyTop?.some((p) => p.includes('.pnpm'))).toBe(true)
  })

  it('dependencyTop 按耗时降序列出，便于判断是否该看依赖', () => {
    const e = spots()
    expect(e.dependencyTop?.length).toBeGreaterThan(0)
    // 绝对路径，仅作诊断
    expect(e.dependencyTop?.[0]).toContain('node_modules')
  })

  it('node:internal 与合成节点归入引擎，且不出现在 dependencyTop', () => {
    const e = mine(
      profile(
        [
          node({ id: 1, url: 'file:///proj/a.js', fn: 'a', line: 0 }),
          node({ id: 2, url: 'node:fs', fn: 'f', line: 0 }),
        ],
        [1, 2],
      ),
    )
    expect(e.engineShare).toBeCloseTo(0.5, 6)
    expect(e.dependencyTop).toBeUndefined()
  })

  it('项目外的路径也用相对根的路径写 hotSpots 之外的字段', () => {
    const e = mine(
      profile([node({ id: 1, url: 'file:///proj/src/deep/a.js', fn: 'a', line: 0 })], [1]),
    )
    expect(e.hotSpots[0]?.file).toBe('src/deep/a.js') // POSIX 分隔符、相对根
  })
})

describe('hotSpots 截断不能静默', () => {
  it('超过上限时记录被丢弃的数量与份额', () => {
    const nodes = Array.from({ length: 25 }, (_, i) =>
      node({ id: i + 1, url: `file:///proj/f${i}.js`, fn: `f${i}`, line: 0 }),
    )
    const e = mine(
      profile(
        nodes,
        nodes.map((_, i) => i + 1),
      ),
      { ...OPTS, maxHotSpots: 20 },
    )
    expect(e.hotSpots).toHaveLength(20)
    expect(e.hotSpotsOmitted?.count).toBe(5)
    expect(e.hotSpotsOmitted?.share).toBeGreaterThan(0)
  })

  it('未超上限时不出现该字段（避免让模型以为有东西没显示）', () => {
    const e = mine(profile([node({ id: 1, url: 'file:///proj/a.js', fn: 'a', line: 0 })], [1]))
    expect(e.hotSpotsOmitted).toBeUndefined()
  })
})

describe('失败路径都返回可诊断的 reason，不抛异常', () => {
  const cases: { name: string; raw: unknown; reason: string }[] = [
    { name: '不是对象', raw: 'nope', reason: 'unsupported-format' },
    { name: '缺少 samples', raw: { nodes: [], timeDeltas: [] }, reason: 'unsupported-format' },
    {
      name: 'samples 非数字数组',
      raw: { nodes: [], samples: ['x'], timeDeltas: [1] },
      reason: 'unsupported-format',
    },
    {
      name: 'node 结构不合法',
      raw: { nodes: [{ id: 'x' }], samples: [1], timeDeltas: [1] },
      reason: 'unsupported-format',
    },
    {
      name: 'samples 与 timeDeltas 长度不等',
      raw: {
        nodes: [node({ id: 1, url: 'file:///proj/a.js', line: 0 })],
        samples: [1, 1],
        timeDeltas: [1],
      },
      reason: 'samples-mismatch',
    },
    {
      name: '采样时长为 0',
      raw: profile([node({ id: 1, url: 'file:///proj/a.js', line: 0 })], [1], [0]),
      reason: 'no-samples',
    },
    {
      name: '没有任何代码落在项目根内',
      raw: profile([node({ id: 1, url: 'file:///elsewhere/a.js', line: 0 })], [1]),
      reason: 'no-project-code',
    },
    {
      name: '只有依赖与引擎、没有项目代码',
      raw: profile([node({ id: 1, url: 'file:///proj/node_modules/d/index.js', line: 0 })], [1]),
      reason: 'no-project-code',
    },
  ]

  for (const c of cases) {
    it(`${c.name} -> ${c.reason}`, () => {
      const r = parseCpuProfile(c.raw, OPTS)
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.reason).toBe(c.reason)
    })
  }

  it('no-project-code 的 detail 指出根路径，便于用户定位问题', () => {
    const r = parseCpuProfile(
      profile([node({ id: 1, url: 'file:///elsewhere/a.js', line: 0 })], [1]),
      OPTS,
    )
    expect(r.ok === false && r.detail).toContain(ROOT)
  })
})

describe('loadCpuProfile：文件读取与 realpath 归一化', () => {
  const write = (text: string): { dir: string; file: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-ev-'))
    const file = join(dir, 'p.cpuprofile')
    writeFileSync(file, text)
    return { dir, file }
  }

  it('读文件并解析成功', () => {
    const { dir, file } = write(
      JSON.stringify(profile([node({ id: 1, url: 'file:///proj/a.js', fn: 'a', line: 0 })], [1])),
    )
    try {
      const r = loadCpuProfile(file, OPTS)
      expect(r.ok).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('文件不存在 -> read-failed', () => {
    const r = loadCpuProfile('/nonexistent/nope.cpuprofile', OPTS)
    expect(r.ok === false && r.reason).toBe('read-failed')
  })

  it('内容不是 JSON -> invalid-json', () => {
    const { dir, file } = write('{ this is not json')
    try {
      const r = loadCpuProfile(file, OPTS)
      expect(r.ok === false && r.reason).toBe('invalid-json')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('项目根经软链给出时也能匹配 —— profile 里的 url 是 realpath', () => {
    // 这是 macOS 上必然踩到的坑：tmpdir() 返回 /var/... 而 realpath 是 /private/var/...。
    // 实测 profile 里写的就是 realpath。不做归一化的话，用户从软链目录跑必定匹配不上。
    const dir = mkdtempSync(join(tmpdir(), 'perf-ev-'))
    const link = join(tmpdir(), `perf-ev-link-${process.pid}-${Date.now()}`)
    try {
      const realDir = realpathSync(dir)
      const file = join(dir, 'p.cpuprofile')
      // url 用 realpath 写，模拟 V8 的行为
      writeFileSync(
        file,
        JSON.stringify(
          profile(
            [node({ id: 1, url: pathToFileURL(join(realDir, 'a.js')).href, fn: 'a', line: 0 })],
            [1],
          ),
        ),
      )
      symlinkSync(realDir, link, 'dir')
      // 用软链路径当项目根：不做 realpath 就会因为路径对不上而报 no-project-code
      const r = loadCpuProfile(file, { projectRoot: link })
      expect(r.ok).toBe(true)
      expect(r.ok && r.evidence.projectShare).toBe(1)
    } finally {
      rmSync(link, { force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
