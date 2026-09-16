/**
 * 忽略规则：目标项目的 `.gitignore` + 配置的 include/exclude。
 *
 * `context/` 的文件发现应当**复用这里**，不要另写一套——两套忽略规则迟早会漂移，
 * 而症状是"模型能 grep 到的文件，上下文里却没有"这类很难查的不一致。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import ignore from 'ignore'

import { matchesGlobLoosely } from './glob.js'

/**
 * 无条件排除的目录名。
 *
 * `node_modules` 是**安全网**而非重复规则：没有它，一个没有 `.gitignore` 的项目
 * 会让走树直接进 `node_modules`（几十万文件），grep 与 glob 都会卡死。`.git` 同理，
 * 而且它的内容对性能分析没有意义。
 *
 * 这也与 `evidence/` 把 `node_modules` 一律算作依赖保持一致。
 */
const ALWAYS_IGNORED_DIRS = new Set(['node_modules', '.git'])

export type IgnoreOptions = {
  projectRoot: string
  /** 配置里的 include。**非空时构成白名单**：文件必须匹配其中之一 */
  include?: readonly string[]
  /** 配置里的 exclude。命中即排除 */
  exclude?: readonly string[]
}

export type IgnoreSet = {
  /** `relPath` 用 POSIX 分隔符。`isDir` 影响目录型规则的匹配，见下方说明 */
  ignored(relPath: string, isDir: boolean): boolean
}

export const loadIgnore = (options: IgnoreOptions): IgnoreSet => {
  const ig = ignore()
  try {
    ig.add(readFileSync(join(options.projectRoot, '.gitignore'), 'utf8'))
  } catch {
    // 没有 .gitignore 是常态，不是错误
  }
  if (options.exclude !== undefined && options.exclude.length > 0) {
    ig.add([...options.exclude])
  }
  const include = options.include ?? []

  return {
    ignored(relPath: string, isDir: boolean): boolean {
      const posix = relPath.split('\\').join('/')
      if (posix === '') return false

      const segments = posix.split('/')
      if (segments.some((s) => ALWAYS_IGNORED_DIRS.has(s))) return true

      // 目录型规则（`node_modules/`）只匹配带尾斜杠的形式 —— 实测
      // `ignores('node_modules')` 为 false 而 `ignores('node_modules/')` 为 true。
      // 而无斜杠规则（`dist`）两者都匹配。所以目录要两种都试，文件只试原形。
      if (ig.ignores(isDir ? `${posix}/` : posix)) return true
      if (isDir && ig.ignores(posix)) return true

      // include 是白名单，但**只对文件生效**：目录必须继续走下去，
      // 否则 `include: ['src/**/*.ts']` 会把 `src` 本身挡在门外，什么都找不到。
      if (!isDir && include.length > 0) {
        return !include.some((p) => matchesGlobLoosely(p, posix))
      }
      return false
    },
  }
}
