/**
 * Prose as a claim channel.
 *
 * A team's bookkeeping can be perfectly consistent while the thing a person
 * actually reads — the assistant's own summary — says something different. That
 * gap is invisible to any check that only looks at tool calls, and it is the gap
 * that matters most, because prose is what gets believed.
 *
 * So the gate watches the model's own text for completion claims and asks a
 * narrow question: *was anything actually done in this turn that could support
 * this sentence?* It does not judge tone, and it does not flag every mention of
 * "done" — only an assertion in the past tense with nothing behind it.
 *
 * ## What counts, and what does not
 *
 * Flagged: "已完成", "全部改完了", "tests pass now".
 * Not flagged: "我会完成" (future), "还没完成" (negated), "完成了吗？" (question),
 * "已完成的定义是…" (definition). The negative filter is deliberately generous —
 * a watcher that fires on conditionals gets muted, and a muted watcher is worse
 * than none.
 */

/** Positive: an assertion that something has been completed. */
const CLAIM_PATTERNS: readonly RegExp[] = [
  /(?:已|都|全部|统统)(?:经)?(?:完成|改完|修好|搞定|做完|实现|通过)/u,
  /(?:完成|改完|修好|搞定|做完)了(?![吗呢？?])/u,
  /\b(?:is|are|was|were)\s+(?:now\s+)?(?:done|complete|completed|finished|implemented|fixed|shipped)\b/iu,
  /\b(?:i|we)(?:'ve|\s+have)?\s+(?:now\s+)?(?:finished|completed|implemented|fixed|done|shipped)\b/iu,
  /\b(?:tests?|checks?)\s+(?:now\s+)?pass(?:es|ed)?\b/iu,
  /测试(?:现在)?(?:全部)?通过/u,
  /[✅✔️]/u,
]

/** Negative: negated, hypothetical, or interrogative. Beats a positive match. */
const NEGATIVE_PATTERNS: readonly RegExp[] = [
  /(?:未|没有|还没|尚未|不能|无法|尚未能)(?:完成|改完|修好|搞定|做完|实现|通过)/u,
  /\bnot\s+(?:yet\s+)?(?:done|complete|completed|finished|implemented|fixed)\b/iu,
  /\b(?:cannot|can't|couldn't|won't|unable\s+to)\b/iu,
  /\b(?:will|would|should|plan\s+to|going\s+to|next\s+step|remaining|todo)\b/i,
  /(?:将|将要|计划|下一步|接下来|待办|剩余|需要)(?:完成|改|修|做|实现)/u,
  /[？?]\s*$/u,
  /(?:的定义|意思是|指的是)/u,
]

/** Prose that names concrete artifacts — used only to rank, never to decide. */
const ARTIFACT_PATTERN = /(?:[\w./-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|py|rs|go|java|css|html))|(?:^|\s)(?:npm|pnpm|yarn|node|npx|git|tsc)\s/imu

/** The same shape as `ARTIFACT_PATTERN`, but global, so every token can be read. */
const ARTIFACT_TOKEN =
  /[\w./\\-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|py|rs|go|java|css|html)|\b(?:npm|pnpm|yarn|node|npx|git|tsc)\b/giu

/** How many artifact names one sentence may contribute to a match. */
const MAX_TOKENS = 8

/**
 * The concrete artifacts a sentence names, lowercased and de-duplicated.
 *
 * Used only to *match* a claim against observations the gate already holds: a
 * sentence that says "host/gate.ts 改完了" is answerable by an observation that
 * mentions `host/gate.ts`, and unanswerable by one that does not. Never used to
 * score the sentence itself — a claim is a claim whether or not it names a file,
 * it is only *ranked* differently.
 */
export function artifactTokens(sentence: string): string[] {
  const seen = new Set<string>()
  for (const match of sentence.matchAll(ARTIFACT_TOKEN)) {
    const token = match[0].toLowerCase().replace(/^[./\\]+/u, '')
    if (token === '') continue
    seen.add(token)
    if (seen.size >= MAX_TOKENS) break
  }
  return [...seen]
}

export interface ProseClaim {
  /** The sentence, trimmed and safe to quote back. */
  readonly sentence: string
  /** Whether the sentence names files or commands it is claiming about. */
  readonly mentionsArtifacts: boolean
}

export interface NarrativeSnapshot {
  readonly claims: readonly ProseClaim[]
  readonly characters: number
}

const MAX_BUFFER = 6000
const MAX_SENTENCE = 240
const MAX_CLAIMS = 5

/**
 * Split prose into sentences without a tokenizer.
 *
 * Good enough on purpose: the unit of judgement is a sentence-sized span, and a
 * slightly wrong split only means a slightly different quote, never a wrong
 * verdict, because the negative filter runs per candidate.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;])|\n+/u)
    .map((line) => line.replace(/^[\s>*\-•]+/u, '').trim())
    .filter((line) => line.length > 0)
}

export function detectClaims(text: string): ProseClaim[] {
  const claims: ProseClaim[] = []
  for (const sentence of splitSentences(text)) {
    if (sentence.length > MAX_SENTENCE * 4) continue
    if (NEGATIVE_PATTERNS.some((pattern) => pattern.test(sentence))) continue
    if (!CLAIM_PATTERNS.some((pattern) => pattern.test(sentence))) continue
    claims.push({
      sentence: sentence.slice(0, MAX_SENTENCE),
      mentionsArtifacts: ARTIFACT_PATTERN.test(sentence),
    })
    if (claims.length >= MAX_CLAIMS) break
  }
  return claims
}

/**
 * Accumulates one agent's streamed prose.
 *
 * Text is appended as the model produces it and consumed once, when the turn is
 * about to stop — which is the moment a claim can be compared against the whole
 * turn's actions. The buffer is bounded because a runaway generator must not turn
 * a gate into a memory leak.
 */
export class NarrativeWatch {
  private readonly buffers = new Map<string, string>()

  /** Append streamed text for one actor. Blank input is ignored. */
  append(actorKey: string, text: string): void {
    if (text === '') return
    const current = this.buffers.get(actorKey) ?? ''
    const next = current + text
    this.buffers.set(actorKey, next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next)
  }

  /** Text accumulated so far, for diagnostics. */
  text(actorKey: string): string {
    return this.buffers.get(actorKey) ?? ''
  }

  /** Claims found so far, without consuming the buffer. */
  peek(actorKey: string): ProseClaim[] {
    return detectClaims(this.text(actorKey))
  }

  /** Claims found so far, consuming the buffer: the turn is being judged once. */
  take(actorKey: string): ProseClaim[] {
    const text = this.text(actorKey)
    this.buffers.delete(actorKey)
    return detectClaims(text)
  }

  /** Discard a buffer without producing claims (a new turn started). */
  reset(actorKey: string): void {
    this.buffers.delete(actorKey)
  }

  clear(): void {
    this.buffers.clear()
  }

  get size(): number {
    return this.buffers.size
  }
}

/**
 * Whether a claim is worth acting on.
 *
 * A claim that names no artifact is a summary, and summaries are cheap; a claim
 * that names a file or a command is a factual assertion the workspace can settle
 * — those are the ones worth interrupting for.
 */
export function isActionableClaim(claim: ProseClaim): boolean {
  return claim.mentionsArtifacts
}
