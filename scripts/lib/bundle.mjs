/**
 * dsh-jev-gate — shared bundling helper for the build gates.
 *
 * The gates need to execute the host TypeScript as real code (not re-implement
 * it) while staying runnable on a machine with no global tooling: this package
 * must never shell out to a globally installed `tsx` / `ts-node`. `esbuild` is
 * already a devDependency of this package, so bundling with it is the one
 * technique that works with nothing but `node` on PATH.
 *
 * Why the dependencies are bundled in rather than marked external: the gate
 * must run *this* package's host code against *this* package's installed
 * dependencies, so what the gate observes is what the package would load.
 * Marking them external would make the result depend on whatever resolution
 * happens to find at run time. Node builtins are the exception — they are
 * supplied by the runtime and must never be inlined.
 *
 * @module dsh-jev-gate/scripts/lib/bundle
 */

import { builtinModules } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from 'esbuild'

/** Absolute path of the package root. This file lives in `scripts/lib/`. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * `builtinModules` yields bare names (`fs`) and, on newer runtimes, some already
 * prefixed ones (`node:test`). Both spellings must be external, because the
 * sources here use `node:` specifiers while dependencies may use the bare form.
 */
const NODE_BUILTINS = [
  ...new Set(builtinModules.flatMap((id) => (id.startsWith('node:') ? [id] : [id, `node:${id}`]))),
]

/** Print the one-line success summary a gate ends with. */
export function ok(name, detail) {
  process.stdout.write(`OK ${name}: ${detail}\n`)
}

/**
 * Report a gate failure and mark the process as failed.
 *
 * Deliberately does not throw: a gate usually has several independent
 * assertions, and reporting all of them is more useful than aborting at the
 * first one. Callers are responsible for not continuing past a failure that
 * makes later work meaningless.
 */
export function fail(name, message) {
  process.stderr.write(`FAIL ${name}: ${message}\n`)
  process.exitCode = 1
}

/**
 * Reject a value that carries no usable content.
 *
 * Used where a check depends on something *extracted* from another file: an
 * extractor that silently returns `undefined` would otherwise turn a missing
 * target into a passing comparison.
 */
export function assertNonEmpty(value, message) {
  const isEmpty =
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  if (isEmpty) throw new Error(message)
  return value
}

/**
 * Bundle one TypeScript entry of this package into a single runnable file.
 *
 * Returns the absolute output path. `platform` / `format` / `external` are
 * parameters because the client-side and host-side entries are not necessarily
 * both Node ESM; the defaults match the host gates.
 */
export async function bundleHost({ entry, outfile, format = 'esm', platform = 'node', external = [] }) {
  const entryPoint = resolve(repoRoot, entry)
  const outFile = resolve(repoRoot, outfile)

  await mkdir(dirname(outFile), { recursive: true })

  await build({
    entryPoints: [entryPoint],
    outfile: outFile,
    bundle: true,
    format,
    platform,
    // `node22` is the floor declared in package.json `engines`.
    target: 'node22',
    // Inline source maps keep a gate failure attributable to the TypeScript
    // line that caused it instead of a generated one.
    sourcemap: 'inline',
    // Resolve `.ts` import specifiers (`./config.ts`) the way the compiler's
    // `rewriteRelativeImportExtensions` setting implies they should be read.
    loader: { '.ts': 'ts' },
    packages: 'bundle',
    external: [...NODE_BUILTINS, ...external],
    logLevel: 'warning',
  })

  return outFile
}

/**
 * Import a bundled file by absolute path.
 *
 * Dynamic `import()` of a bare Windows path fails with
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME` because `F:` parses as a URL scheme, so the
 * path must be converted to a `file://` URL first.
 */
export function importBundle(absolutePath) {
  return import(pathToFileURL(absolutePath).href)
}
