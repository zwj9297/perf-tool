/**
 * `perf run` 的集成测试。
 *
 * 有一条会**真的调用 `git apply --check`**：导出的 patch 承诺"可以直接 git apply"，
 * 而那是个具体的、可验证的承诺（`a/` `b/` 前缀正是为 git 默认的 -p1 服务的）。
 * 只用 jsdiff 自证是循环论证。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  checkPlanRoot,
  loadRunPlan,
  runRunCommand,
  type RunCommandOutcome,
} from '../../src/cli/run-command.js'
import { OUTPUT_DIR, PLAN_FILE } from '../../src/cli/plan-command.js'
import type { Plan } from '../../src/plan/schema.js'
import type { Provider, ProviderTurn } from '../../src/providers/types.js'

const A = ['alpha', 'bravo', 'charlie'].join('\n')

const hasGit = spawnSync('git', ['--version']).status === 0

const patchFor = (rel: string, old: string, next: string): string => {
  const lines = old.split('\n')
  const at = lines.indexOf(next)
  const from = Math.max(0, at - 1)
  const to = Math.min(lines.length, at + 2)
  const ctx = lines.slice(from, to)
  const hunk = ctx.map((l) => (l === next ? `-${l}\n+CHANGED-${l}` : ` ${l}`)).join('\n')
  return `--- ${rel}\n+++ ${rel}\n@@ -${from + 1},${ctx.length} +${from + 1},${ctx.length} @@\n${hunk}\n`
}

const makeProject = (opts: { withPlan?: Plan; git?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'perf-run-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.txt'), A)

  if (opts.git === true) {
    spawnSync('git', ['init'], { cwd: dir })
    spawnSync('git', ['add', '.'], { cwd: dir })
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], {
      cwd: dir,
    })
  }
  if (opts.withPlan !== undefined) {
    mkdirSync(join(dir, OUTPUT_DIR), { recursive: true })
    writeFileSync(join(dir, OUTPUT_DIR, PLAN_FILE), JSON.stringify(opts.withPlan, null, 2))
  }
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 写计划文件。**要先建 `.perf/` 目录**——漏了这一步会得到一个 ENOENT 而不是断言失败 */
const writePlan = (dir: string, plan: Plan): void => {
  mkdirSync(join(dir, OUTPUT_DIR), { recursive: true })
  writeFileSync(join(dir, OUTPUT_DIR, PLAN_FILE), JSON.stringify(plan, null, 2))
}

const planWith = (root: string, steps: number): Plan => ({
  summary: '优化',
  steps: Array.from({ length: steps }, (_, i) => ({
    id: `s${i + 1}`,
    title: `步骤 ${i + 1}`,
    rationale: '因为热',
    files: ['src/a.txt'],
    kind: 'algorithmic' as const,
    risk: 'low' as const,
  })),
  target: { root, language: 'Text' },
  grounded: false,
})

const scripted = (turns: ProviderTurn[]): Provider => {
  let i = 0
  return {
    turn: async () => {
      const t = turns[i]
      i++
      if (t === undefined) throw new Error(`没有为第 ${i} 个回合准备响应`)
      return t
    },
  }
}

const editTurn = (patch: string): ProviderTurn => ({
  kind: 'tools',
  calls: [{ id: 'e1', name: 'submit_edit', arguments: { patch } }],
  text: '',
})

const FIXED_NOW = new Date(2026, 0, 2, 3, 4, 5)

const run = async (
  dir: string,
  turns: ProviderTurn[],
  plan: Plan,
  over: {
    byStep?: boolean
    emitPatch?: string
    mode?: 'apply' | 'preview'
    confirm?: boolean
  } = {},
): Promise<{ outcome: RunCommandOutcome; output: string }> => {
  const chunks: string[] = []
  const outcome = await runRunCommand(
    {
      projectRoot: dir,
      plan,
      byStep: over.byStep ?? false,
      // 默认走 preview：这批用例大多只关心"生成了什么"，不想顺手改文件。
      // 真正测应用的用例显式传 mode: 'apply'。
      mode: over.mode ?? 'preview',
      ...(over.emitPatch === undefined ? {} : { emitPatch: over.emitPatch }),
      cwd: dir,
      color: false,
      confirm: async () => over.confirm ?? true,
      now: FIXED_NOW,
    },
    { provider: scripted(turns), write: (t) => chunks.push(t) },
  )
  return { outcome, output: chunks.join('') }
}

/**
 * 计划加载与执行是分开的两步，这里也分开测。
 *
 * 分开的理由不只是好测：调用方要**先加载计划再做认证预检**——没有计划是首次使用
 * 最常见的情形，比"缺凭证"更根本也更便宜。顺序反了用户会看到无关的 API key 报错。
 */
describe('loadRunPlan：加载与校验', () => {
  it('没有计划时提示先跑 plan', () => {
    const { dir, clean } = makeProject()
    try {
      const r = loadRunPlan(dir)
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.reason).toBe('no-plan')
      expect(r.ok === false && r.message).toContain('perf plan')
    } finally {
      clean()
    }
  })

  it('不是合法 JSON 时报错', () => {
    const { dir, clean } = makeProject()
    try {
      mkdirSync(join(dir, OUTPUT_DIR), { recursive: true })
      writeFileSync(join(dir, OUTPUT_DIR, PLAN_FILE), '{ broken')
      const r = loadRunPlan(dir)
      expect(r.ok === false && r.reason).toBe('plan-invalid')
    } finally {
      clean()
    }
  })

  it('结构不完整时拒绝（计划是给人编辑的，可能被改坏）', () => {
    const { dir, clean } = makeProject()
    try {
      const bad = planWith(dir, 0)
      // 把 steps 拿掉，模拟用户手工编辑时改坏
      writePlan(dir, { ...bad, steps: undefined as unknown as Plan['steps'] })
      const r = loadRunPlan(dir)
      expect(r.ok === false && r.reason).toBe('plan-invalid')
      expect(r.ok === false && r.message).toContain('steps')
    } finally {
      clean()
    }
  })

  it('缺少 target.root 时也拒绝', () => {
    const { dir, clean } = makeProject()
    try {
      const bad = planWith(dir, 1)
      writePlan(dir, { ...bad, target: undefined as unknown as Plan['target'] })
      const r = loadRunPlan(dir)
      expect(r.ok === false && r.reason).toBe('plan-invalid')
      expect(r.ok === false && r.message).toContain('target.root')
    } finally {
      clean()
    }
  })

  it('合法计划被读出', () => {
    const { dir, clean } = makeProject()
    try {
      writePlan(dir, planWith(dir, 2))
      const r = loadRunPlan(dir)
      expect(r.ok && r.plan.steps).toHaveLength(2)
    } finally {
      clean()
    }
  })
})

describe('checkPlanRoot：计划与项目对不上就拒绝', () => {
  it('指向别的项目时给出两边路径', () => {
    const r = checkPlanRoot(planWith('/somewhere/else', 1), '/proj')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).toContain('/somewhere/else')
    expect(r.ok === false && r.message).toContain('/proj')
  })

  it('一致时通过', () => {
    expect(checkPlanRoot(planWith('/proj', 1), '/proj').ok).toBe(true)
  })

  it('执行时也会兜一次（不依赖调用方先查）', async () => {
    const { dir, clean } = makeProject()
    try {
      const { outcome } = await run(dir, [], planWith('/somewhere/else', 1))
      expect(outcome.ok).toBe(false)
      expect(outcome.ok === false && outcome.reason).toBe('plan-root-mismatch')
    } finally {
      clean()
    }
  })
})

describe('生成与预览', () => {
  it('生成改动、打出合并 diff，并明确声明没有修改任何文件', async () => {
    const { dir, clean } = makeProject()
    try {
      const { outcome, output } = await run(
        dir,
        [editTurn(patchFor('src/a.txt', A, 'bravo'))],
        planWith(dir, 1),
      )

      expect(outcome.ok).toBe(true)
      expect(output).toContain('将要改动 1 个文件')
      expect(output).toContain('CHANGED-bravo')
      expect(output).toContain('没有修改任何文件')

      // 关键：磁盘上还是原文
      expect(readFileSync(join(dir, 'src', 'a.txt'), 'utf8')).toBe(A)
    } finally {
      clean()
    }
  })

  it('--by-step 打的是增量，并明确标注不能当 patch 用', async () => {
    const { dir, clean } = makeProject()
    try {
      const { output } = await run(
        dir,
        [
          editTurn(patchFor('src/a.txt', A, 'alpha')),
          editTurn(patchFor('src/a.txt', A.replace('alpha', 'CHANGED-alpha'), 'bravo')),
        ],
        planWith(dir, 2),
        { byStep: true },
      )
      expect(output).toContain('按 step 的增量改动')
      expect(output).toContain('不能拼起来当 patch 用')
      expect(output).toContain('步骤 1')
    } finally {
      clean()
    }
  })

  it('跳过的步骤被列出原因', async () => {
    const { dir, clean } = makeProject()
    try {
      const { outcome, output } = await run(
        dir,
        [
          {
            kind: 'tools',
            calls: [{ id: 'k', name: 'skip_step', arguments: { reason: '不成立' } }],
            text: '',
          },
        ],
        planWith(dir, 1),
      )
      expect(outcome.ok).toBe(true)
      expect(output).toContain('没有生成改动')
      expect(output).toContain('不成立')
    } finally {
      clean()
    }
  })

  it('provider 失败时如实上报', async () => {
    const { dir, clean } = makeProject()
    try {
      const { outcome } = await run(
        dir,
        [{ kind: 'failed', message: '429 限流' }],
        planWith(dir, 1),
      )
      expect(outcome.ok).toBe(false)
      expect(outcome.ok === false && outcome.reason).toBe('provider-failed')
    } finally {
      clean()
    }
  })
})

describe('导出的 patch', () => {
  it('写到指定路径，且内容能应用回原文件', async () => {
    const { dir, clean } = makeProject()
    try {
      const patchPath = join(dir, 'changes.patch')
      const { outcome } = await run(
        dir,
        [editTurn(patchFor('src/a.txt', A, 'bravo'))],
        planWith(dir, 1),
        {
          emitPatch: patchPath,
        },
      )
      expect(outcome.ok && outcome.patchPath).toBe(patchPath)

      const patch = readFileSync(patchPath, 'utf8')
      expect(patch).toContain('--- a/src/a.txt')
      expect(patch).toContain('+++ b/src/a.txt')
      expect(patch).toContain('CHANGED-bravo')
    } finally {
      clean()
    }
  })

  it.skipIf(!hasGit)('真的能被 git apply —— 这是"可直接应用"这个承诺的验证', async () => {
    const { dir, clean } = makeProject({ git: true })
    try {
      const patchPath = join(dir, 'changes.patch')
      await run(dir, [editTurn(patchFor('src/a.txt', A, 'charlie'))], planWith(dir, 1), {
        emitPatch: patchPath,
      })

      const check = spawnSync('git', ['apply', '--check', patchPath], {
        cwd: dir,
        encoding: 'utf8',
      })
      expect(check.stderr).toBe('')
      expect(check.status).toBe(0)

      const applied = spawnSync('git', ['apply', patchPath], { cwd: dir, encoding: 'utf8' })
      expect(applied.status).toBe(0)
      expect(readFileSync(join(dir, 'src', 'a.txt'), 'utf8')).toContain('CHANGED-charlie')
    } finally {
      clean()
    }
  })
})

describe('应用模式：确认、落盘、提交', () => {
  const gitProject = () => {
    const p = makeProject()
    spawnSync('git', ['init'], { cwd: p.dir })
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: p.dir })
    spawnSync('git', ['config', 'user.name', 't'], { cwd: p.dir })
    spawnSync('git', ['add', '.'], { cwd: p.dir })
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], {
      cwd: p.dir,
    })
    return p
  }

  it('确认后才落盘：分支建好、文件改了、提交记下了', async () => {
    const { dir, clean } = gitProject()
    try {
      const { outcome, output } = await run(
        dir,
        [editTurn(patchFor('src/a.txt', A, 'bravo'))],
        planWith(dir, 1),
        { mode: 'apply', confirm: true },
      )

      expect(outcome.ok).toBe(true)
      expect(outcome.ok && outcome.applied).toBe(true)
      expect(outcome.ok && outcome.commits).toHaveLength(1)
      expect(readFileSync(join(dir, 'src', 'a.txt'), 'utf8')).toContain('CHANGED-bravo')
      // 分支按固定时间戳生成
      expect(outcome.ok && outcome.branch).toMatch(/^perf\/20260102-030405/)
      expect(output).toContain('已应用 1 个提交')
      expect(output).toContain('回退方式')
    } finally {
      clean()
    }
  })

  it('拒绝确认时一个字节都不改', async () => {
    const { dir, clean } = gitProject()
    try {
      const { outcome, output } = await run(
        dir,
        [editTurn(patchFor('src/a.txt', A, 'bravo'))],
        planWith(dir, 1),
        { mode: 'apply', confirm: false },
      )

      expect(outcome.ok).toBe(true)
      expect(outcome.ok && outcome.cancelled).toBe(true)
      expect(outcome.ok && outcome.applied).toBe(false)
      expect(readFileSync(join(dir, 'src', 'a.txt'), 'utf8')).toBe(A)
      expect(output).toContain('已取消')
    } finally {
      clean()
    }
  })

  it('--dry-run（preview 模式）不落盘，且说清这一点', async () => {
    const { dir, clean } = gitProject()
    try {
      const { outcome, output } = await run(
        dir,
        [editTurn(patchFor('src/a.txt', A, 'bravo'))],
        planWith(dir, 1),
        {
          mode: 'preview',
        },
      )
      expect(outcome.ok && outcome.applied).toBe(false)
      expect(readFileSync(join(dir, 'src', 'a.txt'), 'utf8')).toBe(A)
      expect(output).toContain('没有修改任何文件')
    } finally {
      clean()
    }
  })

  it('不是 git 仓库时应用失败，但预览已经打出来了（用户看得到会改什么）', async () => {
    const { dir, clean } = makeProject() // 没有 git init
    try {
      const { outcome, output } = await run(
        dir,
        [editTurn(patchFor('src/a.txt', A, 'bravo'))],
        planWith(dir, 1),
        { mode: 'apply', confirm: true },
      )

      expect(outcome.ok).toBe(false)
      expect(outcome.ok === false && outcome.reason).toBe('not-a-repo')
      expect(readFileSync(join(dir, 'src', 'a.txt'), 'utf8')).toBe(A)
      // 预览在应用之前就打了，所以用户仍然看得到打算改什么
      expect(output).toContain('CHANGED-bravo')
    } finally {
      clean()
    }
  })

  it('工作区脏时拒绝，理由里指出是哪些文件', async () => {
    const { dir, clean } = gitProject()
    try {
      // 让工作区变脏，但 patch 要针对**脏内容**写——否则生成阶段就先失败了，
      // 根本到不了那条前置检查（那是另一个用例该覆盖的情形）
      const dirty = `uncommitted work\n${A}`
      writeFileSync(join(dir, 'src', 'a.txt'), dirty)
      const { outcome, output } = await run(
        dir,
        [editTurn(patchFor('src/a.txt', dirty, 'bravo'))],
        planWith(dir, 1),
        { mode: 'apply', confirm: true },
      )

      expect(outcome.ok).toBe(false)
      expect(outcome.ok === false && outcome.reason).toBe('dirty-worktree')
      expect(outcome.ok === false && outcome.message).toContain('src/a.txt')
      // 关键：**在问确认之前**就拒绝了，所以不该出现"已取消"
      expect(output).not.toContain('已取消')
      expect(output).toContain('未提交的改动')
    } finally {
      clean()
    }
  })
})

describe('plan 文件里的路径也会被校验（它允许人工编辑，所以是不可信输入）', () => {
  const planWithFiles = (root: string, files: string[]): Plan => ({
    summary: 'x',
    steps: [
      {
        id: 's1',
        title: 't',
        rationale: 'r',
        files,
        kind: 'config' as const,
        risk: 'low' as const,
      },
    ],
    target: { root, language: 'Text' },
    grounded: false,
  })

  it('step.files 指到项目外 → 拒绝加载，并指出是哪个 step 与哪个路径', () => {
    const { dir, clean } = makeProject()
    try {
      writePlan(dir, planWithFiles(dir, ['../../../../.ssh/id_rsa']))
      const r = loadRunPlan(dir)
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.reason).toBe('unsafe-path')
      expect(r.ok === false && r.message).toContain('s1')
      expect(r.ok === false && r.message).toContain('id_rsa')
    } finally {
      clean()
    }
  })

  it('step.files 指向 .env → 拒绝（否则凭证会被送进模型 prompt）', () => {
    const { dir, clean } = makeProject()
    try {
      writePlan(dir, planWithFiles(dir, ['.env']))
      const r = loadRunPlan(dir)
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.reason).toBe('unsafe-path')
      expect(r.ok === false && r.message).toContain('凭证')
    } finally {
      clean()
    }
  })

  it('绝对路径同样被拒', () => {
    const { dir, clean } = makeProject()
    try {
      writePlan(dir, planWithFiles(dir, ['/etc/passwd']))
      expect(loadRunPlan(dir).ok).toBe(false)
    } finally {
      clean()
    }
  })

  it('合法路径照常通过，且在 `run` 里真的能走到生成那一步', async () => {
    const { dir, clean } = makeProject()
    try {
      writePlan(dir, planWithFiles(dir, ['src/a.txt']))
      expect(loadRunPlan(dir).ok).toBe(true)
      const { outcome } = await run(
        dir,
        [editTurn(patchFor('src/a.txt', A, 'bravo'))],
        planWithFiles(dir, ['src/a.txt']),
      )
      expect(outcome.ok).toBe(true)
    } finally {
      clean()
    }
  })
})

describe('run 轨迹：诊断不该要求重跑一次', () => {
  /**
   * 由来：`plan` 一直有跑道迹，`run` 没有。代价是我为了拿到"每个 step 重试了几次"
   * 不得不**重跑一次生成**——多花一轮 token。而这些数据本来就都在内存里。
   */
  const readTrace = (dir: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dir, OUTPUT_DIR, 'run-trace.json'), 'utf8')) as Record<
      string,
      unknown
    >

  it('preview 模式也落轨迹，步骤标为 generated', async () => {
    const { dir, clean } = makeProject()
    try {
      await run(dir, [editTurn(patchFor('src/a.txt', A, 'bravo'))], planWith(dir, 1), {
        mode: 'preview',
      })
      const t = readTrace(dir)
      expect(t.mode).toBe('preview')
      expect(t.outcome).toEqual({ ok: true, reason: 'preview-only' })
      expect((t.steps as { status: string }[])[0]?.status).toBe('generated')
    } finally {
      clean()
    }
  })

  it('应用成功时记录每个提交的 sha 与文件', async () => {
    const { dir, clean } = makeProject()
    try {
      spawnSync('git', ['init'], { cwd: dir })
      spawnSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
      spawnSync('git', ['config', 'user.name', 't'], { cwd: dir })
      spawnSync('git', ['add', '.'], { cwd: dir })
      spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], {
        cwd: dir,
      })

      await run(dir, [editTurn(patchFor('src/a.txt', A, 'bravo'))], planWith(dir, 1), {
        mode: 'apply',
        confirm: true,
      })
      const t = readTrace(dir)
      const steps = t.steps as { status: string; sha?: string; files: string[] }[]
      expect(steps[0]?.status).toBe('committed')
      expect(steps[0]?.sha).toMatch(/^[0-9a-f]{40}$/)
      expect(steps[0]?.files).toEqual(['src/a.txt'])
      expect(t.branch).toMatch(/^perf\//)
    } finally {
      clean()
    }
  })

  it('验证未通过时标出是哪一步，并带上验证输出', async () => {
    const { dir, clean } = makeProject()
    try {
      spawnSync('git', ['init'], { cwd: dir })
      spawnSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
      spawnSync('git', ['config', 'user.name', 't'], { cwd: dir })
      spawnSync('git', ['add', '.'], { cwd: dir })
      spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], {
        cwd: dir,
      })

      // 验证命令必定失败（exit 1），所以每个 step 都会被门控拦住
      const chunks: string[] = []
      const { runRunCommand } = await import('../../src/cli/run-command.js')
      const outcome = await runRunCommand(
        {
          projectRoot: dir,
          plan: planWith(dir, 1),
          byStep: false,
          mode: 'apply',
          cwd: dir,
          color: false,
          verifyCommand: 'exit 1',
          confirm: async () => true,
          now: FIXED_NOW,
        },
        {
          provider: scripted([editTurn(patchFor('src/a.txt', A, 'bravo'))]),
          write: (t) => chunks.push(t),
        },
      )
      expect(outcome.ok).toBe(false)

      const t = readTrace(dir)
      expect(t.verify).toBe('exit 1')
      expect((t.steps as { status: string }[])[0]?.status).toBe('verify-failed')
      expect(typeof t.verifyOutput).toBe('string')
    } finally {
      clean()
    }
  })

  it('轨迹覆盖计划里的**每一个** step，包括被跳过的（带原因）', async () => {
    const { dir, clean } = makeProject()
    try {
      await run(
        dir,
        [
          editTurn(patchFor('src/a.txt', A, 'bravo')),
          {
            kind: 'tools',
            calls: [{ id: 'k', name: 'skip_step', arguments: { reason: '不成立' } }],
            text: '',
          },
        ],
        planWith(dir, 2),
        { mode: 'preview' },
      )
      const steps = readTrace(dir).steps as { status: string; reason?: string }[]
      expect(steps).toHaveLength(2)
      expect(steps[0]?.status).toBe('generated')
      expect(steps[1]?.status).toBe('skipped')
      expect(steps[1]?.reason).toContain('不成立')
    } finally {
      clean()
    }
  })
})
