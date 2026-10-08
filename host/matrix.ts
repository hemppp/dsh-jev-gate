/**
 * The coverage matrix: what was required, and what actually happened.
 *
 * ## Why a matrix and not a checklist
 *
 * A checklist answers "did the agent mention item 4". The matrix answers the
 * question that matters: for each frozen requirement, what is the *strongest*
 * evidence that exists, and does it agree or disagree with what was claimed.
 * The statuses are therefore ordered by evidential strength and not by
 * completeness:
 *
 * - `covered`      — A/B evidence exists and supports the claim
 * - `contradicted` — A/B evidence exists and refutes it (the strongest signal,
 *                    and the one a self-reported checklist cannot produce)
 * - `self-only`    — only the executor's own words support it
 * - `unreported`   — nothing at all
 *
 * ## Pessimism is a feature
 *
 * `coverageRatio` counts only `covered` rows, and a `deep` item needs more than
 * one supporting observation before it counts as fully covered. This makes the
 * number depressingly low in normal use, which is correct: the alternative is a
 * dashboard that says 95% because the model said so 95% of the time.
 */

import {
  GAP_SEVERITY,
  LEVEL_RANK,
  worstSeverity,
  type Baseline,
  type BaselineItem,
  type CoverageRow,
  type CoverageStatus,
  type DecisionPointId,
  type EvidenceRecord,
  type Gap,
  type GapKind,
  type Matrix,
  type MatrixSummary,
} from './types.ts'

export function makeGap(kind: GapKind, pointId: DecisionPointId, itemId: string | null, detail: string): Gap {
  return { kind, severity: GAP_SEVERITY[kind], pointId, itemId, detail }
}

/** How many supporting observations a fully-covered item needs. */
function requiredSupport(item: BaselineItem): number {
  return item.depth === 'deep' ? 2 : 1
}

function isSupporting(record: EvidenceRecord): boolean {
  return record.level === 'A' || record.level === 'B'
}

/**
 * Gap kinds, by the channel the contradicting observation came through.
 *
 * The channel is where the gate *looked*, so it is the honest thing to name:
 * a failed declared predicate is not the same finding as a file that turned out
 * to be a placeholder, and neither is the same as a claimed file that does not
 * exist.
 */
function contradictionKind(records: readonly EvidenceRecord[]): GapKind {
  if (records.some((record) => record.channel === 'predicate')) return 'counterfactual-failed'
  if (records.some((record) => record.channel === 'workspace-diff')) return 'skeleton'
  return 'claim-mismatch'
}

export function buildRow(item: BaselineItem, evidence: readonly EvidenceRecord[]): CoverageRow {
  const mine = evidence.filter((record) => record.itemId === item.id)
  const supporting = mine.filter((record) => isSupporting(record) && !isContradiction(record))
  const contradicting = mine.filter((record) => isSupporting(record) && isContradiction(record))
  const selfOnly = mine.filter((record) => record.level === 'C')

  let status: CoverageStatus
  if (contradicting.length > 0) status = 'contradicted'
  else if (supporting.length > 0) status = 'covered'
  else if (selfOnly.length > 0) status = 'self-only'
  else status = 'unreported'

  return {
    itemId: item.id,
    requirement: item.requirement,
    status,
    supporting: supporting.map((record) => record.id),
    contradicting: contradicting.map((record) => record.id),
    depthScore: Math.min(1, supporting.length / requiredSupport(item)),
  }
}

/**
 * Whether a support-grade record actually contradicts the claim.
 *
 * Encoded in the evidence `detail` prefix rather than in a parallel structure,
 * because the record is what a person reads when auditing a verdict, and a
 * separate "this was a failure" map would let the two disagree.
 */
export function isContradiction(record: EvidenceRecord): boolean {
  return record.detail.startsWith(CONTRADICTION_PREFIX)
}

export const CONTRADICTION_PREFIX = '✗ '

/** Detail text for a contradicting observation. */
export function contradicted(detail: string): string {
  return `${CONTRADICTION_PREFIX}${detail}`
}

export function gapForRow(item: BaselineItem, row: CoverageRow, pointId: DecisionPointId, evidence: readonly EvidenceRecord[]): Gap[] {
  const gaps: Gap[] = []
  if (row.status === 'unreported') {
    gaps.push(
      makeGap(
        'unreported',
        pointId,
        item.id,
        `基线条目「${item.requirement}」(${item.id}) 在这次上报里完全没有出现。`,
      ),
    )
    return gaps
  }

  if (row.status === 'contradicted') {
    const failing = evidence.filter((record) => row.contradicting.includes(record.id))
    const kind = contradictionKind(failing)
    const reasons = failing.map((record) => record.detail.replace(CONTRADICTION_PREFIX, '')).join('；')
    gaps.push(makeGap(kind, pointId, item.id, `基线条目「${item.requirement}」(${item.id}) 被实测反驳：${reasons}`))
    return gaps
  }

  if (row.status === 'self-only') {
    gaps.push(
      makeGap(
        'no-evidence',
        pointId,
        item.id,
        `基线条目「${item.requirement}」(${item.id}) 只有自述，没有任何 A/B 级观察。`,
      ),
    )
    return gaps
  }

  // Covered, but not to the depth the item declared for itself.
  if (row.depthScore < 1) {
    gaps.push(
      makeGap(
        'downgrade-unauthorized',
        pointId,
        item.id,
        `基线条目「${item.requirement}」(${item.id}) 声明为 ${item.depth} 深度，但只拿到 ${row.depthScore.toFixed(2)} 的支持度。`,
      ),
    )
  }
  return gaps
}

export interface MatrixInput {
  readonly baseline: Baseline
  readonly evidence: readonly EvidenceRecord[]
  readonly pointId: DecisionPointId
  /** Structural findings that are not about a single baseline item. */
  readonly extraGaps?: readonly Gap[]
}

export function buildMatrix(input: MatrixInput): Matrix {
  const rows: CoverageRow[] = []
  const gaps: Gap[] = []

  for (const item of input.baseline.items) {
    const row = buildRow(item, input.evidence)
    rows.push(row)
    for (const gap of gapForRow(item, row, input.pointId, input.evidence)) gaps.push(gap)
  }
  for (const gap of input.extraGaps ?? []) gaps.push(gap)

  return {
    baselineId: input.baseline.id,
    builtAt: Date.now(),
    rows,
    gaps,
    summary: summarize(rows, gaps),
  }
}

export function summarize(rows: readonly CoverageRow[], gaps: readonly Gap[]): MatrixSummary {
  let covered = 0
  let selfOnly = 0
  let unreported = 0
  let contradicted = 0
  let worst: MatrixSummary['worstSeverity'] = null

  for (const row of rows) {
    if (row.status === 'covered') covered += 1
    else if (row.status === 'self-only') selfOnly += 1
    else if (row.status === 'unreported') unreported += 1
    else contradicted += 1
  }
  for (const gap of gaps) worst = worstSeverity(worst, gap.severity)

  const total = rows.length
  return {
    total,
    covered,
    selfOnly,
    unreported,
    contradicted,
    gaps: gaps.length,
    worstSeverity: worst,
    // A baseline with no items is not "100% covered"; it is a baseline that
    // could not judge anything, and 0 is the only honest number for it.
    coverageRatio: total === 0 ? 0 : covered / total,
  }
}

/**
 * Sort gaps most severe first, then by the order the baseline declared them.
 *
 * Ordering matters because only the first few are shown: a `blocker` must never
 * be pushed out of view by a pile of `low` notes.
 */
export function rankGaps(gaps: readonly Gap[], order: readonly string[]): Gap[] {
  const indexOf = new Map(order.map((id, index) => [id, index]))
  return [...gaps].sort((a, b) => {
    const severity = (GAP_SEVERITY[b.kind] === GAP_SEVERITY[a.kind] ? 0 : rankOf(b) - rankOf(a)) as number
    if (severity !== 0) return severity
    const ai = a.itemId === null ? Number.MAX_SAFE_INTEGER : (indexOf.get(a.itemId) ?? Number.MAX_SAFE_INTEGER)
    const bi = b.itemId === null ? Number.MAX_SAFE_INTEGER : (indexOf.get(b.itemId) ?? Number.MAX_SAFE_INTEGER)
    return ai - bi
  })
}

function rankOf(gap: Gap): number {
  return { low: 0, medium: 1, high: 2, blocker: 3 }[gap.severity]
}

/** Whether any gap is at or above `threshold`. */
export function hasSeverityAtLeast(gaps: readonly Gap[], threshold: Gap['severity']): boolean {
  const bar = { low: 0, medium: 1, high: 2, blocker: 3 }[threshold]
  return gaps.some((gap) => rankOf(gap) >= bar)
}

export { LEVEL_RANK }
