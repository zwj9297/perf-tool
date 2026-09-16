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
  /**
   * 未显式配置时是 `undefined`，**不要在这里补默认值**。
   *
   * 默认轮数取决于"有没有实测证据"，而证据又来自**本配置里的 `profile` 字段**
   * ——先把 maxRounds 定下来就成了鸡生蛋。所以默认值的决定推迟到
   * `resolveConfig`，那时 profile 已经解析出来了。
   */
  maxRounds?: number
  /** 相对项目根的 profile 路径，或绝对路径 */
  profile?: string
}

/** 完全解析后的配置：默认值都已落定，下游不必再判 undefined */
export type ResolvedConfig = Config & { maxRounds: number }

export type ConfigFlags = {
  model?: string
  include?: string[]
  exclude?: string[]
  maxRounds?: number
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

/** 有证据时给得多一些：每轮都在回答一个具体问题，收益衰减慢 */
const ROUNDS_WITH_EVIDENCE = 10
/** 无证据时是盲探，边际收益衰减快，给多了只是烧钱 */
const ROUNDS_WITHOUT_EVIDENCE = 8

export const defaultMaxRounds = (hasEvidence: boolean): number =>
  hasEvidence ? ROUNDS_WITH_EVIDENCE : ROUNDS_WITHOUT_EVIDENCE

/** 落定默认轮数。`hasEvidence` 由调用方在解析 profile 之后传入 */
export const resolveConfig = (config: Config, hasEvidence: boolean): ResolvedConfig => ({
  ...config,
  maxRounds: config.maxRounds ?? defaultMaxRounds(hasEvidence),
})

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
  const profile = env.PERF_PROFILE
  if (profile !== undefined && profile !== '') out.profile = profile
  return out
}

const merge = (base: ConfigFlags, over: ConfigFlags): ConfigFlags => {
  const out: ConfigFlags = { ...base }
  if (over.model !== undefined) out.model = over.model
  if (over.maxRounds !== undefined) out.maxRounds = over.maxRounds
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
  }
  if (merged.maxRounds !== undefined) config.maxRounds = merged.maxRounds
  if (merged.profile !== undefined) config.profile = merged.profile

  if (origins.length > 0) notes.push(`覆盖来源：${origins.join('，')}`)
  return { ok: true, config, notes }
}
