/**
 * 配置解析。优先级：**命令行 flag > 环境变量 > `.perftoolrc.json` > 默认值**。
 *
 * 手写校验而不用 TypeBox：这里校验的是**人写的配置文件**，报错要能直接告诉用户
 * 改哪一行；而 TypeBox 那条路（`validateToolArguments`）是强制转换式的，会把这个
 * 场景里最该报错的情况（`"include": "src"` 而不是数组）静默转成合法值。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const CONFIG_FILE = '.perftoolrc.json'

export type Config = {
  model: string
  include: string[]
  exclude: string[]
  /** 已落定默认值，下游不必再判 undefined */
  maxRounds: number
  /** 累计输入 token 上限。见 DEFAULT_MAX_TOKENS 的说明 */
  maxTokens: number
  /** 相对项目根的 profile 路径，或绝对路径 */
  profile?: string
}

/*
 * 这里曾经有个 `Config` / `ResolvedConfig` 的拆分：默认轮数取决于"有没有实测证据"，
 * 而证据来自配置里的 `profile` 字段，于是默认值只能等 profile 解析出来之后才定。
 * 现在默认值与证据无关（轮数统一为兜底、真正的上限是 token 预算），那个鸡生蛋没有了，
 * 拆分也就失去了存在理由——留着只会多一个类型和一个必须记得调的函数。
 */

export type ConfigFlags = {
  model?: string
  include?: string[]
  exclude?: string[]
  maxRounds?: number
  maxTokens?: number
  profile?: string
}

export type ConfigResult =
  | { ok: true; config: Config; notes: string[] }
  | { ok: false; reason: 'file-invalid'; detail: string }

/**
 * 默认模型。
 *
 * 认证由 pi-ai 按 provider 解析，所以这里只管选一个常见的默认值；缺 key 时
 * `describePiAuth` 会给出明确报错，而不是等到第一次调用才失败。
 */
const DEFAULT_MODEL = 'anthropic/claude-sonnet-5'

/**
 * 轮数上限。与 `maxTokens` 互补。
 *
 * 在小仓库上它通常**才是实际生效**的那个（每轮未缓存输入很小，100k 级预算根本用不完）。
 * 它同时兜住"每次只读几行"的模型。大仓库上则由 token 预算先到。
 *
 * **它不再随有无证据变化。** 原设计让两者不同（有证据 10 / 无证据 8），但那个差异
 * 是我猜的——"有证据时每轮都在回答具体问题所以可以多给"与"无证据时是盲探所以该少给"
 * 两种论证都成立，我没有依据选边。而 token 预算成了真正的上限之后，这个差异也就不再
 * 起作用了，所以去掉，避免留一个没有依据的旋钮。
 */
const DEFAULT_MAX_ROUNDS = 20

/**
 * 累计**未命中缓存的输入** token 上限。
 *
 * 400k 是按实测估的：一次 18 轮的运行累计约 70k，约合每轮 4k。所以 400k 在这个规模
 * 的仓库上非常宽松（约 100 轮），实际生效的是 `maxRounds`。它主要防的是**大仓库**：
 * 每轮新读进来的文件更大，未缓存输入随之变大，同样的预算会在更少轮数里耗尽。
 *
 * 两个上限互补，谁先到取决于仓库规模——见 `PlanLoopOptions.maxTokens` 的说明。
 */
const DEFAULT_MAX_TOKENS = 400_000

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const stringArrayOf = (v: unknown, field: string): string[] | string => {
  if (!Array.isArray(v)) return `${field} 必须是字符串数组`
  if (!v.every((x) => typeof x === 'string')) return `${field} 里必须全是字符串`
  return v as string[]
}

type FileConfig = Omit<Partial<Config>, 'profile'> & { profile?: string }

const parseFileConfig = (raw: unknown): FileConfig | string => {
  if (!isRecord(raw)) return `${CONFIG_FILE} 的内容必须是一个 JSON 对象`

  const out: FileConfig = {}
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string' || raw.model === '') return 'model 必须是非空字符串'
    out.model = raw.model
  }
  if (raw.include !== undefined) {
    const v = stringArrayOf(raw.include, 'include')
    if (typeof v === 'string') return v
    out.include = v
  }
  if (raw.exclude !== undefined) {
    const v = stringArrayOf(raw.exclude, 'exclude')
    if (typeof v === 'string') return v
    out.exclude = v
  }
  if (raw.maxTokens !== undefined) {
    if (
      typeof raw.maxTokens !== 'number' ||
      !Number.isInteger(raw.maxTokens) ||
      raw.maxTokens < 1
    ) {
      return 'maxTokens 必须是正整数'
    }
    out.maxTokens = raw.maxTokens
  }
  if (raw.maxRounds !== undefined) {
    if (
      typeof raw.maxRounds !== 'number' ||
      !Number.isInteger(raw.maxRounds) ||
      raw.maxRounds < 1
    ) {
      return 'maxRounds 必须是正整数'
    }
    out.maxRounds = raw.maxRounds
  }
  if (raw.profile !== undefined) {
    if (typeof raw.profile !== 'string' || raw.profile === '') return 'profile 必须是非空字符串'
    out.profile = raw.profile
  }
  // evidence.profile 是 README 里写的形态，也接受
  if (raw.evidence !== undefined) {
    if (!isRecord(raw.evidence)) return 'evidence 必须是对象'
    const p = raw.evidence.profile
    if (p !== undefined) {
      if (typeof p !== 'string' || p === '') return 'evidence.profile 必须是非空字符串'
      out.profile = p
    }
  }
  return out
}

const envOf = (env: Record<string, string | undefined>): ConfigFlags => {
  const out: ConfigFlags = {}
  const model = env.PERF_MODEL
  if (model !== undefined && model !== '') out.model = model
  const rounds = env.PERF_MAX_ROUNDS
  if (rounds !== undefined && rounds !== '') {
    const n = Number(rounds)
    if (Number.isInteger(n) && n > 0) out.maxRounds = n
  }
  const tokens = env.PERF_MAX_TOKENS
  if (tokens !== undefined && tokens !== '') {
    const n = Number(tokens)
    if (Number.isInteger(n) && n > 0) out.maxTokens = n
  }
  const profile = env.PERF_PROFILE
  if (profile !== undefined && profile !== '') out.profile = profile
  return out
}

const merge = (base: ConfigFlags, over: ConfigFlags): ConfigFlags => {
  const out: ConfigFlags = { ...base }
  if (over.model !== undefined) out.model = over.model
  if (over.maxRounds !== undefined) out.maxRounds = over.maxRounds
  if (over.maxTokens !== undefined) out.maxTokens = over.maxTokens
  if (over.profile !== undefined) out.profile = over.profile
  if (over.include !== undefined) out.include = over.include
  if (over.exclude !== undefined) out.exclude = over.exclude
  return out
}

export type LoadConfigInput = {
  projectRoot: string
  flags?: ConfigFlags
  env?: Record<string, string | undefined>
}

export const loadConfig = (input: LoadConfigInput): ConfigResult => {
  const notes: string[] = []

  let fileConfig: FileConfig = {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(input.projectRoot, CONFIG_FILE), 'utf8'))
  } catch (e) {
    // 文件不存在是常态（零配置即可运行）；存在但读不了/解析不了才是错误
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && !(e instanceof SyntaxError) && code !== 'EISDIR') {
      return { ok: false, reason: 'file-invalid', detail: `读取 ${CONFIG_FILE} 失败：${String(e)}` }
    }
    if (e instanceof SyntaxError) {
      return {
        ok: false,
        reason: 'file-invalid',
        detail: `${CONFIG_FILE} 不是合法 JSON：${e.message}`,
      }
    }
  }

  if (raw !== undefined) {
    const parsed = parseFileConfig(raw)
    if (typeof parsed === 'string') return { ok: false, reason: 'file-invalid', detail: parsed }
    fileConfig = parsed
    notes.push(`${CONFIG_FILE} 已读取`)
  }

  const env = envOf(input.env ?? {})
  const flags = input.flags ?? {}

  const merged = merge(merge(fileConfig, env), flags)
  const origins: string[] = []
  if (flags.model !== undefined) origins.push('model←flag')
  else if (env.model !== undefined) origins.push('model←env')
  else if (fileConfig.model !== undefined) origins.push(`model←${CONFIG_FILE}`)

  const config: Config = {
    model: merged.model ?? DEFAULT_MODEL,
    include: merged.include ?? [],
    exclude: merged.exclude ?? [],
    maxRounds: merged.maxRounds ?? DEFAULT_MAX_ROUNDS,
    maxTokens: merged.maxTokens ?? DEFAULT_MAX_TOKENS,
  }
  if (merged.profile !== undefined) config.profile = merged.profile

  if (origins.length > 0) notes.push(`覆盖来源：${origins.join('，')}`)
  return { ok: true, config, notes }
}
