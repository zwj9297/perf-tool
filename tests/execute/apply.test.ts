/**
 * 落盘与 git 提交的测试。
 *
 * **这是唯一会改用户代码的模块**，所以测试的重点全在"该拒绝的时候有没有拒绝"：
 * 基线被动过、不是仓库、有未提交改动、没有 git 身份、分支已存在——每一种都必须
 * 在**写出第一个字节之前**停下来。
 *
 * 另一组重点是 per-step 快照：两个 step 改同一个文件时，第一个 commit 里必须是
 * **第一步之后**的内容，而不是最终态。少了这条，`git revert` 就没法精确回退单步
 * ——而那正是敢改用户代码的前提。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  applyEdits,
  buildBranchName,
  checkPreconditions,
  findStaleFiles,
  slugify,
} from '../../src/execute/apply.js'
import type { StepEdit } from '../../src/execute/generate.js'
import type { OverlayFile } from '../../src/execute/overlay.js'

const V1 = ['alpha', 'bravo', 'charlie'].join('\n')
const V2 = ['CHANGED-alpha', 'bravo', 'charlie'].join('\n')
const V3 = ['CHANGED-alpha', 'CHANGED-bravo', 'charlie'].join('\n')

const git = (cwd: string, args: string[]): { status: number; stdout: string } => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { status: r.status ?? 1, stdout: (r.stdout ?? '').trim() }
}

type ProjectOpts = {
  git?: boolean
  identity?: boolean
  dirty?: boolean
  extra?: Record<string, string>
}

const makeProject = (opts: ProjectOpts = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'perf-apply-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.txt'), V1)

  if (opts.git === true) {
    git(dir, ['init'])
    if (opts.identity !== false) {
      git(dir, ['config', 'user.email', 't@t'])
      git(dir, ['config', 'user.name', 't'])
    }
    git(dir, ['add', '.'])
    git(dir, ['commit', '-m', 'init'])
  }
  if (opts.dirty === true) {
    writeFileSync(join(dir, 'src', 'a.txt'), 'user was here\n')
  }
  for (const [rel, content] of Object.entries(opts.extra ?? {})) {
    writeFileSync(join(dir, rel), content)
  }
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) }
}

const edit = (over: Partial<StepEdit> = {}): StepEdit => ({
  stepId: 's1',
  title: '改 alpha',
  rationale: '因为热',
  patch: 'x',
  files: ['src/a.txt'],
  attempts: 1,
  snapshot: [{ rel: 'src/a.txt', content: V2 }],
  ...over,
})

const merged = (over: Partial<OverlayFile> = {}): OverlayFile => ({
  rel: 'src/a.txt',
  original: V1,
  current: V2,
  ...over,
})

describe('分支名', () => {
  it('slug 只保留 ASCII 字母数字（中文摘要不会变成难读的分支名）', () => {
    expect(slugify('Speed up the hot loop')).toBe('speed-up-the-hot-loop')
    expect(slugify('优化热路径')).toBeUndefined()
    expect(slugify('优化 hot 路径')).toBe('hot')
  })

  it('摘要没有可用 slug 时退化为纯时间戳', () => {
    const now = new Date(2026, 0, 2, 3, 4, 5)
    expect(buildBranchName('优化热路径', now)).toBe('perf/20260102-030405')
    expect(buildBranchName('Speed up loop', now)).toBe('perf/20260102-030405-speed-up-loop')
  })

  it('过长的 slug 被截断且不留尾随连字符', () => {
    expect(slugify('a'.repeat(40))).toHaveLength(30)
    expect(slugify('aaaa bbbb cccc dddd eeee ffff gggg')).not.toMatch(/-$/)
  })
})

describe('前置条件：该拒绝的都拒绝，且不写出任何字节', () => {
  it('不是 git 仓库', () => {
    const { dir, clean } = makeProject()
    try {
      const r = checkPreconditions(dir, 'perf/x')
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.reason).toBe('not-a-repo')
    } finally {
      clean()
    }
  })

  it('已跟踪文件有未提交改动', () => {
    const { dir, clean } = makeProject({ git: true, dirty: true })
    try {
      const r = checkPreconditions(dir, 'perf/x')
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.reason).toBe('dirty-worktree')
      expect(r.ok === false && r.message).toContain('src/a.txt')
    } finally {
      clean()
    }
  })

  it('未跟踪文件**不**算工作区脏（否则 .perf/ 没被 gitignore 的项目每次都跑不了）', () => {
    const { dir, clean } = makeProject({ git: true, extra: { 'scratch.txt': 'x' } })
    try {
      expect(checkPreconditions(dir, 'perf/x').ok).toBe(true)
    } finally {
      clean()
    }
  })

  it('缺少 git 身份（否则会在 checkout 出新分支之后才失败）', () => {
    const { dir, clean } = makeProject({ git: true, identity: false })
    // **用环境变量把全局/系统配置隔离掉，绝不能写 `--global`。**
    //
    // 这条用例最初写成 `git config --global --unset user.email` —— 那是错的，而且
    // 后果不只是测试不可靠：它**改动了开发者机器上的真实配置**，把一个从不恢复的
    // 全局状态删掉了（本仓库 09-16 之后那批提交的作者邮箱从真实邮箱退化成
    // `user@hostname` 兜底值，就是这条留下的痕迹）。何况 vitest 并行跑测试文件，
    // 被删掉的全局身份还会让同批次其它用例的 git 提交失败——表现为间歇性失败。
    //
    // 指向 /dev/null 后，"没有身份"这件事是**构造**出来的，不依赖环境，也不需要
    // 跳过分支。
    const saved = {
      global: process.env.GIT_CONFIG_GLOBAL,
      system: process.env.GIT_CONFIG_SYSTEM,
    }
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
    process.env.GIT_CONFIG_SYSTEM = '/dev/null'
    try {
      const r = checkPreconditions(dir, 'perf/x')
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.reason).toBe('no-git-identity')
      expect(r.ok === false && r.message).toContain('user.email')
    } finally {
      // 恢复，别污染同一进程里的其它测试
      if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = saved.global
      if (saved.system === undefined) delete process.env.GIT_CONFIG_SYSTEM
      else process.env.GIT_CONFIG_SYSTEM = saved.system
      clean()
    }
  })

  it('分支已存在', () => {
    const { dir, clean } = makeProject({ git: true })
    try {
      git(dir, ['branch', 'perf/taken'])
      const r = checkPreconditions(dir, 'perf/taken')
      expect(r.ok === false && r.reason).toBe('branch-exists')
    } finally {
      clean()
    }
  })

  it('仓库还没有任何提交（HEAD 无效，回退就无从谈起）', () => {
    const empty = mkdtempSync(join(tmpdir(), 'perf-empty-'))
    try {
      git(empty, ['init'])
      // 补上身份，才能把"没有提交"这一条单独隔出来测——否则会先命中身份那条
      git(empty, ['config', 'user.email', 't@t'])
      git(empty, ['config', 'user.name', 't'])
      const r = checkPreconditions(empty, 'perf/x')
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.message).toContain('初始提交')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('基线校验：生成后被改过的文件不能覆盖', () => {
  it('磁盘与生成时的原始内容不符 → 报出是哪个文件', () => {
    const { dir, clean } = makeProject({ git: true })
    try {
      writeFileSync(join(dir, 'src', 'a.txt'), 'someone else changed this\n')
      const stale = findStaleFiles(dir, [merged()])
      expect(stale).toHaveLength(1)
      expect(stale[0]?.rel).toBe('src/a.txt')
    } finally {
      clean()
    }
  })

  it('文件被删掉也算失效', () => {
    const { dir, clean } = makeProject({ git: true })
    try {
      rmSync(join(dir, 'src', 'a.txt'))
      expect(findStaleFiles(dir, [merged()])[0]?.detail).toContain('不存在')
    } finally {
      clean()
    }
  })

  it('内容未变时不报', () => {
    const { dir, clean } = makeProject({ git: true })
    try {
      expect(findStaleFiles(dir, [merged()])).toEqual([])
    } finally {
      clean()
    }
  })

  it('applyEdits 发现基线失效时直接拒绝，一个字节都不写', () => {
    const { dir, clean } = makeProject({ git: true })
    try {
      writeFileSync(join(dir, 'src', 'a.txt'), 'someone else changed this\n')
      const before = git(dir, ['symbolic-ref', '--short', 'HEAD']).stdout

      const r = applyEdits({
        projectRoot: dir,
        edits: [edit()],
        merged: [merged()],
        branch: 'perf/x',
      })
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.reason).toBe('stale-baseline')
      // 没建分支、没改文件、还停在原分支
      expect(git(dir, ['symbolic-ref', '--short', 'HEAD']).stdout).toBe(before)
      expect(readFileSync(join(dir, 'src', 'a.txt'), 'utf8')).toBe('someone else changed this\n')
      expect(git(dir, ['rev-parse', '--verify', '--quiet', 'refs/heads/perf/x']).status).not.toBe(0)
    } finally {
      clean()
    }
  })
})

describe('正常应用', () => {
  it('切到新分支、逐 step 提交、文件内容正确', () => {
    const { dir, clean } = makeProject({ git: true })
    try {
      const r = applyEdits({
        projectRoot: dir,
        edits: [edit()],
        merged: [merged()],
        branch: 'perf/test-branch',
      })

      expect(r.ok).toBe(true)
      expect(r.ok && r.commits).toHaveLength(1)
      expect(git(dir, ['symbolic-ref', '--short', 'HEAD']).stdout).toBe('perf/test-branch')
      expect(readFileSync(join(dir, 'src', 'a.txt'), 'utf8')).toBe(V2)
      // 工作区是干净的：改动确实进了提交
      expect(git(dir, ['status', '--porcelain', '--untracked-files=no']).stdout).toBe('')
    } finally {
      clean()
    }
  })

  it('commit message 里带上标题与理由（理由是唯一会被长期保留的"为什么"）', () => {
    const { dir, clean } = makeProject({ git: true })
    try {
      applyEdits({
        projectRoot: dir,
        edits: [edit({ title: '换成 Map', rationale: '查找是 O(n)' })],
        merged: [merged()],
        branch: 'perf/msg',
      })
      const body = git(dir, ['log', '-1', '--pretty=%B']).stdout
      expect(body).toContain('换成 Map')
      expect(body).toContain('查找是 O(n)')
      // 只提交这一步的文件，不该把别的东西裹进来
      expect(git(dir, ['show', '--name-only', '--pretty=', 'HEAD']).stdout).toBe('src/a.txt')
    } finally {
      clean()
    }
  })

  it('每个 commit 里的内容是**那一步之后**的中间态，不是最终态', () => {
    // 这条是 per-step 快照存在的理由：两步改同一个文件时，第一个 commit 必须停在
    // 第一步的结果上，否则 git revert 第一句会把第二步的改动也带走。
    const { dir, clean } = makeProject({ git: true })
    try {
      const r = applyEdits({
        projectRoot: dir,
        edits: [
          edit({ stepId: 's1', title: '第一步', snapshot: [{ rel: 'src/a.txt', content: V2 }] }),
          edit({ stepId: 's2', title: '第二步', snapshot: [{ rel: 'src/a.txt', content: V3 }] }),
        ],
        merged: [merged({ current: V3 })],
        branch: 'perf/steps',
      })

      expect(r.ok && r.commits).toHaveLength(2)
      const shas = r.ok ? r.commits.map((c) => c.sha) : []

      // 第一个 commit 的内容 = 第一步之后
      expect(git(dir, ['show', `${shas[0]}:src/a.txt`]).stdout).toBe(V2)
      // 第二个 commit 的内容 = 第二步之后（也是最终态）
      expect(git(dir, ['show', `${shas[1]}:src/a.txt`]).stdout).toBe(V3)
      // 磁盘上也是最终态
      expect(readFileSync(join(dir, 'src', 'a.txt'), 'utf8')).toBe(V3)
    } finally {
      clean()
    }
  })

  it('回退提示里带上起始 SHA、原分支与分支名', () => {
    const { dir, clean } = makeProject({ git: true })
    try {
      const startSha = git(dir, ['rev-parse', 'HEAD']).stdout
      const r = applyEdits({
        projectRoot: dir,
        edits: [edit()],
        merged: [merged()],
        branch: 'perf/hint',
      })
      expect(r.ok && r.startSha).toBe(startSha)
      expect(r.ok && r.startBranch).toBeDefined()
    } finally {
      clean()
    }
  })

  it('多个 step 改不同文件时各成一个提交', () => {
    const { dir, clean } = makeProject({ git: true, extra: { 'src/b.txt': V1 } })
    try {
      const r = applyEdits({
        projectRoot: dir,
        edits: [
          edit({ stepId: 's1', snapshot: [{ rel: 'src/a.txt', content: V2 }] }),
          edit({
            stepId: 's2',
            files: ['src/b.txt'],
            snapshot: [{ rel: 'src/b.txt', content: V2 }],
          }),
        ],
        merged: [merged(), merged({ rel: 'src/b.txt' })],
        branch: 'perf/multi',
      })
      expect(r.ok && r.commits.map((c) => c.files)).toEqual([['src/a.txt'], ['src/b.txt']])
    } finally {
      clean()
    }
  })

  it('onProgress 报告每一步，并带上标题而不只是 hash', () => {
    const { dir, clean } = makeProject({ git: true })
    try {
      const lines: string[] = []
      applyEdits({
        projectRoot: dir,
        edits: [
          edit({ stepId: 's1', title: '第一步', snapshot: [{ rel: 'src/a.txt', content: V2 }] }),
          edit({ stepId: 's2', title: '第二步', snapshot: [{ rel: 'src/a.txt', content: V3 }] }),
        ],
        merged: [merged({ current: V3 })],
        branch: 'perf/progress',
        onProgress: (t) => lines.push(t),
      })
      const joined = lines.join('')
      expect(joined).toContain('已切到分支')
      expect(joined).toContain('第一步')
      expect(joined).toContain('第二步')
    } finally {
      clean()
    }
  })

  it('某一步没产生实际改动时跳过提交，**不中止后续步骤**', () => {
    // git 对"nothing to commit"会失败，而那个失败会带走后面所有 step。
    // 理论上生成阶段已挡掉无改动的 step（`unchanged`），但这里是写路径，
    // 不靠上游的保证。
    const { dir, clean } = makeProject({ git: true })
    try {
      const lines: string[] = []
      const r = applyEdits({
        projectRoot: dir,
        edits: [
          edit({ stepId: 's1', title: '第一步', snapshot: [{ rel: 'src/a.txt', content: V2 }] }),
          // 与第一步结果相同 —— 无改动
          edit({ stepId: 's2', title: '空步骤', snapshot: [{ rel: 'src/a.txt', content: V2 }] }),
          edit({ stepId: 's3', title: '第三步', snapshot: [{ rel: 'src/a.txt', content: V3 }] }),
        ],
        merged: [merged({ current: V3 })],
        branch: 'perf/noop',
        onProgress: (t) => lines.push(t),
      })

      expect(r.ok).toBe(true)
      // 两次真实提交，空的被跳过
      expect(r.ok && r.commits.map((c) => c.stepId)).toEqual(['s1', 's3'])
      expect(lines.join('')).toContain('跳过提交')
      expect(readFileSync(join(dir, 'src', 'a.txt'), 'utf8')).toBe(V3)
    } finally {
      clean()
    }
  })

  it('没有改动时也会建出分支（但不产生提交）', () => {
    const { dir, clean } = makeProject({ git: true })
    try {
      const r = applyEdits({ projectRoot: dir, edits: [], merged: [], branch: 'perf/none' })
      expect(r.ok).toBe(true)
      expect(r.ok && r.commits).toEqual([])
      expect(git(dir, ['symbolic-ref', '--short', 'HEAD']).stdout).toBe('perf/none')
    } finally {
      clean()
    }
  })
})

describe('逐 step 验证：通过才提交', () => {
  /**
   * 门控点在**提交之前**，这样分支上只会累积可用的步骤，坏的那步不进历史。
   *
   * 这组用例的由来是实测：一份能干净 `git apply`、锚点全都定位准确的补丁，
   * 仍有 2/7 个文件过不了 tsc、43/311 个测试失败。只验证可行性而不验证正确性，
   * 产出就不能被信任。
   */
  const twoSteps = (): StepEdit[] => [
    edit({ stepId: 's1', title: '第一步', snapshot: [{ rel: 'src/a.txt', content: V2 }] }),
    edit({ stepId: 's2', title: '第二步', snapshot: [{ rel: 'src/a.txt', content: V3 }] }),
  ]

  it('未通过的 step 不提交、不进历史，并停止后续', () => {
    const { dir, clean } = makeProject({ git: true })
    try {
      const startSha = git(dir, ['rev-parse', 'HEAD']).stdout
      const r = applyEdits({
        projectRoot: dir,
        edits: twoSteps(),
        merged: [merged({ current: V3 })],
        branch: 'perf/verify',
        verify: (step) =>
          step.stepId === 's1' ? { ok: true } : { ok: false, output: 'tsc: 少了一个 import' },
      })

      expect(r.ok).toBe(false)
      expect(r.ok === false && r.reason).toBe('verify-failed')
      expect(r.ok === false && r.failedStep?.stepId).toBe('s2')
      expect(r.ok === false && r.verifyOutput).toContain('少了一个 import')
      expect(r.ok === false && r.message).toContain('未提交')

      // 只有通过验证的第 1 步进了历史
      expect(r.commits.map((c) => c.stepId)).toEqual(['s1'])
      expect(git(dir, ['rev-list', '--count', `${startSha}..HEAD`]).stdout).toBe('1')

      // 失败的那步**留在工作区**（未提交），供用户检查
      expect(readFileSync(join(dir, 'src', 'a.txt'), 'utf8')).toBe(V3)
      expect(git(dir, ['status', '--porcelain', '--untracked-files=no']).stdout).toContain(
        'src/a.txt',
      )
    } finally {
      clean()
    }
  })

  it('失败报告给出丢弃与跳过两条出路', () => {
    const { dir, clean } = makeProject({ git: true })
    try {
      const r = applyEdits({
        projectRoot: dir,
        edits: [edit()],
        merged: [merged()],
        branch: 'perf/vfail',
        verify: () => ({ ok: false, output: 'boom' }),
      })
      const msg = r.ok === false ? r.message : ''
      expect(msg).toContain('git checkout -- src/a.txt')
      expect(msg).toContain('plan.json')
    } finally {
      clean()
    }
  })

  it('全部通过时照常逐 step 提交', () => {
    const { dir, clean } = makeProject({ git: true })
    try {
      const lines: string[] = []
      const r = applyEdits({
        projectRoot: dir,
        edits: twoSteps(),
        merged: [merged({ current: V3 })],
        branch: 'perf/vok',
        verify: () => ({ ok: true }),
        onProgress: (t) => lines.push(t),
      })

      expect(r.ok).toBe(true)
      expect(r.ok && r.commits.map((c) => c.stepId)).toEqual(['s1', 's2'])
      expect(git(dir, ['rev-list', '--count', 'HEAD']).stdout).toBe('3') // init + 2
      expect(readFileSync(join(dir, 'src', 'a.txt'), 'utf8')).toBe(V3)
      expect(lines.join('')).toContain('验证通过')
    } finally {
      clean()
    }
  })

  it('验证在**写出之后、提交之前**调用（看到的是这一步的磁盘状态）', () => {
    const { dir, clean } = makeProject({ git: true })
    try {
      const seen: string[] = []
      applyEdits({
        projectRoot: dir,
        edits: [edit({ snapshot: [{ rel: 'src/a.txt', content: V2 }] })],
        merged: [merged()],
        branch: 'perf/vorder',
        verify: () => {
          // 验证进行时，磁盘上应当已经是这一步的结果
          seen.push(readFileSync(join(dir, 'src', 'a.txt'), 'utf8'))
          return { ok: true }
        },
      })
      expect(seen).toEqual([V2])
    } finally {
      clean()
    }
  })

  it('不传 verify 时行为不变（默认不验证）', () => {
    const { dir, clean } = makeProject({ git: true })
    try {
      const r = applyEdits({
        projectRoot: dir,
        edits: [edit()],
        merged: [merged()],
        branch: 'perf/vnone',
      })
      expect(r.ok && r.commits).toHaveLength(1)
    } finally {
      clean()
    }
  })
})
