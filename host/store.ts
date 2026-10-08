/**
 * Durable state: the frozen baseline, the ledger snapshot, and an append-only
 * audit trail.
 *
 * ## Why three files instead of one
 *
 * They have different lifetimes, and collapsing them would lose the property
 * that makes each one useful:
 *
 * - `baseline.json` is **write-once**. Freezing it with `O_EXCL` is what makes
 *   "frozen" a fact about the filesystem rather than a promise in a comment; a
 *   second freeze attempt is refused rather than absorbed.
 * - `ledger.json` is a **rewritten snapshot**. It is the resumable state, and it
 *   is debounced because a chatty gate must not turn a chatty model into a
 *   chatty disk.
 * - `events.jsonl` is **append-only and never rewritten**. A snapshot can be
 *   rewritten by whoever holds the pen; an append-only log cannot be edited
 *   without that edit being visible. This is the file a person reads afterwards.
 *
 * ## Failures are reported, not swallowed
 *
 * Every write result lands in `problems` and is surfaced by `jev_status`. A gate
 * whose own bookkeeping silently stopped working is worse than no gate, because
 * it keeps producing confident verdicts against state it is no longer recording.
 */

import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { baselineIntegrity } from './baseline.ts'
import { LEDGER_SCHEMA_VERSION, type Baseline, type LedgerSnapshot } from './types.ts'
import { underWorkspace } from './workspace.ts'

/** Age at which a write is flushed even if the debounce keeps being reset. */
const MAX_DEBOUNCE_STREAK = 10

export interface StoreOptions {
  readonly workspace: string
  readonly stateDir: string
  readonly debounceMs: number
  readonly persistEnabled: boolean
}

export class LedgerStore {
  readonly dir: string
  readonly baselineFile: string
  readonly ledgerFile: string
  readonly eventsFile: string

  /** Non-fatal bookkeeping failures, newest last. Surfaced by `jev_status`. */
  readonly problems: string[] = []

  private timer: ReturnType<typeof setTimeout> | null = null
  private streak = 0
  private pending: LedgerSnapshot | null = null
  private chain: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(private readonly options: StoreOptions) {
    this.dir = underWorkspace(options.workspace, options.stateDir)
    this.baselineFile = join(this.dir, 'baseline.json')
    this.ledgerFile = join(this.dir, 'ledger.json')
    this.eventsFile = join(this.dir, 'events.jsonl')
  }

  private note(message: string): void {
    this.problems.push(message)
    if (this.problems.length > 32) this.problems.splice(0, this.problems.length - 32)
  }

  async ensureDir(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true })
    } catch (error) {
      this.note(`无法创建状态目录 ${this.dir}：${(error as Error).message}`)
    }
  }

  /* ---------------------------------------------------------------- *
   * Baseline: written once, verified on every read
   * ---------------------------------------------------------------- */

  /**
   * Freeze a baseline. Refuses to overwrite, because an editable baseline makes
   * every earlier verdict retroactively meaningless.
   */
  async freezeBaseline(baseline: Baseline): Promise<{ ok: boolean; reason: string | null }> {
    await this.ensureDir()
    const text = `${JSON.stringify(baseline, null, 2)}\n`
    try {
      await writeFile(this.baselineFile, text, { flag: 'wx' })
      return { ok: true, reason: null }
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'EEXIST') {
        return { ok: false, reason: `基线已经冻结过（${this.baselineFile} 已存在），本次没有覆盖它。` }
      }
      this.note(`冻结基线失败：${(error as Error).message}`)
      return { ok: false, reason: `冻结基线失败：${(error as Error).message}` }
    }
  }

  /** Read the frozen baseline, reporting tampering rather than hiding it. */
  async loadBaseline(): Promise<Baseline | null> {
    const text = await readText(this.baselineFile)
    if (text === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this.note(`基线文件不是合法 JSON（${this.baselineFile}）：${(error as Error).message}`)
      return null
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.note(`基线文件结构不对（${this.baselineFile}）。`)
      return null
    }
    const baseline = parsed as Baseline
    if (typeof baseline.digest !== 'string' || !Array.isArray(baseline.items)) {
      this.note(`基线文件缺少 digest/items（${this.baselineFile}）。`)
      return null
    }
    const integrity = baselineIntegrity(baseline)
    if (!integrity.ok) {
      // Judging against a baseline that was edited behind the gate's back would
      // make every verdict that follows a fiction. The honest answer is "there is
      // no usable frozen scope" — `baseline-unfrozen` — which is also what
      // `baseline.ts` documents this mismatch to mean. The file is left on disk
      // untouched so a human can see what happened.
      if (integrity.reason !== null) this.note(integrity.reason)
      return null
    }
    return baseline
  }

  /* ---------------------------------------------------------------- *
   * Ledger snapshot: debounced
   * ---------------------------------------------------------------- */

  schedule(snapshot: LedgerSnapshot): void {
    if (!this.options.persistEnabled || this.disposed) return
    this.pending = snapshot
    this.streak += 1
    if (this.timer !== null) clearTimeout(this.timer)
    if (this.streak >= MAX_DEBOUNCE_STREAK || this.options.debounceMs <= 0) {
      void this.flush()
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.options.debounceMs)
    // A pending timer must not keep the process alive by itself.
    this.timer.unref?.()
  }

  /** Write the pending snapshot now. Safe to call concurrently. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.streak = 0
    const snapshot = this.pending
    this.pending = null
    if (snapshot === null || !this.options.persistEnabled) return
    await this.enqueue(async () => {
      await this.ensureDir()
      const body = `${JSON.stringify(snapshot, null, 2)}\n`
      const temporary = `${this.ledgerFile}.tmp`
      try {
        await writeFile(temporary, body, 'utf8')
        await rename(temporary, this.ledgerFile)
      } catch (error) {
        // Windows refuses a rename over an open target. The payload is already
        // on disk, so an in-place overwrite is content-equivalent.
        try {
          await writeFile(this.ledgerFile, body, 'utf8')
          await rm(temporary, { force: true })
        } catch (fallbackError) {
          this.note(`写账本失败：${(fallbackError as Error).message}`)
        }
      }
    })
  }

  async loadSnapshot(): Promise<LedgerSnapshot | null> {
    const text = await readText(this.ledgerFile)
    if (text === null) return null
    try {
      const parsed = JSON.parse(text) as LedgerSnapshot
      if (typeof parsed !== 'object' || parsed === null) return null
      if (parsed.schemaVersion !== LEDGER_SCHEMA_VERSION) {
        this.note(
          `账本 schemaVersion 是 ${String(parsed.schemaVersion)}，本插件期望 ${LEDGER_SCHEMA_VERSION}，已忽略旧账本。`,
        )
        return null
      }
      return parsed
    } catch (error) {
      this.note(`账本文件不是合法 JSON：${(error as Error).message}`)
      return null
    }
  }

  /* ---------------------------------------------------------------- *
   * Append-only audit trail
   * ---------------------------------------------------------------- */

  /**
   * Append one line to the audit trail.
   *
   * Never rewritten and never rotated: the whole value of this file is that a
   * reader can trust it was not edited in place. It is also the one write that
   * is *not* debounced, because an intervention that is not yet on disk is an
   * intervention nobody can review afterwards.
   */
  async appendEvent(kind: string, payload: unknown): Promise<void> {
    if (!this.options.persistEnabled || this.disposed) return
    const line = `${JSON.stringify({ at: Date.now(), kind, payload })}\n`
    await this.enqueue(async () => {
      await this.ensureDir()
      try {
        await appendFile(this.eventsFile, line, 'utf8')
      } catch (error) {
        this.note(`写审计日志失败：${(error as Error).message}`)
      }
    })
  }

  /** Serialize writes so two flushes cannot interleave. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(task, task)
    return this.chain
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.flush()
    await this.chain
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * One store per workspace
 * ------------------------------------------------------------------ */

/**
 * A workspace → `LedgerStore` map, created on first use.
 *
 * A single host process can serve more than one workspace (a session whose cwd
 * changed, two profiles sharing a daemon). Binding the store at `apply()` time
 * would silently write one project's ledger into another project's directory —
 * and because the audit trail is the artefact a person reads afterwards, that is
 * exactly the kind of mistake that is discovered too late. So the store is
 * resolved from the *caller's* workspace instead.
 *
 * Each workspace keeps its own `problems`; the aggregate tags every line with
 * the state directory it came from, so a failure is never reported without
 * saying whose failure it is.
 */
export class LedgerStoreHub {
  private readonly stores = new Map<string, LedgerStore>()

  constructor(private readonly options: Omit<StoreOptions, 'workspace'>) {}

  for(workspace: string): LedgerStore {
    const existing = this.stores.get(workspace)
    if (existing !== undefined) return existing
    const created = new LedgerStore({ ...this.options, workspace })
    this.stores.set(workspace, created)
    return created
  }

  /** How many distinct workspaces have been seen. Surfaced by `jev_gate_status`. */
  get size(): number {
    return this.stores.size
  }

  get problems(): string[] {
    const lines: string[] = []
    for (const store of this.stores.values()) {
      for (const problem of store.problems) lines.push(`${store.dir}: ${problem}`)
    }
    return lines
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.stores.values()].map((store) => store.flush()))
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.stores.values()].map((store) => store.dispose()))
  }
}
