import { createHash } from 'node:crypto'

/**
 * Deterministic hashing for the ledger.
 *
 * Two different needs, deliberately kept apart:
 * - `hashOf` must be stable across runs and processes for the FROZEN baseline, so
 *   it walks the structure in a canonical key order.
 * - `shortDigest` is for evidence fingerprints, where a collision would only
 *   merge two evidence records — so a truncated digest is fine and keeps the
 *   ledger readable.
 */

/** Canonical JSON with sorted object keys, so key insertion order cannot matter. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value === undefined ? null : value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry))
  }
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    const entry = source[key]
    if (entry === undefined) continue
    out[key] = sortValue(entry)
  }
  return out
}

export function hashOf(value: unknown): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex')
}

export function shortDigest(value: unknown, length = 12): string {
  return hashOf(value).slice(0, length)
}

/** Digest of a judgement's inputs, so a replayed verdict can be compared. */
export function fingerprintOf(parts: readonly unknown[]): string {
  return shortDigest(parts, 16)
}
