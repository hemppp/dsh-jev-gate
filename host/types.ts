/**
 * Domain model for `dsh-jev-gate`.
 *
 * Three invariants this file exists to encode (they are the whole point of the
 * plugin, and every other module is a consequence of them):
 *
 * 1. **Self-report is not evidence.** `EvidenceLevel` grades provenance, and only
 *    `A`/`B` may justify a coverage row. `C` records what someone said.
 * 2. **A verdict is always relative to a frozen baseline.** There is no
 *    `Baseline`, and no verdict — `Baseline` is required, not optional.
 * 3. **An external opinion may only tighten, never loosen.** Loosening requires a
 *    deliberate, recorded authority change (`sole`), never an implicit default.
 */

export const PLUGIN_NAME = 'dsh-jev-gate'
export const PLUGIN_LABEL = 'Jev 门禁'
export const PLUGIN_TAG = '[jev-gate]'

export const LEDGER_SCHEMA_VERSION = 1
export const BASELINE_SCHEMA_VERSION = 1

/* ------------------------------------------------------------------ *
 * Intervention ladder
 * ------------------------------------------------------------------ */

/**
 * Five rungs, weakest to strongest. The ladder is what makes intervention
 * "graceful" rather than a wall: most findings are notes, and only a real
 * contradiction reaches a hard stop.
 */
export type InterventionLevel = 'L0_ledger' | 'L1_note' | 'L2_continue' | 'L3_deny' | 'L4_human'

export const INTERVENTION_LEVELS = ['L0_ledger', 'L1_note', 'L2_continue', 'L3_deny', 'L4_human'] as const

export const LEVEL_RANK: Readonly<Record<InterventionLevel, number>> = {
  L0_ledger: 0,
  L1_note: 1,
  L2_continue: 2,
  L3_deny: 3,
  L4_human: 4,
}

export const LEVEL_DESCRIPTION: Readonly<Record<InterventionLevel, string>> = {
  L0_ledger: '只记账，不打扰任何人',
  L1_note: '把缺口作为附注挂在工具结果旁，下一轮可见',
  L2_continue: '在当前回合的收尾处补一轮，要求补齐证据',
  L3_deny: '拦停这一次调用并给出理由',
  L4_human: '交给人决定，不代替人拍板',
}

/** Rungs a mode is allowed to reach. */
export type GateMode = 'off' | 'dry-run' | 'advisory' | 'enforce' | 'lockdown'

export const GATE_MODES = ['off', 'dry-run', 'advisory', 'enforce', 'lockdown'] as const

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/**
 * Two independent Team implementations live side by side and share no state:
 * the harness built-in one, and the `@nanmicoder/dsh-agent-teams` plugin.
 * A gate that cannot tell them apart cannot tell a captain from a member.
 */
export type TeamFlavor = 'builtin' | 'plugin'

export type ActorRole = 'captain' | 'member' | 'outsider' | 'unknown'

export const ROLE_LABEL: Readonly<Record<ActorRole, string>> = {
  captain: '队长',
  member: '队员',
  outsider: '团队之外',
  unknown: '身份未知',
}

/**
 * What we actually managed to learn about the caller. `role` is `unknown` when
 * no roster source could answer — which is a *reason to be careful*, never a
 * reason to assume "member".
 */
export interface ActorRef {
  readonly sessionId: string | null
  readonly actorKey: string
  readonly name: string | null
  readonly role: ActorRole
  readonly teamId: string | null
  readonly teamName: string | null
  readonly flavor: TeamFlavor | null
  /** How the role was established, for auditability. */
  readonly provenance: 'builtin-roster' | 'plugin-state' | 'capability-inference' | 'none'
}

export const UNKNOWN_ACTOR: ActorRef = {
  sessionId: null,
  actorKey: 'unknown',
  name: null,
  role: 'unknown',
  teamId: null,
  teamName: null,
  flavor: null,
  provenance: 'none',
}

/* ------------------------------------------------------------------ *
 * Decision points
 * ------------------------------------------------------------------ */

/**
 * Every place where a team's bookkeeping could be wrong. The old gate covered
 * four tool *names*; naming decision points instead is what lets the same
 * point be reached from two different teams' tool vocabularies, from a tool
 * call, or from prose.
 */
export type DecisionPointId =
  | 'scope_freeze'
  | 'plan_approval'
  | 'contract_health'
  | 'roster_change'
  | 'ownership_claim'
  | 'task_dispatch'
  | 'completion_report'
  | 'review_verdict'
  | 'contract_amendment'
  | 'phase_advance'
  | 'team_close'
  | 'narrative_claim'
  | 'unknown_team_tool'
  | 'status_read'

export interface DecisionPoint {
  readonly id: DecisionPointId
  /** Shown to the model as the domain of the intervention. */
  readonly title: string
  /** What someone is actually asserting by performing this action. */
  readonly claim: string
  /** Weakest rung a finding at this point may produce. */
  readonly floor: InterventionLevel
  /** Rung used when the finding is a hard contradiction. */
  readonly ceiling: InterventionLevel
  /** Whether the point is gated at all, or merely observed. */
  readonly gated: boolean
}

/* ------------------------------------------------------------------ *
 * Evidence
 * ------------------------------------------------------------------ */

/**
 * `A` — the gate itself observed the fact (a tool ran, a file really changed,
 *       a predicate really executed).
 * `B` — a pre-declared predicate was really executed against real state.
 * `C` — somebody said so. Recorded, never counted.
 */
export type EvidenceLevel = 'A' | 'B' | 'C'

export const EVIDENCE_LEVELS = ['A', 'B', 'C'] as const

export const EVIDENCE_LEVEL_LABEL: Readonly<Record<EvidenceLevel, string>> = {
  A: 'A 级 · 门禁亲自观察',
  B: 'B 级 · 预声明谓词实测',
  C: 'C 级 · 执行者自述（不计入判定）',
}

export type EvidenceChannel =
  | 'tool-result'
  | 'tool-arguments'
  | 'workspace-diff'
  | 'workspace-summary'
  | 'predicate'
  | 'narrative'
  | 'self-report'

export interface EvidenceRecord {
  readonly id: string
  /** Baseline item this speaks to, when it is about one. */
  readonly itemId: string | null
  readonly pointId: DecisionPointId | null
  readonly level: EvidenceLevel
  readonly channel: EvidenceChannel
  readonly at: number
  readonly actorKey: string
  readonly toolName?: string
  readonly digest: string
  readonly detail: string
}

export type CoverageStatus =
  /** A/B evidence exists and agrees with the claim. */
  | 'covered'
  /** Only the executor's own words support it. */
  | 'self-only'
  /** Nothing at all was produced for this item. */
  | 'unreported'
  /** A/B evidence exists but contradicts the claim. */
  | 'contradicted'

export const COVERAGE_LABEL: Readonly<Record<CoverageStatus, string>> = {
  covered: '已覆盖（有 A/B 证据且相符）',
  'self-only': '仅自述',
  unreported: '未上报',
  contradicted: '被实测反驳',
}

export interface CoverageRow {
  readonly itemId: string
  readonly requirement: string
  readonly status: CoverageStatus
  readonly supporting: readonly string[]
  readonly contradicting: readonly string[]
  /** 0..1, share of required depth actually evidenced. */
  readonly depthScore: number
}

/* ------------------------------------------------------------------ *
 * Gaps
 * ------------------------------------------------------------------ */

export type GapKind =
  /** The baseline requires this item and no report mentioned it. */
  | 'unreported'
  /** Only self-report exists. */
  | 'no-evidence'
  /** A claim was made in prose with no tool call behind it. */
  | 'narrative-claim'
  /** Claimed work, but the workspace shows nothing (or comments only). */
  | 'skeleton'
  /** Evidence is materially weaker than the item's declared depth. */
  | 'downgrade-unauthorized'
  /** A pre-declared predicate was executed and failed. */
  | 'counterfactual-failed'
  /** A claimed file list disagrees with the observed one. */
  | 'claim-mismatch'
  /** A quality contract is missing objective/acceptance/verify. */
  | 'contract-incomplete'
  /** A contract was rewritten without recorded authority. */
  | 'amendment-without-authority'
  /** A team tool call nobody declared, so nobody can reason about it. */
  | 'unknown-team-tool'
  /** Nothing was frozen before work started. */
  | 'baseline-unfrozen'
  /** Resuming a halted team / advancing a phase with no reason given. */
  | 'advance-without-reason'
  /** Closing a team while required work is still open. */
  | 'close-with-open-work'
  /** The caller's role could not be established. */
  | 'role-unresolved'
  /** The caller's established role may not perform this action at all. */
  | 'role-mismatch'
  /** An external opinion was used to soften rather than tighten. */
  | 'loosening-not-authorized'

export const GAP_KINDS = [
  'unreported',
  'no-evidence',
  'narrative-claim',
  'skeleton',
  'downgrade-unauthorized',
  'counterfactual-failed',
  'claim-mismatch',
  'contract-incomplete',
  'amendment-without-authority',
  'unknown-team-tool',
  'baseline-unfrozen',
  'advance-without-reason',
  'close-with-open-work',
  'role-unresolved',
  'role-mismatch',
  'loosening-not-authorized',
] as const satisfies readonly GapKind[]

export type GapSeverity = 'low' | 'medium' | 'high' | 'blocker'

export const GAP_SEVERITY: Readonly<Record<GapKind, GapSeverity>> = {
  unreported: 'high',
  'no-evidence': 'high',
  'narrative-claim': 'high',
  skeleton: 'blocker',
  'downgrade-unauthorized': 'high',
  'counterfactual-failed': 'blocker',
  'claim-mismatch': 'high',
  'contract-incomplete': 'medium',
  'amendment-without-authority': 'high',
  'unknown-team-tool': 'low',
  'baseline-unfrozen': 'blocker',
  'advance-without-reason': 'medium',
  'close-with-open-work': 'high',
  'role-unresolved': 'low',
  'role-mismatch': 'high',
  'loosening-not-authorized': 'blocker',
}

export const GAP_LABEL: Readonly<Record<GapKind, string>> = {
  unreported: '基线条目未上报',
  'no-evidence': '只有自述，没有 A/B 证据',
  'narrative-claim': '只在正文里宣布，没有对应动作',
  skeleton: '声称改动，实测没有实质改动',
  'downgrade-unauthorized': '证据强度低于该条目声明的深度',
  'counterfactual-failed': '预声明谓词实测失败',
  'claim-mismatch': '声称的文件与实测不一致',
  'contract-incomplete': '质量任务的契约字段不全',
  'amendment-without-authority': '没有凭据就改了契约',
  'unknown-team-tool': '出现了未登记的团队动作',
  'baseline-unfrozen': '开工前没有冻结基线',
  'advance-without-reason': '推进时没有给出理由',
  'close-with-open-work': '还有未完成的工作就收队',
  'role-unresolved': '调用方身份无法确定',
  'role-mismatch': '该身份不该做这个动作',
  'loosening-not-authorized': '用外部意见放宽了判定',
}

export interface Gap {
  readonly kind: GapKind
  readonly severity: GapSeverity
  readonly pointId: DecisionPointId
  readonly itemId: string | null
  /** One line, model-facing, states the missing fact — not a scolding. */
  readonly detail: string
}

/* ------------------------------------------------------------------ *
 * Reports and verdicts
 * ------------------------------------------------------------------ */

export type ReportedStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

export interface CompletionClaim {
  readonly claimedFiles: readonly string[]
  readonly claimedCommands: readonly string[]
  readonly claimedAcceptance: readonly string[]
  readonly text: string
}

export interface EvidenceReport {
  readonly id: string
  readonly at: number
  readonly actorKey: string
  readonly pointId: DecisionPointId
  readonly toolName: string | null
  readonly itemIds: readonly string[]
  readonly statuses: readonly CoverageStatus[]
  readonly claim: CompletionClaim
  readonly note: string
}

export interface Matrix {
  readonly baselineId: string
  readonly builtAt: number
  readonly rows: readonly CoverageRow[]
  readonly gaps: readonly Gap[]
  readonly summary: MatrixSummary
}

export interface MatrixSummary {
  readonly total: number
  readonly covered: number
  readonly selfOnly: number
  readonly unreported: number
  readonly contradicted: number
  readonly gaps: number
  readonly worstSeverity: GapSeverity | null
  /** 0..1. Deliberately pessimistic: self-report never counts. */
  readonly coverageRatio: number
}

/**
 * Decider vocabulary lives in `config.ts` because it *is* configuration. Imported
 * as a type only, so the dependency here is erased at runtime and cannot create a
 * module cycle.
 */
export type { DeciderAuthority, DeciderKind }
import type { DeciderAuthority, DeciderKind } from './config.ts'

export interface AdviceClaim {
  readonly label: string
  readonly confidence: number | null
  readonly note: string
}

export interface Advice {
  readonly decider: DeciderKind
  readonly authority: DeciderAuthority
  readonly available: boolean
  readonly at: number
  readonly suggested: InterventionLevel | null
  readonly claims: readonly AdviceClaim[]
  readonly reason: string
  /** Set when the advice would loosen a local finding that was not authorized to loosen. */
  readonly loosened: boolean
}

export type VerdictStatus = 'advance' | 'hold' | 'halt' | 'insufficient'

export interface Verdict {
  readonly id: string
  readonly at: number
  readonly pointId: DecisionPointId
  readonly toolName: string
  readonly actor: ActorRef
  readonly status: VerdictStatus
  readonly level: InterventionLevel
  readonly matrix: Matrix
  readonly advice: Advice | null
  /** Per-claim confidence, kept separate on purpose. */
  readonly confidence: {
    readonly evidence: number
    readonly coverage: number
    readonly safety: number
    /** The minimum of the three: an overall number never exceeds its weakest input. */
    readonly overall: number
  }
  readonly message: string
}

/* ------------------------------------------------------------------ *
 * Ledger
 * ------------------------------------------------------------------ */

export interface AttentionEvent {
  readonly at: number
  readonly actorKey: string
  readonly pointId: DecisionPointId
  readonly toolName: string
  readonly level: InterventionLevel
  readonly gapKinds: readonly GapKind[]
}

/* ------------------------------------------------------------------ *
 * Baseline
 * ------------------------------------------------------------------ */

/**
 * One frozen requirement. `depth` says how much evidence the item demands:
 * a `deep` item is one whose completion cannot be established by a single
 * passing command, and therefore needs A-grade observation, not a paraphrase.
 */
export interface BaselineItem {
  readonly id: string
  readonly requirement: string
  readonly phase: string | null
  readonly depth: 'declared' | 'deep'
  /** Per-item acceptance conditions; empty means the item's own text is the bar. */
  readonly acceptance: readonly string[]
  /** Workspace-relative prefixes this item is expected to touch. */
  readonly scope: readonly string[]
}

/**
 * The frozen scope. A verdict is *always* relative to one of these; there is no
 * way to produce a verdict without one, which is invariant (2) made structural.
 */
export interface Baseline {
  readonly schemaVersion: number
  readonly id: string
  readonly frozenAt: number
  readonly frozenBy: string
  /** Digest over the canonical form of this baseline, excluding `digest` itself. */
  readonly digest: string
  readonly goal: string
  readonly items: readonly BaselineItem[]
  readonly deferred: readonly string[]
  readonly blocked: readonly string[]
  /** Advisory prefix list. Empty means "no prefix restriction declared". */
  readonly scope: readonly string[]
}

export interface LedgerSnapshot {
  readonly schemaVersion: number
  readonly baseline: Baseline | null
  readonly evidence: readonly EvidenceRecord[]
  readonly reports: readonly EvidenceReport[]
  readonly verdicts: readonly Verdict[]
  readonly attention: readonly AttentionEvent[]
  readonly amendments: readonly AmendmentRecord[]
  readonly episodes: readonly EpisodeRecord[]
  readonly counts: Readonly<Record<string, number>>
}

export interface AmendmentRecord {
  readonly at: number
  readonly actorKey: string
  readonly teamId: string | null
  readonly taskId: string
  readonly kinds: readonly string[]
  readonly reason: string
  readonly authorized: boolean
}

export interface EpisodeRecord {
  readonly at: number
  readonly kind: 'halt' | 'resume' | 'lane-change'
  readonly actorKey: string
  readonly pointId: DecisionPointId | null
  readonly reason: string
}

export const UNREPORTED = 'unreported' as const

/** Stable, human-readable one-liner used by both CLI-ish surfaces and the model. */
export function levelLabel(level: InterventionLevel): string {
  return `${level}（${LEVEL_DESCRIPTION[level]}）`
}

export function severityRank(severity: GapSeverity): number {
  return { low: 0, medium: 1, high: 2, blocker: 3 }[severity]
}

export function worstSeverity(a: GapSeverity | null, b: GapSeverity | null): GapSeverity | null {
  if (a === null) return b
  if (b === null) return a
  return severityRank(a) >= severityRank(b) ? a : b
}
