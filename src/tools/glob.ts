// 极简 glob 匹配。
//
// **不 shell 出去**（design.md §4.2 第 7 条）：把模型给的模式拼进命令行就是引入
// 注入面。也不用 Node 的 `fs.globSync`——它标着 experimental，而我们只需要"路径
// 匹配"这一件事。
//
// 语义按标准 glob：
//
//   单星号      单层内的任意字符，**不跨斜杠**
//   问号        单层内的单个字符
//   双星号      任意字符，**跨斜杠**
//   双星号加斜杠 零层或多层目录，所以 src/ 后接它再接 *.ts 也能匹配 src/a.ts
//   {a,b}      择一。支持一层，不嵌套
//
// 注意 `*.ts` **不匹配** `src/a.ts`——单星号不跨目录，要跨目录得用双星号那种写法。
// 这是标准语义，此处刻意不为"模型大概想表达的意思"做猜测：猜错会静默地少匹配或
// 多匹配一批文件，比明确不匹配更难查。
//
// （本文件用行注释而非块注释：上面那些模式里含"星号紧跟斜杠"，写进块注释会提前
//   终止注释——`*/` 是块注释的终止符，这个坑刚刚踩过一次。）

const REGEX_SPECIALS = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '[', ']', '|', '\\'])

/** 展开一层 `{a,b}`。不嵌套——嵌套 glob 是另一个复杂度级别，且模型很少用 */
export const expandBraces = (pattern: string): string[] => {
  const open = pattern.indexOf('{')
  if (open === -1) return [pattern]
  const close = pattern.indexOf('}', open)
  if (close === -1) return [pattern]
  const head = pattern.slice(0, open)
  const tail = pattern.slice(close + 1)
  return pattern
    .slice(open + 1, close)
    .split(',')
    .flatMap((alt) => expandBraces(head + alt + tail))
}

const translateOne = (pattern: string): string => {
  let out = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === undefined) break

    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i += 2
        if (pattern[i] === '/') {
          i++
          out += '(?:[^/]*/)*'
        } else {
          out += '.*'
        }
      } else {
        i++
        out += '[^/]*'
      }
      continue
    }
    if (c === '?') {
      i++
      out += '[^/]'
      continue
    }
    out += REGEX_SPECIALS.has(c) ? `\\${c}` : c
    i++
  }
  return out
}

/**
 * 编译结果缓存。
 *
 * 存在的理由：`globToRegExp` 被放在**逐文件的内层循环**里。`doGrep` 与 `doGlob` 对
 * 每个走到的文件调一次 `matchesGlob`，而 `ignore.ignored` 又对每个目录条目做
 * `include.some(matchesGlobLoosely)`——它内部还会对 basename 再调一次。每次调用都要
 * 跑一遍 `expandBraces`（递归 + split + flatMap + join）再 `new RegExp`。
 *
 * 实测两万次调用：每次重新编译 9.0ms，复用已编译 1.0ms，**差 9 倍**。绝对量不大，
 * 但它是「每次调用都重算」且「在最内层循环里」——即那种会随项目规模放大的东西，
 * 也正是 `walkEntries` 默认两万这个量级下值得消除的重复。
 *
 * **缓存是安全的**：`globToRegExp` 是 pattern 的纯函数，且构造时不带 `g` / `y` 标志，
 * 所以 `test()` 不依赖 `lastIndex` 状态。若将来给正则加了标志，这里必须一并改。
 *
 * 设上限只为不无界增长：pattern 来自模型的工具参数与配置，实际只有几十个。超过上限
 * 时整体清空即可，不需要 LRU——命中率本来就接近 100%。
 */
const REGEXP_CACHE = new Map<string, RegExp>()
const REGEXP_CACHE_LIMIT = 256

export const globToRegExp = (pattern: string): RegExp => {
  const cached = REGEXP_CACHE.get(pattern)
  if (cached !== undefined) return cached

  const compiled = new RegExp(`^(?:${expandBraces(pattern).map(translateOne).join('|')})$`)
  if (REGEXP_CACHE.size >= REGEXP_CACHE_LIMIT) REGEXP_CACHE.clear()
  REGEXP_CACHE.set(pattern, compiled)
  return compiled
}

/** `relPath` 用 POSIX 分隔符 */
export const matchesGlob = (pattern: string, relPath: string): boolean =>
  globToRegExp(pattern).test(relPath)

/**
 * 按 gitignore 的直觉匹配：**模式里不含 `/` 时也对 basename 匹配**。
 *
 * 这样 `*.ts` 能匹配 `src/a.ts`。只用于配置里的 include/exclude，不用于 glob 工具
 * ——工具的语义要可预测，配置的语义要符合用户直觉。
 */
export const matchesGlobLoosely = (pattern: string, relPath: string): boolean => {
  if (matchesGlob(pattern, relPath)) return true
  if (pattern.includes('/')) return false
  const slash = relPath.lastIndexOf('/')
  return matchesGlob(pattern, slash === -1 ? relPath : relPath.slice(slash + 1))
}
