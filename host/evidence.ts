/**
 * Evidence, and the one rule that shapes the whole plugin.
 *
 * ## Invariant (1): self-report is not evidence
 *
 * An agent saying "I implemented it" is a record of an assertion, not of work.
 * The ledger therefore grades every record by *provenance*:
 *
 * | Level | Meaning | May justify coverage |
 * |-------|---------|----------------------|
 * | `A` | the gate itself observed the fact — a tool really ran, a file really exists, a file's bytes were really read | yes |
 * | `B` | a predicate that was **declared up front** was really evaluated against real state | yes |
 * | `C` | somebody wrote it down | **no** |
 *
 * Two consequences worth stating, because they are where a naive version gets it
 * wrong:
 *
 * 1. **A tool call's arguments are `C`.** The gate observed *that the call
 *    happened* (an `A` fact about the action), but the file list and the
 *    acceptance list inside it are the model's own words. Those are recorded
 *    separately, at the level they deserve.
 * 2. **A passing command is not automatically `A`.** The gate does not execute
 *    shell commands; it does not need to, and running whatever a model wrote
 *    into a `verify` field is exactly how a "gate" becomes an attack surface. A
 *    declared command is recorded as a claim, and the honest thing to say about
 *    it is that the gate could not check it.
 *
 * ## What the gate *can* check for itself
 *
 * A small, closed predicate language over the workspace — `exists`, `contains`,
 * and "read the file and see whether it is real work". These cost nothing, are
 * deterministic, and cannot be turned into code execution.
 */

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import { shortDigest } from './hash.ts'
import { attributeToItem } from './baseline.ts'
import type {
  ActorRef,
  BaselineItem,
  DecisionPointId,
  EvidenceChannel,
  EvidenceLevel,
  EvidenceRecord,
} from './types.ts'
import { relativeDisplay, underWorkspace } from './workspace.ts'

/* ------------------------------------------------------------------ *
 * Predicates
 * ------------------------------------------------------------------ */

export interface PredicateOutcome {
  /** Whether the gate could evaluate it at all. */
  readonly checked: boolean
  readonly passed: boolean
  readonly detail: string
}

export interface FileProbe {
  readonly exists: boolean
  readonly bytes: number
  readonly lines: number
  /** Lines that carry code rather than a comment or whitespace. */
  readonly substantialLines: number
  readonly binary: boolean
  readonly stub: boolean
  readonly digest: string
}

const COMMENT_PREFIXES = ['//', '#', '/*', '*', '<!--', '--', '"""', "'''", ';']

/**
 * Whether a file looks like a placeholder rather than work.
 *
 * Two independent signals, and both are required before the gate says so:
 * a placeholder marker *and* almost no substance. A single signal would make
 * this fire on honest, small files — and a gate that cries wolf on a two-line
 * config gets switched off, which is a worse outcome than missing one stub.
 */
const STUB_MARKERS = ['todo', 'fixme', 'not implemented', 'unimplemented', 'placeholder', 'coming soon']

export async function probeFile(root: string, path: string): Promise<FileProbe> {
  const absolute = resolvePath(root, path)
  const empty: FileProbe = {
    exists: false,
    bytes: 0,
    lines: 0,
    substantialLines: 0,
    binary: false,
    stub: false,
    digest: shortDigest(['missing', path]),
  }
  if (absolute === null) return empty

  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(absolute)
  } catch {
    return empty
  }
  if (!info.isFile()) return empty

  let buffer: Buffer
  try {
    buffer = await readFile(absolute)
  } catch {
    return { ...empty, exists: true, bytes: info.size }
  }

  const binary = buffer.subarray(0, 8192).includes(0)
  const text = buffer.toString('utf8')
  const rawLines = text.split(/\r?\n/)
  let substantialLines = 0
  for (const line of rawLines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) continue
    substantialLines += 1
  }
  const lowered = text.toLowerCase()
  const hasMarker = STUB_MARKERS.some((marker) => lowered.includes(marker))
  const stub = !binary && (substantialLines === 0 || (substantialLines < 5 && hasMarker && info.size < 8192))

  return {
    exists: true,
    bytes: info.size,
    lines: rawLines.length,
    substantialLines,
    binary,
    stub,
    digest: shortDigest(buffer.toString('base64')),
  }
}

function resolvePath(root: string, path: string): string | null {
  const trimmed = path.trim().replace(/^["']|["']$/g, '')
  if (trimmed === '') return null
  if (isAbsolute(trimmed)) return trimmed
  return underWorkspace(root, trimmed)
}

/**
 * Evaluate one declared acceptance condition.
 *
 * Understood forms, deliberately few:
 * - `exists <path>` or a bare path
 * - `contains <path> <text>`
 *
 * Anything else — including a shell command — is *not checked*. Saying so is
 * better than pretending, and it is why this function returns `checked:false`
 * rather than a failure.
 */
export async function evaluatePredicate(root: string, spec: string): Promise<PredicateOutcome> {
  const text = spec.trim()
  if (text === '') return { checked: false, passed: false, detail: '空的验收条件。' }

  const containsMatch = /^contains\s+(.+?)\s+(.+)$/s.exec(text)
  if (containsMatch !== null) {
    const path = containsMatch[1] ?? ''
    const needle = containsMatch[2] ?? ''
    const absolute = resolvePath(root, path)
    if (absolute === null) return { checked: false, passed: false, detail: `无法解析路径：${spec}` }
    const content = await readTextFile(absolute)
    if (content === null) {
      return { checked: true, passed: false, detail: `${path} 不存在，无法包含 ${needle}。` }
    }
    return content.includes(needle)
      ? { checked: true, passed: true, detail: `${path} 含有 ${JSON.stringify(needle)}。` }
      : { checked: true, passed: false, detail: `${path} 里找不到 ${JSON.stringify(needle)}。` }
  }

  const existsMatch = /^exists\s+(.+)$/s.exec(text)
  const candidate = existsMatch !== null ? (existsMatch[1] ?? '') : text
  if (looksLikePath(candidate)) {
    const probe = await probeFile(root, candidate)
    return probe.exists
      ? { checked: true, passed: true, detail: `${candidate} 存在（${probe.bytes} 字节，${probe.substantialLines} 行有效代码）。` }
      : { checked: true, passed: false, detail: `${candidate} 不存在。` }
  }

  return {
    checked: false,
    passed: false,
    detail: `门禁不执行命令，也不认识这条验收条件：${text}`,
  }
}

function looksLikePath(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.includes(' ')) return false
  return /[./\\]/.test(trimmed) || /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(trimmed)
}

async function readTextFile(absolute: string): Promise<string | null> {
  try {
    return await readFile(absolute, 'utf8')
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Evidence construction
 * ------------------------------------------------------------------ */

export interface EvidenceInput {
  readonly root: string
  readonly actor: ActorRef
  readonly pointId: DecisionPointId | null
  readonly items: readonly BaselineItem[]
  readonly level: EvidenceLevel
  readonly channel: EvidenceChannel
  readonly detail: string
  readonly toolName?: string
  /**
   * The baseline item this record is about, when the caller already knows.
   *
   * Callers iterating an item's *own* acceptance conditions or scope know the
   * owner exactly. Making them re-derive it from text dropped the record
   * whenever the item's id happened not to appear in its requirement — which is
   * the normal case for a baseline derived from a team record, where the id is a
   * task id and the requirement is a task subject. That is not conservatism, it
   * is a lose-lose: real evidence goes unattributed and coverage reads as zero.
   */
  readonly itemId?: string
  /** Free text used to attribute the record to a baseline item when `itemId` is absent. */
  readonly haystack: string
  /** Observation time; defaults to now. */
  readonly at?: number
}

export function makeEvidence(input: EvidenceInput): EvidenceRecord {
  const itemId =
    input.itemId !== undefined
      ? input.itemId
      : input.items.length === 0
        ? null
        : attributeToItem(input.haystack, input.items)
  const record: EvidenceRecord = {
    id: `ev-${shortDigest([input.at ?? 0, input.channel, input.detail, input.actor.actorKey])}`,
    itemId,
    pointId: input.pointId,
    level: input.level,
    channel: input.channel,
    at: input.at ?? Date.now(),
    actorKey: input.actor.actorKey,
    digest: shortDigest([input.channel, input.detail, input.haystack]),
    detail: input.detail,
  }
  return input.toolName === undefined ? record : { ...record, toolName: input.toolName }
}

/** The workspace-relative display path recorded alongside an observation. */
export function displayPath(root: string, path: string): string {
  const absolute = resolvePath(root, path)
  if (absolute === null) return path
  return relativeDisplay(root, absolute)
}

/** Text describing why a record does or does not count, for the model-facing note. */
export function levelNote(level: EvidenceLevel): string {
  if (level === 'A') return '门禁亲自观察到'
  if (level === 'B') return '预声明谓词实测'
  return '执行者自述（不计入判定）'
}
