/**
 * dsh-jev-gate — 每个工作区一份运行时。
 *
 * ## 为什么不是「一份账本」
 *
 * 账本、审计日志和冻结的基线，都属于**某一个工作区**。两个会话在两个不同的
 * 项目里工作时共用一份账本，意味着在 A 项目冻结的验收条件会悄悄地去判定 B 项目
 * 的完成报告——那不是「跨团队」，那是「串台」。
 *
 * 所以这里按工作区根目录分区：每个根目录一份 `Ledger` + 一份 `LedgerStore` +
 * 一个 `Gate`，首次被用到时建立，此后随插件同生共死。
 *
 * ## 为什么不需要锁
 *
 * `for()` 是同步的，`load()` 只在第一次真的去读盘，并且把「正在读」这件事也
 * 记在同一张表里——同一个工作区被两个 agent 同时首次触达时，两边拿到的是
 * **同一个**运行时对象，第二次调用直接复用第一次的读盘结果（`loading` 里存的
 * 那个 promise）。
 */

import type { Context } from '@deepseek-ai/cordis'

import type { RuntimeConfig } from './config.ts'
import { Gate } from './gate.ts'
import { Ledger } from './ledger.ts'
import { Roster } from './roster.ts'
import type { LedgerStore, LedgerStoreHub } from './store.ts'

/** Everything one workspace owns. */
export interface WorkspaceRuntime {
  readonly workspace: string
  readonly ledger: Ledger
  readonly store: LedgerStore
  readonly gate: Gate
}

export interface RuntimeHubOptions {
  readonly ctx: Context
  readonly config: RuntimeConfig
  readonly store: LedgerStoreHub
  readonly roster: Roster
  readonly now?: () => number
}

export class RuntimeHub {
  private readonly runtimes = new Map<string, WorkspaceRuntime>()
  private readonly loading = new Map<string, Promise<WorkspaceRuntime>>()

  constructor(private readonly options: RuntimeHubOptions) {}

  /**
   * The runtime for a workspace, without touching the disk.
   *
   * Reading is deliberately *not* part of this: a caller that only needs to
   * record attention must not be able to trigger IO by accident.
   */
  for(workspace: string): WorkspaceRuntime {
    const existing = this.runtimes.get(workspace)
    if (existing !== undefined) return existing

    const ledger = new Ledger()
    const store = this.options.store.for(workspace)
    const gate = new Gate({
      ctx: this.options.ctx,
      config: this.options.config,
      ledger,
      roster: this.options.roster,
      decider: { ctx: this.options.ctx, config: this.options.config },
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    })

    const created: WorkspaceRuntime = { workspace, ledger, store, gate }
    this.runtimes.set(workspace, created)
    return created
  }

  /** The runtime for a workspace, with the persisted baseline and ledger read in. */
  async load(workspace: string): Promise<WorkspaceRuntime> {
    const existing = this.loading.get(workspace)
    if (existing !== undefined) return existing

    const runtime = this.for(workspace)
    const pending = (async (): Promise<WorkspaceRuntime> => {
      // 顺序有讲究：先恢复账本，再装上基线。基线文件是**权威**（写一次、每次读都
      // 校验完整性），账本只是它可以随时重建的一份视图。
      const snapshot = await runtime.store.loadSnapshot()
      if (snapshot !== null) runtime.ledger.restore(snapshot)
      const baseline = await runtime.store.loadBaseline()
      if (baseline !== null) runtime.ledger.setBaseline(baseline)
      return runtime
    })()

    this.loading.set(workspace, pending)
    return pending
  }

  /** How many distinct workspaces have been seen. Surfaced by `jev_gate_status`. */
  get size(): number {
    return this.runtimes.size
  }

  list(): readonly WorkspaceRuntime[] {
    return [...this.runtimes.values()]
  }

  /** Write every workspace's pending snapshot. */
  async flushAll(): Promise<void> {
    await Promise.all(this.list().map((runtime) => runtime.store.flush()))
  }

  async disposeAll(): Promise<void> {
    await Promise.all(this.list().map((runtime) => runtime.store.dispose()))
  }
}
