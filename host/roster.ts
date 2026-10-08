/**
 * Who is calling.
 *
 * ## Why this is its own layer
 *
 * Two Team implementations are installed side by side and share no state: the
 * harness built-in one (reached through the `agentTeams` Service) and
 * `@nanmicoder/dsh-agent-teams` (reached only through files on disk). Neither is
 * authoritative for the other, and the previous gate ignored both — which meant
 * "a captain approves its own plan" and "a member rewrites the roster" were
 * indistinguishable from correct behaviour.
 *
 * ## Unknown is a finding, not a default
 *
 * When nothing can answer, the role is `unknown`, and `role-unresolved` is
 * recorded. Silently assuming `member` would let a captain's overreach through;
 * silently assuming `captain` would block honest members. Both are worse than
 * saying "I could not tell" and leaving a note.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { PLUGIN_MEMBER_TOOLS, PLUGIN_TEAM_TOOLS, BUILTIN_TEAM_TOOLS } from './catalog.ts'
import { ROLE_LABEL, type ActorRef, type ActorRole, type TeamFlavor } from './types.ts'
import {
  findPluginTeam,
  seam,
  workspaceRootOf,
  type SessionsSeam,
  type TeamProbe,
} from './workspace.ts'

export interface TeamMembershipLike {
  readonly root?: { readonly id?: string }
  readonly id?: string
  readonly role?: 'lead' | 'teammate'
  readonly name?: string
}

export interface TeamMemberViewLike {
  readonly id?: string
  readonly name?: string
  readonly role?: 'lead' | 'teammate'
  readonly status?: string
}

/**
 * The built-in Team service. Only the two read-only role methods are required,
 * so a future version that renames anything else does not disable this seam.
 */
export interface AgentTeamsSeam {
  tryMembership(agent: Agent): TeamMembershipLike | undefined
  listMembers(agent: Agent): readonly TeamMemberViewLike[]
}

/** Everything the gate learned about one caller, plus how it learned it. */
export interface RosterResolution {
  readonly actor: ActorRef
  readonly probe: TeamProbe | null
  /** Model-facing one-liner explaining the identity, shown with a finding. */
  readonly note: string
}

const BUILTIN_TOOL_SET = new Set<string>(BUILTIN_TEAM_TOOLS)
const MEMBER_ONLY_TOOL_SET = new Set<string>(PLUGIN_MEMBER_TOOLS)

/** Whether a tool name belongs to the built-in Team implementation. */
export function isBuiltinTeamTool(name: string): boolean {
  return BUILTIN_TOOL_SET.has(name)
}

/**
 * Tools that a member, rather than a captain, is the natural caller of.
 *
 * Used *only* as a last-resort hint when no roster could answer — never to
 * override a roster that did. The plugin's four member tools are authoritative
 * (`PLUGIN_MEMBER_TOOLS`); the built-in two are the ones whose only sensible
 * caller is the agent doing the work.
 */
const MEMBER_LEANING_TOOLS: ReadonlySet<string> = new Set(['team_task_update', 'send_message'])

export function isMemberLeaningTool(name: string): boolean {
  return MEMBER_ONLY_TOOL_SET.has(name) || MEMBER_LEANING_TOOLS.has(name)
}

const UNRESOLVED_NOTE = '无法确定调用方在同一团队中的身份（两个团队实现都没有给出答案）。'

/**
 * Role resolution with a short-lived cache.
 *
 * The cache exists because a single model step can produce several gated calls,
 * and each would otherwise re-read another plugin's state directory. It is
 * deliberately short: joining, leaving, or being removed must become visible
 * quickly, and a stale role is exactly the kind of error this plugin exists to
 * catch.
 */
export class Roster {
  private readonly cache = new Map<string, { at: number; value: RosterResolution }>()

  constructor(private readonly ttlMs: number = 750) {}

  /** Drop every cached answer. Called after any call that could change a roster. */
  invalidate(): void {
    this.cache.clear()
  }

  async resolve(ctx: unknown, agent: Agent | undefined, workspace: string): Promise<RosterResolution> {
    const sessionId = typeof agent?.id === 'string' ? agent.id : ''
    const actorKey = sessionId === '' ? 'unknown' : sessionId
    const now = Date.now()

    const cached = this.cache.get(actorKey)
    if (cached !== undefined && now - cached.at < this.ttlMs) return cached.value

    const builtin = seam<AgentTeamsSeam>(ctx, 'agentTeams', ['tryMembership'])
    const membership = readMembership(builtin, agent)

    let value: RosterResolution
    if (membership !== null) {
      const role: ActorRole = membership.role === 'teammate' ? 'member' : 'captain'
      value = {
        actor: makeActor({
          sessionId,
          actorKey,
          name: typeof membership.name === 'string' && membership.name !== '' ? membership.name : null,
          role,
          teamId: typeof membership.id === 'string' && membership.id !== '' ? membership.id : null,
          teamName: null,
          flavor: 'builtin',
          provenance: 'builtin-roster',
        }),
        probe: null,
        note: `身份由内置团队名册判定：${ROLE_LABEL[role]}。`,
      }
    } else {
      const probe = sessionId === '' ? null : await findPluginTeam(workspace, sessionId)
      if (probe !== null) {
        value = {
          actor: makeActor({
            sessionId,
            actorKey,
            name: probe.memberName ?? probe.role,
            role: probe.role,
            teamId: probe.teamId,
            teamName: probe.teamName,
            flavor: 'plugin',
            provenance: 'plugin-state',
          }),
          probe,
          note: `身份由团队状态文件判定：在「${probe.teamName}」中是${ROLE_LABEL[probe.role]}。`,
        }
      } else if (builtin !== null) {
        // A roster source answered and said "no team" — that is a fact, not a gap.
        value = {
          actor: makeActor({
            sessionId,
            actorKey,
            name: null,
            role: 'outsider',
            teamId: null,
            teamName: null,
            flavor: null,
            provenance: 'builtin-roster',
          }),
          probe: null,
          note: '内置团队名册明确表示该会话不属于任何团队。',
        }
      } else {
        value = {
          actor: makeActor({
            sessionId,
            actorKey,
            name: null,
            role: 'unknown',
            teamId: null,
            teamName: null,
            flavor: null,
            provenance: 'none',
          }),
          probe: null,
          note: UNRESOLVED_NOTE,
        }
      }
    }

    this.cache.set(actorKey, { at: now, value })
    return value
  }
}

function readMembership(builtin: AgentTeamsSeam | null, agent: Agent | undefined): TeamMembershipLike | null {
  if (builtin === null || agent === undefined) return null
  try {
    const membership = builtin.tryMembership(agent)
    if (typeof membership !== 'object' || membership === null) return null
    return membership
  } catch {
    // A service that answers by throwing is a service we cannot read. Treating
    // that as "no answer" keeps the caller's identity `unknown` rather than
    // silently guessing.
    return null
  }
}

function makeActor(input: {
  sessionId: string
  actorKey: string
  name: string | null
  role: ActorRole
  teamId: string | null
  teamName: string | null
  flavor: TeamFlavor | null
  provenance: ActorRef['provenance']
}): ActorRef {
  return {
    sessionId: input.sessionId === '' ? null : input.sessionId,
    actorKey: input.actorKey,
    name: input.name,
    role: input.role,
    teamId: input.teamId,
    teamName: input.teamName,
    flavor: input.flavor,
    provenance: input.provenance,
  }
}

/** Short, model-facing identity string used in intervention text. */
export function actorLabel(actor: ActorRef): string {
  const who = actor.name ?? actor.sessionId ?? '未知会话'
  return `${who}（${ROLE_LABEL[actor.role]}）`
}

/** Resolve a workspace root without constructing a Roster. */
export function workspaceFor(ctx: unknown, agent: Agent | undefined): string {
  const sessions = seam<SessionsSeam>(ctx, 'sessions', ['get'])
  const sessionId = typeof agent?.id === 'string' ? agent.id : null
  return workspaceRootOf(sessions, sessionId)
}
