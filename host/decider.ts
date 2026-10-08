/**
 * The external opinion seam.
 *
 * ## Invariant (3): an outside opinion may only tighten, never loosen
 *
 * The reason is asymmetric failure. If the decider is unreachable, a gate that
 * defaults to "carry on" has silently become a no-op — and it will *look* like it
 * is working, because it still writes verdicts. So:
 *
 * - Unavailable is a first-class outcome (`available: false`), never an implicit
 *   "fine".
 * - A weaker suggestion is recorded, marked `loosened`, and — unless the
 *   operator deliberately set `deciderAuthority: 'sole'` — **not applied**.
 *   Loosening is an explicit act with a name, not a default.
 * - The decider is *asked*, never obeyed. It answers questions; the matrix it is
 *   asked about was built by the gate from observations, not from prose.
 *
 * ## What is asked
 *
 * Only the closed questions the gate already knows how to score, one per gap,
 * phrased so that a "yes" would *tighten* the finding. A free-form prompt like
 * "review this work" would invite the model to summarise the code, which is
 * exactly the input we refuse to trust.
 *
 * ## Honest limits
 *
 * The `llm` path uses the session's own model route. The `endpoint` path speaks a
 * small documented JSON shape to a URL the operator configures; it has not been
 * exercised against a live third-party service in this checkout, and it is
 * written to fail closed — an unparseable or unexpected response is
 * `available: false`, not a guess.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import type { Advice, AdviceClaim, Gap, InterventionLevel } from './types.ts'
import type { RuntimeConfig } from './config.ts'

/** Questions are closed and pre-scored; the decider's only job is join them. */
export const QUESTION_TYPES = ['noul'] as const

export interface DeciderRequest {
  /** Stable key per gap, so answers can be matched back without trusting order. */
  readonly questions: readonly { readonly id: string; readonly gap: Gap; readonly instructions: string }[]
  /** A compact, non-prose state description; deliberately not the source code. */
  readonly state: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal | undefined
}

export interface DeciderDeps {
  readonly ctx: Context
  readonly config: RuntimeConfig
  /** Injectable for tests; production passes the real route. */
  readonly llmStream?: (options: LlmStreamOptions) => AsyncIterable<{ type: string; text?: string }>
  /** Injectable for tests; production passes global fetch. */
  readonly http?: (url: string, init: HttpInit) => Promise<HttpResponse>
  readonly credential?: (ref: string) => Promise<string | null>
  readonly now?: () => number
}

export interface LlmStreamOptions {
  readonly provider: string
  readonly model: string
  readonly messages: readonly unknown[]
  readonly system?: string
  readonly signal?: AbortSignal
  readonly maxTokens?: number
}

export interface HttpInit {
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly signal?: AbortSignal
}

export interface HttpResponse {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

/* ------------------------------------------------------------------ *
 * Prompt
 * ------------------------------------------------------------------ */

const SYSTEM_PROMPT = [
  'You are a second opinion on a team-of-agents workflow gate.',
  'You are given already-scored findings. You do not see source code and must not ask for it.',
  'For each question, answer with a single number in [0,1]: the probability that the finding genuinely holds.',
  'A low number means the finding looks like a false alarm. Returning a low number TIGHTENS nothing; it can only suggest relaxing a block, which a human must authorise.',
  'Reply with JSON only: {"answers":{"<id>":{"noul":<number>}}}',
].join(' ')

function renderQuestions(request: DeciderRequest): string {
  const lines: string[] = []
  for (const question of request.questions) {
    lines.push(`- id=${question.id} type=${question.gap.kind} severity=${question.gap.severity} detail=${question.gap.detail}`)
  }
  return [
    `state: ${JSON.stringify(request.state)}`,
    'questions:',
    ...lines,
    '',
    'Answer with JSON only.',
  ].join('\n')
}

/* ------------------------------------------------------------------ *
 * Answer parsing
 * ------------------------------------------------------------------ */

function clamp01(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(1, Math.max(0, value))
}

/**
 * Parse the documented answer shape, tolerating the two harmless variations
 * (a bare number, or the value wrapped in an object) and refusing everything
 * else. A partially-understood answer is worse than none, because it would be
 * attributed to the wrong question.
 */
export function parseAnswers(payload: unknown): Map<string, number> {
  const answers = new Map<string, number>()
  if (typeof payload !== 'object' || payload === null) return answers
  const container = (payload as Record<string, unknown>)['answers']
  if (typeof container !== 'object' || container === null) return answers
  for (const [id, raw] of Object.entries(container as Record<string, unknown>)) {
    const direct = clamp01(raw)
    if (direct !== null) {
      answers.set(id, direct)
      continue
    }
    if (typeof raw === 'object' && raw !== null) {
      const nested = (raw as Record<string, unknown>)['noul']
      const value = clamp01(nested)
      if (value !== null) answers.set(id, value)
    }
  }
  return answers
}

/**
 * A `[0,1]` agreement score is not a confidence.
 *
 * The wire protocol may return a probability without saying of what. `|2p-1|` is
 * the honest reading: it is the *distance from a coin flip*. A service that
 * answers 0.5 has told us nothing, and this maps that to 0 rather than to a
 * comfortable-looking half.
 */
export function agreementFrom(value: number): number {
  return Math.abs(2 * value - 1)
}

/* ------------------------------------------------------------------ *
 * The seam
 * ------------------------------------------------------------------ */

/** A suggestion weaker than the local finding is a loosening, and is marked. */
export function isLoosening(local: InterventionLevel, suggested: InterventionLevel | null): boolean {
  if (suggested === null) return false
  const rank: Record<InterventionLevel, number> = { L0_ledger: 0, L1_note: 1, L2_continue: 2, L3_deny: 3, L4_human: 4 }
  return rank[suggested] < rank[local]
}

function unavailable(config: RuntimeConfig, reason: string, now: number): Advice {
  return {
    decider: config.deciderKind,
    authority: config.deciderAuthority,
    available: false,
    at: now,
    suggested: null,
    claims: [],
    reason,
    loosened: false,
  }
}

export async function askDecider(deps: DeciderDeps, request: DeciderRequest): Promise<Advice> {
  const now = deps.now?.() ?? Date.now()
  const config = deps.config

  if (config.deciderKind === 'baseline') {
    // Not a failure and not a call: the frozen baseline *is* the decider here.
    return {
      decider: 'baseline',
      authority: config.deciderAuthority,
      available: true,
      at: now,
      suggested: null,
      claims: [],
      reason: 'deciderKind=baseline：判定者就是本地冻结基线，没有咨询外部意见。',
      loosened: false,
    }
  }

  if (config.deciderProblem !== null) return unavailable(config, config.deciderProblem, now)
  if (request.questions.length === 0) {
    return {
      decider: config.deciderKind,
      authority: config.deciderAuthority,
      available: true,
      at: now,
      suggested: null,
      claims: [],
      reason: '这次没有任何需要外部判断的缺口。',
      loosened: false,
    }
  }

  const bounded = request.questions.slice(0, config.deciderMaxQuestions)
  try {
    const raw =
      config.deciderKind === 'llm'
        ? await askLlm(deps, { ...request, questions: bounded })
        : await askEndpoint(deps, { ...request, questions: bounded })
    if (raw === null) return unavailable(config, '判定器没有返回可解析的答复。', now)
    return buildAdvice(config, bounded, raw, now)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return unavailable(config, `判定器调用失败：${message}`, now)
  }
}

function buildAdvice(
  config: RuntimeConfig,
  questions: DeciderRequest['questions'],
  answers: Map<string, number>,
  now: number,
): Advice {
  const claims: AdviceClaim[] = []
  for (const question of questions) {
    const value = answers.get(question.id)
    claims.push({
      label: question.gap.kind,
      confidence: value === undefined ? null : agreementFrom(value),
      note: value === undefined ? `${question.id}: 判定器没有回答这一条。` : `${question.id}: ${question.gap.detail}`,
    })
  }

  const answered = claims.filter((claim) => claim.confidence !== null)
  if (answered.length === 0) {
    return {
      decider: config.deciderKind,
      authority: config.deciderAuthority,
      available: false,
      at: now,
      suggested: null,
      claims,
      reason: '判定器对这些缺口一条都没回答，按不可用处理。',
      loosened: false,
    }
  }

  // The suggestion is driven only by answers that are confidently *low*: "this
  // finding is probably wrong" is the only thing that could relax anything, and
  // even then it needs either `sole` authority or a human.
  const weakest = answered.reduce((lowest, claim) => Math.min(lowest, claim.confidence ?? 1), 1)
  const confident = weakest >= config.minConfidence
  return {
    decider: config.deciderKind,
    authority: config.deciderAuthority,
    available: true,
    at: now,
    suggested: confident ? null : 'L1_note',
    claims,
    reason: confident
      ? `判定器认同这些缺口（最低一致度 ${weakest.toFixed(2)} ≥ minConfidence ${config.minConfidence}），没有放宽建议。`
      : `判定器对至少一条缺口的一致度只有 ${weakest.toFixed(2)}，低于 minConfidence ${config.minConfidence}；这只构成一个放宽的*提议*。`,
    loosened: false,
  }
}

/* ------------------------------------------------------------------ *
 * Transports
 * ------------------------------------------------------------------ */

async function askLlm(deps: DeciderDeps, request: DeciderRequest): Promise<Map<string, number> | null> {
  const stream = deps.llmStream ?? defaultLlmStream(deps)
  if (stream === null) throw new Error('llm 服务不在场')

  const selection = deps.config.deciderModel
  const options: LlmStreamOptions = {
    provider: deps.config.deciderProvider,
    model: selection,
    messages: [
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: renderQuestions(request) }],
      }),
    ],
    system: SYSTEM_PROMPT,
    maxTokens: 1024,
  }
  if (request.signal !== undefined) (options as { signal?: AbortSignal }).signal = request.signal

  let text = ''
  for await (const chunk of stream(options)) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
  }
  return parseAnswers(extractJson(text))
}

function defaultLlmStream(deps: DeciderDeps): ((options: LlmStreamOptions) => AsyncIterable<{ type: string; text?: string }>) | null {
  const llm = deps.ctx.get('llm') as
    | { stream?: (options: Record<string, unknown>) => AsyncIterable<{ type: string; text?: string }> }
    | undefined
  if (llm === undefined || typeof llm.stream !== 'function') return null
  const bound = llm.stream.bind(llm)
  return (options) => bound(options as unknown as Record<string, unknown>)
}

async function askEndpoint(deps: DeciderDeps, request: DeciderRequest): Promise<Map<string, number> | null> {
  const http = deps.http
  if (http === undefined) throw new Error('没有可用的 HTTP 客户端')

  const base = deps.config.deciderBaseUrl === '' ? DEFAULT_BASE_URL : deps.config.deciderBaseUrl
  const url = joinUrl(base, deps.config.deciderEndpointPath)
  const credential = await resolveCredential(deps)
  if (credential === null) throw new Error(`凭据 ${deps.config.deciderCredentialRef} 无法解析`)

  const body = JSON.stringify({
    state: request.state,
    model: deps.config.deciderModel,
    questions: Object.fromEntries(
      request.questions.map((question) => [question.id, { type: 'noul', instructions: question.instructions }]),
    ),
  })

  const init: HttpInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body,
  }
  if (request.signal !== undefined) (init as { signal?: AbortSignal }).signal = request.signal

  const response = await http(url, init)
  if (!response.ok) {
    // 429/529 mean "try later", 401/422 mean "configured wrong". Both are the
    // same thing to a gate: no opinion, and no opinion is *not* permission.
    throw new Error(`endpoint 返回 HTTP ${response.status}`)
  }
  const text = await response.text()
  return parseAnswers(extractJson(text))
}

const DEFAULT_BASE_URL = 'https://api.typesafe.ai'

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, '')
  const trimmedPath = path.startsWith('/') ? path : `/${path}`
  return `${trimmedBase}${trimmedPath}`
}

async function resolveCredential(deps: DeciderDeps): Promise<string | null> {
  if (deps.credential !== undefined) return deps.credential(deps.config.deciderCredentialRef)
  const credentials = deps.ctx.get('credentials') as
    | { resolve?: (ref: string) => Promise<unknown> }
    | undefined
  if (credentials === undefined || typeof credentials.resolve !== 'function') return null
  try {
    const value = await credentials.resolve(deps.config.deciderCredentialRef)
    if (typeof value === 'string') return value
    if (typeof value === 'object' && value !== null) {
      const inner = (value as Record<string, unknown>)['value']
      if (typeof inner === 'string') return inner
    }
    return null
  } catch {
    return null
  }
}

/**
 * Pull the first JSON object out of a model's reply.
 *
 * Models wrap JSON in prose and fences. Scanning for a balanced object is more
 * reliable than a fence regex, and when nothing parses the caller records
 * "unavailable" rather than inventing an answer.
 */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index] ?? ''
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}
