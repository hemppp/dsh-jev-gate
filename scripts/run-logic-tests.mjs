#!/usr/bin/env node
/**
 * run-logic-tests.mjs —— host 半（门禁核心）的逻辑门禁。
 *
 * 为什么存在：一个判断错了的门禁比没有门禁更糟。这里把 host/ 里可判定的逻辑
 * 逐条钉在真实源码上——数量、集合、边界、映射、默认姿态——让"悄悄改坏了门禁
 * 的判断"在 `npm run test:logic` 就变红，而不是在用户面前才暴露。
 *
 * 覆盖：catalog 图完整性、未知工具保守兜底、update_task 判别、身份要求、
 * 干预阶梯（floor 不越 ceiling）、severity/label 映射、正文声明识别、
 * NarrativeWatch 缓冲、契约/恢复/修订缺口、证据谓词、配置面与默认姿态。
 *
 * 运行：node scripts/run-logic-tests.mjs
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { assertNonEmpty, bundleHost, fail, importBundle, ok, repoRoot } from './lib/bundle.mjs'

const NAME = 'run-logic-tests'

let passed = 0
let failed = 0

/** 记一条断言：通过则计数；失败打印 FAIL 但不中断，保证一次跑完所有问题。 */
function check(condition, message) {
  if (condition === true) {
    passed += 1
    return true
  }
  failed += 1
  fail(NAME, message)
  return false
}

/** 结构相等（对断言用的纯数据足够，且失败信息可读）。 */
function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 载入一个 host 模块的 bundle：esbuild 打包 + pathToFileURL 导入（Windows 安全）。 */
async function loadHost(entry, name) {
  const out = await bundleHost({ entry, outfile: `.tmp/logic/${name}.mjs` })
  return importBundle(out)
}

const TMP = resolve(repoRoot, '.tmp', 'logic')
await rm(TMP, { recursive: true, force: true })
await mkdir(TMP, { recursive: true })

const catalog = await loadHost('host/catalog.ts', 'catalog')
const types = await loadHost('host/types.ts', 'types')
const intervene = await loadHost('host/intervene.ts', 'intervene')
const config = await loadHost('host/config.ts', 'config')
const narrative = await loadHost('host/narrative.ts', 'narrative')
const contract = await loadHost('host/contract.ts', 'contract')
const evidence = await loadHost('host/evidence.ts', 'evidence')
const matrix = await loadHost('host/matrix.ts', 'matrix')

const RANK = types.LEVEL_RANK

/* ------------------------------------------------------------------ *
 * 1. catalog 图完整性
 * ------------------------------------------------------------------ */

const pointIds = Object.keys(catalog.DECISION_POINTS)
// 决策点数量固定为 14：多一个少一个都会让门禁图与文档/契约快照脱节。
check(pointIds.length === 14, `DECISION_POINTS 应有 14 个决策点，实际 ${pointIds.length}`)

// 每个点的 id 必须等于它在表里的键，否则按 id 查表会静默错位。
const idMismatches = Object.entries(catalog.DECISION_POINTS)
  .filter(([key, point]) => point.id !== key)
  .map(([key, point]) => `${key}!=${point.id}`)
check(idMismatches.length === 0, `决策点 id 与键不一致：${idMismatches.join(', ')}`)

// floor 不得高于 ceiling：否则 clampLevel 的"天花板优先"规则会被写反。
const inverted = pointIds.filter((id) => RANK[catalog.DECISION_POINTS[id].floor] > RANK[catalog.DECISION_POINTS[id].ceiling])
check(inverted.length === 0, `floor 高于 ceiling 的决策点：${inverted.join(', ')}`)

// 未门禁集合必须恰为 {task_dispatch, status_read}——从源码读出，不靠猜。
const ungated = pointIds.filter((id) => catalog.DECISION_POINTS[id].gated === false).sort()
check(
  sameJson(ungated, ['status_read', 'task_dispatch']),
  `未门禁决策点集合应为 [status_read,task_dispatch]，实际 ${JSON.stringify(ungated)}`,
)

// 结构自检必须干净：它正是防止旧的重复 tool 登记问题复发的机制。
const issues = catalog.catalogIssues()
check(Array.isArray(issues) && issues.length === 0, `catalogIssues() 应为空数组，实际 ${JSON.stringify(issues)}`)

// 工具绑定 23 条（9 built-in + 14 plugin）；这是旧版本写错的地方。
check(catalog.TOOL_BINDINGS.length === 23, `TOOL_BINDINGS 应有 23 条，实际 ${catalog.TOOL_BINDINGS.length}`)

// 没有重复 tool：重复条目会让 BY_TOOL 直接抛错（源码里就是硬失败）。
const toolNames = catalog.TOOL_BINDINGS.map((binding) => binding.tool)
check(
  new Set(toolNames).size === toolNames.length,
  `TOOL_BINDINGS 存在重复 tool：${toolNames.filter((t, i) => toolNames.indexOf(t) !== i).join(', ')}`,
)
// team_task_create 必须只登记一次（历史 bug：它被列了两次）。
check(toolNames.filter((t) => t === 'team_task_create').length === 1, 'team_task_create 在 TOOL_BINDINGS 中重复登记')

// 三个声明列表的规模与插件前缀，是监听器与 catalogIssues 的输入。
check(catalog.BUILTIN_TEAM_TOOLS.length === 9, `BUILTIN_TEAM_TOOLS 应有 9 条，实际 ${catalog.BUILTIN_TEAM_TOOLS.length}`)
check(catalog.PLUGIN_TEAM_TOOLS.length === 14, `PLUGIN_TEAM_TOOLS 应有 14 条，实际 ${catalog.PLUGIN_TEAM_TOOLS.length}`)
check(catalog.PLUGIN_MEMBER_TOOLS.length === 4, `PLUGIN_MEMBER_TOOLS 应有 4 条，实际 ${catalog.PLUGIN_MEMBER_TOOLS.length}`)
check(catalog.PLUGIN_PREFIX === 'agent_teams_', `PLUGIN_PREFIX 应为 agent_teams_，实际 ${String(catalog.PLUGIN_PREFIX)}`)

/* ------------------------------------------------------------------ *
 * 2. 未知工具：保守兜底，绝不落到"允许"
 * ------------------------------------------------------------------ */

const unknownBinding = catalog.bindingForCall('agent_teams_totally_new_tool', {})
// 未登记的 agent_teams_* 必须落到"未登记团队动作"这个点，而不是被忽略。
check(unknownBinding === catalog.UNKNOWN_PLUGIN_BINDING, '未登记工具未返回 UNKNOWN_PLUGIN_BINDING 单例')
check(sameJson(unknownBinding.points, ['unknown_team_tool']), `未知工具应落在 unknown_team_tool，实际 ${JSON.stringify(unknownBinding.points)}`)
// 兜底绑定自身必须是门禁的：未知动作是"没人能判断对不对"，不是"安全"。
check(unknownBinding.gated === true, '未知工具兜底 binding 必须是 gated=true（绝不等于 allow）')
check(catalog.DECISION_POINTS.unknown_team_tool.gated === true, 'unknown_team_tool 决策点必须 gated=true')
check(catalog.pointForCall('agent_teams_totally_new_tool', {}) === 'unknown_team_tool', 'pointForCall 对未知工具应返回 unknown_team_tool')
// 非团队名字也走同一条保守兜底（调用方仍需自行决定是否忽略）。
check(catalog.pointForCall('bash', {}) === 'unknown_team_tool', 'pointForCall 对非团队工具应返回 unknown_team_tool')
// toolBindingFor 对未登记名字返回 undefined——它不做兜底，兜底只在 bindingForCall。
check(catalog.toolBindingFor('bash') === undefined, 'toolBindingFor 对未登记名字应返回 undefined')

// 团队工具名判定必须比 catalog 更宽：未登记的 agent_teams_* 仍要被拦。
check(catalog.isTeamToolName('agent_teams_something_new') === true, 'isTeamToolName 必须接受未登记的 agent_teams_* 名字')
check(catalog.isTeamToolName('team_task_create') === true, 'isTeamToolName 必须接受已登记的内置工具名')
check(catalog.isTeamToolName('bash') === false, 'isTeamToolName 必须拒绝非团队工具名')
check(catalog.isTeamToolName('agent_teams') === false, 'isTeamToolName 必须要求 agent_teams_ 前缀（带下划线）')

/* ------------------------------------------------------------------ *
 * 3. update_task 的判别（一个名字两个语义）
 * ------------------------------------------------------------------ */

// verdict 存在即评审结论；否则 status 是完成上报；findings 非空也算评审。
check(catalog.pointForCall('agent_teams_update_task', { verdict: 'pass' }) === 'review_verdict', 'update_task(verdict) 应判为 review_verdict')
check(catalog.pointForCall('agent_teams_update_task', { status: 'completed' }) === 'completion_report', 'update_task(status) 应判为 completion_report')
check(catalog.pointForCall('agent_teams_update_task', {}) === 'completion_report', 'update_task({}) 应回退到 points[0]=completion_report')
check(catalog.pointForCall('agent_teams_update_task', { findings: [] }) === 'completion_report', 'update_task(findings:[]) 空数组不应判为评审')
check(catalog.pointForCall('agent_teams_update_task', { findings: [{ id: 'x' }] }) === 'review_verdict', 'update_task(findings 非空) 应判为 review_verdict')
check(catalog.pointForCall('agent_teams_update_task', { verdict: '', status: '' }) === 'completion_report', 'update_task(空字符串字段) 应回退到 completion_report')
check(catalog.pointForCall('agent_teams_update_task', { verdict: 'pass', status: 'completed' }) === 'review_verdict', 'update_task(verdict 优先于 status) 应判为 review_verdict')
// 内置 team_task_update 共用同一个判别函数，语义必须一致。
check(catalog.pointForCall('team_task_update', { verdict: 'pass' }) === 'review_verdict', '内置 team_task_update(verdict) 应判为 review_verdict')
check(catalog.pointForCall('team_task_update', { status: 'completed' }) === 'completion_report', '内置 team_task_update(status) 应判为 completion_report')
check(catalog.pointForCall('team_task_update', {}) === 'completion_report', '内置 team_task_update({}) 应回退到 completion_report')
// 两个 update 工具的候选点顺序相同，回退行为才可预期。
check(
  sameJson(catalog.bindingForCall('agent_teams_update_task', {}).points, ['completion_report', 'review_verdict']),
  'plugin update_task 的 points 顺序应为 [completion_report, review_verdict]',
)
check(
  sameJson(catalog.bindingForCall('team_task_update', {}).points, ['completion_report', 'review_verdict']),
  'builtin team_task_update 的 points 顺序应为 [completion_report, review_verdict]',
)
// 已登记工具走真实 binding，不能返回兜底单例。
check(catalog.bindingForCall('agent_teams_update_task', {}) !== catalog.UNKNOWN_PLUGIN_BINDING, '已登记工具不得返回未知兜底 binding')

/* ------------------------------------------------------------------ *
 * 4. 身份 / 角色要求
 * ------------------------------------------------------------------ */

const legalRoles = ['captain', 'member', 'any', 'observer']
const illegal = catalog.TOOL_BINDINGS.filter((binding) => !legalRoles.includes(binding.requires))
check(illegal.length === 0, `存在非法 requires 值：${illegal.map((b) => `${b.tool}=${String(b.requires)}`).join(', ')}`)

const captainOnly = catalog.TOOL_BINDINGS.filter((b) => b.requires === 'captain').map((b) => b.tool).sort()
const memberOnly = catalog.TOOL_BINDINGS.filter((b) => b.requires === 'member').map((b) => b.tool).sort()
// 队长专属工具集（源码声明）：改动这个集合等于改动权限模型，必须在测试里可见。
check(
  sameJson(captainOnly, [
    'agent_teams_add_member',
    'agent_teams_amend_task',
    'agent_teams_approve',
    'agent_teams_create',
    'agent_teams_create_task',
    'agent_teams_delete',
    'agent_teams_edit_plan',
    'agent_teams_reassign_task',
    'agent_teams_remove_member',
    'agent_teams_resume',
    'interrupt_agent',
    'spawn_teammate',
    'team_task_create',
  ]),
  `captain-only 工具集不符：${JSON.stringify(captainOnly)}`,
)
// 成员专属工具集：claim/update/send_message 是成员自治的入口。
check(
  sameJson(memberOnly, ['agent_teams_claim_task', 'agent_teams_send_message', 'agent_teams_update_task']),
  `member-only 工具集不符：${JSON.stringify(memberOnly)}`,
)
// 认领任务必须是成员动作：队长认领会与"分派"语义冲突。
check(catalog.bindingForCall('agent_teams_claim_task', {}).requires === 'member', 'agent_teams_claim_task 必须是 member')
// 声明为成员工具的条目不得是 captain-only（catalogIssues 也查这一条）。
check(
  catalog.PLUGIN_MEMBER_TOOLS.every((tool) => catalog.toolBindingFor(tool)?.requires !== 'captain'),
  'PLUGIN_MEMBER_TOOLS 中存在 captain-only 绑定',
)
// 门禁与非门禁绑定的数量：全部门禁会让门禁噪音化，全部放行等于没有门禁。
check(catalog.TOOL_BINDINGS.filter((b) => b.gated).length === 16, 'gated 绑定应为 16 条')
check(catalog.TOOL_BINDINGS.filter((b) => !b.gated).length === 7, '非门禁绑定应为 7 条')

/* ------------------------------------------------------------------ *
 * 5. 干预阶梯：capForMode / decisionKindFor / planLevel
 * ------------------------------------------------------------------ */

const levels = ['L0_ledger', 'L1_note', 'L2_continue', 'L3_deny', 'L4_human']
const modes = ['off', 'dry-run', 'advisory', 'enforce', 'lockdown']

// capForMode 的每个 (档位, 模式) 组合：这是"这个模式最多能做什么"的唯一权威。
const expectCap = (level, mode) => {
  if (mode === 'enforce' || mode === 'lockdown') return level
  if (mode === 'advisory') return level === 'L3_deny' || level === 'L4_human' ? 'L1_note' : level
  return 'L0_ledger'
}
for (const mode of modes) {
  for (const level of levels) {
    check(
      config.capForMode(level, mode) === expectCap(level, mode),
      `capForMode(${level}, ${mode}) 应为 ${expectCap(level, mode)}，实际 ${config.capForMode(level, mode)}`,
    )
  }
}

// 五档 -> 五个决策通道的映射：写反一个就会"警告"变"拦截"。
check(intervene.decisionKindFor('L0_ledger') === 'none', 'L0_ledger 应映射为 none')
check(intervene.decisionKindFor('L1_note') === 'note', 'L1_note 应映射为 note')
check(intervene.decisionKindFor('L2_continue') === 'continue', 'L2_continue 应映射为 continue')
check(intervene.decisionKindFor('L3_deny') === 'deny', 'L3_deny 应映射为 deny')
check(intervene.decisionKindFor('L4_human') === 'ask', 'L4_human 应映射为 ask')

// 只有 enforce/lockdown 允许真的阻断。
for (const mode of modes) {
  const expectedBlocking = mode === 'enforce' || mode === 'lockdown'
  check(
    intervene.blockingAllowed(config.toRuntimeConfig({ mode })) === expectedBlocking,
    `blockingAllowed(${mode}) 应为 ${expectedBlocking}`,
  )
}
for (const mode of modes) {
  const expectedDelivery = mode === 'advisory' || mode === 'enforce' || mode === 'lockdown'
  check(
    config.allowsDelivery(mode) === expectedDelivery,
    `allowsDelivery(${mode}) 应为 ${expectedDelivery}`,
  )
}

const enforceCfg = config.toRuntimeConfig({ mode: 'enforce', enabled: true })
const dryCfg = config.toRuntimeConfig({ mode: 'dry-run' })
const advisoryCfg = config.toRuntimeConfig({ mode: 'advisory' })

const blockerGap = (pointId) => [matrix.makeGap('skeleton', pointId, null, '合成缺口：用于阶梯边界断言')]

for (const pointId of pointIds) {
  const point = catalog.DECISION_POINTS[pointId]
  const gaps = blockerGap(pointId)
  // planned 不得超过该点自己的 ceiling：ceiling 是"这个点最多能走多远"的上限。
  const plannedEnforce = intervene.planLevel({ pointId, status: 'advance', gaps, config: enforceCfg })
  check(
    RANK[plannedEnforce.planned] <= RANK[point.ceiling],
    `planLevel(${pointId}) planned=${plannedEnforce.planned} 超过了 ceiling=${point.ceiling}`,
  )
  // enforce 模式下交付档位不得被降级（配置允许什么就交付什么）。
  check(
    plannedEnforce.delivered === plannedEnforce.planned,
    `enforce 模式下 ${pointId} 的 delivered 不应被降级（planned=${plannedEnforce.planned}, delivered=${plannedEnforce.delivered}）`,
  )
  // dry-run 下天花板恒为 L0_ledger：彩排绝不产生真实动作。
  const plannedDry = intervene.planLevel({ pointId, status: 'advance', gaps, config: dryCfg })
  check(plannedDry.delivered === 'L0_ledger', `dry-run 模式下 ${pointId} 的 delivered 应为 L0_ledger，实际 ${plannedDry.delivered}`)
  // advisory 下 L3/L4 被压到 L1_note，其余不变。
  const plannedAdvisory = intervene.planLevel({ pointId, status: 'advance', gaps, config: advisoryCfg })
  check(
    plannedAdvisory.delivered === expectCap(plannedAdvisory.planned, 'advisory'),
    `advisory 模式下 ${pointId} 的 delivered 应为 ${expectCap(plannedAdvisory.planned, 'advisory')}，实际 ${plannedAdvisory.delivered}`,
  )
}

// "floor 永远不能越过 ceiling"：completion_report 的 floor 是 L1_note，但 dry-run
// 的天花板是 L0_ledger——此时必须保持 L0_ledger，而不是把 floor 抬回来。
const insufficientDry = intervene.planLevel({ pointId: 'completion_report', status: 'insufficient', config: dryCfg })
check(insufficientDry.delivered === 'L0_ledger', `dry-run 下 floor 不得越过 ceiling，实际 ${insufficientDry.delivered}`)
// 同一句话在不设天花板时（enforce）才落到 floor 上。
const insufficientEnforce = intervene.planLevel({ pointId: 'completion_report', status: 'insufficient', config: enforceCfg })
check(insufficientEnforce.planned === 'L1_note' && insufficientEnforce.delivered === 'L1_note', 'insufficient 应计划 L1_note，且 enforce 下如实交付')

// 没有缺口时按 floor 收敛：floor 为 L0 的点不应产生任何提示。
const noneScope = intervene.planLevel({ pointId: 'scope_freeze', status: 'advance', gaps: [], config: enforceCfg })
check(noneScope.planned === 'L0_ledger', `无缺口时 scope_freeze 应为 L0_ledger，实际 ${noneScope.planned}`)
const noneCompletion = intervene.planLevel({ pointId: 'completion_report', status: 'advance', gaps: [], config: enforceCfg })
check(noneCompletion.planned === 'L1_note', `无缺口时 completion_report 应被 floor 抬到 L1_note，实际 ${noneCompletion.planned}`)

// 外部决定者提出"放宽"本身就是一条发现：不得把档位降到"无事发生"。
const loosening = intervene.planLevel({ pointId: 'scope_freeze', status: 'advance', gaps: [], config: enforceCfg, looseningProposed: true })
check(loosening.planned === 'L1_note', `提出放宽时 planned 至少应为 L1_note，实际 ${loosening.planned}`)

// 合成消息里的标签必须真的来自 GAP_LABEL（否则模型看到的是 undefined）。
const message = intervene.composeMessage({
  started: '[jev-gate]',
  pointId: 'completion_report',
  actor: types.UNKNOWN_ACTOR,
  gaps: [matrix.makeGap('skeleton', 'completion_report', null, '合成缺口')],
  itemOrder: [],
  config: enforceCfg,
  level: 'L2_continue',
})
check(!message.includes('undefined'), 'composeMessage 输出里出现了 undefined（GAP_LABEL/ROLE_LABEL 有缺项）')
check(message.includes(types.GAP_LABEL.skeleton), 'composeMessage 应包含缺口的中文标签')
check(intervene.summarizeGaps([]) === '无缺口', 'summarizeGaps([]) 应为「无缺口」')

/* ------------------------------------------------------------------ *
 * 6. severity / label 映射覆盖全部 gap kind
 * ------------------------------------------------------------------ */

// gap kind 共 16 种；任务书写的 17 与源码不符，这里以源码为准。
check(types.GAP_KINDS.length === 16, `GAP_KINDS 应有 16 条，实际 ${types.GAP_KINDS.length}`)
check(new Set(types.GAP_KINDS).size === types.GAP_KINDS.length, 'GAP_KINDS 存在重复项')

const severityMissing = types.GAP_KINDS.filter((kind) => types.GAP_SEVERITY[kind] === undefined)
// 缺 severity 会让 makeGap 产出 undefined 严重度，进而让 rankGaps 静默乱序。
check(severityMissing.length === 0, `GAP_SEVERITY 缺少：${severityMissing.join(', ')}`)
const labelMissing = types.GAP_KINDS.filter((kind) => {
  const label = types.GAP_LABEL[kind]
  return typeof label !== 'string' || label.trim() === ''
})
// 缺 label 会在模型面前显示成 undefined——正文就是模型读的那份文本。
check(labelMissing.length === 0, `GAP_LABEL 缺少或为空：${labelMissing.join(', ')}`)
check(
  types.GAP_KINDS.every((kind) => ['low', 'medium', 'high', 'blocker'].includes(types.GAP_SEVERITY[kind])),
  'GAP_SEVERITY 存在非法严重度',
)
// 两个映射的键集必须恰好等于 GAP_KINDS，多一个键说明有已删除的 kind 残留。
check(
  sameJson(Object.keys(types.GAP_SEVERITY).sort(), [...types.GAP_KINDS].sort()),
  'GAP_SEVERITY 的键集与 GAP_KINDS 不一致',
)
check(
  sameJson(Object.keys(types.GAP_LABEL).sort(), [...types.GAP_KINDS].sort()),
  'GAP_LABEL 的键集与 GAP_KINDS 不一致',
)
// makeGap 必须把 severity 从映射里带出来（不是调用方随手填的）。
check(matrix.makeGap('skeleton', 'completion_report', null, 'x').severity === 'blocker', 'makeGap(skeleton) 的 severity 应为 blocker')
check(matrix.makeGap('unknown-team-tool', 'unknown_team_tool', null, 'x').severity === 'low', 'makeGap(unknown-team-tool) 的 severity 应为 low')

/* ------------------------------------------------------------------ *
 * 7. 正文声明识别
 * ------------------------------------------------------------------ */

// 正例：过去时 + 指名物件的完成声明必须被识别。
const positive = narrative.detectClaims('已完成 host/catalog.ts 的改造。')
check(positive.length === 1, `正例应识别出 1 条声明，实际 ${positive.length}`)
check(positive[0]?.mentionsArtifacts === true, '正例应被标记为提及了具体物件')
check(narrative.isActionableClaim(positive[0]) === true, '提及物件的声明应可行动')

// 反例一：否定句（"还没完成"）——否定优先于肯定。
check(narrative.detectClaims('还没有完成 host/catalog.ts 的重构。').length === 0, '否定句不应被判为完成声明')
// 反例二：未来时/计划（"计划完成"）。
check(narrative.detectClaims('我计划完成 host/catalog.ts 的改造。').length === 0, '未来时/计划句不应被判为完成声明')
// 反例三：疑问句（"已完成了吗？"）。
check(narrative.detectClaims('已完成了吗？').length === 0, '疑问句不应被判为完成声明')
// 反例四：定义句（"「已完成」的定义是…"）。
check(narrative.detectClaims('「已完成」的定义是：把勾选写进清单。').length === 0, '定义句不应被判为完成声明')
// 英文正例：tests pass 也是完成声明。
check(narrative.detectClaims('The tests now pass.').length === 1, '英文 tests pass 应被判为完成声明')

// 不指名物件的声明只是总结：会被识别，但不可行动。
const vague = narrative.detectClaims('已完成改造。')
check(vague.length === 1, `空泛声明应被识别，实际 ${vague.length}`)
check(vague[0]?.mentionsArtifacts === false, '空泛声明不应被标记为提及物件')
check(narrative.isActionableClaim(vague[0]) === false, '不提名物件的声明不应可行动')
// 空文本不产生声明。
check(narrative.detectClaims('').length === 0, '空文本不应产生声明')
// 一次最多 5 条：防止一段话刷屏式触发。
const many = narrative.detectClaims(Array.from({ length: 8 }, (_, i) => `已完成 host/part-${i}.ts 的改造。`).join('\n'))
check(many.length === 5, `声明数量应被限制为 5，实际 ${many.length}`)

/* ------------------------------------------------------------------ *
 * 8. NarrativeWatch 缓冲
 * ------------------------------------------------------------------ */

const watch = new narrative.NarrativeWatch()
watch.append('member-1', '已完成 host/a.ts')
// peek 不消费缓冲（诊断用）。
check(watch.peek('member-1').length === 1, 'peek 应能看到缓冲里的声明')
check(watch.text('member-1') === '已完成 host/a.ts', 'peek 不得消费缓冲')
// take 消费缓冲：同一段正文只判一次。
const taken = watch.take('member-1')
check(taken.length === 1, `take 应返回声明，实际 ${taken.length}`)
check(watch.take('member-1').length === 0, 'take 之后缓冲应被清空（第二次 take 必须返回空）')
check(watch.text('member-1') === '', 'take 之后 text 应为空')

// 未知 key 读空串，不抛错。
check(watch.text('nobody') === '', '未知 key 的 text 应为空字符串')
// 空输入被忽略。
watch.append('member-2', '')
check(watch.text('member-2') === '', '空字符串 append 应被忽略')
// 缓冲有上限：一次塞进 3 倍上限也不能无界增长。
watch.append('member-3', 'x'.repeat(18000))
check(watch.text('member-3').length <= 6000, `缓冲必须被限制在 6000 字符以内，实际 ${watch.text('member-3').length}`)
check(watch.text('member-3').length === 6000, `缓冲应保留尾部 6000 字符，实际 ${watch.text('member-3').length}`)
// reset 丢弃；size 反映活跃 key 数；clear 清空全部。
watch.reset('member-3')
check(watch.text('member-3') === '', 'reset 应丢弃该 key 的缓冲')
watch.append('a', 'x')
watch.append('b', 'y')
check(watch.size === 2, `size 应为 2，实际 ${watch.size}`)
watch.clear()
check(watch.size === 0, 'clear 应清空全部缓冲')

/* ------------------------------------------------------------------ *
 * 9. 契约 / 恢复 / 修订缺口
 * ------------------------------------------------------------------ */

// 质量任务缺 objective/acceptance/verify/inScope = 4 条 contract-incomplete。
const incomplete = contract.contractGaps({ kind: 'implementation' }, 'contract_health')
check(incomplete.length === 4, `缺全部必填字段的 implementation 契约应产生 4 条缺口，实际 ${incomplete.length}`)
check(
  incomplete.every((gap) => gap.kind === 'contract-incomplete'),
  `缺口 kind 应全为 contract-incomplete，实际 ${JSON.stringify(incomplete.map((g) => g.kind))}`,
)
check(incomplete.every((gap) => gap.pointId === 'contract_health'), '缺口应带上被检查的决策点 id')
check(incomplete.every((gap) => gap.severity === 'medium'), 'contract-incomplete 的严重度应为 medium')
// 完整契约不产生缺口。
check(
  contract.contractGaps(
    { kind: 'implementation', objective: '实现 X', acceptance: ['a'], verify: ['node x.mjs'], inScope: ['host/'] },
    'contract_health',
  ).length === 0,
  '完整的 implementation 契约不应产生缺口',
)
// 非质量类任务不适用契约体检。
check(contract.contractGaps({ kind: 'work' }, 'contract_health').length === 0, '非质量类任务不应产生契约缺口')
check(contract.contractGaps({}, 'contract_health').length === 0, '没有 kind 的调用不应产生契约缺口')
// review 任务额外要求 reviewedTaskId：否则不知道在评审谁。
const reviewGap = contract.contractGaps({ kind: 'review', objective: '评审 X', acceptance: ['a'] }, 'review_verdict')
check(reviewGap.length === 1 && reviewGap[0].kind === 'contract-incomplete', 'review 缺 reviewedTaskId 应产生 1 条缺口')

// resume=true 但没有 reason：这是"恢复一个被显式停止的团队"的唯一记录。
const resumeGap = contract.resumeGaps({ resume: true, resumeReason: '' }, 'phase_advance')
check(resumeGap.length === 1 && resumeGap[0].kind === 'advance-without-reason', '空 resumeReason 应产生 advance-without-reason')
check(contract.resumeGaps({ resume: true, resumeReason: '阻塞已修复，继续验证' }, 'phase_advance').length === 0, '有真实原因的 resume 不应产生缺口')
check(contract.resumeGaps({ resume: false }, 'phase_advance').length === 0, 'resume=false 不是恢复动作，不应产生缺口')
check(contract.resumeGaps({}, 'phase_advance').length === 0, '没有 resume 字段不应产生缺口')

// 修订理由过短 = 无法复核授权来源。
const shortAmendment = contract.amendmentGaps({ reason: 'short' }, 'contract_amendment')
check(
  shortAmendment.some((gap) => gap.kind === 'amendment-without-authority'),
  '过短 reason 应产生 amendment-without-authority',
)
check(shortAmendment.every((gap) => gap.severity === 'high'), 'amendment-without-authority 的严重度应为 high')
// 只有 reason 问题时恰好 1 条；空 reason 也是 1 条。
check(contract.amendmentGaps({ reason: 'short', objective: 'x' }, 'contract_amendment').length === 1, '只缺 reason 时应收敛为 1 条缺口')
check(contract.amendmentGaps({ reason: '', objective: 'x' }, 'contract_amendment').length === 1, '空 reason 应为 1 条缺口')
// 没有任何字段被替换的 amend 调用本身也是缺口。
const noFields = contract.amendmentGaps({ reason: '这是一个足够长的理由' }, 'contract_amendment')
check(noFields.length === 1 && noFields[0].kind === 'amendment-without-authority', '没有替换任何契约字段的 amend 应产生 1 条缺口')
// 完整修订不产生缺口。
check(
  contract.amendmentGaps({ reason: '因为原验收条件写错了', objective: 'x' }, 'contract_amendment').length === 0,
  '理由充分且确实替换了字段的 amend 不应产生缺口',
)

/* ------------------------------------------------------------------ *
 * 10. 证据谓词：只认文件，绝不执行命令
 * ------------------------------------------------------------------ */

const probeDir = resolve(TMP, 'probe')
await mkdir(probeDir, { recursive: true })
const probeRel = '.tmp/logic/probe/evidence-probe.md'
await writeFile(
  resolve(probeDir, 'evidence-probe.md'),
  ['export const one = 1', 'export const two = 2', 'export const three = 3', 'export const four = 4', 'export const five = 5', 'export const six = 6', ''].join('\n'),
  'utf8',
)

// 存在路径：checked=true 且 passed=true。
const existsOutcome = await evidence.evaluatePredicate(repoRoot, probeRel)
check(existsOutcome.checked === true, `已存在路径应可判定（checked=true），实际 ${existsOutcome.checked}`)
check(existsOutcome.passed === true, '已存在路径应判定通过')
// exists 前缀写法等价。
const existsKeyword = await evidence.evaluatePredicate(repoRoot, `exists ${probeRel}`)
check(existsKeyword.checked === true && existsKeyword.passed === true, 'exists <path> 写法应判定通过')
// 不存在的路径：可判定但未通过（这是"没有证据"，不是"无法判定"）。
const missingOutcome = await evidence.evaluatePredicate(repoRoot, 'exists .tmp/logic/probe/definitely-missing.md')
check(missingOutcome.checked === true, '缺失路径应可判定（checked=true）')
check(missingOutcome.passed === false, '缺失路径应判定未通过')
// contains：文件里出现过的字符串才算通过。
const containsOutcome = await evidence.evaluatePredicate(repoRoot, `contains ${probeRel} three`)
check(containsOutcome.checked === true && containsOutcome.passed === true, 'contains 命中应判定通过')
const containsMiss = await evidence.evaluatePredicate(repoRoot, `contains ${probeRel} not-present-anywhere`)
check(containsMiss.checked === true && containsMiss.passed === false, 'contains 未命中应判定未通过')
// 命令：门禁拒绝执行，既不是失败也不是通过——checked=false。
const commandOutcome = await evidence.evaluatePredicate(repoRoot, 'npm run test:logic')
check(commandOutcome.checked === false, 'shell 命令必须返回 checked=false（门禁不执行命令）')
check(commandOutcome.passed === false, 'shell 命令不得被判为通过')
check(commandOutcome.detail.includes('不执行命令'), '拒绝执行命令时应说明原因')
const nodeCommand = await evidence.evaluatePredicate(repoRoot, 'node scripts/run-logic-tests.mjs')
check(nodeCommand.checked === false, 'node 命令同样必须返回 checked=false')
// 空条件不可判定。
check((await evidence.evaluatePredicate(repoRoot, '')).checked === false, '空验收条件应返回 checked=false')

/* ------------------------------------------------------------------ *
 * 11. 配置面与默认姿态
 * ------------------------------------------------------------------ */

// 22 个 volatile 字段：浏览器半必须逐个镜像，顺序也要一致。
check(config.VOLATILE_FIELDS.length === 22, `VOLATILE_FIELDS 应有 22 个字段，实际 ${config.VOLATILE_FIELDS.length}`)
check(new Set(config.VOLATILE_FIELDS).size === config.VOLATILE_FIELDS.length, 'VOLATILE_FIELDS 存在重复字段')
// 声明顺序固定：客户端字段顺序与它逐项比对，顺序变了就是两半漂移。
check(
  sameJson(config.VOLATILE_FIELDS, [
    'enabled',
    'mode',
    'onUnavailable',
    'minConfidence',
    'maxGapsPerIntervention',
    'stateDir',
    'persistEnabled',
    'debounceMs',
    'interveneAtStateTransition',
    'interveneAtPreFinish',
    'roleAwareness',
    'narrativeWatch',
    'requireBaseline',
    'deciderKind',
    'deciderProvider',
    'deciderModel',
    'deciderBaseUrl',
    'deciderEndpointPath',
    'deciderCredentialRef',
    'deciderAuthority',
    'deciderMaxQuestions',
    'rulesJson',
  ]),
  `VOLATILE_FIELDS 顺序不符：${JSON.stringify(config.VOLATILE_FIELDS)}`,
)
// 每个 volatile 字段都必须有默认值；否则运行时读到 undefined。
const noDefault = config.VOLATILE_FIELDS.filter((field) => config.DEFAULT_CONFIG[field] === undefined)
check(noDefault.length === 0, `DEFAULT_CONFIG 缺少字段：${noDefault.join(', ')}`)

// 默认姿态：未配置时门禁关闭、模式为彩排——装上插件不该立刻改变任何行为。
const runtimeDefault = config.toRuntimeConfig(undefined)
check(runtimeDefault.enabled === false, `toRuntimeConfig(undefined).enabled 应为 false，实际 ${runtimeDefault.enabled}`)
check(runtimeDefault.mode === 'dry-run', `toRuntimeConfig(undefined).mode 应为 dry-run，实际 ${runtimeDefault.mode}`)
const runtimeEmpty = config.toRuntimeConfig({})
check(runtimeEmpty.enabled === false && runtimeEmpty.mode === 'dry-run', 'toRuntimeConfig({}) 应与默认姿态一致')
// 默认决定者可立即使用：不存在"声明了却没实现"的决定者。
check(runtimeEmpty.unimplementedDecider === null, `默认决定者不应有未实现项，实际 ${String(runtimeEmpty.unimplementedDecider)}`)
check(runtimeEmpty.deciderProblem === null, `默认配置不应有决定者问题，实际 ${String(runtimeEmpty.deciderProblem)}`)
// 已知决定者都会被如实接受。
for (const kind of config.DECIDER_KINDS) {
  const runtime = config.toRuntimeConfig({ deciderKind: kind, deciderCredentialRef: kind === 'endpoint' ? 'MY_GATEWAY_KEY' : '' })
  check(runtime.deciderKind === kind, `deciderKind=${kind} 应被接受，实际 ${runtime.deciderKind}`)
  check(runtime.unimplementedDecider === null, `deciderKind=${kind} 不应被标为未实现`)
}
// 未知决定者退回 baseline 并留下诊断，而不是静默使用。
const unknownDecider = config.toRuntimeConfig({ deciderKind: 'magic' })
check(unknownDecider.deciderKind === 'baseline', '未知 deciderKind 应退回 baseline')
check(typeof unknownDecider.deciderProblem === 'string' && unknownDecider.deciderProblem !== '', '未知 deciderKind 必须留下诊断信息')
// endpoint 缺凭据引用名 = 无法使用，必须显式报错（而不是运行时才炸）。
const endpointNoRef = config.toRuntimeConfig({ deciderKind: 'endpoint' })
check(endpointNoRef.deciderProblem !== null, 'endpoint 决定者缺少 deciderCredentialRef 时必须报问题')
// 凭据引用名是"名字"，不是密钥本身：非法名被拒绝。
check(config.toRuntimeConfig({ deciderKind: 'endpoint', deciderCredentialRef: 'bad name!' }).deciderProblem !== null, '非法凭据引用名必须被拒绝')
// 已知枚举被裁剪到合法值。
check(config.toRuntimeConfig({ mode: 'nonsense' }).mode === 'dry-run', '非法 mode 应退回默认值')
check(config.toRuntimeConfig({ mode: 'enforce' }).mode === 'enforce', '合法 mode 应被接受')
// 数值字段被夹在范围内，而不是接受任意值。
check(config.toRuntimeConfig({ minConfidence: 5 }).minConfidence === 1, 'minConfidence 应上限夹到 1')
check(config.toRuntimeConfig({ minConfidence: -1 }).minConfidence === 0, 'minConfidence 应下限夹到 0')
check(config.toRuntimeConfig({ maxGapsPerIntervention: 999 }).maxGapsPerIntervention === 50, 'maxGapsPerIntervention 应上限夹到 50')

// stateDir 必须留在工作区内：绝对路径与 '..' 都被拒绝并退回默认。
const stateRelative = config.normalizeStateDir('state/gate')
check(stateRelative.dir === 'state/gate' && stateRelative.problem === null, '合法相对 stateDir 应被接受')
check(config.normalizeStateDir('').dir === config.DEFAULT_CONFIG.stateDir, '空 stateDir 应退回默认值')
const stateAbsolute = config.normalizeStateDir('/etc/jev-gate')
check(stateAbsolute.dir === config.DEFAULT_CONFIG.stateDir && stateAbsolute.problem !== null, '绝对 stateDir 必须被拒绝')
const stateEscape = config.normalizeStateDir('../outside')
check(stateEscape.dir === config.DEFAULT_CONFIG.stateDir && stateEscape.problem !== null, "含 '..' 的 stateDir 必须被拒绝")

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

if (failed > 0) {
  process.stderr.write(`FAIL ${NAME}: ${failed} logic assertion(s) failed\n`)
} else {
  const detail = assertNonEmpty(`${passed} assertions passed`, 'assertion count')
  ok(NAME, detail)
}
