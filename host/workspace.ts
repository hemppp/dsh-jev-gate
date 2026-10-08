/**
 * Workspace-relative state: where the ledger lives, and how to read the *other*
 * team implementation's state without owning it.
 *
 * ## Reading someone else's state directory
 *
 * `@nanmicoder/dsh-agent-teams` keeps its bookkeeping under
 * `<workspace>/<stateDir>/<teamId>/team.json` and exposes no service for it. Its
 * tool descriptions forbid *the model* from touching those files directly; a
 * host-plane plugin that only ever reads them, and only to answer "who is this
 * caller", is a different thing — and the alternative is worse: a gate that
 * cannot tell a captain from a member cannot gate anything meaningful.
 *
 * Two consequences are load-bearing:
 *
 * - This is a *read*. Nothing here writes, moves or creates anything under the
 *   team state directory; the plugin's own state lives in its own `stateDir`.
 * - Every read is tolerant. There is no schema promise, and the writer falls
 *   back from atomic rename to in-place overwrite on Windows, so a partially
 *   written file is a real possibility. A parse failure is "I could not tell",
 *   never "therefore the caller is a member".
 */

import { readdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

/** The team plugin's own default `stateDir`. */
export const TEAM_STATE_DEFAULT_DIR = '.agent-teams'

/** Directories never worth walking when looking for a relocated state root. */
const SCAN_SKIP = new Set(['node_modules', '.git', 'lib', 'dist', 'build', '.tmp', 'archive'])

/** Bound on the relocation scan, so a huge workspace cannot stall a tool call. */
const SCAN_LIMIT = 200

/* ------------------------------------------------------------------ *
 * Host service seams
 * ------------------------------------------------------------------ */

/**
 * A capability read structurally off a host service.
 *
 * Services are not this plugin's dependencies, so there are no types to import
 * and `instanceof` is unavailable. Structural checks plus a `null` return are
 * how the plugin stays honest: a missing seam and a mis-configured one are
 * reported as different things by the caller.
 */
export function seam<T extends object>(ctx: unknown, name: string, members: readonly string[]): T | null {
  let candidate: unknown
  try {
    const get = (ctx as { get?: unknown } | null)?.get
    if (typeof get !== 'function') return null
    candidate = (get as (this: unknown, key: string) => unknown).call(ctx, name)
  } catch {
    return null
  }
  if (typeof candidate !== 'object' || candidate === null) return null
  const record = candidate as Record<string, unknown>
  for (const member of members) {
    if (typeof record[member] !== 'function') return null
  }
  return candidate as T
}

export interface SessionLike {
  readonly id?: string
  readonly header?: { readonly cwd?: string }
}

export interface SessionsSeam {
  get(id: string): SessionLike | undefined
}

export interface AgentLike {
  readonly id: string
}

export interface AgentsSeam {
  list(): readonly AgentLike[]
  get(id: string): AgentLike | undefined
}

/**
 * The session's working directory, which is what "the workspace" means for
 * every path this plugin resolves. Falls back to the process directory only
 * when the session store genuinely cannot answer — a silent fallback there
 * would point the ledger at the wrong project.
 */
export function workspaceRootOf(sessions: SessionsSeam | null, sessionId: string | null): string {
  if (sessions !== null && sessionId !== null && sessionId !== '') {
    const cwd = sessions.get(sessionId)?.header?.cwd
    if (typeof cwd === 'string' && cwd.trim() !== '') return resolve(cwd)
  }
  return resolve(process.cwd())
}

/* ------------------------------------------------------------------ *
 * Small fs helpers
 * ------------------------------------------------------------------ */

export async function readTextIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

export async function readJsonIfPresent(file: string): Promise<unknown> {
  const text = await readTextIfPresent(file)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export async function listSubdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * Join a workspace-relative, already-validated segment onto the root.
 *
 * Callers pass values that came from `normalizeStateDir` or from a baseline, so
 * the only job here is to keep the result inside the workspace regardless.
 */
export function underWorkspace(root: string, relative: string): string {
  const resolved = resolve(root, relative)
  const prefix = root.endsWith('/') ? root : `${root}/`
  const normalized = resolved.replace(/\\/g, '/')
  if (normalized !== root.replace(/\\/g, '/') && !normalized.startsWith(prefix.replace(/\\/g, '/'))) {
    return resolve(root)
  }
  return resolved
}

/** Path as the ledger reports it: workspace-relative, forward slashes. */
export function relativeDisplay(root: string, absolute: string): string {
  const normalizedRoot = resolve(root).replace(/\\/g, '/')
  const normalized = resolve(absolute).replace(/\\/g, '/')
  if (normalized === normalizedRoot) return '.'
  if (normalized.startsWith(`${normalizedRoot}/`)) return normalized.slice(normalizedRoot.length + 1)
  return normalized
}

/* ------------------------------------------------------------------ *
 * Team-plugin state (read-only)
 * ------------------------------------------------------------------ */

/**
 * The subset of `team.json` this gate reasons about.
 *
 * Every field is optional because the on-disk record carries no version and no
 * schema promise: a field this plugin needs may simply be absent, and that must
 * degrade to "I could not tell" rather than to a thrown parse error.
 */
export interface TeamMemberRecord {
  readonly id?: string
  readonly name?: string
  readonly role?: string
  readonly status?: string
}

export interface TeamTaskRecord {
  readonly id?: string
  readonly subject?: string
  readonly status?: string
  readonly assignee?: string
  readonly kind?: string
  readonly round?: number
  readonly verdict?: string
  readonly dependencies?: readonly string[]
  readonly objective?: string
  readonly acceptance?: readonly string[]
  readonly verify?: readonly string[]
  readonly inScope?: readonly string[]
  readonly reviewedTaskId?: string
  readonly findings?: readonly unknown[]
  readonly revisions?: readonly unknown[]
  readonly acceptanceResults?: readonly unknown[]
  readonly commandsRun?: readonly unknown[]
  readonly output?: string
}

export interface TeamRecord {
  readonly name?: string
  readonly id?: string
  readonly description?: string
  readonly captainSessionId?: string
  readonly members?: readonly TeamMemberRecord[]
  readonly tasks?: readonly TeamTaskRecord[]
  readonly phase?: string
  readonly planReviewState?: string
  readonly approvedAt?: number
  readonly halted?: boolean
  readonly escalated?: boolean
}

/** A successfully located team, plus what the caller is inside it. */
export interface TeamProbe {
  readonly root: string
  readonly teamFile: string
  readonly record: TeamRecord
  readonly teamId: string
  readonly teamName: string
  readonly role: 'captain' | 'member'
  /** Member display name when the caller is a member. */
  readonly memberName: string | null
  /** True when this record came from an `archive/` subdirectory. */
  readonly archived: boolean
}

/** Task statuses that mean "no longer work in progress". */
export const TERMINAL_TASK_STATUSES: readonly string[] = ['completed', 'failed', 'cancelled']

export function isTerminalTask(task: TeamTaskRecord): boolean {
  const status = task.status
  return typeof status === 'string' && TERMINAL_TASK_STATUSES.includes(status)
}

export function openTasks(record: TeamRecord): readonly TeamTaskRecord[] {
  return (record.tasks ?? []).filter((task) => !isTerminalTask(task))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asTeamRecord(value: unknown): TeamRecord | null {
  const record = asRecord(value)
  if (record === null) return null
  // The one field that must exist for the record to identify anybody at all.
  if (typeof record['captainSessionId'] !== 'string') return null
  return record as unknown as TeamRecord
}

/**
 * Candidate state roots, best first.
 *
 * `<workspace>/.agent-teams` is the plugin's documented default and is tried
 * first so the common case costs one `readdir`. If the team plugin's `stateDir`
 * was reconfigured, the fallback walks the workspace's immediate children
 * looking for the same shape (`<candidate>/<teamId>/team.json`). That is a
 * heuristic, and it is bounded, and it is only reached when the default missed.
 */
async function candidateStateRoots(workspace: string): Promise<string[]> {
  const preferred = join(workspace, TEAM_STATE_DEFAULT_DIR)
  const roots = [preferred]

  const children = await listSubdirectories(workspace)
  const extra: string[] = []
  for (const child of children.slice(0, SCAN_LIMIT)) {
    if (SCAN_SKIP.has(child)) continue
    const nested = join(workspace, child)
    const grandchildren = await listSubdirectories(nested)
    if (grandchildren.length === 0) continue
    // Cheap shape test: does any grandchild look like a team directory?
    let looksLikeTeams = false
    for (const grandchild of grandchildren.slice(0, 32)) {
      if (grandchild === 'archive') continue
      const teamFile = join(nested, grandchild, 'team.json')
      if ((await readTextIfPresent(teamFile)) !== null) {
        looksLikeTeams = true
        break
      }
    }
    if (looksLikeTeams) extra.push(nested)
  }

  return [...roots, ...extra]
}

async function probeRoot(root: string, sessionId: string): Promise<TeamProbe | null> {
  const teamDirs = await listSubdirectories(root)
  let captainMatch: TeamProbe | null = null
  let memberMatch: TeamProbe | null = null

  for (const teamDir of teamDirs) {
    // `archive/` holds retired teams and has no `team.json` of its own; the
    // plugin's own live scan relies on the same shape, so this mirrors it.
    if (teamDir === 'archive') continue
    const teamFile = join(root, teamDir, 'team.json')
    const record = asTeamRecord(await readJsonIfPresent(teamFile))
    if (record === null) continue

    const teamId = typeof record.id === 'string' && record.id !== '' ? record.id : teamDir
    const teamName = typeof record.name === 'string' && record.name !== '' ? record.name : teamId

    if (record.captainSessionId === sessionId) {
      captainMatch ??= {
        root,
        teamFile,
        record,
        teamId,
        teamName,
        role: 'captain',
        memberName: null,
        archived: false,
      }
      continue
    }

    const member = (record.members ?? []).find((entry) => entry.id === sessionId && entry.status !== 'removed')
    if (member !== undefined) {
      memberMatch ??= {
        root,
        teamFile,
        record,
        teamId,
        teamName,
        role: 'member',
        memberName: typeof member.name === 'string' && member.name !== '' ? member.name : null,
        archived: false,
      }
    }
  }

  return captainMatch ?? memberMatch
}

/**
 * Find the team this session participates in, across every plausible state root.
 *
 * A captain owns at most one team, so a captain hit wins over a member hit. When
 * nothing matches, the caller learns "not found" — which the roster layer then
 * reports as `outsider` only if a roster source actually answered.
 */
export async function findPluginTeam(workspace: string, sessionId: string): Promise<TeamProbe | null> {
  if (sessionId === '') return null
  for (const root of await candidateStateRoots(workspace)) {
    const probe = await probeRoot(root, sessionId)
    if (probe !== null) return probe
  }
  return null
}

/** The default state root path, exported for diagnostics and tests. */
export function defaultTeamStateRoot(workspace: string): string {
  return join(workspace, TEAM_STATE_DEFAULT_DIR)
}

/** Whether a path plausibly names a team state directory. */
export function looksLikeTeamStateRoot(path: string): boolean {
  return basename(path) === TEAM_STATE_DEFAULT_DIR
}
