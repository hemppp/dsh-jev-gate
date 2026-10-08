/**
 * From findings to force.
 *
 * This module is the whole "graceful" claim, so it is worth being precise about
 * what it does and does not do.
 *
 * - **It does not decide whether something is wrong.** That happened in
 *   `matrix.ts`, from observations. Here we only choose how loudly to say it.
 * - **It separates three questions** that a single "block or not" boolean
 *   conflates: how bad is the finding (severity), how much force may this
 *   decision point ever use (the point's ceiling), and how much force is this
 *   *mode* allowed to use (`capForMode`). A dry-run and a lockdown see exactly
 *   the same findings and differ only in the last step — which is what makes a
 *   dry-run a real rehearsal rather than a different code path.
 * - **It lets the plan and the delivery differ.** The ledger records the planned
 *   rung, so a dry-run can say what it *would* have said. Only the delivered rung
 *   is capped.
 *
 * The ladder itself is deliberately short. Five rungs, and the two weakest ones
 * do not interrupt anybody — most findings should be notes, or the gate becomes
 * noise and gets disabled.
 */

import { DECISION_POINTS } from './catalog.ts'
import { allowsBlocking, capForMode, configuredCeilingFor, type RuntimeConfig } from './config.ts'
import { GAP_LABEL, LEVEL_RANK, ROLE_LABEL, type Gap, type GapSeverity, type InterventionLevel, type VerdictStatus } from './types.ts'
import type { ActorRef } from './types.ts'

/** Rung a severity asks for, before any ceiling or mode is applied. */
const SEVERITY_LEVEL: Readonly<Record<GapSeverity, InterventionLevel>> = {
  low: 'L1_note',
  medium: 'L1_note',
  high: 'L2_continue',
  blocker: 'L3_deny',
}

function clampLevel(level: InterventionLevel, floor: InterventionLevel, ceiling: InterventionLevel): InterventionLevel {
  let result = level
  if (LEVEL_RANK[result] > LEVEL_RANK[ceiling]) result = ceiling
  // A floor never overrides a ceiling: in a dry-run the ceiling is L0, and
  // restoring the floor there would turn a rehearsal into the real thing.
  if (LEVEL_RANK[result] < LEVEL_RANK[floor] && LEVEL_RANK[ceiling] >= LEVEL_RANK[floor]) result = floor
  return result
}

export interface PlanInput {
  readonly pointId: keyof typeof DECISION_POINTS
  readonly status: VerdictStatus
  readonly gaps: readonly Gap[]
  readonly config: RuntimeConfig
  /** Set when the external decider proposed loosening a local finding. */
  readonly looseningProposed?: boolean
}

export interface PlannedLevel {
  /** What the findings deserve, before mode capping. */
  readonly planned: InterventionLevel
  /** What this mode may actually deliver. */
  readonly delivered: InterventionLevel
}

/**
 * Choose the rung for a set of findings.
 *
 * `insufficient` (no baseline to judge against) plans `L1_note`, not a block: the
 * gate genuinely does not know, and blocking on ignorance would make it unusable
 * exactly when a team is still forming. The *action* that should have frozen a
 * baseline is handled where that action lives, not here.
 */
export function planLevel(input: PlanInput): PlannedLevel {
  const point = DECISION_POINTS[input.pointId]
  // Rules and lockdown narrow the point for real; the mode only narrows what may
  // be *delivered*. Clamping the planned rung against the mode-capped ceiling
  // would erase what a dry-run is for, so `planned` takes the configured ceiling
  // and `delivered` takes the mode cap on top.
  const ceiling = configuredCeilingFor(input.pointId, input.config)
  const floor = point.floor

  if (input.status === 'insufficient') {
    return { planned: 'L1_note', delivered: capForMode(clampLevel('L1_note', floor, ceiling), input.config.mode) }
  }

  let worst: GapSeverity | null = null
  for (const gap of input.gaps) {
    if (worst === null || LEVEL_RANK[SEVERITY_LEVEL[gap.severity]] > LEVEL_RANK[SEVERITY_LEVEL[worst]]) worst = gap.severity
  }

  let planned: InterventionLevel = worst === null ? 'L0_ledger' : SEVERITY_LEVEL[worst]

  // A loosening proposal is itself a finding. It must never lower the rung, and
  // recording it as `blocker` would be an overreaction — but it does mean the
  // verdict cannot quietly drop to "nothing to say".
  if (input.looseningProposed && LEVEL_RANK[planned] < LEVEL_RANK['L1_note']) planned = 'L1_note'

  const plannedClamped = clampLevel(planned, floor, ceiling)
  return { planned: plannedClamped, delivered: capForMode(plannedClamped, input.config.mode) }
}

/* ------------------------------------------------------------------ *
 * Decision objects
 * ------------------------------------------------------------------ */

export type DecisionKind = 'none' | 'note' | 'continue' | 'deny' | 'ask'

export interface Decision {
  readonly kind: DecisionKind
  readonly reason: string
  /** English line for hosts that localise the approval prompt. */
  readonly displayReasonEn: string
}

export function decisionKindFor(level: InterventionLevel): DecisionKind {
  if (level === 'L3_deny') return 'deny'
  if (level === 'L4_human') return 'ask'
  if (level === 'L2_continue') return 'continue'
  if (level === 'L1_note') return 'note'
  return 'none'
}

/**
 * Whether this mode may turn a rung into an actual refusal.
 *
 * Split out because the `ask` rung has a subtlety: it *hands the decision to a
 * human*, which is only meaningful if blocking is available at all. In
 * `advisory` the ladder is capped before this point, so `ask` should not arise;
 * the guard exists so that a future ceiling change cannot make it arise silently.
 */
export function blockingAllowed(config: RuntimeConfig): boolean {
  return allowsBlocking(config.mode)
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

const GAP_ORDER = Object.keys(GAP_LABEL) as (keyof typeof GAP_LABEL)[]

function gapRank(gap: Gap): number {
  return { low: 0, medium: 1, high: 2, blocker: 3 }[gap.severity]
}

/** Worst first, then by baseline order, then by declaration order. */
export function orderGaps(gaps: readonly Gap[], itemOrder: readonly string[]): Gap[] {
  const indexOf = new Map(itemOrder.map((id, index) => [id, index]))
  const kindIndex = new Map(GAP_ORDER.map((kind, index) => [kind, index]))
  return [...gaps].sort((a, b) => {
    if (gapRank(a) !== gapRank(b)) return gapRank(b) - gapRank(a)
    const ai = a.itemId === null ? Number.MAX_SAFE_INTEGER : (indexOf.get(a.itemId) ?? Number.MAX_SAFE_INTEGER)
    const bi = b.itemId === null ? Number.MAX_SAFE_INTEGER : (indexOf.get(b.itemId) ?? Number.MAX_SAFE_INTEGER)
    if (ai !== bi) return ai - bi
    return (kindIndex.get(a.kind) ?? 0) - (kindIndex.get(b.kind) ?? 0)
  })
}

export interface MessageInput {
  readonly started: string
  readonly pointId: keyof typeof DECISION_POINTS
  readonly actor: ActorRef
  readonly gaps: readonly Gap[]
  readonly itemOrder: readonly string[]
  readonly config: RuntimeConfig
  readonly level: InterventionLevel
}

/**
 * The text a person (or the model) actually reads.
 *
 * Written as an observation, not a scolding: it states which frozen requirement
 * has no supporting fact, and what would settle it. Every line names a `GapKind`
 * so the message can be grepped against the ledger, and the count of what was
 * withheld is stated rather than silently truncated — a message that shows three
 * of eleven findings without saying so is worse than one that shows none.
 */
export function composeMessage(input: MessageInput): string {
  const ordered = orderGaps(input.gaps, input.itemOrder)
  const shown = ordered.slice(0, input.config.maxGapsPerIntervention)
  const hidden = ordered.length - shown.length

  const head =
    input.level === 'L3_deny'
      ? `${input.started} 拦下了这次调用。`
      : input.level === 'L4_human'
        ? `${input.started} 把这次调用交给人决定。`
        : `${input.started} 在「${DECISION_POINTS[input.pointId].title}」处记下了几处缺口。`

  const who = `调用方身份：${ROLE_LABEL[input.actor.role]}${input.actor.name === null ? '' : ` ${input.actor.name}`}${input.actor.teamName === null ? '' : `（团队 ${input.actor.teamName}）`}，依据 ${input.actor.provenance}。`

  const lines = shown.map((gap) => `- [${gap.kind}] ${GAP_LABEL[gap.kind]}：${gap.detail}`)
  const tail =
    hidden > 0
      ? `${input.started} 另有 ${hidden} 条缺口没有逐条列出（配置 maxGapsPerIntervention=${input.config.maxGapsPerIntervention}）。完整清单在账本里。`
      : ''

  const advice =
    input.level === 'L1_note' || input.level === 'L2_continue'
      ? `${input.started} 这只是记录，不阻止你继续；补齐上面的事实即可销案。`
      : ''

  return [head, who, ...lines, advice, tail].filter((part) => part !== '').join('\n')
}

/** One-line summary for the ledger and for `jev_gate_status`. */
export function summarizeGaps(gaps: readonly Gap[]): string {
  if (gaps.length === 0) return '无缺口'
  const byKind = new Map<string, number>()
  for (const gap of gaps) byKind.set(gap.kind, (byKind.get(gap.kind) ?? 0) + 1)
  return [...byKind.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind}×${count}`)
    .join(' ')
}
