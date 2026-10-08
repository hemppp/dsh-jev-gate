import type { DecisionPoint, DecisionPointId, TeamFlavor } from './types.ts'

/**
 * The decision-point graph and the tool vocabulary that reaches it.
 *
 * Why a graph instead of a name table
 * -----------------------------------
 * The previous gate matched four literal tool names, which meant every tool the
 * two Team implementations had in common beyond those four was silently
 * un-gated — the unsafe default. Here, tools are *bindings* to decision points,
 * and the graph is authored once. Consequences that fall out for free:
 *
 * - `agent_teams_resume`, roster edits and ownership changes are covered because
 *   their decision points exist, not because someone remembered to list them.
 * - One decision point can be reached from two different vocabularies (built-in
 *   and plugin) without duplicating judgement logic.
 * - A team tool nobody has catalogued still lands on `unknown-team-tool` instead
 *   of vanishing.
 */

export const DECISION_POINTS: Readonly<Record<DecisionPointId, DecisionPoint>> = {
  scope_freeze: {
    id: 'scope_freeze',
    title: '划定范围并冻结基线',
    claim: '我确认了要做哪些事，以及每件事「做完」长什么样。',
    floor: 'L0_ledger',
    ceiling: 'L3_deny',
    gated: true,
  },
  plan_approval: {
    id: 'plan_approval',
    title: '批准计划并开始执行',
    claim: '这份计划已经被有权的人看过、并且现在开始动真格了。',
    floor: 'L1_note',
    ceiling: 'L3_deny',
    gated: true,
  },
  contract_health: {
    id: 'contract_health',
    title: '登记一条工作契约',
    claim: '这条任务的目标、验收方式和验证手段都写清楚了。',
    floor: 'L0_ledger',
    ceiling: 'L3_deny',
    gated: true,
  },
  roster_change: {
    id: 'roster_change',
    title: '增删团队成员',
    claim: '这次人员变动是队长的决定，而且我知道多了一个/少了一个谁。',
    floor: 'L1_note',
    ceiling: 'L3_deny',
    gated: true,
  },
  ownership_claim: {
    id: 'ownership_claim',
    title: '认领、改派或接管任务',
    claim: '这条任务从此归某个具体的人，别人不会同时在做它。',
    floor: 'L0_ledger',
    ceiling: 'L3_deny',
    gated: true,
  },
  task_dispatch: {
    id: 'task_dispatch',
    title: '派活或催办',
    claim: '我把下一步该做什么传达到了具体的人。',
    floor: 'L0_ledger',
    ceiling: 'L2_continue',
    gated: false,
  },
  completion_report: {
    id: 'completion_report',
    title: '宣布一项工作完成',
    claim: '这件事真的做完了，而且我能指出做完的证据在哪。',
    floor: 'L1_note',
    ceiling: 'L4_human',
    gated: true,
  },
  review_verdict: {
    id: 'review_verdict',
    title: '给出评审结论',
    claim: '我作为评审者，独立地对最新一版实现下了结论。',
    floor: 'L1_note',
    ceiling: 'L4_human',
    gated: true,
  },
  contract_amendment: {
    id: 'contract_amendment',
    title: '修改已登记的契约',
    claim: '原来的契约有错，而且我有权这样改。',
    floor: 'L1_note',
    ceiling: 'L3_deny',
    gated: true,
  },
  phase_advance: {
    id: 'phase_advance',
    title: '推进阶段或恢复团队',
    claim: '上一个阶段的条件已经满足，所以可以往前走。',
    floor: 'L1_note',
    ceiling: 'L3_deny',
    gated: true,
  },
  team_close: {
    id: 'team_close',
    title: '收队或归档',
    claim: '该做的都做完了，没有遗留。',
    floor: 'L1_note',
    ceiling: 'L3_deny',
    gated: true,
  },
  narrative_claim: {
    id: 'narrative_claim',
    title: '用正文宣布结论',
    claim: '（没有经过任何工具）这件事已经完成/已经通过。',
    floor: 'L1_note',
    ceiling: 'L4_human',
    gated: true,
  },
  unknown_team_tool: {
    id: 'unknown_team_tool',
    title: '未登记的团队动作',
    claim: '我用了某个团队动作，但门禁不认识它，所以没人能判断它对不对。',
    floor: 'L0_ledger',
    ceiling: 'L2_continue',
    gated: true,
  },
  status_read: {
    id: 'status_read',
    title: '查看状态',
    claim: '我只是在看，没有改变任何东西。',
    floor: 'L0_ledger',
    ceiling: 'L0_ledger',
    gated: false,
  },
}

export function decisionPoint(id: DecisionPointId): DecisionPoint {
  return DECISION_POINTS[id]
}

/* ------------------------------------------------------------------ *
 * Tool vocabulary
 * ------------------------------------------------------------------ */

/** Built-in Team implementation (`agentTeams` host Service). */
export const BUILTIN_TEAM_TOOLS = [
  'spawn_teammate',
  'team_task_create',
  'team_task_get',
  'team_task_list',
  'team_task_update',
  'list_agents',
  'wait_agent',
  'send_message',
  'interrupt_agent',
] as const

/** `@nanmicoder/dsh-agent-teams` (14 tools, stable business API names). */
export const PLUGIN_TEAM_TOOLS = [
  'agent_teams_create',
  'agent_teams_approve',
  'agent_teams_edit_plan',
  'agent_teams_add_member',
  'agent_teams_remove_member',
  'agent_teams_create_task',
  'agent_teams_reassign_task',
  'agent_teams_claim_task',
  'agent_teams_update_task',
  'agent_teams_amend_task',
  'agent_teams_send_message',
  'agent_teams_status',
  'agent_teams_resume',
  'agent_teams_delete',
] as const

/** Tools a *member* may legitimately call in the plugin implementation. */
export const PLUGIN_MEMBER_TOOLS = [
  'agent_teams_claim_task',
  'agent_teams_update_task',
  'agent_teams_send_message',
  'agent_teams_status',
] as const

/** Namespace that marks a tool as belonging to the plugin implementation. */
export const PLUGIN_PREFIX = 'agent_teams_'

export type RoleRequirement = 'captain' | 'member' | 'any' | 'observer'

export interface ToolBinding {
  readonly tool: string
  readonly flavor: TeamFlavor
  /** Decision points this tool can reach, most specific first. */
  readonly points: readonly DecisionPointId[]
  readonly requires: RoleRequirement
  readonly gated: boolean
  /**
   * Picks the decision point from the call's parsed arguments when a single tool
   * serves more than one. Returning `null` falls back to `points[0]`.
   */
  readonly discriminate?: (args: Readonly<Record<string, unknown>>) => DecisionPointId | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {}
}

/**
 * `agent_teams_update_task` is the one genuinely overloaded tool: a member
 * completing work and a reviewer issuing a verdict arrive through the same
 * name. The verdict field is the discriminator; a bare status change is a
 * completion claim.
 */
function discriminateUpdate(args: Readonly<Record<string, unknown>>): DecisionPointId | null {
  const verdict = args['verdict']
  if (typeof verdict === 'string' && verdict.length > 0) return 'review_verdict'
  const status = args['status']
  if (typeof status === 'string' && status.length > 0) return 'completion_report'
  if (Array.isArray(args['findings']) && args['findings'].length > 0) return 'review_verdict'
  return null
}

const BINDINGS: readonly ToolBinding[] = [
  /* -- built-in ---------------------------------------------------- */
  { tool: 'spawn_teammate', flavor: 'builtin', points: ['roster_change'], requires: 'captain', gated: true },
  { tool: 'team_task_create', flavor: 'builtin', points: ['contract_health'], requires: 'captain', gated: true },
  { tool: 'team_task_get', flavor: 'builtin', points: ['status_read'], requires: 'any', gated: false },
  { tool: 'team_task_list', flavor: 'builtin', points: ['status_read'], requires: 'any', gated: false },
  {
    tool: 'team_task_update',
    flavor: 'builtin',
    points: ['completion_report', 'review_verdict'],
    requires: 'any',
    gated: true,
    discriminate: discriminateUpdate,
  },
  { tool: 'list_agents', flavor: 'builtin', points: ['status_read'], requires: 'any', gated: false },
  { tool: 'wait_agent', flavor: 'builtin', points: ['status_read'], requires: 'any', gated: false },
  { tool: 'send_message', flavor: 'builtin', points: ['task_dispatch'], requires: 'any', gated: false },
  { tool: 'interrupt_agent', flavor: 'builtin', points: ['ownership_claim'], requires: 'captain', gated: true },

  /* -- plugin ------------------------------------------------------ */
  { tool: 'agent_teams_create', flavor: 'plugin', points: ['scope_freeze'], requires: 'captain', gated: true },
  { tool: 'agent_teams_approve', flavor: 'plugin', points: ['plan_approval'], requires: 'captain', gated: true },
  { tool: 'agent_teams_edit_plan', flavor: 'plugin', points: ['phase_advance'], requires: 'captain', gated: true },
  { tool: 'agent_teams_add_member', flavor: 'plugin', points: ['roster_change'], requires: 'captain', gated: true },
  { tool: 'agent_teams_remove_member', flavor: 'plugin', points: ['roster_change'], requires: 'captain', gated: true },
  { tool: 'agent_teams_create_task', flavor: 'plugin', points: ['contract_health'], requires: 'captain', gated: true },
  { tool: 'agent_teams_reassign_task', flavor: 'plugin', points: ['ownership_claim'], requires: 'captain', gated: true },
  { tool: 'agent_teams_claim_task', flavor: 'plugin', points: ['ownership_claim'], requires: 'member', gated: true },
  {
    tool: 'agent_teams_update_task',
    flavor: 'plugin',
    points: ['completion_report', 'review_verdict'],
    requires: 'member',
    gated: true,
    discriminate: discriminateUpdate,
  },
  { tool: 'agent_teams_amend_task', flavor: 'plugin', points: ['contract_amendment'], requires: 'captain', gated: true },
  { tool: 'agent_teams_send_message', flavor: 'plugin', points: ['task_dispatch'], requires: 'member', gated: false },
  { tool: 'agent_teams_status', flavor: 'plugin', points: ['status_read'], requires: 'any', gated: false },
  { tool: 'agent_teams_resume', flavor: 'plugin', points: ['phase_advance'], requires: 'captain', gated: true },
  { tool: 'agent_teams_delete', flavor: 'plugin', points: ['team_close'], requires: 'captain', gated: true },
]

const BY_TOOL = new Map<string, ToolBinding>()
for (const binding of BINDINGS) {
  if (BY_TOOL.has(binding.tool)) {
    throw new Error(`dsh-jev-gate: duplicate tool binding for "${binding.tool}" — the catalog must name each tool exactly once`)
  }
  BY_TOOL.set(binding.tool, binding)
}

export const TOOL_BINDINGS: readonly ToolBinding[] = BINDINGS

export function toolBindingFor(name: string): ToolBinding | undefined {
  return BY_TOOL.get(name)
}

/**
 * Membership test used by the listeners. Deliberately broader than the catalog:
 * an uncatalogued `agent_teams_*` tool is still a team action we must not ignore.
 */
export function isTeamToolName(name: string): boolean {
  if (BY_TOOL.has(name)) return true
  if (name.startsWith(PLUGIN_PREFIX)) return true
  return false
}

/** The synthetic binding used for an uncatalogued tool in the plugin namespace. */
export const UNKNOWN_PLUGIN_BINDING: ToolBinding = {
  tool: '<unknown>',
  flavor: 'plugin',
  points: ['unknown_team_tool'],
  requires: 'any',
  gated: true,
}

export function bindingForCall(name: string, args: unknown): ToolBinding {
  const known = BY_TOOL.get(name)
  if (!known) return UNKNOWN_PLUGIN_BINDING
  return known
}

export function pointForCall(name: string, args: unknown): DecisionPointId {
  const binding = BY_TOOL.get(name)
  if (!binding) return 'unknown_team_tool'
  const record = asRecord(args)
  if (binding.discriminate) {
    const resolved = binding.discriminate(record)
    if (resolved !== null) return resolved
  }
  const first = binding.points[0]
  return first ?? 'unknown_team_tool'
}

/**
 * Structural self-check. `catalogIssues()` returns an empty array when the graph
 * is coherent; the contract-snapshot gate asserts that, so a future edit cannot
 * silently reintroduce the old duplicate-name bug or leave a declared tool
 * without a decision point.
 */
export function catalogIssues(): string[] {
  const issues: string[] = []
  const seen = new Set<string>()

  for (const binding of BINDINGS) {
    if (seen.has(binding.tool)) issues.push(`duplicate binding: ${binding.tool}`)
    seen.add(binding.tool)

    if (binding.points.length === 0) issues.push(`${binding.tool}: no decision point`)
    for (const point of binding.points) {
      if (!(point in DECISION_POINTS)) issues.push(`${binding.tool}: unknown decision point ${point}`)
    }
    if (binding.gated && binding.points.every((point) => !DECISION_POINTS[point].gated)) {
      issues.push(`${binding.tool}: marked gated but every decision point is observational`)
    }
  }

  for (const tool of BUILTIN_TEAM_TOOLS) {
    if (!seen.has(tool)) issues.push(`declared built-in tool has no binding: ${tool}`)
  }
  for (const tool of PLUGIN_TEAM_TOOLS) {
    if (!seen.has(tool)) issues.push(`declared plugin tool has no binding: ${tool}`)
  }
  for (const tool of PLUGIN_MEMBER_TOOLS) {
    const binding = BY_TOOL.get(tool)
    if (!binding) issues.push(`declared member tool has no binding: ${tool}`)
    else if (binding.requires === 'captain') issues.push(`member tool marked captain-only: ${tool}`)
  }

  const declaredFlavor = new Map<string, TeamFlavor>([
    ...BUILTIN_TEAM_TOOLS.map((tool) => [tool, 'builtin'] as const),
    ...PLUGIN_TEAM_TOOLS.map((tool) => [tool, 'plugin'] as const),
  ])
  for (const binding of BINDINGS) {
    const expected = declaredFlavor.get(binding.tool)
    if (expected !== undefined && expected !== binding.flavor) {
      issues.push(`${binding.tool}: flavor ${binding.flavor} disagrees with its declared list (${expected})`)
    }
  }

  return issues
}
