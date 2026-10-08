/**
 * dsh-jev-gate — secret gate.
 *
 * Two separate jobs, because they fail differently:
 *
 * 1. **A real scan.** A credential committed into `host/`, `client/` or the
 *    manifest is a live credential. The detectors below are the shapes that
 *    actually leak — provider key prefixes, `Bearer` headers pasted out of a
 *    `curl`, AWS access key ids, opaque base64url blobs, and literal
 *    `api_key = "…"` assignments.
 * 2. **A structural rule.** This plugin resolves its credential by *reference*
 *    through the host credential service; it must never read one out of the
 *    environment, because an environment variable is visible to every child
 *    process and cannot be revoked per session. So a `process.env` read is a
 *    hard failure anywhere in `host/` or `client/`. A mention inside a comment
 *    is documentation and is reported but not failed.
 *
 * The gate is self-testing. A scanner that matches nothing passes trivially, so
 * before scanning the repository this run synthesizes credential-shaped strings
 * in memory and requires every detector to fire on them. The fixtures are built
 * from parts at run time: a literal test key in this file would be exactly the
 * thing the gate is supposed to catch.
 *
 * Run: node scripts/run-secret-scan.mjs
 *
 * @module dsh-jev-gate/scripts/run-secret-scan
 */

import { readdir, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { fail, ok, repoRoot } from './lib/bundle.mjs'

const NAME = 'run-secret-scan'

/** Directories walked in full. */
const SCAN_DIRS = ['host', 'client', 'scripts']
/** Single files of interest outside those directories. */
const SCAN_FILES = ['package.json', 'cordis.patch.yml', 'README.md']
/** Directories that are generated, vendored or irrelevant. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.tmp'])
/**
 * Directories skipped only at the package root.
 *
 * `lib/` is `tsc` output, but a directory *named* `lib` is not: `scripts/lib/`
 * holds real source that must be scanned. Matching on the name alone silently
 * excluded it, which is exactly the kind of hole this gate exists to close.
 */
const SKIP_ROOT_DIRS = new Set(['lib'])
/** Files that exist only to define the detectors, so they must not be scanned. */
const SELF_PATHS = new Set(['scripts/run-secret-scan.mjs'])

/**
 * Known-safe literals.
 *
 * Deliberately empty: every entry is a hole a real secret could pass through,
 * so one is added only after a specific false positive is understood. The
 * mechanism is kept so that decision is explicit and logged rather than
 * expressed by loosening a detector.
 */
const ALLOWLIST = []

/* ------------------------------------------------------------------ *
 * Detectors
 * ------------------------------------------------------------------ */

function regexFind(pattern) {
  return (text) => {
    const found = []
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(text)) !== null) {
      found.push({ text: match[0], index: match.index })
      if (match[0].length === 0) pattern.lastIndex += 1
    }
    return found
  }
}

/** Shannon entropy in bits per character. */
function entropy(value) {
  const counts = new Map()
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const p = count / value.length
    bits -= p * Math.log2(p)
  }
  return bits
}

const HEX_HASH = /^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{128})$/i

/**
 * Decide whether a long base64url run is opaque enough to be a secret.
 *
 * The filters exist to keep the detector usable: a hex digest is a hash by
 * shape, a run over a two-character alphabet is a separator or a fixture, and a
 * low-entropy run is prose that happens to be alphanumeric. Everything that
 * survives them is reported.
 */
function classifyBase64Run(run) {
  if (HEX_HASH.test(run)) return { exempt: 'hex digest (hash), not a credential' }
  const distinct = new Set(run).size
  if (distinct <= 8) return { exempt: `only ${distinct} distinct characters` }
  if (entropy(run) < 3.9) return { exempt: `entropy ${entropy(run).toFixed(2)} bits/char is below the 3.90 threshold` }
  return { secret: true }
}

const DETECTORS = [
  {
    id: 'sk-prefixed-key',
    why: 'provider API key with the `sk-` prefix',
    find: regexFind(/\bsk-[A-Za-z0-9_-]{16,}/g),
  },
  {
    id: 'bearer-token',
    why: '`Bearer` authorization token',
    find: regexFind(/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g),
  },
  {
    id: 'aws-access-key-id',
    why: 'AWS access key id',
    find: regexFind(/\bAKIA[0-9A-Z]{16}\b/g),
  },
  {
    id: 'api-key-assignment',
    why: 'literal secret assigned to an api key field',
    find: regexFind(/api[_-]?key\s*[:=]\s*["'][^"'\n]{16,}["']/gi),
  },
  {
    id: 'opaque-base64url-run',
    why: 'long high-entropy base64url run',
    find: regexFind(/[A-Za-z0-9_-]{40,}/g),
    refine: classifyBase64Run,
  },
]

/* ------------------------------------------------------------------ *
 * Scanning
 * ------------------------------------------------------------------ */

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1
  return line
}

/** Never echo a live secret into the log; show enough to locate it. */
function redact(value) {
  return value.length <= 8 ? `${value[0] ?? ''}…` : `${value.slice(0, 4)}…<${value.length} chars>`
}

/**
 * Mark which character positions of `text` are inside a comment.
 *
 * The environment rule below is about what the code *does*, and prose that
 * documents the rule ("...never read from `process.env`") must not trip it —
 * otherwise the only way to pass the gate would be to stop documenting why it
 * exists. Quotes and template literals are tracked so a `//` inside a string is
 * not mistaken for a comment, and newlines are preserved so line numbers stay
 * correct.
 */
function commentMask(text) {
  const mask = new Uint8Array(text.length)
  let state = 'code'
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; mask[i] = 1; mask[i + 1] = 1; i += 1; continue }
      if (ch === '/' && next === '*') { state = 'block'; mask[i] = 1; mask[i + 1] = 1; i += 1; continue }
      if (ch === "'") { state = 'single'; continue }
      if (ch === '"') { state = 'double'; continue }
      if (ch === '`') { state = 'template'; continue }
      continue
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; continue }
      mask[i] = 1
      continue
    }
    if (state === 'block') {
      mask[i] = 1
      if (ch === '*' && next === '/') { mask[i + 1] = 1; i += 1; state = 'code' }
      continue
    }
    // Inside a string or template literal: only escapes and the closing quote
    // matter, and a comment marker here is just text.
    if (ch === '\\') { i += 1; continue }
    if (state === 'single' && ch === "'") { state = 'code'; continue }
    if (state === 'double' && ch === '"') { state = 'code'; continue }
    if (state === 'template' && ch === '`') { state = 'code'; continue }
  }
  return mask
}

/**
 * Run every detector over one file's text.
 *
 * Returns findings and exemptions separately. Exemptions are reported as well,
 * because an exemption is a judgement the gate made and it should be auditable.
 */
function scanContent(relPath, text) {
  const findings = []
  const exemptions = []
  for (const detector of DETECTORS) {
    for (const hit of detector.find(text)) {
      const line = lineOf(text, hit.index)
      let verdict = { secret: true }
      if (detector.refine) verdict = detector.refine(hit.text)
      if (verdict.exempt) {
        exemptions.push({ detector: detector.id, line, reason: verdict.exempt, sample: redact(hit.text) })
        continue
      }
      const allowed = ALLOWLIST.find((entry) => entry.detector === detector.id && entry.test.test(hit.text))
      if (allowed) {
        exemptions.push({ detector: detector.id, line, reason: `allowlist: ${allowed.reason}`, sample: redact(hit.text) })
        continue
      }
      findings.push({ detector: detector.id, why: detector.why, line, sample: redact(hit.text) })
    }
  }
  return { findings, exemptions }
}

async function collectFiles() {
  const files = []
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(join(dir, entry.name))
      } else if (entry.isFile()) {
        files.push(join(dir, entry.name))
      }
    }
  }
  for (const dir of SCAN_DIRS) {
    if (SKIP_ROOT_DIRS.has(dir)) continue
    const absolute = resolve(repoRoot, dir)
    if (existsSync(absolute)) await walk(absolute)
  }
  for (const file of SCAN_FILES) {
    if (SKIP_ROOT_DIRS.has(file)) continue
    const absolute = resolve(repoRoot, file)
    if (existsSync(absolute)) files.push(absolute)
  }
  return files
    .map((absolute) => relative(repoRoot, absolute).split(sep).join('/'))
    .filter((path) => !SELF_PATHS.has(path))
    .sort()
}

/* ------------------------------------------------------------------ *
 * Self-test
 * ------------------------------------------------------------------ */

/**
 * Build one credential-shaped sample per detector from parts.
 *
 * Nothing here is a working credential, and nothing here is written as a single
 * literal that a future run of this gate would flag.
 */
function buildSyntheticSamples() {
  const base64url = randomBytes(36).toString('base64url')
  return {
    'sk-prefixed-key': `sk-${'a1B2c3D4e5F6g7H8'.repeat(2)}`,
    'bearer-token': `Bearer ${base64url}`,
    'aws-access-key-id': `AKIA${'Q7Z3M9PLK2W8XCV1'}`,
    'api-key-assignment': `api_key: "${'N9qL2vRt7Xw4Bz6M1'}"`,
    'opaque-base64url-run': base64url,
  }
}

async function selfTest() {
  const problems = []
  const samples = buildSyntheticSamples()

  for (const detector of DETECTORS) {
    const sample = samples[detector.id]
    if (sample === undefined) {
      problems.push(`no synthetic sample for detector '${detector.id}' — the self-test would be vacuous`)
      continue
    }
    const direct = detector.find(sample)
    if (direct.length === 0) {
      problems.push(`detector '${detector.id}' did not match its own synthetic sample`)
      continue
    }
    // The pipeline matters too: a detector that fires but is then filtered out
    // would give a scanner that reports nothing.
    const { findings } = scanContent('<synthetic>', sample)
    if (!findings.some((finding) => finding.detector === detector.id)) {
      problems.push(`the scan pipeline suppressed detector '${detector.id}' on its synthetic sample`)
    }
  }

  return problems
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const problems = await selfTest()
  if (problems.length > 0) {
    for (const problem of problems) fail(NAME, `self-test: ${problem}`)
    process.stderr.write(`FAIL ${NAME}: the scanner failed its own self-test\n`)
    return
  }
  process.stdout.write(
    `self-test: ${DETECTORS.length} detectors fired on ${DETECTORS.length} synthetic credential(s) generated at run time\n`,
  )

  const files = await collectFiles()
  const findings = []
  const exemptions = []
  const envReads = []
  const commentMentions = []

  for (const relPath of files) {
    const text = await readFile(resolve(repoRoot, relPath), 'utf8')
    process.stdout.write(`scanned ${relPath}\n`)

    const result = scanContent(relPath, text)
    for (const finding of result.findings) findings.push({ path: relPath, ...finding })
    for (const exemption of result.exemptions) exemptions.push({ path: relPath, ...exemption })

    // The credential service, not the environment, is this plugin's secret
    // source; a `process.env` read would bypass revocation and leak the value
    // into every child process.
    if (relPath.startsWith('host/') || relPath.startsWith('client/')) {
      const mask = commentMask(text)
      const pattern = /\bprocess\s*\.\s*env\b/g
      let match
      while ((match = pattern.exec(text)) !== null) {
        const where = `${relPath}:${lineOf(text, match.index)}`
        // A mention in a comment is documentation, not a read.
        if (mask[match.index] === 1) commentMentions.push(where)
        else envReads.push(where)
      }
    }
  }

  const byReason = new Map()
  for (const exemption of exemptions) {
    const group = byReason.get(exemption.reason) ?? { count: 0, paths: new Set() }
    group.count += 1
    group.paths.add(exemption.path)
    byReason.set(exemption.reason, group)
  }
  for (const [reason, group] of byReason) {
    const paths = [...group.paths].sort().join(', ')
    process.stdout.write(`exempt [${reason}] ${group.count} occurrence(s) in ${paths}\n`)
  }
  for (const where of commentMentions) {
    process.stdout.write(`exempt [process.env mentioned in a comment, not a read] ${where}\n`)
  }
  process.stdout.write(
    `allowlist: ${ALLOWLIST.length} entr${ALLOWLIST.length === 1 ? 'y' : 'ies'}, ${exemptions.length} exemption(s) considered\n`,
  )

  if (findings.length > 0) {
    for (const finding of findings) {
      fail(NAME, `possible secret in ${finding.path}:${finding.line} [${finding.detector}] ${finding.why} — ${finding.sample}`)
    }
  }
  if (envReads.length > 0) {
    fail(NAME, `process.env read in the plugin (secrets must come from the credential service): ${envReads.join(', ')}`)
  }

  if (findings.length > 0 || envReads.length > 0) {
    process.stderr.write(`FAIL ${NAME}: ${findings.length} finding(s), ${envReads.length} environment read(s)\n`)
    return
  }

  ok(NAME, `${files.length} file(s) scanned, 0 findings, 0 process.env reads, ${exemptions.length} exemption(s)`)
}

// The detectors are exported so an independent caller can re-check them against
// its own sample; the scan itself still runs whenever this file is the entry
// point, which is the only way the gate is invoked. Running the module as a
// library must not silently scan the repository.
export { DETECTORS, ALLOWLIST, scanContent, commentMask, selfTest, buildSyntheticSamples }

const invokedPath = process.argv[1]
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  await main()
}
