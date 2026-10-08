/**
 * dsh-jev-gate — structural contract gate.
 *
 * What this is for: the defects that shipped in the previous version were not
 * logic bugs, they were *drift*. A declared decider with no implementation, a
 * browser field list that no longer matched the host's volatile set, a decision
 * point the client had never heard of. None of those fail a typecheck, and none
 * of them fail a unit test, because both halves are internally consistent — they
 * only disagree with each other.
 *
 * So this gate executes the real host modules (bundled from source, not
 * re-implemented here) and compares them against the package manifest, the
 * bundle patch and the browser half. Every check is a refusal to let two things
 * that must agree start disagreeing.
 *
 * The browser half is read as text and evaluated in an isolated `node:vm`
 * context with stubbed imports: importing it for real would require a DOM and
 * the harness client runtime, and the point is to inspect what it declares, not
 * to run it.
 *
 * Run: node scripts/run-contract-check.mjs
 *
 * @module dsh-jev-gate/scripts/run-contract-check
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createContext, runInContext, runInNewContext } from 'node:vm'

import { assertNonEmpty, bundleHost, fail, importBundle, ok, repoRoot } from './lib/bundle.mjs'

const NAME = 'run-contract-check'

/** Repo-relative path of the browser half, as declared by `package.json` exports. */
const CLIENT_ENTRY = 'client/index.js'
const CLIENT_ENTRY_ABS = resolve(repoRoot, CLIENT_ENTRY)

/* ------------------------------------------------------------------ *
 * Failure collection
 * ------------------------------------------------------------------ */

const failures = []
const notes = []

function check(label, body) {
  try {
    body()
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assertSameSet(actual, expected, what) {
  const a = [...actual].sort()
  const b = [...expected].sort()
  if (a.join('\u0000') !== b.join('\u0000')) {
    const missing = b.filter((entry) => !a.includes(entry))
    const extra = a.filter((entry) => !b.includes(entry))
    throw new Error(
      `${what} differs — missing: [${missing.join(', ')}]; unexpected: [${extra.join(', ')}]` +
        ` (actual: [${a.join(', ')}], expected: [${b.join(', ')}])`,
    )
  }
}

/* ------------------------------------------------------------------ *
 * Source-text helpers
 *
 * These read JavaScript that is never executed in this process (the browser
 * half) or TypeScript type syntax the compiler erases (the decision-point
 * union). Both must be read structurally — a substring search would happily
 * "find" the name inside a comment.
 * ------------------------------------------------------------------ */

/** Skip a quoted string starting at `start`; returns the index of its closing quote. */
function skipString(code, start) {
  const quote = code[start]
  let i = start + 1
  while (i < code.length) {
    const ch = code[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) return i
    i += 1
  }
  return code.length - 1
}

/**
 * Return the source text of the array/object literal that opens at `start`,
 * or null when the brackets never balance. Strings and comments are skipped so
 * a `]` inside a comment cannot truncate the literal.
 */
function readLiteralAt(code, start) {
  const open = code[start]
  const close = open === '[' ? ']' : '}'
  let depth = 0
  for (let i = start; i < code.length; i += 1) {
    const ch = code[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(code, i)
      continue
    }
    if (ch === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i)
      if (end < 0) return null
      i = end
      continue
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2)
      if (end < 0) return null
      i = end + 1
      continue
    }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return code.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Find a literal assigned to `name` (`const`/`let`/`var`/`exports.` form), but
 * only when the assignment *is* the literal.
 *
 * The strictness matters: `const FIELDS = SPECS.map((spec) => spec.field)`
 * contains no literal of its own, and a looser scan would run on to whatever
 * unrelated bracket appears later in the file and report that as the field
 * list. Returning null here sends the caller to the module-evaluation route.
 */
function findAssignedLiteral(code, name) {
  const declaration = new RegExp(`(?:^|[\\s;{}(])(?:(?:const|let|var)\\s+|exports\\.|module\\.exports\\.)${name}\\s*=`, 'gm')
  let match
  while ((match = declaration.exec(code)) !== null) {
    let i = match.index + match[0].length
    while (i < code.length && /\s/.test(code[i])) i += 1
    // Allow the common wrappers that still yield a data literal.
    for (const wrapper of ['Object.freeze(', 'Object.seal(', 'Object.assign(']) {
      if (code.startsWith(wrapper, i)) {
        i += wrapper.length
        while (i < code.length && /\s/.test(code[i])) i += 1
      }
    }
    const ch = code[i]
    if (ch === '[' || ch === '{') return readLiteralAt(code, i)
  }
  return null
}

/** Evaluate a data literal (array/object of primitives) in an empty context. */
function evalDataLiteral(source) {
  return runInNewContext(`(${source})`, Object.create(null), { timeout: 1000 })
}

/**
 * A stand-in for every module the browser half imports.
 *
 * Any property returns another stub, and stubs are callable/constructible, so
 * module-level destructuring and `class extends` of an imported binding both
 * survive evaluation. Nothing is executed for real — the page is never loaded.
 */
function makeStubRequire() {
  const makeStub = (label) => {
    const target = function stub() {
      return makeStub(`${label}()`)
    }
    return new Proxy(target, {
      get(_target, property) {
        if (property === Symbol.toPrimitive) return () => label
        if (property === 'then') return undefined
        if (property === 'name') return label
        return makeStub(`${label}.${String(property)}`)
      },
      apply() {
        return makeStub(`${label}()`)
      },
      construct() {
        return makeStub(`${label}#new`)
      },
    })
  }
  const cache = new Map()
  return (id) => {
    if (!cache.has(id)) cache.set(id, makeStub(id))
    return cache.get(id)
  }
}

/**
 * Evaluate the browser half in a sandbox and return whatever it exports.
 *
 * The file is a ModuleLoader entry (`window.__ModuleLoader__.load({ factory })`),
 * so the sandbox captures the definition and invokes the factory exactly as the
 * page would. Returns null when the file is not in that shape, which is the
 * caller's signal to fall back to reading declarations out of the text.
 */
function evaluateClientModule(code) {
  let definition = null
  const sandbox = {
    console,
    window: {
      __ModuleLoader__: {
        load: (value) => {
          definition = value
        },
      },
    },
  }
  runInContext(code, createContext(sandbox), { filename: CLIENT_ENTRY, timeout: 5000 })
  if (!definition || typeof definition.factory !== 'function') return null
  const moduleRecord = { exports: {} }
  const produced = definition.factory(makeStubRequire(), moduleRecord, moduleRecord.exports)
  return produced ?? moduleRecord.exports
}

/**
 * Resolve one exported name from the browser half.
 *
 * Literal first (precise and side-effect free), then a real evaluation of the
 * module. Both routes are structural: the literal is parsed, and the evaluation
 * reads the property, so neither can be satisfied by a mention in a comment.
 */
function resolveClientValue(name, code) {
  const literal = findAssignedLiteral(code, name)
  if (literal !== null) {
    try {
      return { value: evalDataLiteral(literal), source: 'literal' }
    } catch {
      /* Not a data literal (functions, spreads) — fall through to evaluation. */
    }
  }
  const exported = evaluateClientModule(code)
  if (exported && Object.prototype.hasOwnProperty.call(exported, name)) {
    return { value: exported[name], source: 'module-eval' }
  }
  // A non-exported `const DECISION_POINTS = {...}` is still evaluable in shape
  // by a final literal pass that ignores the export wrapper.
  const loose = findAllLiterals(code, name)
  if (loose.length === 1) {
    try {
      return { value: evalDataLiteral(loose[0]), source: 'inner-literal' }
    } catch {
      /* unreachable in practice; reported as "not resolvable" below */
    }
  }
  return { value: undefined, source: 'none' }
}

/** Every literal assigned to `name` anywhere in the file (exported or not). */
function findAllLiterals(code, name) {
  const pattern = new RegExp(`\\b${name}\\s*=`, 'g')
  const found = []
  let match
  while ((match = pattern.exec(code)) !== null) {
    let i = match.index + match[0].length
    while (i < code.length && /\s/.test(code[i])) i += 1
    const ch = code[i]
    if (ch === '[' || ch === '{') {
      const literal = readLiteralAt(code, i)
      if (literal !== null) found.push(literal)
    }
  }
  return found
}

/* ------------------------------------------------------------------ *
 * Package-manifest helpers
 * ------------------------------------------------------------------ */

/**
 * Read the bundle patch layer.
 *
 * A purpose-built reader rather than a YAML dependency: the manifest is a
 * sequence of one mapping per row, either at the top level (a profile's own patch
 * file) or nested under a bundle's `insert:` / `replace:` wrapper, and adding a
 * parser dependency to check a file that must not gain dependencies would be
 * self-defeating. Unknown syntax is skipped rather than guessed at, because the
 * checks below only ever ask whether specific keys are present.
 */
function parsePatchEntries(text) {
  const stripComment = (line) => {
    let quote = null
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]
      if (quote) {
        if (ch === '\\') i += 1
        else if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        continue
      }
      if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
    }
    return line
  }

  const scalar = (raw) => {
    const value = raw.trim()
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) return value.slice(1, -1)
    if (value === 'true') return true
    if (value === 'false') return false
    if (value === 'null' || value === '~') return null
    if (value !== '' && !Number.isNaN(Number(value))) return Number(value)
    return value
  }

  /** Split on commas that are outside quotes, brackets and braces. */
  const splitFlow = (text) => {
    const parts = []
    let depth = 0
    let quote = null
    let start = 0
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]
      if (quote !== null) {
        if (ch === '\\') i += 1
        else if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        continue
      }
      if (ch === '[' || ch === '{') depth += 1
      else if (ch === ']' || ch === '}') depth -= 1
      else if (ch === ',' && depth === 0) {
        parts.push(text.slice(start, i))
        start = i + 1
      }
    }
    parts.push(text.slice(start))
    return parts
  }

  /**
   * Read the flow form of a wrapper value: `[{ id: 'x', name: 'y' }]`.
   *
   * Best effort on purpose: the file this reads is ours, and a reader that
   * silently produced an empty row would turn a malformed patch into a passing
   * check. A row it cannot read contributes no keys, so the id/name assertions
   * below report the miss.
   */
  const readFlowRows = (text) => {
    const inner = text.trim().replace(/^\[/, '').replace(/\]$/, '')
    if (inner.trim() === '') return []
    const rows = []
    for (const chunk of splitFlow(inner)) {
      const body = chunk.trim().replace(/^\{/, '').replace(/\}$/, '')
      const row = {}
      for (const pairText of splitFlow(body)) {
        const pair = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*$/.exec(pairText)
        if (pair === null) continue
        row[pair[1]] = scalar(pair[2])
      }
      rows.push(row)
    }
    return rows
  }

  const entries = []
  const stack = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine)
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    let body = line.trim()

    if (body.startsWith('- ') || body === '-') {
      const item = body === '-' ? '' : body.slice(2).trim()
      const wrapper = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(item)
      // A bundle patch declares its rows through an `insert:` / `replace:`
      // wrapper: `- insert:` followed by a nested sequence, or the flow form
      // `- insert: [{ id: …, name: … }]`. The wrapper is not itself a row, so
      // counting it as one makes a perfectly valid patch look like two rows.
      if (wrapper !== null && (wrapper[1] === 'insert' || wrapper[1] === 'replace')) {
        const inline = wrapper[2].trim()
        // Block form: the nested `- ` items below this line are the rows, and the
        // main loop handles each of them exactly like a top-level row.
        if (inline === '') continue
        for (const row of readFlowRows(inline)) entries.push(row)
        continue
      }
      const entry = {}
      entries.push(entry)
      stack.length = 0
      stack.push({ indent, node: entry })
      body = item
      if (body === '') continue
    } else if (entries.length === 0) {
      // A mapping document rather than a sequence: treat it as a single entry.
      const entry = {}
      entries.push(entry)
      stack.push({ indent, node: entry })
    }

    const pair = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(body)
    if (!pair) continue
    const [, key, rawValue] = pair
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop()
    const node = stack[stack.length - 1].node
    if (rawValue.trim() === '') {
      const child = {}
      node[key] = child
      stack.push({ indent: indent + 1, node: child })
    } else {
      node[key] = scalar(rawValue)
    }
  }
  return entries
}

/** Collect every file path an `exports` value ends up pointing at. */
function exportTargets(value, into) {
  if (typeof value === 'string') into.push(value)
  else if (value && typeof value === 'object') for (const nested of Object.values(value)) exportTargets(nested, into)
  return into
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const manifest = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8'))
  const patchEntries = parsePatchEntries(await readFile(resolve(repoRoot, 'cordis.patch.yml'), 'utf8'))
  const typesSource = await readFile(resolve(repoRoot, 'host/types.ts'), 'utf8')

  const clientCode = existsSync(CLIENT_ENTRY_ABS) ? await readFile(CLIENT_ENTRY_ABS, 'utf8') : null

  const catalogModule = await importBundle(
    await bundleHost({ entry: 'host/catalog.ts', outfile: '.tmp/contract/catalog.mjs' }),
  )
  const configModule = await importBundle(
    await bundleHost({ entry: 'host/config.ts', outfile: '.tmp/contract/config.mjs' }),
  )
  const typesModule = await importBundle(await bundleHost({ entry: 'host/types.ts', outfile: '.tmp/contract/types.mjs' }))

  /* -- 1. the catalog's own self-check ---------------------------- */
  check('catalog self-check', () => {
    const issues = catalogModule.catalogIssues()
    assert(Array.isArray(issues), `catalogIssues() did not return an array (got ${typeof issues})`)
    assert(issues.length === 0, `catalogIssues() reported ${issues.length} issue(s): ${issues.join('; ')}`)
  })

  /* -- 2. decision points: declared union vs registered graph ----- */
  check('decision point registry', () => {
    const declared = extractTypeUnion(typesSource, 'DecisionPointId')
    const registered = Object.keys(catalogModule.DECISION_POINTS)
    assert(declared.length > 0, 'could not read the DecisionPointId union out of host/types.ts')
    assertSameSet(registered, declared, 'DECISION_POINTS keys vs the DecisionPointId union')

    for (const [key, point] of Object.entries(catalogModule.DECISION_POINTS)) {
      assert(point.id === key, `DECISION_POINTS['${key}'].id is '${point.id}' — the key and the id must agree`)
    }
  })

  check('decision point ceiling >= floor', () => {
    const rank = typesModule.LEVEL_RANK
    for (const [key, point] of Object.entries(catalogModule.DECISION_POINTS)) {
      assert(rank[point.floor] !== undefined, `${key}: unknown floor '${point.floor}'`)
      assert(rank[point.ceiling] !== undefined, `${key}: unknown ceiling '${point.ceiling}'`)
      assert(
        rank[point.ceiling] >= rank[point.floor],
        `${key}: ceiling ${point.ceiling} is weaker than floor ${point.floor}`,
      )
    }
  })

  /* -- 3. the bundle patch declares exactly one config-free row --- */
  check('cordis.patch.yml row', () => {
    assert(patchEntries.length === 1, `expected exactly one row in cordis.patch.yml, found ${patchEntries.length}`)
    const entry = patchEntries[0]
    assertEqual(entry.id, manifest.name, 'cordis.patch.yml row id vs package.json name')
    assertEqual(entry.name, manifest.name, 'cordis.patch.yml row name vs package.json name')
    // Installing a plugin that can stop team actions must not start stopping
    // them: an empty row means "present, all defaults", i.e. disabled.
    assert(
      !Object.prototype.hasOwnProperty.call(entry, 'config'),
      'cordis.patch.yml row carries a `config` key — installing the plugin would change behaviour',
    )
  })

  /* -- 4. exports and the dsh manifest ---------------------------- */
  check('package.json exports', () => {
    const exportKeys = Object.keys(manifest.exports ?? {})
    assertSameSet(exportKeys, ['.', './client', './cordis.patch.yml', './package.json'], 'package.json exports keys')
    assertEqual(manifest.dsh?.bundle?.patch, './cordis.patch.yml', 'dsh.bundle.patch')
    assertEqual(manifest.dsh?.client?.platform, 'web', 'dsh.client.platform')
  })

  /* -- 5. everything declared as shipped exists ------------------- */
  await checkAsync('declared paths exist', async () => {
    const missing = []
    const deferred = []
    const consider = (label, entry) => {
      if (existsSync(resolve(repoRoot, entry))) return
      // `lib/` is compiler output, not source: it does not exist on a clean
      // checkout, and `npm run gates` runs this gate *before* `npm run build`.
      // Failing here would make the gate impossible to pass from a fresh clone,
      // and it would not add coverage — `run-lib-sync.mjs` runs straight after
      // the build and hard-fails when `lib/` is absent, so build presence and
      // freshness are owned by exactly one gate.
      if (entry === 'lib' || entry.startsWith('lib/') || entry.startsWith('./lib/')) {
        deferred.push(`${label}: ${entry}`)
        return
      }
      missing.push(`${label}: ${entry}`)
    }
    for (const entry of manifest.files ?? []) consider('files', entry)
    for (const target of exportTargets(manifest.exports ?? {}, [])) {
      if (target.startsWith('./')) consider('exports', target)
    }
    // Recorded before the assertion: `assert` throws, and the note is the most
    // useful part of the output precisely when another declared path is missing.
    if (deferred.length > 0) {
      notes.push(`build output absent (checked by run-lib-sync.mjs after the build step): ${deferred.join(', ')}`)
    }
    assert(missing.length === 0, `${missing.length} declared path(s) do not exist: ${missing.join(', ')}`)
  })

  /* -- 6. browser field list vs host volatile field list ---------- */
  check('client FIELDS vs VOLATILE_FIELDS', () => {
    assert(clientCode !== null, `${CLIENT_ENTRY} does not exist`)
    const resolved = resolveClientValue('FIELDS', clientCode)
    assert(
      resolved.value !== undefined,
      `could not resolve FIELDS from ${CLIENT_ENTRY} (tried the assigned literal, then module evaluation)`,
    )
    assert(Array.isArray(resolved.value), `FIELDS is ${typeof resolved.value}, not an array`)
    const fields = resolved.value.map((entry) => String(entry))
    assert(fields.length > 0, 'FIELDS is empty')
    // Order-sensitive on purpose: the form renders these in declaration order,
    // so a reordering is a real (if cosmetic) drift.
    assertEqual(
      fields.join(','),
      configModule.VOLATILE_FIELDS.join(','),
      `FIELDS (via ${resolved.source}) vs host VOLATILE_FIELDS`,
    )
  })

  /* -- 7. no declared decider is unimplemented -------------------- */
  check('decider kinds are implemented', () => {
    const kinds = [...configModule.DECIDER_KINDS]
    const implemented = [...configModule.IMPLEMENTED_DECIDERS]
    const unimplemented = kinds.filter((kind) => !configModule.isImplementedDecider(kind))
    assert(
      unimplemented.length === 0,
      `DECIDER_KINDS declares kind(s) with no implementation: ${unimplemented.join(', ')}`,
    )
    assertSameSet(kinds, implemented, 'DECIDER_KINDS vs IMPLEMENTED_DECIDERS')
  })

  /* -- 8. safe by default ----------------------------------------- */
  check('safe defaults', () => {
    assertEqual(configModule.DEFAULT_CONFIG.enabled, false, 'DEFAULT_CONFIG.enabled')
    assertEqual(configModule.DEFAULT_CONFIG.mode, 'dry-run', 'DEFAULT_CONFIG.mode')
  })

  /* -- 9. the browser's decision-point copy matches the host's ---- */
  check('client DECISION_POINTS vs host', () => {
    assert(clientCode !== null, `${CLIENT_ENTRY} does not exist`)
    const resolved = resolveClientValue('DECISION_POINTS', clientCode)
    assert(
      resolved.value !== undefined,
      `could not resolve DECISION_POINTS from ${CLIENT_ENTRY} — the browser half must expose its copied table`,
    )
    const clientPoints = normalizeDecisionPoints(resolved.value)
    const hostPoints = normalizeDecisionPoints(catalogModule.DECISION_POINTS)
    assert(clientPoints.size > 0, 'the browser DECISION_POINTS table is empty')
    assertSameSet([...clientPoints.keys()], [...hostPoints.keys()], 'client DECISION_POINTS ids vs the host catalog')
    for (const [id, ceiling] of hostPoints) {
      assertEqual(clientPoints.get(id), ceiling, `client ceiling for ${id}`)
    }
  })

  // Notes are judgement calls the check made; print them before the verdict so a
  // reader of a failing run still sees which assertions were deliberately
  // relaxed and why.
  for (const note of notes) process.stdout.write(`NOTE ${NAME}: ${note}\n`)

  if (failures.length > 0) {
    for (const message of failures) fail(NAME, message)
    process.stderr.write(`FAIL ${NAME}: ${failures.length} contract assertion(s) failed\n`)
    return
  }
  ok(
    NAME,
    `9 contract assertions passed (catalog, decision points, bundle row, manifest, paths, FIELDS, deciders, defaults, client table)`,
  )
}

/* ------------------------------------------------------------------ *
 * Check-specific helpers
 * ------------------------------------------------------------------ */

/** Read the members of an exported string-literal union type out of TS source. */
function extractTypeUnion(source, typeName) {
  const match = new RegExp(`export\\s+type\\s+${typeName}\\s*=`).exec(source)
  if (!match) return []
  const members = []
  for (const line of source.slice(match.index + match[0].length).split('\n')) {
    const trimmed = line.trim()
    // The `=` ends its own line, so leading blank lines are part of the shape.
    if (trimmed === '' && members.length === 0) continue
    if (!trimmed.startsWith('|')) break
    for (const literal of trimmed.matchAll(/'([^']*)'|"([^"]*)"/g)) members.push(literal[1] ?? literal[2])
  }
  return members
}

/** Normalize either half's decision-point table to `id -> default ceiling`. */
function normalizeDecisionPoints(value) {
  const out = new Map()
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
        out.set(entry.id, entry.ceiling ?? entry.defaultCeiling ?? null)
      }
    }
    return out
  }
  if (value && typeof value === 'object') {
    for (const [id, entry] of Object.entries(value)) {
      if (typeof entry === 'string') out.set(id, entry)
      else if (entry && typeof entry === 'object') out.set(id, entry.ceiling ?? entry.defaultCeiling ?? null)
      else out.set(id, null)
    }
  }
  return out
}

// `check` is synchronous by design; the one filesystem check is awaited through
// this thin wrapper so a throw inside it is still collected rather than fatal.
async function checkAsync(label, body) {
  try {
    await body()
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
  }
}

await main()
