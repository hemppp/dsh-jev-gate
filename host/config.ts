/**
 * dsh-jev-gate — configuration.
 *
 * ## No hard-coded tunables
 *
 * Every threshold, path, mode and policy is declared here and read at runtime
 * from `toRuntimeConfig()`. `DEFAULT_CONFIG` is a default, not a hard-coded
 * value: it is overridable from one visible place.
 *
 * ## Off by default, and staged
 *
 * `enabled` defaults to `false` and `mode` to `'dry-run'`. A plugin that can stop
 * team actions must not start stopping them the moment it is installed. The
 * ladder is `off → dry-run → advisory → enforce`.
 *
 * ## Every field is on the settings form
 *
 * The host renders the plugin's `Config` schema as the form for this row under
 * Plugins. Two hard rules come from the host:
 *
 * 1. Only fields marked `.volatile()` appear in the form. Here that is *all* of
 *    them, deliberately: leaving a knob off the form is how the previous version
 *    ended up with rules nobody could edit.
 * 2. Only top-level fields are writable, because the host treats a field name as
 *    a single-segment path. Nested objects therefore cannot be form fields. That
 *    is why the decider settings are a flat group, and why the rule overrides
 *    arrive as a single JSON string (`rulesJson`) instead of an array.
 *
 * `scripts/run-contract-check.mjs` computes the volatile field set from this
 * schema and asserts the browser half exposes exactly the same names, so the two
 * cannot drift apart silently.
 *
 * ## Secrets are not configuration
 *
 * `deciderCredentialRef` holds a *reference name*. The value lives in the host
 * credential service and is resolved per request. It is never written to
 * `cordis.yml`, never returned to a page, and never read from `process.env`.
 *
 * @module dsh-jev-gate/config
 */

import Schema from '@deepseek-ai/schemastery'

import { DECISION_POINTS } from './catalog.ts'
import { INTERVENTION_LEVELS, LEVEL_RANK, type DecisionPointId, type InterventionLevel } from './types.ts'

/** Run mode. */
export const MODES = ['off', 'dry-run', 'advisory', 'enforce', 'lockdown'] as const
export type Mode = (typeof MODES)[number]

export const MODE_LABELS: Record<Mode, string> = {
  off: '已关闭',
  'dry-run': '只记账（dry-run）',
  advisory: '只提醒（advisory）',
  enforce: '完整阶梯（enforce）',
  lockdown: '只准只读（lockdown）',
}

/** Stance when the external decider is unavailable. */
export const UNAVAILABLE_POLICIES = ['allow', 'ask', 'deny'] as const
export type UnavailablePolicy = (typeof UNAVAILABLE_POLICIES)[number]

/**
 * Who decides whether a gap is acceptable.
 *
 * - `'advisory'` (default): an outside opinion may only tighten the verdict or
 *   escalate to a human. If it believes the evidence is sufficient, that belief
 *   is not adopted — the disagreement itself is what gets escalated.
 * - `'sole'`: the decider alone may clear a gap and let the run proceed. This is
 *   a deliberate act of delegation, never the default, and it is recorded.
 */
export const DECIDER_AUTHORITIES = ['advisory', 'sole'] as const
export type DeciderAuthority = (typeof DECIDER_AUTHORITIES)[number]

/**
 * Decider implementations that have real code behind them.
 *
 * `'llm'` is listed because it is implemented here by calling the host's own
 * model service (`ctx.llm.stream`) — a declared-but-unimplemented decider is a
 * configuration that lies about behaviour, which is the exact defect this list
 * exists to prevent.
 */
export const DECIDER_KINDS = ['baseline', 'llm', 'endpoint'] as const
export type DeciderKind = (typeof DECIDER_KINDS)[number]

export const IMPLEMENTED_DECIDERS: readonly DeciderKind[] = ['baseline', 'llm', 'endpoint']
export type ImplementedDecider = (typeof IMPLEMENTED_DECIDERS)[number]

export function isImplementedDecider(kind: DeciderKind): kind is ImplementedDecider {
  return IMPLEMENTED_DECIDERS.includes(kind)
}

/** Role-awareness policy. */
export const ROLE_POLICIES = ['off', 'observe', 'enforce'] as const
export type RolePolicy = (typeof ROLE_POLICIES)[number]

/** Narrative-claim policy: how hard to react to a claim made only in prose. */
export const NARRATIVE_POLICIES = ['off', 'note', 'steer', 'deny'] as const
export type NarrativePolicy = (typeof NARRATIVE_POLICIES)[number]

/** One per-decision-point override. */
export interface RuleOverride {
  readonly pointId: DecisionPointId
  readonly enabled?: boolean
  /** Most force this decision point may ever reach. */
  readonly ceiling?: InterventionLevel
}

/**
 * The declarative configuration shape (what may be written into `cordis.yml`).
 */
export interface Config {
  enabled: boolean
  mode: Mode
  /** Stance when the external decider cannot be reached. */
  onUnavailable: UnavailablePolicy
  /** Minimum confidence for an outside opinion to be acted on at all. */
  minConfidence: number
  /** How many gaps one intervention may spell out one by one. */
  maxGapsPerIntervention: number
  /** Ledger directory, relative to the workspace. Must not contain `..`. */
  stateDir: string
  persistEnabled: boolean
  /** Debounce for ledger writes, in milliseconds. */
  debounceMs: number
  /** Gate the moment a state-transferring team call is about to happen. */
  interveneAtStateTransition: boolean
  /** Gate the moment a turn is about to stop. */
  interveneAtPreFinish: boolean
  /** Whether the caller's team role is established and enforced. */
  roleAwareness: RolePolicy
  /** Reaction to a completion/pass claim made only in prose. */
  narrativeWatch: NarrativePolicy
  /** Refuse gated actions when no scope baseline has been frozen. */
  requireBaseline: boolean
  /** Decider implementation. */
  deciderKind: DeciderKind
  /** `llm`: provider override; blank follows the session's own route. */
  deciderProvider: string
  /** `llm` / `endpoint`: model id; blank follows each kind's own default. */
  deciderModel: string
  /** `endpoint`: base URL. Blank falls back to the documented default. */
  deciderBaseUrl: string
  /** `endpoint`: path appended to the base URL. */
  deciderEndpointPath: string
  /** Credential *reference name*; the value lives in the credential service. */
  deciderCredentialRef: string
  /** `advisory` (tighten only) or `sole` (may clear a gap). */
  deciderAuthority: DeciderAuthority
  /** Most questions one decider consultation may ask. */
  deciderMaxQuestions: number
  /**
   * Per-decision-point overrides as a JSON array. A JSON string rather than an
   * array because the settings form can only write top-level scalar fields.
   */
  rulesJson: string
}

export const DEFAULT_CONFIG: Config = {
  enabled: false,
  mode: 'dry-run',
  onUnavailable: 'ask',
  minConfidence: 0.6,
  maxGapsPerIntervention: 3,
  stateDir: '.dsh-jev-gate',
  persistEnabled: true,
  debounceMs: 500,
  interveneAtStateTransition: true,
  interveneAtPreFinish: true,
  roleAwareness: 'enforce',
  narrativeWatch: 'steer',
  requireBaseline: true,
  deciderKind: 'baseline',
  deciderProvider: '',
  deciderModel: '',
  deciderBaseUrl: '',
  deciderEndpointPath: '/v1/systemone',
  deciderCredentialRef: '',
  deciderAuthority: 'advisory',
  deciderMaxQuestions: 8,
  rulesJson: '',
}

/**
 * Schemastery schema. The host uses it to render this row's form and to fill in
 * missing fields.
 *
 * Fields marked `.volatile()` arrive at `apply()` as stable references carrying
 * `.get()` rather than as bare values; `toRuntimeConfig()` unwraps them. The
 * single cast is needed because `Config` describes the unwrapped shape while
 * `Schema.object({…})` infers the wrapped one.
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_CONFIG.enabled).volatile(),
  mode: Schema.union([
    Schema.const('off'),
    Schema.const('dry-run'),
    Schema.const('advisory'),
    Schema.const('enforce'),
    Schema.const('lockdown'),
  ])
    .default(DEFAULT_CONFIG.mode)
    .volatile(),
  onUnavailable: Schema.union([Schema.const('allow'), Schema.const('ask'), Schema.const('deny')])
    .default(DEFAULT_CONFIG.onUnavailable)
    .volatile(),
  minConfidence: Schema.number().min(0).max(1).default(DEFAULT_CONFIG.minConfidence).volatile(),
  maxGapsPerIntervention: Schema.number().step(1).min(1).max(50).default(DEFAULT_CONFIG.maxGapsPerIntervention).volatile(),
  stateDir: Schema.string().default(DEFAULT_CONFIG.stateDir).volatile(),
  persistEnabled: Schema.boolean().default(DEFAULT_CONFIG.persistEnabled).volatile(),
  debounceMs: Schema.number().step(1).min(0).max(60000).default(DEFAULT_CONFIG.debounceMs).volatile(),
  interveneAtStateTransition: Schema.boolean().default(DEFAULT_CONFIG.interveneAtStateTransition).volatile(),
  interveneAtPreFinish: Schema.boolean().default(DEFAULT_CONFIG.interveneAtPreFinish).volatile(),
  roleAwareness: Schema.union([Schema.const('off'), Schema.const('observe'), Schema.const('enforce')])
    .default(DEFAULT_CONFIG.roleAwareness)
    .volatile(),
  narrativeWatch: Schema.union([
    Schema.const('off'),
    Schema.const('note'),
    Schema.const('steer'),
    Schema.const('deny'),
  ])
    .default(DEFAULT_CONFIG.narrativeWatch)
    .volatile(),
  requireBaseline: Schema.boolean().default(DEFAULT_CONFIG.requireBaseline).volatile(),
  deciderKind: Schema.union([Schema.const('baseline'), Schema.const('llm'), Schema.const('endpoint')])
    .default(DEFAULT_CONFIG.deciderKind)
    .volatile(),
  deciderProvider: Schema.string().default(DEFAULT_CONFIG.deciderProvider).volatile(),
  deciderModel: Schema.string().default(DEFAULT_CONFIG.deciderModel).volatile(),
  deciderBaseUrl: Schema.string().default(DEFAULT_CONFIG.deciderBaseUrl).volatile(),
  deciderEndpointPath: Schema.string().default(DEFAULT_CONFIG.deciderEndpointPath).volatile(),
  deciderCredentialRef: Schema.string().role('credential-ref').default(DEFAULT_CONFIG.deciderCredentialRef).volatile(),
  deciderAuthority: Schema.union([Schema.const('advisory'), Schema.const('sole')])
    .default(DEFAULT_CONFIG.deciderAuthority)
    .volatile(),
  deciderMaxQuestions: Schema.number().step(1).min(1).max(32).default(DEFAULT_CONFIG.deciderMaxQuestions).volatile(),
  rulesJson: Schema.string().default(DEFAULT_CONFIG.rulesJson).volatile(),
}) as unknown as Schema<Config>

/** The volatile fields, in declaration order — the browser half must mirror this. */
export const VOLATILE_FIELDS: readonly string[] = [
  'enabled',
  'mode',
  'onUnavailable',
  'minConfidence',
  'maxGapsPerIntervention',
  'stateDir',
  'persistEnabled',
  'debounceMs',
  'interveneAtStateTransition',
  'interveneAtPreFinish',
  'roleAwareness',
  'narrativeWatch',
  'requireBaseline',
  'deciderKind',
  'deciderProvider',
  'deciderModel',
  'deciderBaseUrl',
  'deciderEndpointPath',
  'deciderCredentialRef',
  'deciderAuthority',
  'deciderMaxQuestions',
  'rulesJson',
]

/** Normalized runtime configuration: every field present and in range. */
export interface RuntimeConfig extends Config {
  /** Nothing declared but unimplemented may reach the gate. */
  unimplementedDecider: DeciderKind | null
  /** Non-null when the configured decider cannot be used as written. */
  deciderProblem: string | null
  /** Parsed rule overrides plus a parse diagnostic. */
  rules: readonly RuleOverride[]
  rulesError: string | null
}

/** A volatile field at runtime: a stable reference carrying `.get()`. */
interface LiveRef<T> {
  get(): T | undefined
}

function isLiveRef(value: unknown): value is LiveRef<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
}

/**
 * Read a field that may be volatile.
 *
 * Volatile fields arrive as references, not values; reading one directly yields
 * an object. Unwrapping here (and only here) keeps that quirk from leaking into
 * the rest of the plugin. Harmless on non-volatile fields.
 */
export function currentValue<T>(value: unknown, fallback: T): T {
  const raw = isLiveRef(value) ? value.get() : value
  return raw === undefined || raw === null ? fallback : (raw as T)
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, numeric))
}

function pick<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function pickText(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback
}

/**
 * A ledger directory must stay inside the workspace. An absolute path or one
 * containing `..` would let configuration move state (and, on a shared machine,
 * the record of what was authorised) outside the project it describes.
 */
export function normalizeStateDir(value: unknown): { dir: string; problem: string | null } {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return { dir: DEFAULT_CONFIG.stateDir, problem: null }
  const normalized = raw.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    return { dir: DEFAULT_CONFIG.stateDir, problem: `stateDir 必须是相对路径，收到绝对路径 '${raw}'，已退回默认值。` }
  }
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.includes('..')) {
    return { dir: DEFAULT_CONFIG.stateDir, problem: `stateDir 不得包含 '..'，收到 '${raw}'，已退回默认值。` }
  }
  return { dir: segments.join('/') || DEFAULT_CONFIG.stateDir, problem: null }
}

const POINT_IDS = new Set<string>(Object.keys(DECISION_POINTS))

/** Parse the `rulesJson` string. Never throws; a bad string yields a diagnostic. */
export function parseRuleOverrides(source: unknown): { rules: RuleOverride[]; error: string | null } {
  const text = typeof source === 'string' ? source.trim() : ''
  if (text === '') return { rules: [], error: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { rules: [], error: `rulesJson 不是合法 JSON：${(error as Error).message}` }
  }
  if (!Array.isArray(parsed)) return { rules: [], error: 'rulesJson 必须是一个数组。' }

  const rules: RuleOverride[] = []
  for (const [index, entry] of parsed.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { rules: [], error: `rulesJson[${index}] 必须是对象。` }
    }
    const record = entry as Record<string, unknown>
    const pointId = record['pointId']
    if (typeof pointId !== 'string' || !POINT_IDS.has(pointId)) {
      return { rules: [], error: `rulesJson[${index}].pointId 不是已知决策点：${JSON.stringify(pointId)}` }
    }
    const rule: { pointId: DecisionPointId; enabled?: boolean; ceiling?: InterventionLevel } = {
      pointId: pointId as DecisionPointId,
    }
    if (typeof record['enabled'] === 'boolean') rule.enabled = record['enabled']
    const ceiling = record['ceiling']
    if (ceiling !== undefined) {
      if (typeof ceiling !== 'string' || !INTERVENTION_LEVELS.includes(ceiling as InterventionLevel)) {
        return { rules: [], error: `rulesJson[${index}].ceiling 不是已知力度：${JSON.stringify(ceiling)}` }
      }
      rule.ceiling = ceiling as InterventionLevel
    }
    rules.push(rule)
  }
  return { rules, error: null }
}

/**
 * Normalize a (possibly partial or out-of-range) configuration.
 *
 * Pure, so logic tests can assert it without starting a harness. It also refuses
 * to blur two different failures together: declaring a decider kind that does
 * not exist is a `deciderProblem` reported at load time, not a gate that
 * silently falls back to something else.
 */
export function toRuntimeConfig(partial: Partial<Config> | undefined): RuntimeConfig {
  const source = partial ?? {}

  const declaredKind = currentValue<unknown>(source.deciderKind, DEFAULT_CONFIG.deciderKind)
  const kindIsKnown = typeof declaredKind === 'string' && (DECIDER_KINDS as readonly string[]).includes(declaredKind)
  const deciderKind: DeciderKind = kindIsKnown ? (declaredKind as DeciderKind) : DEFAULT_CONFIG.deciderKind
  const problem = kindIsKnown ? null : `deciderKind '${String(declaredKind)}' 不是已知实现（${DECIDER_KINDS.join(' / ')}），已退回 baseline。`

  const stateDir = normalizeStateDir(currentValue<unknown>(source.stateDir, DEFAULT_CONFIG.stateDir))
  const parsedRules = parseRuleOverrides(currentValue<unknown>(source.rulesJson, DEFAULT_CONFIG.rulesJson))

  const credentialRef = pickText(currentValue<unknown>(source.deciderCredentialRef, ''), '')

  let deciderProblem = problem ?? stateDir.problem
  if (deciderProblem === null && deciderKind === 'endpoint') {
    if (credentialRef === '') {
      deciderProblem =
        "deciderKind='endpoint' 需要 deciderCredentialRef：这里填凭据的**名字**（例如 MY_GATEWAY_KEY），密钥本身存进宿主凭据服务。"
    } else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialRef)) {
      deciderProblem = `deciderCredentialRef '${credentialRef}' 不是合法的凭据引用名（应形如 MY_GATEWAY_KEY）。`
    }
  }
  if (deciderProblem === null && deciderKind === 'llm' && parsedRules.error !== null) {
    deciderProblem = parsedRules.error
  }

  return {
    enabled: currentValue<unknown>(source.enabled, DEFAULT_CONFIG.enabled) === true,
    mode: pick(MODES, currentValue<unknown>(source.mode, DEFAULT_CONFIG.mode), DEFAULT_CONFIG.mode),
    onUnavailable: pick(
      UNAVAILABLE_POLICIES,
      currentValue<unknown>(source.onUnavailable, DEFAULT_CONFIG.onUnavailable),
      DEFAULT_CONFIG.onUnavailable,
    ),
    minConfidence: clampNumber(
      currentValue<unknown>(source.minConfidence, DEFAULT_CONFIG.minConfidence),
      DEFAULT_CONFIG.minConfidence,
      0,
      1,
    ),
    maxGapsPerIntervention: Math.round(
      clampNumber(
        currentValue<unknown>(source.maxGapsPerIntervention, DEFAULT_CONFIG.maxGapsPerIntervention),
        DEFAULT_CONFIG.maxGapsPerIntervention,
        1,
        50,
      ),
    ),
    stateDir: stateDir.dir,
    persistEnabled: currentValue<unknown>(source.persistEnabled, DEFAULT_CONFIG.persistEnabled) !== false,
    debounceMs: Math.round(
      clampNumber(currentValue<unknown>(source.debounceMs, DEFAULT_CONFIG.debounceMs), DEFAULT_CONFIG.debounceMs, 0, 60000),
    ),
    interveneAtStateTransition:
      currentValue<unknown>(source.interveneAtStateTransition, DEFAULT_CONFIG.interveneAtStateTransition) !== false,
    interveneAtPreFinish: currentValue<unknown>(source.interveneAtPreFinish, DEFAULT_CONFIG.interveneAtPreFinish) !== false,
    roleAwareness: pick(
      ROLE_POLICIES,
      currentValue<unknown>(source.roleAwareness, DEFAULT_CONFIG.roleAwareness),
      DEFAULT_CONFIG.roleAwareness,
    ),
    narrativeWatch: pick(
      NARRATIVE_POLICIES,
      currentValue<unknown>(source.narrativeWatch, DEFAULT_CONFIG.narrativeWatch),
      DEFAULT_CONFIG.narrativeWatch,
    ),
    requireBaseline: currentValue<unknown>(source.requireBaseline, DEFAULT_CONFIG.requireBaseline) !== false,
    deciderKind,
    deciderProvider: pickText(currentValue<unknown>(source.deciderProvider, ''), ''),
    deciderModel: pickText(currentValue<unknown>(source.deciderModel, ''), ''),
    deciderBaseUrl: pickText(currentValue<unknown>(source.deciderBaseUrl, ''), ''),
    deciderEndpointPath: pickText(currentValue<unknown>(source.deciderEndpointPath, ''), DEFAULT_CONFIG.deciderEndpointPath),
    deciderCredentialRef: credentialRef,
    deciderAuthority: pick(
      DECIDER_AUTHORITIES,
      currentValue<unknown>(source.deciderAuthority, DEFAULT_CONFIG.deciderAuthority),
      DEFAULT_CONFIG.deciderAuthority,
    ),
    deciderMaxQuestions: Math.round(
      clampNumber(
        currentValue<unknown>(source.deciderMaxQuestions, DEFAULT_CONFIG.deciderMaxQuestions),
        DEFAULT_CONFIG.deciderMaxQuestions,
        1,
        32,
      ),
    ),
    rulesJson: typeof source.rulesJson === 'string' ? source.rulesJson : DEFAULT_CONFIG.rulesJson,
    unimplementedDecider: isImplementedDecider(deciderKind) ? null : deciderKind,
    deciderProblem,
    rules: parsedRules.rules,
    rulesError: parsedRules.error,
  }
}

/** Whether this mode may deliver any intervention at all. */
export function allowsDelivery(mode: Mode): boolean {
  return mode === 'advisory' || mode === 'enforce' || mode === 'lockdown'
}

/** Whether this mode may block or hand back to a human. */
export function allowsBlocking(mode: Mode): boolean {
  return mode === 'enforce' || mode === 'lockdown'
}

/**
 * Flatten a planned level into the level this mode may actually deliver.
 *
 * The single most important pure function here: it separates "how strongly we
 * think this should be said" from "how strongly this mode is allowed to say it".
 * The planned level is always recorded in the ledger (so a dry-run can still tell
 * you what *would* have been said), while delivery is capped by this result.
 *
 * - `enforce` / `lockdown`: unchanged here — `lockdown` differs earlier, by
 *   refusing scope expansion outright rather than by capping the ladder.
 * - `advisory`: may note and may continue the turn, but never blocks.
 * - `dry-run` / `off`: recorded only.
 */
export function capForMode(level: InterventionLevel, mode: Mode): InterventionLevel {
  if (mode === 'enforce' || mode === 'lockdown') return level
  if (mode === 'advisory') return level === 'L3_deny' || level === 'L4_human' ? 'L1_note' : level
  return 'L0_ledger'
}

/**
 * The most force allowed for one decision point by configuration alone.
 *
 * Rules (`enabled:false`, an explicit `ceiling`) and `lockdown` narrow a point
 * for real. The mode cap is deliberately *not* applied here: keeping the two
 * apart is what lets a dry-run still record the rung it would have used, and
 * only cap the delivery. `ceilingFor` is this value plus the mode cap.
 */
export function configuredCeilingFor(pointId: DecisionPointId, config: RuntimeConfig): InterventionLevel {
  let ceiling: InterventionLevel = DECISION_POINTS[pointId].ceiling
  for (const rule of config.rules) {
    if (rule.pointId !== pointId) continue
    if (rule.enabled === false) ceiling = 'L0_ledger'
    if (rule.ceiling !== undefined && LEVEL_RANK[rule.ceiling] < LEVEL_RANK[ceiling]) ceiling = rule.ceiling
  }
  if (config.mode === 'lockdown' && LEVEL_RANK[ceiling] > LEVEL_RANK['L1_note']) ceiling = 'L1_note'
  return ceiling
}

/** The most force allowed for one decision point, given config and mode. */
export function ceilingFor(pointId: DecisionPointId, config: RuntimeConfig): InterventionLevel {
  return capForMode(configuredCeilingFor(pointId, config), config.mode)
}
