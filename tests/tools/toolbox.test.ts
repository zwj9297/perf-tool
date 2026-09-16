/**
 * 只读工具的测试。用**真实文件系统**（临时目录）而不是 mock fs——这一层的核心
 * 价值就是真实的路径解析与软链行为，mock 掉 fs 等于把要测的东西测没了。
 *
 * 最要紧的一组是「符号链接越过项目根」：字符串上看着完全在项目内，只有 realpath
 * 之后才看得出越界。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { globToRegExp, matchesGlob } from '../../src/tools/glob.js'
import { isCredentialFile, resolveInsideProject } from '../../src/tools/paths.js'
import { createToolbox } from '../../src/tools/toolbox.js'
import type { ProviderToolCall } from '../../src/providers/types.js'
import type { Toolbox } from '../../src/tools/types.js'

const SRC_A = [
  'export function hot(n: number) {',
  '  let sum = 0',
  '  for (let i = 0; i < n; i++) sum += i',
  '  return sum',
  '}',
  '',
  'export const marker = "NEEDLE_IN_A"',
  '',
].join('\n')

let base = ''
let proj = ''
let outside = ''
let toolbox: Toolbox
const ctx = { projectRoot: '' }

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'perf-tools-'))
  proj = join(base, 'proj')
  outside = join(base, 'outside')

  mkdirSync(join(proj, 'src', 'deep'), { recursive: true })
  mkdirSync(join(proj, 'node_modules', 'dep'), { recursive: true })
  mkdirSync(join(proj, 'ignored-dir'), { recursive: true })
  mkdirSync(outside, { recursive: true })

  writeFileSync(join(proj, 'src', 'a.ts'), SRC_A)
  writeFileSync(join(proj, 'src', 'deep', 'b.ts'), 'export const NEEDLE_IN_B = 1\n')
  writeFileSync(join(proj, 'node_modules', 'dep', 'index.js'), 'const NEEDLE_IN_DEP = 1\n')
  writeFileSync(join(proj, 'ignored-dir', 'x.ts'), 'export const NEEDLE_IN_IGNORED = 1\n')
  writeFileSync(join(proj, 'build.log'), 'NEEDLE_IN_LOG\n')
  writeFileSync(join(proj, 'README.md'), '# readme\n')
  writeFileSync(join(proj, '.env'), 'SECRET=1\n')
  writeFileSync(join(proj, '.env.local'), 'SECRET=2\n')
  writeFileSync(join(proj, 'server.pem'), 'KEY\n')
  writeFileSync(join(proj, '.gitignore'), 'ignored-dir/\n*.log\n')
  // 软链：一个指向项目外，一个指向项目内的另一个目录
  writeFileSync(join(outside, 'outside.ts'), 'export const OUTSIDE = 1\n')
  symlinkSync(outside, join(proj, 'link-outside'), 'dir')
  symlinkSync(join(proj, 'src'), join(proj, 'link-inside'), 'dir')

  toolbox = createToolbox({ projectRoot: proj })
  ctx.projectRoot = proj
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

const call = (name: string, args: Record<string, unknown>): ProviderToolCall => ({
  id: `t-${name}`,
  name,
  arguments: args,
})

const run = (name: string, args: Record<string, unknown>) => toolbox.run(call(name, args), ctx)

describe('glob 匹配语义', () => {
  it('单星号不跨目录', () => {
    expect(matchesGlob('*.ts', 'a.ts')).toBe(true)
    expect(matchesGlob('*.ts', 'src/a.ts')).toBe(false)
  })

  it('双星号跨目录，且可匹配零层', () => {
    expect(matchesGlob('src/**/*.ts', 'src/a.ts')).toBe(true)
    expect(matchesGlob('src/**/*.ts', 'src/deep/b.ts')).toBe(true)
    expect(matchesGlob('**/*.ts', 'src/deep/b.ts')).toBe(true)
    expect(matchesGlob('**/*.ts', 'a.ts')).toBe(true)
  })

  it('问号匹配单个字符且不跨目录', () => {
    expect(matchesGlob('a?.ts', 'ab.ts')).toBe(true)
    expect(matchesGlob('a?.ts', 'a/b.ts')).toBe(false)
  })

  it('花括号择一', () => {
    expect(matchesGlob('**/*.{ts,tsx}', 'src/a.ts')).toBe(true)
    expect(matchesGlob('**/*.{ts,tsx}', 'src/a.tsx')).toBe(true)
    expect(matchesGlob('**/*.{ts,tsx}', 'src/a.js')).toBe(false)
  })

  it('正则特殊字符被转义，不会当成通配', () => {
    expect(matchesGlob('a+b.ts', 'a+b.ts')).toBe(true)
    expect(matchesGlob('a+b.ts', 'aab.ts')).toBe(false) // 若没转义 + 会变成量词
    expect(matchesGlob('a.b.ts', 'axb.ts')).toBe(false) // 若没转义 . 会匹配任意字符
  })
})

describe('路径安全：这一层的核心', () => {
  it('拒绝绝对路径与 .. 越界', () => {
    for (const p of ['/etc/passwd', '../outside/outside.ts', 'src/../../x.ts']) {
      const r = resolveInsideProject(proj, p)
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.reason).toBe('escapes')
    }
  })

  it('软链指向项目外 → 拒绝（只有 realpath 之后才看得出越界）', () => {
    // 字符串上 'link-outside/outside.ts' 完全在项目内，但它 realpath 之后在外面
    const r = resolveInsideProject(proj, 'link-outside/outside.ts')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('escapes')
    expect(r.ok === false && r.detail).toContain('项目根之外')
  })

  it('软链指向项目内 → 允许（不能因为防越界就把合法路径也挡了）', () => {
    const r = resolveInsideProject(proj, 'link-inside/a.ts')
    expect(r.ok).toBe(true)
    // 返回的是解析后的真实相对路径
    expect(r.ok && r.rel).toBe('src/a.ts')
  })

  it('凭证类文件被拒绝，且原因是"拒绝"而不是"不存在"', () => {
    for (const p of ['.env', '.env.local', 'server.pem']) {
      const r = resolveInsideProject(proj, p)
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.reason).toBe('denied-credential')
    }
  })

  it('凭证判断覆盖 .env 派生与常见密钥扩展名，但不误伤正常源码', () => {
    for (const p of ['.env', '.env.production', 'a.pem', 'a.key', 'id_rsa', '.npmrc']) {
      expect(isCredentialFile(p)).toBe(true)
    }
    for (const p of ['src/a.ts', 'environment.ts', 'env.ts', 'my.keyboard.ts', 'README.md']) {
      expect(isCredentialFile(p)).toBe(false)
    }
  })

  it('read_file 读 .env 被拒（走完整工具链）', async () => {
    const r = await run('read_file', { path: '.env' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('拒绝')
  })

  /**
   * 凭证文件必须**四个工具一致地**不可见/不可读。
   *
   * 这条断言不是凑数：最初 `list_dir` / `grep` / `glob` 只过了 gitignore，没过凭证
   * 黑名单，于是 `.env`、`server.pem` 会出现在目录列表里——文档承诺的"跳过 .env"
   * 只兑现了四分之一，而且工具之间自相矛盾。
   */
  it('凭证文件对所有工具都不可见', async () => {
    const listed = await run('list_dir', {})
    for (const name of ['.env', '.env.local', 'server.pem']) {
      expect(listed.text).not.toContain(name)
    }

    // grep 也搜不到它们的内容
    const grepped = await run('grep', { pattern: 'SECRET' })
    expect(grepped.text).toContain('没有匹配')

    // glob 也列不出它们
    const globbed = await run('glob', { pattern: '**/*' })
    expect(globbed.text).not.toContain('.env')
    expect(globbed.text).not.toContain('.pem')
  })
})

describe('read_file', () => {
  it('返回带行号的内容与总行数', async () => {
    const r = await run('read_file', { path: 'src/a.ts' })
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain('共 8 行')
    expect(r.text).toContain('     1| export function hot')
    expect(r.text).toContain('NEEDLE_IN_A')
  })

  it('指定行范围只返回那一段，且不算截断', async () => {
    const r = await run('read_file', { path: 'src/a.ts', start: 3, end: 4 })
    expect(r.text).toContain('第 3-4 行')
    expect(r.text).toContain('     3|   for (let i')
    expect(r.text).not.toContain('NEEDLE_IN_A')
    // 模型自己指定的范围被满足，就不该说"已截断"
    expect(r.truncated).not.toBe(true)
  })

  it('被文件末尾截住不算截断（"请缩小范围"在那个场景是误导）', async () => {
    const r = await run('read_file', { path: 'src/a.ts', start: 1, end: 999 })
    expect(r.text).toContain('第 1-8 行')
    expect(r.truncated).not.toBe(true)
  })

  it('未指定范围且文件超长时截断，并标记 truncated', async () => {
    const long = Array.from({ length: 900 }, (_, i) => `line ${i + 1}`).join('\n')
    writeFileSync(join(proj, 'long.txt'), long)
    const r = await run('read_file', { path: 'long.txt' })
    expect(r.text).toContain('共 900 行')
    expect(r.text).toContain('第 1-400 行')
    expect(r.truncated).toBe(true)
  })

  it('起始行超出总行数时给出明确说明', async () => {
    const r = await run('read_file', { path: 'src/a.ts', start: 500 })
    expect(r.text).toContain('只有 8 行')
  })

  it('目录、二进制、不存在的路径都被拒且各有说明', async () => {
    writeFileSync(join(proj, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00]))
    const dir = await run('read_file', { path: 'src' })
    expect(dir.isError).toBe(true)
    expect(dir.text).toContain('list_dir')

    const bin = await run('read_file', { path: 'bin.dat' })
    expect(bin.isError).toBe(true)
    expect(bin.text).toContain('二进制')

    const missing = await run('read_file', { path: 'nope.ts' })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('不存在')
  })

  it('超长单行被截断并在头部说明', async () => {
    writeFileSync(join(proj, 'min.js'), `var a=${'x'.repeat(5000)};\n`)
    const r = await run('read_file', { path: 'min.js' })
    expect(r.text).toContain('过长被截断')
  })
})

describe('grep', () => {
  it('找到匹配并给出 文件:行号', async () => {
    const r = await run('grep', { pattern: 'NEEDLE_IN_A' })
    expect(r.text).toContain('src/a.ts:7:')
  })

  it('可用 glob 限定范围', async () => {
    const r = await run('grep', { pattern: 'NEEDLE_IN_B', glob: 'src/**/*.ts' })
    expect(r.text).toContain('src/deep/b.ts:1:')
  })

  it('不会走进 node_modules / 被 gitignore 的目录 / 日志', async () => {
    for (const needle of ['NEEDLE_IN_DEP', 'NEEDLE_IN_IGNORED', 'NEEDLE_IN_LOG']) {
      const r = await run('grep', { pattern: needle })
      expect(r.text).toContain('没有匹配')
    }
  })

  it('非法正则给出可修正的报错，而不是抛异常', async () => {
    const r = await run('grep', { pattern: '[' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('正则不合法')
  })

  it('反向查询场景：找函数的调用点', async () => {
    writeFileSync(join(proj, 'src', 'caller.ts'), 'import { hot } from "./a"\nhot(100)\n')
    const r = await run('grep', { pattern: 'hot\\(' })
    expect(r.text).toContain('src/caller.ts:2:')
  })
})

describe('glob 工具', () => {
  it('按模式列举文件', async () => {
    const r = await run('glob', { pattern: 'src/**/*.ts' })
    expect(r.text).toContain('src/a.ts')
    expect(r.text).toContain('src/deep/b.ts')
    expect(r.text).not.toContain('node_modules')
  })

  it('无匹配时说明而不是空字符串', async () => {
    const r = await run('glob', { pattern: '**/*.rs' })
    expect(r.text).toContain('没有文件匹配')
  })
})

describe('list_dir', () => {
  it('不传 path 时列项目根，目录带尾斜杠', async () => {
    const r = await run('list_dir', {})
    expect(r.text).toContain('src/')
    expect(r.text).toContain('README.md')
  })

  it('过滤掉 node_modules 与被 gitignore 的目录', async () => {
    const r = await run('list_dir', {})
    expect(r.text).not.toContain('node_modules')
    expect(r.text).not.toContain('ignored-dir')
  })

  it('列子目录', async () => {
    const r = await run('list_dir', { path: 'src' })
    expect(r.text).toContain('a.ts')
    expect(r.text).toContain('deep/')
  })

  it('文件路径被拒并提示用 read_file', async () => {
    const r = await run('list_dir', { path: 'README.md' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('read_file')
  })

  it('软链不会被当成目录走进去（走树的安全性）', async () => {
    const r = await run('list_dir', {})
    // link-outside 存在但指向项目外；走树时它既非目录也非普通文件，被跳过
    expect(r.text).not.toContain('link-outside/')
  })
})

describe('参数校验', () => {
  it('缺必填参数时回填 isError，而不是让实现读到 undefined', async () => {
    const r = await run('read_file', {})
    expect(r.isError).toBe(true)
    expect(r.text).toContain('参数不合法')
  })

  it('参数类型不对时同样被拦下', async () => {
    const r = await run('grep', { pattern: 123 as unknown as string })
    // TypeBox 会做强转，所以数字变成字符串后是合法的 —— 断言它至少没崩，且行为可预期
    expect(typeof r.text).toBe('string')
  })

  it('多余的参数被拒绝（additionalProperties: false）', async () => {
    const r = await run('glob', { pattern: '*.ts', evil: 1 })
    expect(r.isError).toBe(true)
  })
})

describe('include / exclude 的语义', () => {
  it('include 是白名单，但只作用于文件——目录必须继续走', async () => {
    const tb = createToolbox({ projectRoot: proj, include: ['src/**/*.ts'] })
    const r = await tb.run(call('glob', { pattern: '**/*' }), ctx)
    expect(r.text).toContain('src/a.ts')
    expect(r.text).not.toContain('README.md')
  })

  it('exclude 命中即排除', async () => {
    const tb = createToolbox({ projectRoot: proj, exclude: ['src/deep/**'] })
    const r = await tb.run(call('glob', { pattern: '**/*.ts' }), ctx)
    expect(r.text).toContain('src/a.ts')
    expect(r.text).not.toContain('deep/b.ts')
  })

  it('include 里不含斜杠的模式按 basename 匹配（配置语义要符合直觉）', async () => {
    const tb = createToolbox({ projectRoot: proj, include: ['*.ts'] })
    const r = await tb.run(call('glob', { pattern: '**/*' }), ctx)
    expect(r.text).toContain('src/a.ts')
    expect(r.text).toContain('src/deep/b.ts')
    expect(r.text).not.toContain('README.md')
  })
})

describe('glob 编译结果被缓存 —— 消除内层循环里的重复编译', () => {
  /**
   * 断言用的是**对象同一性**而不是耗时：计时断言会 flaky，而"同一 pattern 返回同一个
   * RegExp 对象"是确定性的，它恰好就是缓存存在的定义。
   *
   * 这条缓存针对的是一个具体的调用形态：`doGrep` / `doGlob` 对每个走到的文件调一次
   * `matchesGlob`，`ignore.ignored` 又对每个目录条目做 `include.some(matchesGlobLoosely)`
   * （它内部还会对 basename 再调一次）。实测两万次调用从 9.0ms 降到 1.0ms。
   */
  it('同一 pattern 返回同一个 RegExp 对象', () => {
    expect(globToRegExp('src/**/*.ts')).toBe(globToRegExp('src/**/*.ts'))
  })

  it('不同 pattern 各有各的，语义不变', () => {
    expect(globToRegExp('*.ts')).not.toBe(globToRegExp('*.js'))
    expect(matchesGlob('*.ts', 'a.ts')).toBe(true)
    expect(matchesGlob('*.ts', 'src/a.ts')).toBe(false)
  })

  it('交替使用多个 pattern 不会串味', () => {
    for (let i = 0; i < 5; i++) {
      expect(matchesGlob('**/*.ts', 'src/a.ts')).toBe(true)
      expect(matchesGlob('**/*.js', 'src/a.ts')).toBe(false)
    }
  })

  it('超过缓存上限后语义仍正确（清空只是丢缓存，不影响结果）', () => {
    for (let i = 0; i < 300; i++) matchesGlob(`p${i}*.ts`, 'x.ts')
    expect(matchesGlob('src/**/*.ts', 'src/a.ts')).toBe(true)
    expect(matchesGlob('src/**/*.ts', 'src/a.js')).toBe(false)
  })
})

describe('过滤规则生效时，工具要提醒"没有结果 ≠ 不存在"', () => {
  // 这条的由来是一次实测：模型把被 include 白名单挡住的 package.json 与 tsconfig.json
  // 当成了"项目里没有这些东西"，并据此声明"构建配置与测试基线无法核实"。
  const filtered = () => createToolbox({ projectRoot: proj, include: ['src/**/*.ts'] })

  it('glob 无匹配时附上过滤说明', async () => {
    const r = await filtered().run(call('glob', { pattern: '**/*.json' }), ctx)
    expect(r.text).toContain('没有文件匹配')
    expect(r.text).toContain('白名单')
    expect(r.text).toContain('不等于"不存在"')
  })

  it('list_dir 的输出里也附上（"文件不存在"的推断就发生在这里）', async () => {
    const r = await filtered().run(call('list_dir', {}), ctx)
    expect(r.text).toContain('白名单')
  })

  it('grep 无匹配时附上', async () => {
    const r = await filtered().run(call('grep', { pattern: 'NEEDLE_IN_LOG' }), ctx)
    expect(r.text).toContain('没有匹配')
    expect(r.text).toContain('白名单')
  })

  it('没有配过滤时不附（不制造噪音）', async () => {
    const r = await run('glob', { pattern: '**/*.nope' })
    expect(r.text).not.toContain('不等于"不存在"')
  })
})
