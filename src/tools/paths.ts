/**
 * 路径解析与安全边界。**这是整个工具层唯一的安全闸门**，所有读写都必须过这里。
 *
 * 两条独立的防线，缺一不可：
 *
 * 1. **拒绝绝对路径与 `..`**（在 fs 访问之前，纯字符串判断）
 * 2. **`realpath` 之后再判 containment**（在 fs 访问之后）——只做字符串判断是不够的：
 *    一个指向 `/etc/passwd` 的软链，字符串上看着完全在项目内。必须先解析软链，
 *    拿真实路径再判。这与 `CLAUDE.md` 的安全规则、以及 `evidence/` 里 url 是
 *    realpath 那件事同源。
 *
 * **残余风险（已知并接受）**：`realpath` 与随后的读取之间存在 TOCTOU 窗口——期间
 * 有人把路径换成软链就能读到项目外。前提是攻击者已能写这个项目目录，而用户本来
 * 就在这个目录里运行工具，收益极低。Node 也没有可移植的 `O_NOFOLLOW` 可用。
 */
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

export type PathFailureReason =
  /** 绝对路径、含 `..`、或解析后落在项目根外 */
  | 'escapes'
  /** 凭证类文件，一律拒绝 */
  | 'denied-credential'
  /** 路径不存在 */
  | 'not-found'

export type PathFailure = { ok: false; reason: PathFailureReason; detail: string }
export type ResolvedPath = { ok: true; abs: string; rel: string }

/** 一律拒绝的文件名（小写比较） */
const DENIED_BASENAMES = new Set([
  '.env',
  '.npmrc',
  '.netrc',
  '_netrc',
  'credentials',
  '.htpasswd',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
])

/** 一律拒绝的扩展名（小写比较） */
const DENIED_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.ppk',
  '.asc',
  '.gpg',
])

const basenameOf = (p: string): string => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? p : p.slice(i + 1)
}

const extensionOf = (name: string): string => {
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i).toLowerCase()
}

/**
 * 是否凭证类文件。`.env` 与 `.env.local` 这类派生都要拦，所以用前缀判断。
 *
 * 宁可少拦也不要多拦：过宽的规则（比如见到 `secret` 就拦）会挡掉正常源码，
 * 而模型读不到它会以为文件不存在，进而基于残缺信息下结论。
 */
export const isCredentialFile = (relOrAbs: string): boolean => {
  const name = basenameOf(relOrAbs).toLowerCase()
  if (DENIED_BASENAMES.has(name)) return true
  if (name.startsWith('.env.')) return true
  return DENIED_EXTENSIONS.has(extensionOf(name))
}

/** realpath 缓存。同一进程里同一个根只解析一次 */
const realRootCache = new Map<string, string>()

const realRootOf = (projectRoot: string): string => {
  const cached = realRootCache.get(projectRoot)
  if (cached !== undefined) return cached
  let real: string
  try {
    real = realpathSync(projectRoot)
  } catch {
    // 根不存在就让后续的 relative 判断自然失败，报错信息更有意义
    real = resolve(projectRoot)
  }
  realRootCache.set(projectRoot, real)
  return real
}

/**
 * 把一个模型给的路径解析成项目根内的绝对路径。
 *
 * 入参必须是**相对路径**：绝对路径直接拒绝，不做"好心帮忙转换成相对"——那会让
 * 越界尝试变成一次静默成功，而我们要的是明确报错。
 */
export const resolveInsideProject = (
  projectRoot: string,
  input: string,
): ResolvedPath | PathFailure => {
  const raw = input.trim()
  if (raw === '') {
    return { ok: false, reason: 'escapes', detail: '路径为空' }
  }
  if (isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) {
    return { ok: false, reason: 'escapes', detail: `不接受绝对路径：${input}` }
  }
  if (raw.split(/[\\/]/).includes('..')) {
    return { ok: false, reason: 'escapes', detail: `路径不得包含 ..：${input}` }
  }
  // 凭证检查放在 fs 访问之前：这样"被拒绝"永远不会被伪装成"不存在"
  if (isCredentialFile(raw)) {
    return { ok: false, reason: 'denied-credential', detail: `拒绝访问凭证类文件：${input}` }
  }

  const realRoot = realRootOf(projectRoot)
  const abs = resolve(realRoot, raw)

  let real: string
  try {
    real = realpathSync(abs)
  } catch {
    return { ok: false, reason: 'not-found', detail: `不存在：${input}` }
  }

  const rel = relative(realRoot, real)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return {
      ok: false,
      reason: 'escapes',
      detail: `解析后落在项目根之外：${input} → ${real}`,
    }
  }

  // rel === '' 就是项目根本身。**不能当越界拒掉**：`list_dir` 不传 path 时正是要
  // 列根目录。而 `read_file` 拿到它之后会因为"不是文件"而报错，各司其职。
  const posixRel = rel === '' ? '.' : rel.split('\\').join('/')
  // 软链可能把名字伪装成非凭证文件，所以解析之后再查一次
  if (isCredentialFile(posixRel)) {
    return { ok: false, reason: 'denied-credential', detail: `拒绝访问凭证类文件：${posixRel}` }
  }

  return { ok: true, abs: real, rel: posixRel }
}
