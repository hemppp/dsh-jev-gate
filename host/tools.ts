/**
 * The model-facing tools.
 *
 * The gate works without any of these: it observes, measures and intervenes
 * through the host's own event surface. These four exist because there are things
 * only the model knows and only a person can authorise, and a gate that offers no
 * way to say either becomes an obstacle to route around.
 *
 * | Tool | Who | Why an agent needs it |
 * |------|-----|-----------------------|
 * | `jev_gate_freeze` | captain | declare the bar explicitly, instead of having the gate infer it from team state |
 * | `jev_gate_check` | anyone | test a claim against the workspace *before* making it, so a contradiction is a chance to fix rather than a finding |
 * | `jev_gate_status` | anyone | read what the gate has recorded about this team so far |
 * | `jev_gate_authorize` | captain | put a deliberate, reasoned acceptance on the record, so a known gap stops being re-raised |
 *
 * The fourth is the one that keeps the gate honest in the other direction: there
 * is always a legitimate way to proceed past a finding, and it costs a written
 * reason. That is a much better failure mode than a gate people disable.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

import { createBaseline, baselineFromDeclaration, baselineIntegrity } from './baseline.ts'
import { claimFromArgs } from './contract.ts'
import type { RuntimeConfig } from './config.ts'
import { evaluatePredicate, probeFile } from './evidence.ts'
import { isReportLike } from './gate.ts'
import { makeGap, buildMatrix } from './matrix.ts'
import type { Roster } from './roster.ts'
import type { RuntimeHub } from './runtime.ts'
import type { LedgerStoreHub } from './store.ts'
import { GAP_LABEL, type Baseline, type BaselineItem, type Gap } from './types.ts'
import { workspaceFor } from './roster.ts'

export interface ToolDeps {
  readonly ctx: Context
  readonly config: RuntimeConfig
  /**
   * 每个工作区一份账本与闸口。
   *
   * 工具必须取**调用方自己那个工作区**的那一份：宿主进程的 cwd 与调用方的工作区
   * 常常不是同一个目录，取错了就会把 A 项目的基线与账本用在 B 项目上。
   */
  readonly runtimes: RuntimeHub
  readonly store: LedgerStoreHub
  readonly roster: Roster
}

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Render a list of gaps as the lines a person reads. */
function gapLines(gaps: readonly Gap[]): string[] {
  return gaps.map((gap) => `- [${gap.kind}/${gap.severity}] ${GAP_LABEL[gap.kind]}：${gap.detail}`)
}

export function registerTools(deps: ToolDeps): Array<() => void> {
  const disposers: Array<() => void> = []

  /* ---------------------------------------------------------------- *
   * jev_gate_freeze
   * ---------------------------------------------------------------- */
  disposers.push(
    deps.ctx.tools.register(
      defineTool({
        name: 'jev_gate_freeze',
        description: [
          '在开工前把这次工作要满足的条件冻结下来，作为后续所有判定的唯一标准。',
          '冻结是不可覆盖的：一旦写了，之后的判定都对着它做，改它需要重开一份。',
          '队长用它显式声明，而不是让门禁从团队状态里猜。',
        ].join(' '),
        parameters: {
          goal: { type: 'string', required: true, description: '这一阶段要达成什么。' },
          items: {
            type: 'array',
            required: true,
            description: '逐条要求。每条都会被门禁单独核对。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true, description: '稳定 id，后续上报要引用它。' },
                requirement: { type: 'string', required: true, description: '这条要求在讲什么，用人话写。' },
                phase: { type: 'string', description: '属于哪个阶段，可留空。' },
                depth: {
                  type: 'string',
                  enum: ['declared', 'deep'],
                  description: 'declared 只需一处证据；deep 需要多处独立证据。',
                },
                acceptance: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '可判定的验收条件。门禁只认得 "exists <路径>" 和 "contains <路径> <文本>"，其余会如实记为不可核。',
                },
                scope: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '预期会动的路径前缀。',
                },
              },
            },
          },
          deferred: { type: 'array', items: { type: 'string' }, description: '明确推迟、这次不做的。' },
          blocked: { type: 'array', items: { type: 'string' }, description: '被外部挡住、做不了的。' },
          scope: { type: 'array', items: { type: 'string' }, description: '整体允许触碰的路径前缀。' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              frozen: { type: 'boolean', required: true },
              baselineId: { type: 'string', required: true },
              digest: { type: 'string', required: true },
              itemCount: { type: 'number', required: true },
              problems: { type: 'array', items: { type: 'string' }, required: true },
              message: { type: 'string', required: true },
            },
          },
          render: (_args, value) => text(value.message),
        },
        execute: async (args, exec: ToolRunContext) => {
          const parsed = baselineFromDeclaration(args, `tool:jev_gate_freeze:${actorKeyOf(exec)}`)
          if (parsed.baseline.items.length === 0) {
            return {
              frozen: false,
              baselineId: '',
              digest: '',
              itemCount: 0,
              problems: parsed.problems,
              message: `没有可冻结的条目，拒绝写空基线。${parsed.problems.length === 0 ? '' : `\n${parsed.problems.join('\n')}`}`,
            }
          }

          const runtime = await deps.runtimes.load(workspaceFor(deps.ctx, exec.agent))
          const store = runtime.store
          const result = await store.freezeBaseline(parsed.baseline)
          if (!result.ok) {
            const existing = runtime.ledger.getBaseline()
            return {
              frozen: false,
              baselineId: existing?.id ?? '',
              digest: existing?.digest ?? '',
              itemCount: existing?.items.length ?? 0,
              problems: parsed.problems,
              message: `冻结被拒绝：${result.reason}\n已存在的基线是 ${existing?.id ?? '(无)'}——门禁不会用新基线覆盖旧基线，因为那会让过去的判定失去标准。`,
            }
          }
          runtime.ledger.setBaseline(parsed.baseline)
          await store.flush()
          return {
            frozen: true,
            baselineId: parsed.baseline.id,
            digest: parsed.baseline.digest,
            itemCount: parsed.baseline.items.length,
            problems: parsed.problems,
            message: [
              `已冻结基线 ${parsed.baseline.id}（${parsed.baseline.items.length} 条，digest ${parsed.baseline.digest.slice(0, 12)}）。`,
              parsed.problems.length === 0 ? '' : `声明时有这些问题，已记下但没阻止冻结：\n${parsed.problems.join('\n')}`,
            ]
              .filter((line) => line !== '')
              .join('\n'),
          }
        },
      }),
    ),
  )

  /* ---------------------------------------------------------------- *
   * jev_gate_check
   * ---------------------------------------------------------------- */
  disposers.push(
    deps.ctx.tools.register(
      defineTool({
        name: 'jev_gate_check',
        description: [
          '在正式上报之前，先拿同样的口径自查一遍。',
          '它不会阻止你，只是把门禁会看到的 A/B 级事实先告诉你——',
          '这样矛盾可以变成一次修正，而不是一条记在账上的缺口。',
        ].join(' '),
        parameters: {
          changedPaths: { type: 'array', items: { type: 'string' }, description: '你打算声称改过的文件。' },
          commandsRun: {
            type: 'array',
            description: '你打算声称执行过的命令。门禁不执行它们，只会照录。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                command: { type: 'string', required: true },
                status: { type: 'string', enum: ['passed', 'failed'] },
              },
            },
          },
          acceptanceResults: {
            type: 'array',
            description: '你打算声称已通过的验收条目。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                criterion: { type: 'string', required: true },
                status: { type: 'string', enum: ['passed', 'failed'] },
              },
            },
          },
          fileProbes: {
            type: 'array',
            description: '额外的封闭谓词，例如 "exists src/index.ts" 或 "contains README.md 安装"。',
            items: { type: 'string' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              baselineId: { type: 'string', required: true },
              coverageRatio: { type: 'number', required: true },
              worstSeverity: { type: 'string', required: true },
              gaps: { type: 'array', items: { type: 'string' }, required: true },
              message: { type: 'string', required: true },
            },
          },
          render: (_args, value) => text(value.message),
        },
        execute: async (args, exec: ToolRunContext) => {
          const workspace = workspaceFor(deps.ctx, exec.agent)
          const runtime = await deps.runtimes.load(workspace)
          const probe = await deps.roster.resolve(deps.ctx, exec.agent, workspace)
          const baseline = await runtime.gate.ensureBaseline(probe.probe)
          if (baseline === null) {
            return {
              baselineId: '',
              coverageRatio: 0,
              worstSeverity: 'blocker',
              gaps: ['baseline-unfrozen'],
              message: '还没有冻结基线，无从自查。先用 jev_gate_freeze 把标准写下来。',
            }
          }

          const claim = claimFromArgs(args)
          const gaps: Gap[] = []

          for (const path of claim.claimedFiles) {
            const fileProbe = await probeFile(workspace, path)
            if (!fileProbe.exists) {
              gaps.push(makeGap('claim-mismatch', 'completion_report', null, `你声称改过 ${path}，但门禁看不到它。`))
            } else if (fileProbe.stub) {
              gaps.push(
                makeGap('skeleton', 'completion_report', null, `${path} 只有 ${fileProbe.substantialLines} 行有效代码，看着是占位。`),
              )
            }
          }

          const extraProbes = Array.isArray(args.fileProbes)
            ? args.fileProbes.filter((entry): entry is string => typeof entry === 'string')
            : []
          for (const spec of extraProbes) {
            const outcome = await evaluatePredicate(workspace, spec)
            if (outcome.checked && !outcome.passed) {
              gaps.push(makeGap('counterfactual-failed', 'completion_report', null, outcome.detail))
            }
            if (!outcome.checked) {
              gaps.push(makeGap('no-evidence', 'completion_report', null, outcome.detail))
            }
          }

          const matrix = buildMatrix({
            baseline,
            evidence: runtime.ledger.getEvidence(),
            pointId: 'completion_report',
            extraGaps: gaps,
          })
          const worst = matrix.summary.worstSeverity ?? 'none'
          return {
            baselineId: baseline.id,
            coverageRatio: matrix.summary.coverageRatio,
            worstSeverity: worst,
            gaps: matrix.gaps.map((gap) => gap.kind),
            message: [
              `自查（对着基线 ${baseline.id}）：覆盖 ${(matrix.summary.coverageRatio * 100).toFixed(0)}%，最严重 ${worst}。`,
              ...gapLines(matrix.gaps),
              matrix.gaps.length === 0 ? '这一轮没什么要补的。' : '这些都只是提醒，不会阻止你上报。',
            ].join('\n'),
          }
        },
      }),
    ),
  )

  /* ---------------------------------------------------------------- *
   * jev_gate_status
   * ---------------------------------------------------------------- */
  disposers.push(
    deps.ctx.tools.register(
      defineTool({
        name: 'jev_gate_status',
        description: '读取门禁到目前为止记下的东西：基线、判定、缺口统计、账本健康。只读。',
        parameters: {
          verbose: { type: 'boolean', description: '是否列出最近的判定与缺口明细。' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              enabled: { type: 'boolean', required: true },
              mode: { type: 'string', required: true },
              baseline: { type: 'string', required: true },
              coverageRatio: { type: 'number', required: true },
              counts: { type: 'json', required: true },
              recent: { type: 'array', items: { type: 'string' }, required: true },
              problems: { type: 'array', items: { type: 'string' }, required: true },
              message: { type: 'string', required: true },
            },
          },
          render: (_args, value) => text(value.message),
        },
        execute: async (args, exec) => {
          const verbose = args.verbose === true
          const runtime = await deps.runtimes.load(workspaceFor(deps.ctx, exec.agent))
          const snapshot = runtime.ledger.snapshot()
          const latest = snapshot.verdicts[snapshot.verdicts.length - 1]
          const baseline = snapshot.baseline

          const integrity = baseline === null ? null : baselineIntegrity(baseline)
          const baselineLine =
            baseline === null
              ? '未冻结'
              : `${baseline.id}（${baseline.items.length} 条，${integrity?.ok === true ? 'digest 校验通过' : `digest 校验失败：${integrity?.reason ?? ''}`}）`

          const recent = snapshot.verdicts
            .slice(verbose ? -10 : -3)
            .map((verdict) => `${new Date(verdict.at).toISOString()} ${verdict.toolName} → ${verdict.status}/${verdict.level}`)

          return {
            enabled: deps.config.enabled,
            mode: deps.config.mode,
            baseline: baselineLine,
            coverageRatio: latest?.matrix.summary.coverageRatio ?? 0,
            counts: snapshot.counts as unknown as JsonValue,
            recent,
            problems: deps.store.problems,
            message: [
              `dsh-jev-gate：enabled=${deps.config.enabled} mode=${deps.config.mode} decider=${deps.config.deciderKind}/${deps.config.deciderAuthority}`,
              `基线：${baselineLine}`,
              `判定 ${snapshot.verdicts.length} 次，观察 ${snapshot.evidence.length} 条，注意力事件 ${snapshot.attention.length} 次。`,
              latest === undefined
                ? '还没有任何判定。'
                : `最近一次：${latest.status} / ${latest.level}，最严重 ${latest.matrix.summary.worstSeverity ?? 'none'}。`,
              recent.length === 0 ? '' : `最近记录：\n${recent.map((line) => `  ${line}`).join('\n')}`,
              deps.store.problems.length === 0
                ? ''
                : `账本健康问题（${deps.store.problems.length}）：\n${deps.store.problems.map((line) => `  - ${line}`).join('\n')}`,
            ]
              .filter((line) => line !== '')
              .join('\n'),
          }
        },
      }),
    ),
  )

  /* ---------------------------------------------------------------- *
   * jev_gate_authorize
   * ---------------------------------------------------------------- */
  disposers.push(
    deps.ctx.tools.register(
      defineTool({
        name: 'jev_gate_authorize',
        description: [
          '把一次「已知缺口但决定继续」的决定写进账本，附上理由。',
          '它不会关闭门禁，也不会改写基线；它只是让这条缺口从「没人管」变成「有人签字」。',
          '队长用它，人是最终负责的那一个。',
        ].join(' '),
        parameters: {
          decision: { type: 'string', required: true, description: '决定做什么，一句话。' },
          rationale: { type: 'string', required: true, description: '为什么这个缺口可以接受。这是凭据，不能空着。' },
          gapKinds: {
            type: 'array',
            items: { type: 'string' },
            description: '这次签字覆盖哪几类缺口（用缺口 kind，例如 "no-evidence"）。',
          },
          decidedBy: { type: 'string', description: '是谁做的这个决定（人名或角色）。' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              recorded: { type: 'boolean', required: true },
              episodeAt: { type: 'number', required: true },
              message: { type: 'string', required: true },
            },
          },
          render: (_args, value) => text(value.message),
        },
        execute: async (args, exec: ToolRunContext) => {
          const record = args
          const decision = typeof record.decision === 'string' ? record.decision.trim() : ''
          const rationale = typeof record.rationale === 'string' ? record.rationale.trim() : ''
          const actorKey = actorKeyOf(exec)

          if (decision === '' || rationale.length < 8) {
            return {
              recorded: false,
              episodeAt: 0,
              message: [
                '拒绝记录：一次授权需要说清「决定什么」和「为什么可以接受」，后者至少 8 个字符。',
                '这不是形式主义——账本里只有理由能让下一个人复核这个决定。',
              ].join('\n'),
            }
          }

          const at = Date.now()
          const runtime = await deps.runtimes.load(workspaceFor(deps.ctx, exec.agent))
          runtime.ledger.recordEpisode({
            at,
            kind: 'lane-change',
            actorKey,
            pointId: null,
            reason: `决定：${decision}｜理由：${rationale}${typeof record.decidedBy === 'string' ? `｜签署人：${record.decidedBy}` : ''}`,
          })
          const store = runtime.store
          await store.appendEvent('authorize', { at, actorKey, decision, rationale })
          await store.flush()

          const kinds = Array.isArray(record.gapKinds)
            ? record.gapKinds.filter((entry): entry is string => typeof entry === 'string')
            : []

          return {
            recorded: true,
            episodeAt: at,
            message: [
              `已记录：${decision}`,
              `理由：${rationale}`,
              kinds.length === 0 ? '' : `覆盖缺口：${kinds.join('、')}`,
              '注意：基线没有被改，门禁也没有被关。签字的含义是「这次我知道，并由我负责」。',
            ]
              .filter((line) => line !== '')
              .join('\n'),
          }
        },
      }),
    ),
  )

  return disposers
}

function actorKeyOf(exec: ToolRunContext): string {
  const agent = exec.agent
  const id = agent === undefined ? undefined : (agent as { id?: unknown }).id
  return typeof id === 'string' ? id : 'anonymous'
}

export { isReportLike, createBaseline }
export type { Baseline, BaselineItem }
