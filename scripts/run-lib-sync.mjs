/**
 * dsh-jev-gate — lib freshness gate.
 *
 * `lib/` is what consumers actually load: it is the `tsc` output, it is
 * gitignored, and it ships inside the published package. A previous version of
 * this plugin shipped a `lib/` that had drifted from `host/`, so the code that
 * ran was not the code in the repository. Nothing detected that, because
 * nothing compared the two.
 *
 * This gate compiles `host/` into a throwaway directory and compares the result
 * byte-for-byte against the committed `lib/`. Same file set, same bytes, or the
 * gate fails and names every file that differs. A missing `lib/` is a failure
 * too — "not built yet" must never look like "nothing to check".
 *
 * Run: node scripts/run-lib-sync.mjs
 *
 * @module dsh-jev-gate/scripts/run-lib-sync
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import { fail, ok, repoRoot } from './lib/bundle.mjs'

const NAME = 'run-lib-sync'

const LIB_DIR = resolve(repoRoot, 'lib')
/**
 * The throwaway tree must sit at the **same depth below the repository root** as
 * `lib/` does.
 *
 * `tsc` writes sourcemap `sources` as a path relative to each emitted file, so
 * building into `.tmp/libsync` — one level deeper than `lib/` — shifts every entry
 * by one `../` and makes every `.map` file differ for a reason that has nothing to
 * do with staleness. One level deep, like `lib/`, and the bytes are comparable.
 */
const TMP_DIR = resolve(repoRoot, '.tmp-libsync')
const TSC = resolve(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')

/**
 * Emission extensions that are compared.
 *
 * `declarationMap` is on, so `.d.ts.map` is shipped alongside `.d.ts`; a stale
 * one points editors at the wrong source line, which is the same class of
 * defect as a stale `.js`.
 */
const EMITTED = ['.js', '.d.ts', '.js.map', '.d.ts.map']

function isEmitted(path) {
  return EMITTED.some((extension) => path.endsWith(extension))
}

/** Recursively collect files, returning repo-relative POSIX paths. */
async function collectFiles(dir, base = dir) {
  const found = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await collectFiles(absolute, base)))
    } else if (entry.isFile()) {
      found.push(relative(base, absolute).split(sep).join('/'))
    }
  }
  return found
}

async function main() {
  if (!existsSync(LIB_DIR)) {
    fail(NAME, 'lib/ does not exist — the build must run first (tsc emits lib/); refusing to report freshness for a directory that is not there')
    return
  }
  if (!existsSync(TSC)) {
    fail(NAME, `typescript is not installed at ${relative(repoRoot, TSC).split(sep).join('/')} — run npm install`)
    return
  }

  const libFiles = (await collectFiles(LIB_DIR)).filter(isEmitted).sort()

  let compile
  let compared = []
  try {
    // The output goes to a throwaway tree, never to lib/: this gate observes the
    // build, it does not perform it. `--declarationDir <tmp>/types` mirrors the
    // `lib/types` split, and TMP_DIR sits one level below the repository root
    // exactly like `lib/` does — both matter, because `tsc` records map `sources`
    // relative to each emitted file. Same shape, same depth, comparable bytes.
    await rm(TMP_DIR, { recursive: true, force: true })
    await mkdir(TMP_DIR, { recursive: true })
    compile = spawnSync(
      process.execPath,
      [TSC, '-p', 'tsconfig.json', '--pretty', 'false', '--outDir', TMP_DIR, '--declarationDir', join(TMP_DIR, 'types')],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
    if (compile.error) {
      fail(NAME, `could not run tsc: ${compile.error.message}`)
      return
    }
    if (compile.status !== 0) {
      const diagnostics = `${compile.stdout ?? ''}${compile.stderr ?? ''}`.trim()
      process.stderr.write(`${diagnostics}\n`)
      fail(NAME, `tsc exited ${compile.status}; freshness cannot be certified while the sources do not compile`)
      return
    }

    const builtFiles = (await collectFiles(TMP_DIR)).filter(isEmitted).sort()

    const built = new Set(builtFiles)
    const shipped = new Set(libFiles)
    const missing = builtFiles.filter((path) => !shipped.has(path))
    const extra = libFiles.filter((path) => !built.has(path))
    const differing = []

    for (const path of builtFiles) {
      if (!shipped.has(path)) continue
      const [fresh, stale] = await Promise.all([
        readFile(join(TMP_DIR, path)),
        readFile(join(LIB_DIR, path)),
      ])
      if (!fresh.equals(stale)) differing.push(path)
    }

    compared = builtFiles.filter((path) => shipped.has(path))

    if (missing.length > 0 || extra.length > 0 || differing.length > 0) {
      for (const path of missing) fail(NAME, `lib/${path} is missing (tsc emits it)`)
      for (const path of extra) fail(NAME, `lib/${path} is stale: tsc no longer emits it`)
      for (const path of differing) fail(NAME, `lib/${path} differs from a fresh build`)
      process.stderr.write(
        `FAIL ${NAME}: lib is stale — ${missing.length} missing, ${extra.length} stale-extra, ${differing.length} differing of ${builtFiles.length} emitted file(s); run the build and commit lib/\n`,
      )
      return
    }
  } finally {
    // Every exit path removes the throwaway tree, including the failure paths
    // above and an unexpected throw.
    await rm(TMP_DIR, { recursive: true, force: true })
  }

  ok(NAME, `lib/ matches a fresh tsc build byte-for-byte (${compared.length} file(s) compared)`)
}

await main()
