/**
 * Reading the executor's own bookkeeping.
 *
 * Everything this module produces is `C`-grade by construction: it is the claim,
 * parsed and checked for internal completeness. That is still worth doing — a
 * contract that names no objective is incomplete *before* anyone lies about it —
 * but the important discipline is that these findings never masquerade as
 * observation. The gate's own view of the workspace is `evidence.ts`.
 *
 * The second job here is turning a tool call into a `CompletionClaim`, so the two
 * can be compared. Comparing "what was claimed" against "what was seen" is the
 * only way `claim-mismatch` can exist at all.
 */

import { isQualityKind } from './baseline.ts'
import { makeGap } from './matrix.ts'
import type { CompletionClaim, DecisionPointId, Gap } from './types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim() !== '') out.push(entry.trim())
  }
  return out
}

function recordList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord)
}

/* ------------------------------------------------------------------ *
 * Claims
 * ------------------------------------------------------------------ */

/**
 * Turn a tool call's arguments into the claim it is making.
 *
 * Field names follow the plugin Team implementation (`changedPaths`,
 * `commandsRun`, `acceptanceResults`); the built-in tool uses the same names for
 * the same reasons. Unknown tool shapes degrade to an empty claim rather than
 * throwing — a gate must always be able to say *something*, even about a call it
 * does not fully understand.
 */
export function claimFromArgs(args: unknown): CompletionClaim {
  const record = asRecord(args)

  const claimedFiles = stringList(record['changedPaths'])
  const commands = recordList(record['commandsRun'])
  const claimedCommands = commands.map((entry) => asString(entry['command'])).filter((value) => value !== '')
  const results = recordList(record['acceptanceResults'])
  const claimedAcceptance = results.map((entry) => asString(entry['criterion'])).filter((value) => value !== '')

  const textParts = [
    asString(record['output']),
    asString(record['evidence_note']),
    asString(record['summary']),
    asString(record['description']),
  ].filter((value) => value !== '')

  return {
    claimedFiles,
    claimedCommands,
    claimedAcceptance,
    text: textParts.join('\n'),
  }
}

/** A one-line restatement of a claim, for the model-facing note. */
export function describeClaim(claim: CompletionClaim): string {
  const parts: string[] = []
  if (claim.claimedFiles.length > 0) parts.push(`文件 ${claim.claimedFiles.length} 个`)
  if (claim.claimedCommands.length > 0) parts.push(`命令 ${claim.claimedCommands.length} 条`)
  if (claim.claimedAcceptance.length > 0) parts.push(`验收条目 ${claim.claimedAcceptance.length} 条`)
  return parts.length === 0 ? '没有给出任何文件/命令/验收条目' : parts.join('，')
}

/* ------------------------------------------------------------------ *
 * Contract health
 * ------------------------------------------------------------------ */

/**
 * Fields a quality task's contract must carry, and why.
 *
 * `verify` is present but not *sufficient*: the gate does not run the commands it
 * finds there. A `verify` list is required so that the contract is reviewable by
 * a human and so the executor has committed to something falsifiable in advance —
 * not so the gate can execute a string a model wrote.
 */
export function contractGaps(args: unknown, pointId: DecisionPointId): Gap[] {
  const record = asRecord(args)
  const kind = asString(record['kind'])
  if (!isQualityKind(kind)) return []

  const gaps: Gap[] = []
  const objective = asString(record['objective']).trim()
  const acceptance = stringList(record['acceptance'])
  const verify = stringList(record['verify'])

  if (objective === '') {
    gaps.push(makeGap('contract-incomplete', pointId, null, `质量任务（kind=${kind}）没有 objective：没人能说清它要达成什么。`))
  }
  if (acceptance.length === 0) {
    gaps.push(makeGap('contract-incomplete', pointId, null, `质量任务（kind=${kind}）没有 acceptance：没有可逐条判定的验收条件。`))
  }
  if ((kind === 'implementation' || kind === 'repair') && verify.length === 0) {
    gaps.push(
      makeGap('contract-incomplete', pointId, null, `质量任务（kind=${kind}）没有 verify：改完拿什么证明，事先没有说。`),
    )
  }
  if ((kind === 'implementation' || kind === 'repair') && stringList(record['inScope']).length === 0) {
    gaps.push(makeGap('contract-incomplete', pointId, null, `质量任务（kind=${kind}）没有 inScope：改动范围没有边界。`))
  }
  if (kind === 'review' && asString(record['reviewedTaskId']).trim() === '') {
    gaps.push(makeGap('contract-incomplete', pointId, null, 'review 任务没有 reviewedTaskId：不知道它在评审哪一个实现。'))
  }

  return gaps
}

/**
 * A contract amendment is a rewrite of the terms under which work is judged, so
 * the bar is not "did it work" but "is the authority on the record".
 *
 * An empty `reason` is the common failure: the field exists, and a model fills it
 * with whitespace or omits it while still changing the contract.
 */
export function amendmentGaps(args: unknown, pointId: DecisionPointId): Gap[] {
  const record = asRecord(args)
  const gaps: Gap[] = []

  const reason = asString(record['reason']).trim()
  if (reason === '') {
    gaps.push(
      makeGap('amendment-without-authority', pointId, null, '这次契约修改没有给出 reason：改了什么、为什么改，没有人能复核。'),
    )
  } else if (reason.length < 8) {
    gaps.push(
      makeGap('amendment-without-authority', pointId, null, `这次契约修改的 reason 只有 ${reason.length} 个字符（"${reason}"），不足以说明授权来源。`),
    )
  }

  const changedFields = [
    record['objective'] !== undefined,
    record['acceptance'] !== undefined,
    record['verify'] !== undefined,
    record['inScope'] !== undefined,
    record['outOfScope'] !== undefined,
  ].filter(Boolean).length
  if (changedFields === 0) {
    gaps.push(makeGap('amendment-without-authority', pointId, null, '这次 amend 调用没有替换任何契约字段。'))
  }

  return gaps
}

/**
 * A resume that does not say why it is resuming.
 *
 * Resuming a halted team is the one action that reverses an explicit stop, so the
 * reason is the record that distinguishes "we fixed the blocker" from "we got
 * impatient".
 */
export function resumeGaps(args: unknown, pointId: DecisionPointId): Gap[] {
  const record = asRecord(args)
  const resumes = record['resume'] === true
  if (!resumes) return []
  const reason = asString(record['resumeReason']).trim()
  if (reason === '') {
    return [makeGap('advance-without-reason', pointId, null, 'resume=true 但没有 resumeReason：为什么恢复，没有记录。')]
  }
  return []
}

/**
 * Structural sanity for a plan edit.
 *
 * A `remove_task` is the interesting case: removing work from a plan is how a
 * scope quietly shrinks, and it is worth a note even when the call is otherwise
 * well-formed.
 */
export function planEditNotes(args: unknown): string[] {
  const record = asRecord(args)
  const operations = recordList(record['operations'])
  if (operations.length === 0) return ['这次 edit_plan 没有任何 operation。']
  const notes: string[] = []
  const removals = operations.filter((entry) => asString(entry['action']) === 'remove_task').length
  if (removals > 0) notes.push(`这次 edit_plan 里有 ${removals} 个 remove_task：计划在缩小。`)
  return notes
}

/* ------------------------------------------------------------------ *
 * Review verdicts
 * ------------------------------------------------------------------ */

export interface ReviewShape {
  readonly verdict: string
  readonly findings: number
  readonly unresolved: number
}

/**
 * What a review verdict says, reduced to the two things that matter: the verdict
 * itself, and whether it carries findings it claims are resolved.
 */
export function reviewShape(args: unknown): ReviewShape | null {
  const record = asRecord(args)
  const verdict = asString(record['verdict'])
  if (verdict === '') return null
  const findings = recordList(record['findings'])
  const unresolved = findings.filter((entry) => entry['resolved'] !== true).length
  return { verdict, findings: findings.length, unresolved }
}
