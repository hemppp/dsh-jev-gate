/**
 * dsh-jev-gate — developer runner for the host entry.
 *
 * `host/index.ts` is the plugin entry: it must export a `name`, an `inject`
 * list, the `Config` schema and an `apply` function, because that is the surface
 * the host loads and the surface the contract check verifies indirectly. This
 * runner bundles that entry the same way the build does, imports it, and prints
 * what it actually exports — so the first thing a developer learns when the
 * entry is wrong is which of the four is missing, without a full build.
 *
 * A missing or broken entry fails loudly here (`entry not found`, or the export
 * that is absent) before a full build is spent on it.
 *
 * Run: node scripts/bundle-run.mjs
 *
 * @module dsh-jev-gate/scripts/bundle-run
 */

import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import { bundleHost, fail, importBundle, ok, repoRoot } from './lib/bundle.mjs'

const NAME = 'bundle-run'

const ENTRY = resolve(repoRoot, 'host', 'index.ts')
const OUT_DIR = resolve(repoRoot, '.tmp', 'bundle-run')
const OUTFILE = join(OUT_DIR, 'index.mjs')

function rel(path) {
  return relative(repoRoot, path).split(sep).join('/')
}

async function main() {
  if (!existsSync(ENTRY)) {
    fail(NAME, `${rel(ENTRY)} does not exist — the host entry has not been written yet, so there is nothing to run`)
    return
  }

  try {
    await mkdir(OUT_DIR, { recursive: true })
    await bundleHost({ entry: ENTRY, outfile: OUTFILE })

    const plugin = await importBundle(OUTFILE)

    const name = plugin.default?.name ?? plugin.name
    const inject = plugin.default?.inject ?? plugin.inject
    const hasConfig = Boolean(plugin.Config ?? plugin.default?.Config)
    const hasApply = Boolean(plugin.apply ?? plugin.default?.apply)

    process.stdout.write(`bundle: ${rel(OUTFILE)}\n`)
    process.stdout.write(`name: ${name === undefined ? '<missing>' : String(name)}\n`)
    process.stdout.write(`inject: ${inject === undefined ? '<missing>' : JSON.stringify(inject)}\n`)
    process.stdout.write(`Config exported: ${hasConfig}\n`)
    process.stdout.write(`apply exported: ${hasApply}\n`)

    const missing = [
      name === undefined ? 'name' : null,
      inject === undefined ? 'inject' : null,
      hasConfig ? null : 'Config',
      hasApply ? null : 'apply',
    ].filter(Boolean)

    if (missing.length > 0) {
      fail(NAME, `the host entry does not export ${missing.join(', ')}`)
      return
    }

    ok(NAME, `${rel(ENTRY)} bundles and exports name/inject/Config/apply`)
  } finally {
    await rm(OUT_DIR, { recursive: true, force: true })
  }
}

await main()
