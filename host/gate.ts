/**
 * The gate: one call in, one verdict out.
 *
 * The order of operations is the design, and it is deliberately not the obvious
 * one:
 *
 * 1. **Find the measuring stick.** A baseline, or nothing. Everything after this
 *    point is meaningless without one, which is why "no baseline" is a first-class
 *    outcome (`insufficient`) rather than a default.
 * 2. **Observe, then read the claim.** Observations are the gate's own account —
 *    file probes, evaluated predicates. The claim is parsed *separately* and kept
 *    at `C`. Merging them here is the single easiest way to reintroduce the bug
 *    this plugin exists to fix.
 * 3. **Measure.** `matrix.ts`, against the frozen items.
 * 4. **Ask, then judge.** The decider is consulted last, is told only the closed
 *    questions, and may not lower the rung.
 * 5. **Record before delivering.** The verdict is written to the ledger first, so
 *    a crash in the delivery path cannot lose the fact that a finding existed.
 *
 * Nothing here executes what a model wrote. `verify` strings become `B`-grade
 * observations only when they match the gate's small closed predicate language;
 * everything else is honestly recorded as an unverifiable claim.
 */

import type { Context } from '@deepseek-ai/cordis'

import { baselineFromTeam, isQualityKind } from './baseline.ts'
import { toolBindingFor, type RoleRequirement, type ToolBinding } from './catalog.ts'
import { ceilingFor, type RuntimeConfig } from './config.ts'
import { amendmentGaps, claimFromArgs, contractGaps, describeClaim, resumeGaps } from './contract.ts'
import { askDecider, type DeciderDeps } from './decider.ts'
import { contradicted, buildMatrix, makeGap } from './matrix.ts'
import { evaluatePredicate, makeEvidence, probeFile, type FileProbe } from './evidence.ts'
import type { Ledger } from './ledger.ts'
import type { Roster } from './roster.ts'
import { decisionKindFor, planLevel, composeMessage, orderGaps } from './intervene.ts'
import { artifactTokens, isActionableClaim, type ProseClaim } from './narrative.ts'
import { openTasks, type TeamProbe } from './workspace.ts'
import { shortDigest } from './hash.ts'
import {
  severityRank,
  worstSeverity,
  type ActorRef,
  type Baseline,
  type BaselineItem,
  type CompletionClaim,
  type DecisionPointId,
  type EvidenceRecord,
  type Gap,
  type GapSeverity,
  type Verdict,
  type VerdictStatus,
} from './types.ts'

/** How many files the gate is willing to probe for one call. */
const MAX_PROBED_FILES = 40
/** How many entries one scope probe will inspect. */
const MAX_SCOPE_ENTRIES = 120
/**
 * How long an `A`/`B` observation stays fresh enough to answer a prose claim.
 *
 * The unit is "this turn": a sentence claiming that something is done is answered
 * by an observation from the same working session, not by one from an hour ago
 * that a different turn produced.
 */
const NARRATIVE_WINDOW_MS = 30 * 60_000

export interface EvaluateInput {
  readonly toolName: string
  readonly args: unknown
  readonly actor: ActorRef
  readonly pointId: DecisionPointId
  readonly workspace: string
  /** The team's on-disk state, when the caller is in a plugin-run team. */
  readonly probe: TeamProbe | null
  readonly signal?: AbortSignal
  /**
   * Prose the actor produced in this turn.
   *
   * The third claim channel, alongside tool arguments and tool results, and the
   * one a person actually reads. Prose is *judged*, never trusted: every
   * actionable sentence becomes a `C` observation, and becomes a
   * `narrative-claim` gap when the ledger holds no fresh `A`/`B` observation
   * that answers it.
   */
  readonly prose?: readonly ProseClaim[]
}

export interface GateDeps {
  readonly ctx: Context
  readonly config: RuntimeConfig
  readonly ledger: Ledger
  readonly roster: Roster
  readonly decider: DeciderDeps
  /** Observation timestamps come from here so tests are deterministic. */
  readonly now?: () => number
}

export class Gate {
  constructor(private readonly deps: GateDeps) {}

  /**
   * The baseline in force.
   *
   * Order matters: an explicitly frozen baseline (via `jev_gate_freeze`, or one
   * restored from disk) wins. Only when there is none does the gate derive one
   * from whatever the team has already written down — and it *freezes* that
   * derivation immediately, so the bar cannot drift under a running team.
   */
  async ensureBaseline(probe: TeamProbe | null): Promise<Baseline | null> {
    const existing = this.deps.ledger.getBaseline()
    if (existing !== null) return existing
    if (probe === null) return null
    const derived = baselineFromTeam(probe)
    if (derived.items.length === 0) return null
    this.deps.ledger.setBaseline(derived)
    return derived
  }

  async evaluate(input: EvaluateInput): Promise<Verdict> {
    const now = this.deps.now?.() ?? Date.now()
    const config = this.deps.config
    const binding: ToolBinding = toolBindingFor(input.toolName) ?? {
      tool: input.toolName,
      flavor: 'plugin',
      points: ['unknown_team_tool'],
      requires: 'any',
      gated: true,
    }

    const baseline = await this.ensureBaseline(input.probe)
    const observations: EvidenceRecord[] = []
    const structuralGaps: Gap[] = []

    /* -- 2a. the gate's own observations --------------------------- */
    let claim: CompletionClaim | null = null
    if (baseline !== null && isReportLike(input.pointId)) {
      claim = claimFromArgs(input.args)
      const probed = await this.collectObservations(input, baseline, claim, observations)
      structuralGaps.push(...probed)
    } else if (isReportLike(input.pointId)) {
      structuralGaps.push(
        makeGap('baseline-unfrozen', input.pointId, null, '这次上报发生时还没有任何冻结基线，无从逐条核对。'),
      )
    }

    /* -- 2b. the executor's own bookkeeping ------------------------ */
    if (claim !== null) {
      observations.push(
        makeEvidence({
          root: input.workspace,
          actor: input.actor,
          pointId: input.pointId,
          items: baseline?.items ?? [],
          level: 'C',
          channel: 'tool-arguments',
          detail: `调用方自述：${describeClaim(claim)}。这是 C 级——门禁观察到调用发生了，但清单内容只是调用方自己的话。`,
          toolName: input.toolName,
          haystack: claim.claimedFiles.join(' '),
        }),
      )
    }

    /* -- 2c. structural checks that need no observation ------------ */
    structuralGaps.push(...this.roleGaps(binding, input.actor, input.pointId))
    if (input.pointId === 'contract_health') structuralGaps.push(...contractGaps(input.args, input.pointId))
    if (input.pointId === 'contract_amendment') structuralGaps.push(...amendmentGaps(input.args, input.pointId))
    if (input.pointId === 'phase_advance') {
      structuralGaps.push(...resumeGaps(input.args, input.pointId))
      structuralGaps.push(...emptyEditPlanGaps(input.args, input.pointId))
    }
    if (input.pointId === 'team_close') structuralGaps.push(...this.closeGaps(input.probe, input.pointId))
    if (input.pointId === 'unknown_team_tool') {
      structuralGaps.push(
        makeGap(
          'unknown-team-tool',
          input.pointId,
          null,
          `工具 ${input.toolName} 不在登记表里：它可能在改团队状态，但没人能就它推导出任何契约。`,
        ),
      )
    }
    if (input.pointId === 'narrative_claim') {
      // Prose is recorded at `C` first — the sentence is a record that somebody
      // asserted it, which is exactly what `C` means. Only then is it measured.
      const actionable = (input.prose ?? []).filter(isActionableClaim)
      for (const claim of actionable) {
        observations.push(
          makeEvidence({
            root: input.workspace,
            actor: input.actor,
            pointId: input.pointId,
            items: baseline?.items ?? [],
            level: 'C',
            channel: 'narrative',
            detail: `正文自述：${claim.sentence}`,
            haystack: claim.sentence,
            at: now,
          }),
        )
      }
      structuralGaps.push(
        ...this.narrativeGaps(input, actionable, [...this.deps.ledger.getEvidence(), ...observations], now),
      )
    }

    /* -- 3. measure ------------------------------------------------ */
    const effective = baseline
    const extraGaps = [...structuralGaps]
    if (effective === null) {
      // Without a baseline there is nothing to build a matrix over. The verdict
      // says `insufficient`; it does not borrow confidence from the absence.
      extraGaps.push(
        makeGap('baseline-unfrozen', input.pointId, null, '没有任何冻结基线，这次调用无法对着一个固定的标准判定。'),
      )
    }

    const matrix = buildMatrix({
      baseline: effective ?? EMPTY_BASELINE,
      evidence: [...this.deps.ledger.getEvidence(), ...observations],
      pointId: input.pointId,
      extraGaps,
    })

    /* -- 4. ask, then judge ---------------------------------------- */
    const advice = await this.consult(input, matrix.gaps, effective, observations)
    const loosening = advice !== null && isLooseningAdvice(advice, matrix.gaps, input, effective)
    const gaps = loosening ? [...matrix.gaps, looseningGap(input.pointId, advice?.reason ?? '')] : [...matrix.gaps]

    const status: VerdictStatus = effective === null ? 'insufficient' : statusFrom(gaps)
    const planned = planLevel({
      pointId: input.pointId,
      status,
      gaps,
      config,
      looseningProposed: loosening,
    })

    const message = composeMessage({
      started: `[dsh-jev-gate]`,
      pointId: input.pointId,
      actor: input.actor,
      gaps,
      itemOrder: effective?.items.map((item) => item.id) ?? [],
      config,
      level: planned.delivered,
    })

    const verdict: Verdict = {
      id: `vd-${shortDigest([now, input.toolName, input.actor.actorKey, gaps.map((gap) => gap.kind).join(',')])}`,
      at: now,
      pointId: input.pointId,
      toolName: input.toolName,
      actor: input.actor,
      status,
      level: planned.delivered,
      matrix: { ...matrix, gaps },
      advice,
      confidence: this.confidence(matrix.summary.coverageRatio, worstOf(gaps), observations),
      message,
    }

    /* -- 5. record ------------------------------------------------ */
    for (const record of observations) this.deps.ledger.recordEvidence(record)
    this.deps.ledger.recordVerdict(verdict)
    if (decisionKindFor(planned.delivered) !== 'none') {
      this.deps.ledger.recordAttention({
        at: now,
        actorKey: input.actor.actorKey,
        pointId: input.pointId,
        toolName: input.toolName,
        level: planned.delivered,
        gapKinds: gaps.map((gap) => gap.kind),
      })
    }

    return verdict
  }

  /* ---------------------------------------------------------------- *
   * Observations
   * ---------------------------------------------------------------- */

  private async collectObservations(
    input: EvaluateInput,
    baseline: Baseline,
    claim: CompletionClaim,
    out: EvidenceRecord[],
  ): Promise<Gap[]> {
    const gaps: Gap[] = []
    const probeCache = new Map<string, FileProbe>()

    /* -- claimed files, probed for real --------------------------- */
    for (const path of claim.claimedFiles.slice(0, MAX_PROBED_FILES)) {
      let probe = probeCache.get(path)
      if (probe === undefined) {
        probe = await probeFile(input.workspace, path)
        probeCache.set(path, probe)
      }
      if (!probe.exists) {
        out.push(
          this.observe(input, baseline, 'workspace-diff', contradicted(`${path} 不存在，但被声称改过。`), path),
        )
        continue
      }
      if (probe.stub) {
        out.push(
          this.observe(
            input,
            baseline,
            'workspace-diff',
            contradicted(`${path} 存在，但只有 ${probe.substantialLines} 行有效代码，看着是占位而不是实现。`),
            path,
          ),
        )
        continue
      }
      out.push(
        this.observe(
          input,
          baseline,
          'workspace-diff',
          `${path} 存在（${probe.bytes} 字节，${probe.substantialLines} 行有效代码）。`,
          path,
        ),
      )
    }

    /* -- declared acceptance conditions, evaluated where possible -- */
    for (const item of baseline.items) {
      for (const spec of item.acceptance) {
        const outcome = await evaluatePredicate(input.workspace, spec)
        const detail = outcome.checked
          ? outcome.passed
            ? `${spec} → ${outcome.detail}`
            : contradicted(`${spec} → ${outcome.detail}`)
          : `${spec} → ${outcome.detail}（因此这条只是声明，不是证据）`
        out.push(
          this.observe(
            input,
            baseline,
            outcome.checked ? 'predicate' : 'self-report',
            detail,
            `${item.requirement} ${spec}`,
            outcome.checked ? 'B' : 'C',
            item.id,
          ),
        )
      }
    }

    /* -- declared scope, checked for substance -------------------- */
    for (const item of baseline.items) {
      if (item.scope.length === 0) continue
      const already = out.some((record) => record.itemId === item.id)
      if (already) continue
      const found = await this.probeScope(input.workspace, item.scope)
      if (found === null) continue
      if (found.files === 0) {
        out.push(
          this.observe(
            input,
            baseline,
            'workspace-diff',
            contradicted(`条目声明要动 ${item.scope.join(' / ')}，但那里没有任何有实质内容的文件。`),
            item.requirement,
            'A',
            item.id,
          ),
        )
      } else {
        out.push(
          this.observe(
            input,
            baseline,
            'workspace-diff',
            `条目声明范围 ${item.scope.join(' / ')} 下找到 ${found.files} 个有实质内容的文件（最大 ${found.largestBytes} 字节）。`,
            item.requirement,
            'A',
            item.id,
          ),
        )
      }
    }

    /* -- the claim itself, at C ------------------------------------ */
    for (const spec of claim.claimedAcceptance) {
      out.push(
        this.observe(input, baseline, 'self-report', `调用方把「${spec}」记为已通过。这是自述。`, spec, 'C'),
      )
    }
    for (const command of claim.claimedCommands) {
      out.push(
        this.observe(
          input,
          baseline,
          'self-report',
          `调用方声明执行过「${command}」。门禁不执行命令，所以这只能是自述。`,
          command,
          'C',
        ),
      )
    }

    if (claim.claimedFiles.length === 0 && claim.claimedAcceptance.length === 0 && claim.claimedCommands.length === 0) {
      gaps.push(
        makeGap(
          'claim-mismatch',
          input.pointId,
          null,
          '这次上报没有给出任何文件、验收条目或命令：没有任何可核对的东西。',
        ),
      )
    }
    return gaps
  }

  private observe(
    input: EvaluateInput,
    baseline: Baseline,
    channel: EvidenceRecord['channel'],
    detail: string,
    haystack: string,
    level: EvidenceRecord['level'] = 'A',
    itemId?: string,
  ): EvidenceRecord {
    return makeEvidence({
      root: input.workspace,
      actor: input.actor,
      pointId: input.pointId,
      items: baseline.items,
      level,
      channel,
      detail,
      toolName: input.toolName,
      haystack,
      itemId,
    })
  }

  /**
   * Does anything with substance live under these prefixes?
   *
   * `null` means "could not look" (no such directory), which is different from
   * "looked and found nothing" — collapsing the two would turn a typo in a scope
   * prefix into an accusation.
   */
  private async probeScope(root: string, prefixes: readonly string[]): Promise<{ files: number; largestBytes: number } | null> {
    let files = 0
    let largestBytes = 0
    let looked = false
    const seen = new Set<string>()

    for (const prefix of prefixes) {
      const probe = await probeFile(root, prefix)
      // A prefix naming a file is checkable directly; a prefix naming a directory
      // needs a listing, which `probeFile` cannot do. Try a shallow scan.
      if (probe.exists && !probe.binary) {
        looked = true
        if (!probe.stub) {
          files += 1
          largestBytes = Math.max(largestBytes, probe.bytes)
        }
        continue
      }
      const listed = await this.listPrefix(root, prefix, seen)
      if (listed === null) continue
      looked = true
      files += listed.files
      largestBytes = Math.max(largestBytes, listed.largestBytes)
    }

    return looked ? { files, largestBytes } : null
  }

  private async listPrefix(root: string, prefix: string, seen: Set<string>): Promise<{ files: number; largestBytes: number } | null> {
    const { readdir } = await import('node:fs/promises')
    const { resolve } = await import('node:path')
    const base = resolve(root, prefix.replace(/[\\/]+$/, ''))
    if (seen.has(base)) return null
    seen.add(base)

    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = await readdir(base, { withFileTypes: true })
    } catch {
      return null
    }

    let files = 0
    let largestBytes = 0
    let inspected = 0
    for (const entry of entries) {
      if (inspected >= MAX_SCOPE_ENTRIES) break
      inspected += 1
      if (!entry.isFile()) continue
      const probe = await probeFile(root, `${prefix.replace(/[\\/]+$/, '')}/${entry.name}`)
      if (!probe.exists || probe.stub) continue
      files += 1
      largestBytes = Math.max(largestBytes, probe.bytes)
    }
    return { files, largestBytes }
  }

  /* ---------------------------------------------------------------- *
   * Structural findings
   * ---------------------------------------------------------------- */

  /**
   * Whether the caller is allowed to do this at all.
   *
   * `unknown` is treated as a *reason for care*, not as a violation: a team
   * implementation we cannot read is a real possibility, and blocking every call
   * from a session we could not classify would make the gate unusable in exactly
   * the configuration it is meant to serve.
   */
  private roleGaps(binding: ToolBinding, actor: ActorRef, pointId: DecisionPointId): Gap[] {
    if (this.deps.config.roleAwareness === 'off') return []
    const gaps: Gap[] = []

    if (actor.role === 'unknown' && this.deps.config.roleAwareness === 'enforce') {
      gaps.push(
        makeGap(
          'role-unresolved',
          pointId,
          null,
          '无法从任何名册来源确定调用方身份：内置名册和插件状态都没有给出答案。',
        ),
      )
    }

    const required: RoleRequirement = binding.requires
    if (this.deps.config.roleAwareness === 'enforce' && required === 'captain' && actor.role === 'member') {
      gaps.push(
        makeGap(
          'role-mismatch',
          pointId,
          null,
          `${binding.tool} 只由队长发起，但调用方是队员 ${actor.name ?? ''}（依据 ${actor.provenance}）。`,
        ),
      )
    }
    return gaps
  }

  /**
   * Prose that has nothing behind it.
   *
   * The question is narrow on purpose: *did anything in this turn actually touch
   * what this sentence claims?* An assertion naming `host/gate.ts` is answered by
   * an observation that mentions that file; an assertion naming only a command is
   * answered by any fresh `A`/`B` observation from the same actor. A claim whose
   * nouns the ledger cannot see is not disproved — it is *unanswered*, which is a
   * different and more useful thing to say, and the only honest one.
   *
   * Nothing here reads the sentence for tone, and nothing here lowers a rung.
   */
  private narrativeGaps(
    input: EvaluateInput,
    claims: readonly ProseClaim[],
    corpus: readonly EvidenceRecord[],
    now: number,
  ): Gap[] {
    if (claims.length === 0) return []
    const gaps: Gap[] = []
    for (const claim of claims) {
      const names = artifactTokens(claim.sentence)
      const fresh = corpus.filter(
        (record) =>
          record.level !== 'C' &&
          record.actorKey === input.actor.actorKey &&
          record.pointId !== 'narrative_claim' &&
          now - record.at <= NARRATIVE_WINDOW_MS,
      )
      const answered =
        names.length === 0
          ? fresh.length > 0
          : fresh.some((record) => {
              const haystack = `${record.detail} ${record.toolName ?? ''}`.toLowerCase()
              return names.some((name) => haystack.includes(name))
            })
      if (answered) continue
      gaps.push(
        makeGap(
          'narrative-claim',
          input.pointId,
          null,
          names.length === 0
            ? `正文宣布「${claim.sentence}」，但这一轮没有任何 A/B 证据。`
            : `正文宣布「${claim.sentence}」，但这一轮没有任何 A/B 证据提到它点名的产物（${names.join('、')}）。`,
        ),
      )
    }
    return gaps
  }

  private closeGaps(probe: TeamProbe | null, pointId: DecisionPointId): Gap[] {    if (probe === null) return []
    const open = openTasks(probe.record)
    if (open.length === 0) return []
    const names = open.slice(0, 5).map((task) => `${task.id}(${task.status})`).join('、')
    return [
      makeGap(
        'close-with-open-work',
        pointId,
        null,
        `还有 ${open.length} 个未终态任务就收队：${names}${open.length > 5 ? ' 等' : ''}。`,
      ),
    ]
  }

  /* ---------------------------------------------------------------- *
   * Decider
   * ---------------------------------------------------------------- */

  private async consult(
    input: EvaluateInput,
    gaps: readonly Gap[],
    baseline: Baseline | null,
    observations: readonly EvidenceRecord[],
  ): Promise<Verdict['advice']> {
    if (this.deps.config.deciderKind === 'baseline') return null
    const actionable = gaps.filter((gap) => severityRank(gap.severity) >= severityRank('high'))
    if (actionable.length === 0) return null

    return askDecider(this.deps.decider, {
      questions: actionable.map((gap) => ({
        id: `q${gaps.indexOf(gap)}`,
        gap,
        instructions: `判断这条缺口是否成立：${gap.detail}`,
      })),
      state: {
        tool: input.toolName,
        point: input.pointId,
        actor: {
          role: input.actor.role,
          name: input.actor.name,
          provenance: input.actor.provenance,
        },
        baseline: baseline === null ? null : { id: baseline.id, items: baseline.items.length },
        observed: observations.map((record) => ({ level: record.level, channel: record.channel, detail: record.detail })),
      },
      signal: input.signal,
    })
  }

  /* ---------------------------------------------------------------- *
   * Confidence
   * ---------------------------------------------------------------- */

  /**
   * Three confidences, and the overall is their minimum.
   *
   * Averaging them would let strong coverage hide weak evidence, which is exactly
   * the arithmetic that makes a bad gate look good.
   */
  private confidence(
    coverageRatio: number,
    worst: GapSeverity | null,
    observations: readonly EvidenceRecord[],
  ): Verdict['confidence'] {
    const observed = observations.filter((record) => record.level === 'A' || record.level === 'B').length
    const evidence = observations.length === 0 ? 0 : observed / observations.length
    const coverage = coverageRatio
    const safety = worst === null ? 1 : { low: 0.85, medium: 0.7, high: 0.4, blocker: 0.1 }[worst]
    return { evidence, coverage, safety, overall: Math.min(evidence, coverage, safety) }
  }
}

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

/** Decision points whose payload is a claim about work. */
export function isReportLike(pointId: DecisionPointId): boolean {
  return pointId === 'completion_report' || pointId === 'review_verdict'
}

export function statusFrom(gaps: readonly Gap[]): VerdictStatus {
  let worst: GapSeverity | null = null
  for (const gap of gaps) worst = worstSeverity(worst, gap.severity)
  if (worst === 'blocker') return 'halt'
  if (worst === 'high') return 'hold'
  return 'advance'
}

function worstOf(gaps: readonly Gap[]): GapSeverity | null {
  let worst: GapSeverity | null = null
  for (const gap of gaps) worst = worstSeverity(worst, gap.severity)
  return worst
}

function emptyEditPlanGaps(args: unknown, pointId: DecisionPointId): Gap[] {
  if (typeof args !== 'object' || args === null) return []
  const operations = (args as Record<string, unknown>)['operations']
  if (operations === undefined) return []
  if (Array.isArray(operations) && operations.length === 0) {
    return [makeGap('advance-without-reason', pointId, null, '这次 edit_plan 没有任何 operation，相当于空推进。')]
  }
  return []
}

/**
 * Whether the decider's opinion would loosen a finding it is not authorised to
 * loosen.
 *
 * `advisory` means advice may only ever tighten. A decider that answers "this
 * looks fine" is making a claim about the workspace that it has not seen — so the
 * proposal is recorded as a finding against the gate's own authority, and the
 * level does not drop.
 */
function isLooseningAdvice(
  advice: Verdict['advice'],
  gaps: readonly Gap[],
  input: EvaluateInput,
  baseline: Baseline | null,
): boolean {
  if (advice === null || !advice.available) return false
  if (advice.suggested === null) return false
  if (isSoleAuthority(advice.authority)) return false
  const blocked = gaps.some((gap) => severityRank(gap.severity) >= severityRank('high'))
  return blocked && decisionKindFor(advice.suggested) === 'none' && baseline !== null && input.pointId !== 'status_read'
}

function isSoleAuthority(authority: string): boolean {
  return authority === 'sole'
}

function looseningGap(pointId: DecisionPointId, reason: string): Gap {
  return makeGap(
    'loosening-not-authorized',
    pointId,
    null,
    `外部判定器提议放宽这次判定，但 deciderAuthority 不是 sole：${reason}`,
  )
}

/** A stand-in used only to build an empty matrix; it never reaches a verdict. */
const EMPTY_BASELINE: Baseline = {
  schemaVersion: 0,
  id: 'bl-none',
  frozenAt: 0,
  frozenBy: 'none',
  digest: 'none',
  goal: '',
  items: [],
  deferred: [],
  blocked: [],
  scope: [],
}

export { isQualityKind, ceilingFor, orderGaps }
export type { BaselineItem }
