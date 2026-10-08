/**
 * The frozen scope.
 *
 * ## Invariant (2): a verdict is always relative to a frozen baseline
 *
 * The previous version made the baseline a file the user was supposed to write
 * by hand, and then treated "no baseline" as an ordinary state. Here it is the
 * opposite: the baseline has no optional form in the type system, and it is
 * frozen from something that actually declares intent.
 *
 * Two ways to freeze one, in order of preference:
 *
 * 1. **From the team's own record.** A team's `description` and its task list —
 *    subject, acceptance criteria, scope, quality kind — already are a scope
 *    declaration. Deriving the baseline from it costs the model nothing, which
 *    matters: a gate that requires extra ceremony is a gate people turn off.
 * 2. **From an explicit declaration.** The `jev_gate_freeze` tool, for the cases
 *    the team record cannot express (a solo run, or acceptance criteria richer
 *    than a task subject).
 *
 * ## Deep versus declared
 *
 * `depth` is the whole reason the baseline is a data structure rather than a
 * list of strings. A `deep` item is one whose completion cannot be established
 * by a single passing command — a quality task with a real contract. Declaring
 * one and then evidencing it with a self-report is `downgrade-unauthorized`,
 * and that check is only possible because the requirement recorded its own
 * depth up front.
 */

import { hashOf } from './hash.ts'
import {
  BASELINE_SCHEMA_VERSION,
  type Baseline,
  type BaselineItem,
} from './types.ts'
import type { TeamProbe, TeamTaskRecord } from './workspace.ts'

/** Task kinds that carry a real quality contract (from the team plugin's own vocabulary). */
export const QUALITY_KINDS: readonly string[] = [
  'requirements',
  'implementation',
  'verification',
  'review',
  'repair',
  'integration',
]

export function isQualityKind(kind: unknown): boolean {
  return typeof kind === 'string' && QUALITY_KINDS.includes(kind)
}

function nonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
}

/**
 * The digest of a baseline, computed over its *content* only.
 *
 * `id` and `digest` are excluded so the id can be derived from the digest
 * without a circular dependency, and so a re-read of an untampered file
 * reproduces the same value.
 */
export function baselineDigest(baseline: Omit<Baseline, 'id' | 'digest'> | Baseline): string {
  return hashOf({
    schemaVersion: baseline.schemaVersion,
    frozenAt: baseline.frozenAt,
    frozenBy: baseline.frozenBy,
    goal: baseline.goal,
    items: baseline.items,
    deferred: baseline.deferred,
    blocked: baseline.blocked,
    scope: baseline.scope,
  })
}

export function createBaseline(input: {
  goal: string
  items: readonly BaselineItem[]
  deferred?: readonly string[]
  blocked?: readonly string[]
  scope?: readonly string[]
  frozenBy: string
  frozenAt?: number
}): Baseline {
  const frozenAt = input.frozenAt ?? Date.now()
  const content = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    frozenAt,
    frozenBy: input.frozenBy,
    goal: input.goal,
    items: input.items,
    deferred: input.deferred ?? [],
    blocked: input.blocked ?? [],
    scope: input.scope ?? [],
  }
  const digest = baselineDigest(content)
  return { id: `bl-${digest.slice(0, 12)}`, digest, ...content }
}

/**
 * Whether a stored baseline still matches its own digest.
 *
 * A mismatch means the file was edited behind the gate's back. That is not a
 * crash; it is `baseline-unfrozen` — the ledger can no longer claim to be
 * judging against a frozen scope, and saying so is the honest response.
 */
export function baselineIntegrity(baseline: Baseline): { ok: boolean; reason: string | null } {
  const expected = baselineDigest(baseline)
  if (expected === baseline.digest) return { ok: true, reason: null }
  return {
    ok: false,
    reason: `基线摘要不匹配（文件里是 ${baseline.digest}，按内容重算是 ${expected}）：文件在冻结之后被改动过。`,
  }
}

/**
 * Derive the baseline from the team's own durable record.
 *
 * Every field comes from something the team already wrote down. Nothing is
 * inferred about *what would be good*; only about what was declared.
 */
export function baselineFromTeam(probe: TeamProbe): Baseline {
  const record = probe.record
  const goal =
    typeof record.description === 'string' && record.description.trim() !== ''
      ? record.description.trim()
      : probe.teamName

  const items: BaselineItem[] = (record.tasks ?? []).map((task: TeamTaskRecord, index) => {
    const id = typeof task.id === 'string' && task.id !== '' ? task.id : `t${index + 1}`
    const subject = typeof task.subject === 'string' && task.subject.trim() !== '' ? task.subject.trim() : id
    const acceptance = nonEmptyStrings(task.acceptance)
    const verify = nonEmptyStrings(task.verify)
    const deep = isQualityKind(task.kind) || acceptance.length > 0 || verify.length > 0
    const acceptanceText = [...acceptance, ...verify.map((command) => `验证命令：${command}`)]
    return {
      id,
      requirement: subject,
      phase: typeof task.kind === 'string' && task.kind !== '' ? task.kind : null,
      depth: deep ? 'deep' : 'declared',
      acceptance: acceptanceText,
      scope: nonEmptyStrings(task.inScope),
    }
  })

  return createBaseline({
    goal,
    items,
    deferred: [],
    blocked: [],
    scope: nonEmptyStrings(record.tasks?.flatMap((task) => nonEmptyStrings(task.inScope))),
    frozenBy: `auto:team-state(${probe.teamFile})`,
  })
}

/**
 * Freeze a baseline from an explicit declaration.
 *
 * Tolerant by design: a declaration with no items is still a legitimate
 * "the scope is: nothing yet", and the caller gets the items it actually got
 * rather than an exception.
 */
export function baselineFromDeclaration(
  args: Readonly<Record<string, unknown>>,
  frozenBy: string,
): { baseline: Baseline; problems: string[] } {
  const problems: string[] = []
  const rawGoal = args['goal']
  const goal = typeof rawGoal === 'string' && rawGoal.trim() !== '' ? rawGoal.trim() : ''
  if (goal === '') problems.push('这次冻结没有给出 goal（做成什么算完成）。')

  const rawItems = args['items']
  const items: BaselineItem[] = []
  if (Array.isArray(rawItems)) {
    for (const [index, entry] of rawItems.entries()) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        problems.push(`items[${index}] 不是对象，已跳过。`)
        continue
      }
      const record = entry as Record<string, unknown>
      const requirement =
        typeof record['requirement'] === 'string' && record['requirement'].trim() !== ''
          ? record['requirement'].trim()
          : ''
      if (requirement === '') {
        problems.push(`items[${index}] 缺少 requirement，已跳过。`)
        continue
      }
      const id =
        typeof record['id'] === 'string' && record['id'].trim() !== '' ? record['id'].trim() : `i${index + 1}`
      const depth = record['depth'] === 'deep' ? 'deep' : 'declared'
      const declaredAcceptance = nonEmptyStrings(record['acceptance'])
      items.push({
        id,
        requirement,
        phase: typeof record['phase'] === 'string' && record['phase'] !== '' ? record['phase'] : null,
        // An item that declares acceptance criteria is `deep` whether or not the
        // caller said so: the criteria are what make a self-report insufficient.
        depth: declaredAcceptance.length > 0 ? 'deep' : depth,
        acceptance: declaredAcceptance,
        scope: nonEmptyStrings(record['scope']),
      })
    }
  } else if (rawItems !== undefined) {
    problems.push('items 不是数组，已按空处理。')
  }

  const duplicates = new Set<string>()
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) duplicates.add(item.id)
    seen.add(item.id)
  }
  if (duplicates.size > 0) problems.push(`items 里出现重复 id：${[...duplicates].join('、')}`)

  return {
    baseline: createBaseline({
      goal,
      items,
      deferred: nonEmptyStrings(args['deferred']),
      blocked: nonEmptyStrings(args['blocked']),
      scope: nonEmptyStrings(args['scope']),
      frozenBy,
    }),
    problems,
  }
}

/**
 * Attribute a piece of evidence to at most one baseline item.
 *
 * Deliberately conservative: only a *unique* textual hit counts. A clue that
 * matches several items says nothing about which one it belongs to, and
 * guessing would inflate coverage — the one direction this ledger must never
 * err in.
 */
export function attributeToItem(haystack: string, items: readonly BaselineItem[]): string | null {
  const matches = items.filter((item) => haystack.includes(item.id))
  return matches.length === 1 ? (matches[0]?.id ?? null) : null
}
