/**
 * The in-memory ledger, and the only thing persistence is allowed to see.
 *
 * Two decisions worth stating, because a naive ledger gets both wrong:
 *
 * 1. **Verdicts are never rewritten.** A later verdict does not supersede an
 *    earlier one; it is appended. The history *is* the product — "this team
 *    claimed completion four times and was contradicted twice" is a fact you can
 *    only read from an append-only record.
 * 2. **The baseline is not evidence and is not counted.** It is the measuring
 *    stick. Accidentally counting it would inflate coverage, so it lives in its
 *    own field and `reset()` keeps it while dropping everything measured against
 *    it.
 *
 * Every array is bounded. A long-running team produces unbounded observations,
 * and the ledger is a diagnostic, not a transcript; when a bound is hit the
 * *oldest* entries are dropped, because the recent past is what a verdict is
 * about.
 */

import type {
  AmendmentRecord,
  AttentionEvent,
  Baseline,
  EpisodeRecord,
  EvidenceRecord,
  EvidenceReport,
  GapKind,
  LedgerSnapshot,
  Verdict,
} from './types.ts'
import { LEDGER_SCHEMA_VERSION } from './types.ts'

const LIMITS = {
  evidence: 1000,
  reports: 200,
  verdicts: 200,
  attention: 500,
  amendments: 200,
  episodes: 100,
} as const

function push<T>(list: T[], item: T, limit: number): void {
  list.push(item)
  if (list.length > limit) list.splice(0, list.length - limit)
}

export class Ledger {
  private baseline: Baseline | null = null
  private readonly evidence: EvidenceRecord[] = []
  private readonly reports: EvidenceReport[] = []
  private readonly verdicts: Verdict[] = []
  private readonly attention: AttentionEvent[] = []
  private readonly amendments: AmendmentRecord[] = []
  private readonly episodes: EpisodeRecord[] = []
  private readonly counters = new Map<string, number>()

  setBaseline(baseline: Baseline): void {
    this.baseline = baseline
  }

  getBaseline(): Baseline | null {
    return this.baseline
  }

  recordEvidence(record: EvidenceRecord): void {
    // A repeated observation of the same fact is deduplicated by id. Re-probing
    // the same file every turn would otherwise drown the real signal in noise.
    if (this.evidence.some((existing) => existing.id === record.id)) return
    push(this.evidence, record, LIMITS.evidence)
  }

  recordReport(report: EvidenceReport): void {
    push(this.reports, report, LIMITS.reports)
  }

  recordVerdict(verdict: Verdict): void {
    push(this.verdicts, verdict, LIMITS.verdicts)
    this.bump(`verdict:${verdict.status}`)
    for (const gap of verdict.matrix.gaps) this.bump(`gap:${gap.kind}`)
  }

  recordAttention(event: AttentionEvent): void {
    push(this.attention, event, LIMITS.attention)
    this.bump(`level:${event.level}`)
  }

  recordAmendment(record: AmendmentRecord): void {
    push(this.amendments, record, LIMITS.amendments)
    this.bump('amendment')
  }

  recordEpisode(record: EpisodeRecord): void {
    push(this.episodes, record, LIMITS.episodes)
    this.bump(`episode:${record.kind}`)
  }

  private bump(key: string): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1)
  }

  /** Observations already collected, for a fresh matrix build. */
  getEvidence(): readonly EvidenceRecord[] {
    return this.evidence
  }

  getVerdicts(): readonly Verdict[] {
    return this.verdicts
  }

  getAttention(): readonly AttentionEvent[] {
    return this.attention
  }

  /** How many of a given gap kind have been found so far. */
  gapCount(kind: GapKind): number {
    return this.counters.get(`gap:${kind}`) ?? 0
  }

  /** Whether the same point has already been flagged for the same actor recently. */
  recentAttention(actorKey: string, pointId: string, windowMs: number): AttentionEvent | null {
    const cutoff = Date.now() - windowMs
    for (let index = this.attention.length - 1; index >= 0; index -= 1) {
      const event = this.attention[index]
      if (event === undefined) continue
      if (event.at < cutoff) break
      if (event.actorKey === actorKey && event.pointId === pointId) return event
    }
    return null
  }

  snapshot(): LedgerSnapshot {
    const counts: Record<string, number> = {}
    for (const [key, value] of this.counters) counts[key] = value
    return {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      baseline: this.baseline,
      evidence: [...this.evidence],
      reports: [...this.reports],
      verdicts: [...this.verdicts],
      attention: [...this.attention],
      amendments: [...this.amendments],
      episodes: [...this.episodes],
      counts,
    }
  }

  /**
   * Rehydrate from a persisted snapshot.
   *
   * Only the baseline and the append-only histories are restored; derived counts
   * are recomputed from the histories so a hand-edited `counts` block cannot
   * change a verdict.
   */
  restore(snapshot: LedgerSnapshot): void {
    this.baseline = snapshot.baseline
    this.evidence.length = 0
    this.reports.length = 0
    this.verdicts.length = 0
    this.attention.length = 0
    this.amendments.length = 0
    this.episodes.length = 0
    this.counters.clear()

    for (const record of snapshot.evidence) this.recordEvidence(record)
    for (const report of snapshot.reports) this.recordReport(report)
    for (const verdict of snapshot.verdicts) this.recordVerdict(verdict)
    for (const event of snapshot.attention) this.recordAttention(event)
    for (const record of snapshot.amendments) this.recordAmendment(record)
    for (const record of snapshot.episodes) this.recordEpisode(record)
  }

  /** Drop everything measured, keep the measuring stick. */
  reset(): void {
    this.evidence.length = 0
    this.reports.length = 0
    this.verdicts.length = 0
    this.attention.length = 0
    this.amendments.length = 0
    this.episodes.length = 0
    this.counters.clear()
  }
}
