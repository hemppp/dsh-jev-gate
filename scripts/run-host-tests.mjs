/**
 * dsh-jev-gate — 宿主侧行为测试。
 *
 * 与 `run-logic-tests.mjs` 的分工：那边只钉纯函数，这边把**真实对象装起来、
 * 跑真实场景、看真实结果**——Gate 端到端判定、账本冻结的权威性、持久化往返、
 * `LedgerStoreHub` 的工作区隔离、`RuntimeHub` 的加载语义、角色缺口、
 * 未知团队工具是否照样过闸，以及验收条件判定的「绝不执行命令」。
 *
 * 三条自我约束：
 *
 * 1. 不联网、不调真实模型、不 spawn 任何子进程——`now` 处处注入，判定时刻固定。
 * 2. 所有落盘都发生在 `.tmp/host/` 下，跑完清理；绝不写到仓库外面。
 * 3. 断言是行为性的：装真对象、驱动真场景、看真结果。不写「函数存在」这种烟测，
 *    也不用被测代码的同一个表达式去反推期望值。
 *
 * @module dsh-jev-gate/scripts/run-host-tests
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { assertNonEmpty, bundleHost, fail, importBundle, ok, repoRoot } from './lib/bundle.mjs'

const NAME = 'run-host-tests'
let passed = 0
let failed = 0

/** 记一条断言：通过就计数，不通过就报 FAIL——不中断，好让所有问题一次暴露。 */
function check(condition, message) {
  if (condition === true) {
    passed += 1
    return
  }
  failed += 1
  fail(NAME, message)
}

/** 按 JSON 比较两个值：比 `===` 更能说清「结构一样」。 */
function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** 固定判定时刻，让 `verdict.at` 这类字段可断言。 */
const FIXED_NOW = 1_700_000_000_000
/** 插件默认的状态目录名。 */
const STATE_DIR = '.dsh-jev-gate'
/** 打包产物与临时工作区的根。 */
const TMP = resolve(repoRoot, '.tmp', 'host')
/**
 * 一个「如果被真的执行就会留下痕迹」的文件名。
 *
 * `evaluatePredicate` 若哪天改成走 shell，`node -e …` 那条验收条件就会把它写出来。
 * 它必须永远不存在。
 */
const SPAWN_MARKER = join(repoRoot, 'run-host-tests-spawn-marker.txt')

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

/**
 * 打包一个宿主模块并 import 进来（Windows 上必须走 file:// URL）。
 *
 * `@deepseek-ai/dsh-llm` 必须保持 external：那个包用
 * `createRequire(import.meta.url)('../package.json')` 读它自己的清单，一旦被内联
 * 进 `.tmp/host/`，这个相对路径就会指到不存在的地方。保持 external 之后，Node 从
 * 打包产物所在目录往上找 `node_modules`，拿到的仍是本包真正安装的那一份依赖。
 */
const EXTERNAL_PACKAGES = ['@deepseek-ai/dsh-llm']

async function loadHost(entry, name) {
  const outfile = await bundleHost({
    entry,
    outfile: `.tmp/host/${name}.mjs`,
    external: EXTERNAL_PACKAGES,
  })
  return importBundle(outfile)
}

/** 建一个临时工作区目录。 */
function workspace(name) {
  const dir = join(TMP, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 最小 `ctx` 桩件。
 *
 * 本文件要跑的代码路径（`deciderKind: 'baseline'`）刻意不触摸任何宿主服务，
 * 所以这里对每一次属性访问都**大声抛错**：真要是碰到了，说明这次场景选错了，
 * 而不是悄悄拿到 `undefined` 继续跑出一个假结论。
 */
function makeCtx() {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property === 'symbol') return undefined
        throw new Error(`run-host-tests: 这次不应访问 ctx.${String(property)}（场景选错了）`)
      },
    },
  )
}

const [
  gateMod,
  storeMod,
  runtimeMod,
  ledgerMod,
  baselineMod,
  configMod,
  catalogMod,
  evidenceMod,
  typesMod,
  interveneMod,
] = await Promise.all([
  loadHost('host/gate.ts', 'gate'),
  loadHost('host/store.ts', 'store'),
  loadHost('host/runtime.ts', 'runtime'),
  loadHost('host/ledger.ts', 'ledger'),
  loadHost('host/baseline.ts', 'baseline'),
  loadHost('host/config.ts', 'config'),
  loadHost('host/catalog.ts', 'catalog'),
  loadHost('host/evidence.ts', 'evidence'),
  loadHost('host/types.ts', 'types'),
  loadHost('host/intervene.ts', 'intervene'),
])

const ctx = makeCtx()

/** 一个 captain 身份（`provenance` 说明它来自插件团队状态）。 */
const CAPTAIN = Object.freeze({
  sessionId: 'sess-captain',
  actorKey: 'key-captain',
  name: 'captain',
  role: 'captain',
  teamId: 'team-1',
  teamName: '研究团',
  flavor: 'plugin',
  provenance: 'plugin-team-state',
})

/** 一个 member 身份：与 captain 只差 role。 */
const MEMBER = Object.freeze({ ...CAPTAIN, sessionId: 'sess-member', actorKey: 'key-member', name: 'member', role: 'member' })

/** 一个身份没解析出来的调用方。 */
const UNRESOLVED = Object.freeze({
  ...CAPTAIN,
  sessionId: 'sess-outsider',
  actorKey: 'key-outsider',
  name: 'outsider',
  role: 'unknown',
  provenance: 'none',
})

/**
 * 主场景的冻结基线：三条各自暴露一种「证据缺口」的条目，外加一条完全没有证据的。
 *
 * - `item-impl`：没有任何 acceptance，但调用方声称改过 `item-impl.ts`（不存在）→ 矛盾。
 * - `item-accept`：验收条件是本插件认识的 `exists` 谓词，产物不存在 → 反事实失败。
 * - `item-cmd`：验收条件是一条 shell 命令，本插件不认识 → 只能记成自述。
 * - `item-docs`：既无 acceptance 也无任何证据 → 未上报。
 */
function fixtureBaseline(goal) {
  return baselineMod.createBaseline({
    goal,
    items: [
      // 注意：requirement 里写上自己的 id 不是装饰。gate.ts:339 把验收条件证据的
      // haystack 拼成 `${item.requirement} ${spec}`，而 baseline.ts:239-242 的
      // attributeToItem 只靠 `haystack.includes(item.id)` 归属——requirement 不含 id
      // 时，predicate / 自述证据会全部归属到 null，该行永远停在 unreported。
      {
        id: 'item-impl',
        requirement: 'item-impl：实现 host 侧账本的持久化',
        phase: 'implementation',
        depth: 'declared',
        acceptance: [],
        scope: [],
      },
      {
        id: 'item-accept',
        requirement: 'item-accept：产物 reports/accept.md 必须存在',
        phase: 'verification',
        depth: 'declared',
        acceptance: ['exists reports/accept.md'],
        scope: [],
      },
      {
        id: 'item-cmd',
        requirement: 'item-cmd：跑通门禁命令',
        phase: 'verification',
        depth: 'declared',
        acceptance: ['npm test'],
        scope: [],
      },
      { id: 'item-docs', requirement: 'item-docs：补上文档', phase: null, depth: 'declared', acceptance: [], scope: [] },
    ],
    frozenBy: 'captain',
    frozenAt: FIXED_NOW,
  })
}

/** 主场景里 captain 上报完成时递进去的参数。 */
const COMPLETION_ARGS = Object.freeze({
  task_id: 'item-impl',
  status: 'completed',
  changedPaths: ['item-impl.ts'],
  acceptanceResults: [{ criterion: '实现 host 侧账本的持久化', status: 'passed' }],
})

/** 取一条判定里的缺口种类（排序后），方便整体比较。 */
function kindsOf(verdict) {
  return verdict.matrix.gaps.map((gap) => gap.kind).sort()
}

/** 取某条基线条目的覆盖状态；缺行时返回可读的占位串。 */
function rowStatus(verdict, itemId) {
  const row = verdict.matrix.rows.find((entry) => entry.itemId === itemId)
  return row === undefined ? '<matrix 里没有这一行>' : row.status
}

/** 组装一个只依赖注入时间的 Gate。 */
function makeGate({ config, ledger, now = FIXED_NOW }) {
  return new gateMod.Gate({
    ctx,
    config,
    ledger,
    roster: {},
    decider: { ctx, config },
    now: () => now,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 一、Gate + Ledger 端到端：一条「上报完成、但验收未达成」的判定
// ─────────────────────────────────────────────────────────────────────────────

const dryCfg = configMod.toRuntimeConfig({ mode: 'dry-run', roleAwareness: 'enforce' })
const wsMain = workspace('ws-main')

{
  const baseline = fixtureBaseline('把 host 侧的账本补完')
  const ledger = new ledgerMod.Ledger()
  ledger.setBaseline(baseline)
  const gate = makeGate({ config: dryCfg, ledger })

  const toolName = 'team_task_update'
  // 判定点由工具名 + 参数判别出来，不由调用方随便指定——这是闸口的第一道防线。
  const pointId = catalogMod.pointForCall(toolName, COMPLETION_ARGS)
  check(
    pointId === 'completion_report',
    `team_task_update 带 status 时应判别为 completion_report（观测：${pointId}）`,
  )

  const verdict = await gate.evaluate({
    toolName,
    args: COMPLETION_ARGS,
    actor: CAPTAIN,
    pointId,
    workspace: wsMain,
    probe: null,
  })

  check(verdict.at === FIXED_NOW, `注入的 now 应当成为判定时刻（观测：${verdict.at}）`)
  check(
    typeof verdict.id === 'string' && verdict.id.startsWith('vd-'),
    `判定 id 应当带 vd- 前缀（观测：${verdict.id}）`,
  )
  check(
    verdict.status === 'halt',
    `既有 blocker 缺口，状态就该是 halt（观测：${verdict.status}；缺口：${JSON.stringify(kindsOf(verdict))}）`,
  )
  check(
    verdict.level === 'L0_ledger',
    `dry-run 姿态下交付力度必须削到 L0_ledger（观测：${verdict.level}）`,
  )

  check(
    verdict.matrix.rows.length === 4,
    `矩阵应当为 4 条基线条目各建一行（观测：${verdict.matrix.rows.length}）`,
  )
  const implStatus = rowStatus(verdict, 'item-impl')
  check(
    implStatus === 'contradicted',
    `item-impl 被声称改过的文件不存在，该行必须是 contradicted（观测：${implStatus}）`,
  )
  const acceptStatus = rowStatus(verdict, 'item-accept')
  check(
    acceptStatus === 'contradicted',
    `item-accept 的 exists 谓词判否，该行必须是 contradicted（观测：${acceptStatus}）`,
  )
  const cmdStatus = rowStatus(verdict, 'item-cmd')
  check(
    cmdStatus === 'self-only',
    `item-cmd 的验收条件是 shell 命令、只有自述，该行必须是 self-only（观测：${cmdStatus}）`,
  )
  const docsStatus = rowStatus(verdict, 'item-docs')
  check(
    docsStatus === 'unreported',
    `item-docs 没有任何证据，该行必须是 unreported（观测：${docsStatus}）`,
  )

  const kinds = kindsOf(verdict)
  check(
    sameJson(kinds, ['counterfactual-failed', 'no-evidence', 'skeleton', 'unreported']),
    `缺口种类应当是 (counterfactual-failed,no-evidence,skeleton,unreported)（观测：${JSON.stringify(kinds)}）`,
  )

  const skeleton = verdict.matrix.gaps.find((gap) => gap.kind === 'skeleton')
  check(
    skeleton !== undefined && skeleton.severity === 'blocker',
    `skeleton 缺口的严重度应当是 blocker（观测：${skeleton === undefined ? '缺口不存在' : skeleton.severity}）`,
  )
  const counterfactual = verdict.matrix.gaps.find((gap) => gap.kind === 'counterfactual-failed')
  check(
    counterfactual !== undefined && counterfactual.severity === 'blocker',
    `counterfactual-failed 缺口的严重度应当是 blocker（观测：${
      counterfactual === undefined ? '缺口不存在' : counterfactual.severity
    }）`,
  )

  check(
    verdict.matrix.summary.worstSeverity === 'blocker',
    `矩阵摘要的最坏严重度应当是 blocker（观测：${verdict.matrix.summary.worstSeverity}）`,
  )
  check(
    verdict.matrix.summary.contradicted === 2 && verdict.matrix.summary.selfOnly === 1,
    `矩阵摘要应当数出 2 条矛盾、1 条仅有自述（观测：contradicted=${verdict.matrix.summary.contradicted}, selfOnly=${verdict.matrix.summary.selfOnly}）`,
  )
  check(
    verdict.matrix.summary.coverageRatio === 0,
    `没有任何 A/B 支撑时覆盖率应当是 0——自述不算覆盖（观测：${verdict.matrix.summary.coverageRatio}）`,
  )
  check(
    verdict.confidence.safety === 0.1,
    `blocker 场景的安全置信度应当是 0.1（观测：${verdict.confidence.safety}）`,
  )

  // 判定先记账、后交付：账本里要能看到这次判定与它数出来的缺口。
  check(
    ledger.getVerdicts().length === 1,
    `判定必须落进账本（观测：${ledger.getVerdicts().length} 条）`,
  )
  check(
    ledger.gapCount('skeleton') === 1,
    `账本应当记下一次 skeleton 缺口（观测：${ledger.gapCount('skeleton')}）`,
  )
  check(
    ledger.getAttention().length === 0,
    `L0_ledger 不该产生待办事件（decisionKindFor('L0_ledger') 是 none，观测：${ledger.getAttention().length} 条）`,
  )
  check(
    ledger.getBaseline() !== null && ledger.getBaseline().digest === baseline.digest,
    '账本里保留的基线应当是刚冻结的那一份',
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 二、同一个场景换姿态：力度是被 mode 削出来的，不是判定算出来的
// ─────────────────────────────────────────────────────────────────────────────

{
  /** 同一个场景，只换姿态，跑一次。 */
  async function runWithMode(mode) {
    const cfg = configMod.toRuntimeConfig({ mode })
    const ledger = new ledgerMod.Ledger()
    ledger.setBaseline(fixtureBaseline('把 host 侧的账本补完'))
    const verdict = await makeGate({ config: cfg, ledger }).evaluate({
      toolName: 'team_task_update',
      args: COMPLETION_ARGS,
      actor: CAPTAIN,
      pointId: 'completion_report',
      workspace: wsMain,
      probe: null,
    })
    return verdict
  }

  const advisory = await runWithMode('advisory')
  check(
    advisory.status === 'halt',
    `advisory 不改变判定状态，仍应是 halt（观测：${advisory.status}）`,
  )
  check(
    advisory.level === 'L1_note',
    `advisory 姿态下 L3_deny 必须被削到 L1_note（观测：${advisory.level}）`,
  )

  const enforced = await runWithMode('enforce')
  check(
    enforced.level === 'L3_deny',
    `enforce 姿态下 blocker 场景应当交付 L3_deny（观测：${enforced.level}）`,
  )
  check(
    typesMod.LEVEL_RANK[enforced.level] > typesMod.LEVEL_RANK[advisory.level],
    `同一场景下 enforce 的交付力度必须高于 advisory（观测：enforce=${enforced.level}, advisory=${advisory.level}）`,
  )
  check(
    sameJson(kindsOf(enforced), kindsOf(advisory)),
    `换姿态只削力度，不该改变缺口（观测：enforce=${JSON.stringify(kindsOf(enforced))}, advisory=${JSON.stringify(kindsOf(advisory))}）`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 三、没有基线就是 insufficient：ceiling 压得住 floor
// ─────────────────────────────────────────────────────────────────────────────

{
  // 对全部 14 个决策点：dry-run 下交付力度一律 L0_ledger。
  const ledger = new ledgerMod.Ledger()
  const gate = makeGate({ config: dryCfg, ledger })
  const pointIds = Object.keys(catalogMod.DECISION_POINTS)
  check(
    pointIds.length === 14,
    `决策点应当有 14 个（观测：${pointIds.length}）`,
  )
  for (const pointId of pointIds) {
    const verdict = await gate.evaluate({
      toolName: 'no-such-tool-at-all',
      args: {},
      actor: CAPTAIN,
      pointId,
      workspace: wsMain,
      probe: null,
    })
    check(
      verdict.level === 'L0_ledger',
      `dry-run 下决策点 ${pointId} 的交付力度必须是 L0_ledger（观测：${verdict.level}）`,
    )
  }
}

{
  // completion_report 的 floor 是 L1_note：没有基线时计划力度就是 L1_note，
  // 但 dry-run 的 ceiling 是 L0_ledger——floor 不许把 ceiling 顶回去。
  const ledger = new ledgerMod.Ledger()
  const verdict = await makeGate({ config: dryCfg, ledger }).evaluate({
    toolName: 'team_task_update',
    args: COMPLETION_ARGS,
    actor: CAPTAIN,
    pointId: 'completion_report',
    workspace: wsMain,
    probe: null,
  })
  check(
    verdict.status === 'insufficient',
    `没有冻结基线时状态必须是 insufficient（观测：${verdict.status}）`,
  )
  check(
    verdict.level === 'L0_ledger',
    `completion_report 的 floor 是 L1_note，但 dry-run 的 ceiling 是 L0_ledger——floor 不许把它顶回来（观测：${verdict.level}）`,
  )

  // 同一件事在纯函数层面再钉一次：planned 是 L1_note，delivered 是 L0_ledger。
  const planned = interveneMod.planLevel({
    pointId: 'completion_report',
    status: 'insufficient',
    gaps: [],
    config: dryCfg,
    looseningProposed: false,
  })
  check(
    planned.planned === 'L1_note' && planned.delivered === 'L0_ledger',
    `insufficient 时计划力度 L1_note、交付力度 L0_ledger（观测：planned=${planned.planned}, delivered=${planned.delivered}）`,
  )
  // 同一件事再用 rules 压一次 ceiling 来钉「floor 不许压过 ceiling」：
  // plan_approval 的 floor 是 L1_note，把 ceiling 用 rules 压到 L0_ledger 之后，
  // 计划力度仍然是 L1_note，交付力度必须老老实实停在 L0_ledger。
  const capped = interveneMod.planLevel({
    pointId: 'plan_approval',
    status: 'insufficient',
    gaps: [],
    config: configMod.toRuntimeConfig({
      mode: 'enforce',
      rulesJson: '[{"pointId":"plan_approval","ceiling":"L0_ledger"}]',
    }),
    looseningProposed: false,
  })
  check(
    capped.planned === 'L1_note' && capped.delivered === 'L0_ledger',
    `ceiling 被 rules 压到 L0_ledger 时，floor(L1_note) 不许把它顶回去：planned=L1_note、delivered=L0_ledger（观测：planned=${capped.planned}, delivered=${capped.delivered}）`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 四、决策点自己的 ceiling 决定交付上限
// ─────────────────────────────────────────────────────────────────────────────

{
  const enforceCfg = configMod.toRuntimeConfig({ mode: 'enforce' })
  const ledger = new ledgerMod.Ledger()
  ledger.setBaseline(
    baselineMod.createBaseline({
      goal: 'ceiling 场景的基线',
      items: [
        {
          id: 'item-skeleton',
          requirement: 'item-skeleton：实现',
          phase: null,
          depth: 'declared',
          acceptance: [],
          scope: [],
        },
      ],
      frozenBy: 'captain',
      frozenAt: FIXED_NOW,
    }),
  )
  const gate = makeGate({ config: enforceCfg, ledger })

  // 先真跑一次完成上报：声称改过一个盘上并不存在的文件 → workspace-diff 矛盾。
  // 这条证据会被记进 ledger，后面的决策点都能看到它。
  const first = await gate.evaluate({
    toolName: 'team_task_update',
    args: { task_id: 'item-skeleton', status: 'completed', changedPaths: ['item-skeleton.ts'] },
    actor: CAPTAIN,
    pointId: 'completion_report',
    workspace: wsMain,
    probe: null,
  })
  check(
    first.matrix.gaps.some((gap) => gap.kind === 'skeleton' && gap.severity === 'blocker'),
    `声称改过不存在的文件应当留下 skeleton(blocker) 缺口（观测：${JSON.stringify(kindsOf(first))}）`,
  )

  // scope_freeze 的 ceiling 是 L3_deny：blocker 场景原样交付 L3_deny。
  const high = await gate.evaluate({
    toolName: 'agent_teams_create',
    args: { goal: '开一个团队' },
    actor: CAPTAIN,
    pointId: 'scope_freeze',
    workspace: wsMain,
    probe: null,
  })
  check(
    high.status === 'halt',
    `已经被证明是画饼的条目是 blocker，状态该是 halt（观测：${high.status}）`,
  )
  check(
    high.level === 'L3_deny',
    `ceiling 为 L3_deny 的决策点应当交付 L3_deny（观测：${high.level}）`,
  )

  // unknown_team_tool 的 ceiling 只有 L2_continue：同样的 blocker 缺口必须被压到 L2_continue。
  const low = await gate.evaluate({
    toolName: 'agent_teams_brand_new_tool',
    args: {},
    actor: CAPTAIN,
    pointId: 'unknown_team_tool',
    workspace: wsMain,
    probe: null,
  })
  check(
    low.status === 'halt',
    `unknown_team_tool 场景同样是 blocker，状态该是 halt（观测：${low.status}）`,
  )
  check(
    low.level === 'L2_continue',
    `ceiling 为 L2_continue 的决策点即使遇到 blocker 也只能交付 L2_continue（观测：${low.level}）`,
  )
  check(
    catalogMod.DECISION_POINTS['unknown_team_tool'].ceiling === 'L2_continue',
    `这里正是靠 catalog 的 ceiling 定住上限的（观测：${catalogMod.DECISION_POINTS['unknown_team_tool'].ceiling}）`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 五、high 而非 blocker：状态是 hold，力度到 L2_continue，并留下待办事件
// ─────────────────────────────────────────────────────────────────────────────

{
  const enforceCfg = configMod.toRuntimeConfig({ mode: 'enforce' })
  const ledger = new ledgerMod.Ledger()
  ledger.setBaseline(
    baselineMod.createBaseline({
      goal: '只有一个条目的基线',
      items: [
        { id: 'item-solo', requirement: '不留任何证据', phase: null, depth: 'declared', acceptance: [], scope: [] },
      ],
      frozenBy: 'captain',
      frozenAt: FIXED_NOW,
    }),
  )
  const verdict = await makeGate({ config: enforceCfg, ledger }).evaluate({
    toolName: 'agent_teams_reassign_task',
    args: { task_id: 'item-solo' },
    actor: CAPTAIN,
    pointId: 'ownership_claim',
    workspace: wsMain,
    probe: null,
  })
  const kinds = kindsOf(verdict)
  check(
    sameJson(kinds, ['unreported']),
    `只有一条无证据条目时应当只有 unreported 一种缺口（观测：${JSON.stringify(kinds)}）`,
  )
  check(
    verdict.status === 'hold',
    `high 缺口对应 hold（观测：${verdict.status}）`,
  )
  check(
    verdict.level === 'L2_continue',
    `high 缺口的计划力度是 L2_continue，enforce 下原样交付（观测：${verdict.level}）`,
  )
  check(
    ledger.getAttention().length === 1,
    `L2_continue 的交付种类是 continue，必须留下一条待办事件（观测：${ledger.getAttention().length} 条）`,
  )
  const attention = ledger.getAttention()[0]
  check(
    attention !== undefined && attention.level === 'L2_continue' && attention.pointId === 'ownership_claim',
    `待办事件应当记下力度与决策点（观测：${JSON.stringify(attention)}）`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 六、冻结基线是权威的：第二次冻结不许覆盖
// ─────────────────────────────────────────────────────────────────────────────

{
  const wsFreeze = workspace('ws-freeze')
  const store = new storeMod.LedgerStore({
    workspace: wsFreeze,
    stateDir: STATE_DIR,
    debounceMs: 60_000,
    persistEnabled: true,
  })
  const first = baselineMod.createBaseline({
    goal: '第一版基线',
    items: [
      { id: 'item-x', requirement: 'x 必须成立', phase: null, depth: 'declared', acceptance: [], scope: [] },
    ],
    frozenBy: 'captain',
    frozenAt: FIXED_NOW,
  })
  const second = baselineMod.createBaseline({
    goal: '第二版基线',
    items: [
      { id: 'item-y', requirement: 'y 必须成立', phase: null, depth: 'declared', acceptance: [], scope: [] },
    ],
    frozenBy: 'captain',
    frozenAt: FIXED_NOW + 1_000,
  })

  const firstResult = await store.freezeBaseline(first)
  check(
    firstResult.ok === true,
    `第一次冻结基线应当成功（观测：${JSON.stringify(firstResult)}）`,
  )

  const secondResult = await store.freezeBaseline(second)
  check(
    secondResult.ok === false,
    `对着已冻结的基线再冻一次必须失败（观测：${JSON.stringify(secondResult)}）`,
  )
  check(
    typeof secondResult.reason === 'string' && secondResult.reason.includes('已经冻结过'),
    `第二次冻结的失败理由应当说明基线已经冻结过（观测：${String(secondResult.reason)}）`,
  )
  check(
    store.problems.length === 0,
    `「拒绝覆盖」是正常路径，不该被记成 store 的问题（观测：${JSON.stringify(store.problems)}）`,
  )

  const loaded = await store.loadBaseline()
  check(
    loaded !== null && loaded.goal === '第一版基线',
    `盘上留下的必须是第一版基线（观测：${loaded === null ? 'null' : loaded.goal}）`,
  )
  check(
    loaded !== null && loaded.digest === first.digest,
    `读回来的摘要必须与冻结时一致（观测：${loaded === null ? 'null' : loaded.digest}）`,
  )
  check(
    loaded !== null && sameJson(loaded.items.map((item) => item.id), ['item-x']),
    `读回来的条目必须与冻结时一致（观测：${loaded === null ? 'null' : JSON.stringify(loaded.items.map((item) => item.id))}）`,
  )
  check(
    loaded !== null && baselineMod.baselineIntegrity(loaded).ok === true,
    '读回来的基线必须能通过自己的摘要校验',
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 七、坏掉的基线文件：记问题，不抛异常
// ─────────────────────────────────────────────────────────────────────────────

{
  const cases = [
    {
      name: '缺少 digest/items',
      text: JSON.stringify({ schemaVersion: 1, id: 'bl-broken', frozenAt: 1, frozenBy: 'x', goal: 'g' }),
      expectNull: true,
      problemFragment: '缺少 digest/items',
    },
    {
      name: '不是合法 JSON',
      text: '{ 这不是 JSON',
      expectNull: true,
      problemFragment: '不是合法 JSON',
    },
  ]

  for (const entry of cases) {
    const wsBad = workspace(`ws-bad-${entry.problemFragment.length}`)
    const store = new storeMod.LedgerStore({
      workspace: wsBad,
      stateDir: STATE_DIR,
      debounceMs: 60_000,
      persistEnabled: true,
    })
    mkdirSync(store.dir, { recursive: true })
    writeFileSync(join(store.dir, 'baseline.json'), entry.text, 'utf8')

    let loaded
    let threw = null
    try {
      loaded = await store.loadBaseline()
    } catch (error) {
      threw = error
    }
    check(
      threw === null,
      `基线文件坏掉（${entry.name}）时不许抛异常（观测：抛出了 ${threw === null ? '无' : String(threw)}）`,
    )
    check(
      entry.expectNull ? loaded === null : loaded !== null,
      `基线文件坏掉（${entry.name}）时应当返回 null（观测：${loaded === null ? 'null' : '有值'}）`,
    )
    check(
      store.problems.some((problem) => problem.includes(entry.problemFragment)),
      `基线文件坏掉（${entry.name}）时应当在 store.problems 里说明原因（观测：${JSON.stringify(store.problems)}）`,
    )
  }

  // 摘要被改过：文件本身还读得出来，但必须被拒绝——拿一份被偷偷改过的基线去判定，
  // 等于让之后每一个裁决都建立在虚构的范围上。唯一诚实的回答是「没有可用的冻结范围」。
  const wsTampered = workspace('ws-tampered')
  const tamperedStore = new storeMod.LedgerStore({
    workspace: wsTampered,
    stateDir: STATE_DIR,
    debounceMs: 60_000,
    persistEnabled: true,
  })
  const honest = baselineMod.createBaseline({
    goal: '原来的目标',
    items: [
      { id: 'item-t', requirement: 't 必须成立', phase: null, depth: 'declared', acceptance: [], scope: [] },
    ],
    frozenBy: 'captain',
    frozenAt: FIXED_NOW,
  })
  const tamperedCandidate = { ...honest, goal: '被偷偷换掉的目标' }
  mkdirSync(tamperedStore.dir, { recursive: true })
  writeFileSync(join(tamperedStore.dir, 'baseline.json'), `${JSON.stringify(tamperedCandidate, null, 2)}\n`, 'utf8')
  const tampered = await tamperedStore.loadBaseline()
  check(
    tampered === null,
    `摘要不符的基线必须被拒绝，而不是拿来判定（观测：${tampered === null ? 'null' : '有值'}）`,
  )
  check(
    baselineMod.baselineIntegrity(tamperedCandidate).ok === false,
    '被改过的基线必须能自己算出摘要不符',
  )
  check(
    tamperedStore.problems.some((problem) => problem.includes('摘要不匹配')),
    `摘要不符必须在 store.problems 里留痕（观测：${JSON.stringify(tamperedStore.problems)}）`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 八、持久化往返 + schemaVersion 不认就整体忽略
// ─────────────────────────────────────────────────────────────────────────────

{
  const wsPersist = workspace('ws-persist')
  const stateDir = STATE_DIR
  const baseline = fixtureBaseline('持久化往返用的基线')
  const store = new storeMod.LedgerStore({
    workspace: wsPersist,
    stateDir,
    debounceMs: 60_000,
    persistEnabled: true,
  })

  const frozen = await store.freezeBaseline(baseline)
  check(frozen.ok === true, `持久化场景的基线冻结应当成功（观测：${JSON.stringify(frozen)}）`)

  const ledger = new ledgerMod.Ledger()
  ledger.setBaseline(baseline)
  const verdict = await makeGate({
    config: configMod.toRuntimeConfig({ mode: 'enforce' }),
    ledger,
  }).evaluate({
    toolName: 'team_task_update',
    args: COMPLETION_ARGS,
    actor: CAPTAIN,
    pointId: 'completion_report',
    workspace: wsPersist,
    probe: null,
  })
  check(verdict.status === 'halt', `持久化场景应当产生一条 halt 判定（观测：${verdict.status}）`)

  store.schedule(ledger.snapshot())
  await store.flush()

  const reopened = new storeMod.LedgerStore({
    workspace: wsPersist,
    stateDir,
    debounceMs: 60_000,
    persistEnabled: true,
  })
  const snapshot = await reopened.loadSnapshot()
  check(snapshot !== null, '重新打开的 store 应当读回账本快照')
  check(
    snapshot !== null && snapshot.schemaVersion === typesMod.LEDGER_SCHEMA_VERSION,
    `读回的账本 schemaVersion 应当是当前版本（观测：${snapshot === null ? 'null' : snapshot.schemaVersion}）`,
  )
  check(
    snapshot !== null && snapshot.verdicts.length === ledger.getVerdicts().length,
    `判定条数必须往返一致（观测：盘上 ${snapshot === null ? 'null' : snapshot.verdicts.length}，内存 ${ledger.getVerdicts().length}）`,
  )
  check(
    snapshot !== null && snapshot.evidence.length === ledger.getEvidence().length,
    `证据条数必须往返一致（观测：盘上 ${snapshot === null ? 'null' : snapshot.evidence.length}，内存 ${ledger.getEvidence().length}）`,
  )
  check(
    snapshot !== null && sameJson(snapshot.counts, ledger.snapshot().counts),
    `计数必须往返一致（观测：盘上 ${snapshot === null ? 'null' : JSON.stringify(snapshot.counts)}）`,
  )

  // restore 之后 counts 是由历史重放算出来的，不是从文件里抄来的。
  const restored = new ledgerMod.Ledger()
  restored.restore(snapshot)
  check(
    restored.getVerdicts().length === ledger.getVerdicts().length,
    `restore 后判定条数应当一致（观测：${restored.getVerdicts().length}）`,
  )
  check(
    sameJson(restored.snapshot().counts, ledger.snapshot().counts),
    `restore 重放出来的计数应当与内存账本一致（观测：${JSON.stringify(restored.snapshot().counts)}）`,
  )
  check(
    restored.gapCount('skeleton') === ledger.gapCount('skeleton'),
    `restore 重放出来的缺口计数应当一致（观测：${restored.gapCount('skeleton')}）`,
  )
  check(
    restored.getBaseline() !== null && restored.getBaseline().digest === baseline.digest,
    'restore 应当把快照里的基线一并装回去',
  )
}

{
  // schemaVersion 不认：整体忽略，记问题，不抛异常。
  const wsSchema = workspace('ws-schema')
  const store = new storeMod.LedgerStore({
    workspace: wsSchema,
    stateDir: STATE_DIR,
    debounceMs: 60_000,
    persistEnabled: true,
  })
  const foreign = {
    schemaVersion: 999,
    baseline: null,
    evidence: [],
    reports: [],
    verdicts: [{ id: 'vd-foreign' }],
    attention: [],
    amendments: [],
    episodes: [],
    counts: {},
  }
  await store.flush()
  mkdirSync(store.dir, { recursive: true })
  writeFileSync(join(store.dir, 'ledger.json'), `${JSON.stringify(foreign, null, 2)}\n`, 'utf8')

  let loaded
  let threw = null
  try {
    loaded = await store.loadSnapshot()
  } catch (error) {
    threw = error
  }
  check(threw === null, `schemaVersion 不认时不许抛异常（观测：${threw === null ? '无' : String(threw)}）`)
  check(loaded === null, `schemaVersion 不认时应当整体忽略这份账本（观测：${loaded === null ? 'null' : '有值'}）`)
  check(
    store.problems.some((problem) => problem.includes('schemaVersion')),
    `schemaVersion 不认时应当在 store.problems 里说明（观测：${JSON.stringify(store.problems)}）`,
  )
  check(
    existsSync(join(store.dir, 'ledger.json')),
    '被忽略的旧账本不该被删掉——它仍然是别人的资产',
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 九、LedgerStoreHub：工作区之间必须彻底隔离
// ─────────────────────────────────────────────────────────────────────────────

{
  const wsHubA = workspace('ws-hub-a')
  const wsHubB = workspace('ws-hub-b')
  const hub = new storeMod.LedgerStoreHub({
    stateDir: STATE_DIR,
    debounceMs: 60_000,
    persistEnabled: true,
  })

  const storeA = hub.for(wsHubA)
  const storeAAgain = hub.for(wsHubA)
  const storeB = hub.for(wsHubB)

  check(storeA === storeAAgain, '同一个 workspace 必须复用同一个 store 实例')
  check(storeA !== storeB, '两个 workspace 必须是两个不同的 store 实例')
  check(
    storeA.dir !== storeB.dir,
    `两个 workspace 的状态目录必须不同（观测：${storeA.dir} / ${storeB.dir}）`,
  )
  check(hub.size === 2, `两个 workspace 之后 hub 应当只持有 2 个 store（观测：${hub.size}）`)

  const baselineA = baselineMod.createBaseline({
    goal: 'A 的基线',
    items: [
      { id: 'item-a', requirement: 'a 必须成立', phase: null, depth: 'declared', acceptance: [], scope: [] },
    ],
    frozenBy: 'captain',
    frozenAt: FIXED_NOW,
  })
  const baselineB = baselineMod.createBaseline({
    goal: 'B 的基线',
    items: [
      { id: 'item-b', requirement: 'b 必须成立', phase: null, depth: 'declared', acceptance: [], scope: [] },
    ],
    frozenBy: 'captain',
    frozenAt: FIXED_NOW,
  })

  const frozeA = await storeA.freezeBaseline(baselineA)
  check(frozeA.ok === true, `给 A 冻结基线应当成功（观测：${JSON.stringify(frozeA)}）`)

  const seenFromB = await storeB.loadBaseline()
  check(
    seenFromB === null,
    `A 冻的基线对 B 必须完全不可见（观测：${seenFromB === null ? 'null' : seenFromB.goal}）`,
  )

  const frozeB = await storeB.freezeBaseline(baselineB)
  check(frozeB.ok === true, `B 也必须能独立冻结自己的基线（观测：${JSON.stringify(frozeB)}）`)

  const readBackA = await storeA.loadBaseline()
  const readBackB = await storeB.loadBaseline()
  check(
    readBackA !== null && readBackA.goal === 'A 的基线',
    `A 读回来必须还是 A 的基线（观测：${readBackA === null ? 'null' : readBackA.goal}）`,
  )
  check(
    readBackB !== null && readBackB.goal === 'B 的基线',
    `B 读回来必须还是 B 的基线（观测：${readBackB === null ? 'null' : readBackB.goal}）`,
  )

  // hub.problems 必须带上是哪个 store 的问题——否则多工作区下无从定位。
  writeFileSync(join(storeA.dir, 'ledger.json'), '{ 坏掉的账本', 'utf8')
  await storeA.loadSnapshot()
  const hubProblems = hub.problems
  check(
    hubProblems.length >= 1,
    `store 的问题应当被 hub 收集（观测：${JSON.stringify(hubProblems)}）`,
  )
  check(
    hubProblems.every((problem) => problem.startsWith(`${storeA.dir}: `)),
    `hub.problems 的每一条都必须以它自己的状态目录打头（观测：${JSON.stringify(hubProblems)}）`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 十、RuntimeHub：一个 workspace 一个 runtime，且只在首次加载时读盘
// ─────────────────────────────────────────────────────────────────────────────

{
  const wsRuntimeA = workspace('ws-runtime-a')
  const wsRuntimeB = workspace('ws-runtime-b')
  const storeHub = new storeMod.LedgerStoreHub({
    stateDir: STATE_DIR,
    debounceMs: 60_000,
    persistEnabled: true,
  })
  const hub = new runtimeMod.RuntimeHub({
    ctx,
    config: dryCfg,
    store: storeHub,
    roster: {},
  })

  const runtimeA1 = await hub.load(wsRuntimeA)
  const runtimeA2 = await hub.load(wsRuntimeA)
  const runtimeB = await hub.load(wsRuntimeB)

  check(runtimeA1 === runtimeA2, '同一个 workspace 的 load() 必须解析到同一个 runtime（同一性）')
  check(runtimeB !== runtimeA1, '第二个 workspace 必须得到另一个 runtime')
  check(
    runtimeA1.workspace === wsRuntimeA && runtimeB.workspace === wsRuntimeB,
    `runtime 要记住自己的 workspace（观测：${runtimeA1.workspace} / ${runtimeB.workspace}）`,
  )
  check(runtimeA1.ledger !== runtimeB.ledger, '两个 workspace 必须是两个不同的账本实例')
  check(
    runtimeA1.store !== runtimeB.store && runtimeA1.store.dir !== runtimeB.store.dir,
    `两个 workspace 必须是两个不同的 store，且目录不同（观测：${runtimeA1.store.dir} / ${runtimeB.store.dir}）`,
  )
  check(runtimeA1.store === storeHub.for(wsRuntimeA), 'runtime 里的 store 应当就是 hub 里那一份')

  // 一次真实的判定，证明这个 runtime 拿着的 Gate 是真能跑的。
  const verdict = await runtimeA1.gate.evaluate({
    toolName: 'agent_teams_status',
    args: {},
    actor: CAPTAIN,
    pointId: 'status_read',
    workspace: wsRuntimeA,
    probe: null,
  })
  check(
    verdict.pointId === 'status_read',
    `runtime 里那个 Gate 应当能真的判定（观测：${verdict.pointId}）`,
  )
}

{
  // 首次 load() 从盘上恢复基线 + 账本；之后的 load() 不再读盘。
  const wsReload = workspace('ws-reload')
  const baseline = baselineMod.createBaseline({
    goal: '恢复用的基线',
    items: [
      { id: 'item-r', requirement: 'r 必须成立', phase: null, depth: 'declared', acceptance: [], scope: [] },
    ],
    frozenBy: 'captain',
    frozenAt: FIXED_NOW,
  })

  const storeHub = new storeMod.LedgerStoreHub({
    stateDir: STATE_DIR,
    debounceMs: 60_000,
    persistEnabled: true,
  })
  const prepStore = storeHub.for(wsReload)
  const froze = await prepStore.freezeBaseline(baseline)
  check(froze.ok === true, `恢复场景的基线冻结应当成功（观测：${JSON.stringify(froze)}）`)

  const prepLedger = new ledgerMod.Ledger()
  prepLedger.setBaseline(baseline)
  await makeGate({ config: dryCfg, ledger: prepLedger }).evaluate({
    toolName: 'agent_teams_status',
    args: {},
    actor: CAPTAIN,
    pointId: 'status_read',
    workspace: wsReload,
    probe: null,
  })
  prepStore.schedule(prepLedger.snapshot())
  await prepStore.flush()

  const hub = new runtimeMod.RuntimeHub({ ctx, config: dryCfg, store: storeHub, roster: {} })
  const first = await hub.load(wsReload)
  check(
    first.ledger.getBaseline() !== null && first.ledger.getBaseline().digest === baseline.digest,
    '首次 load() 应当把盘上的冻结基线装进账本',
  )
  check(
    first.ledger.getVerdicts().length === prepLedger.getVerdicts().length,
    `首次 load() 应当把盘上的判定装进账本（观测：${first.ledger.getVerdicts().length} vs ${prepLedger.getVerdicts().length}）`,
  )
  check(
    first.ledger.getEvidence().length === prepLedger.getEvidence().length,
    `首次 load() 应当把盘上的证据装进账本（观测：${first.ledger.getEvidence().length} vs ${prepLedger.getEvidence().length}）`,
  )

  // 把盘上的账本换成一份空的：第二次 load() 若还读盘，判定就会消失。
  writeFileSync(
    join(prepStore.dir, 'ledger.json'),
    `${JSON.stringify({ ...prepLedger.snapshot(), verdicts: [], evidence: [], counts: {} }, null, 2)}\n`,
    'utf8',
  )
  const second = await hub.load(wsReload)
  check(second === first, '第二次 load() 必须返回同一个 runtime')
  check(
    second.ledger.getVerdicts().length === prepLedger.getVerdicts().length,
    `第二次 load() 不该再读盘（盘上已被换成空账本，观测：${second.ledger.getVerdicts().length} vs ${prepLedger.getVerdicts().length}）`,
  )
  check(
    hub.size === 1,
    `同一个 workspace 只该有一个 runtime（观测：${hub.size}）`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 十一、角色缺口：谁在叫 captain-only 的工具
// ─────────────────────────────────────────────────────────────────────────────

{
  const enforceCfg = configMod.toRuntimeConfig({ mode: 'enforce', roleAwareness: 'enforce' })
  const wsRole = workspace('ws-role')

  /** 让某个身份对着某个工具、某个决策点走一次闸口。 */
  async function evaluateAs(actor, toolName, pointId, cfg) {
    const ledger = new ledgerMod.Ledger()
    ledger.setBaseline(
      baselineMod.createBaseline({
        goal: '角色场景基线',
        items: [
          { id: 'item-role', requirement: '不留证据', phase: null, depth: 'declared', acceptance: [], scope: [] },
        ],
        frozenBy: 'captain',
        frozenAt: FIXED_NOW,
      }),
    )
    return makeGate({ config: cfg, ledger }).evaluate({
      toolName,
      args: {},
      actor,
      pointId,
      workspace: wsRole,
      probe: null,
    })
  }

  const memberOnCaptainTool = await evaluateAs(MEMBER, 'agent_teams_approve', 'plan_approval', enforceCfg)
  const memberKinds = kindsOf(memberOnCaptainTool)
  check(
    memberKinds.includes('role-mismatch'),
    `member 调 requires:'captain' 的工具必须报 role-mismatch（观测：${JSON.stringify(memberKinds)}）`,
  )
  const mismatch = memberOnCaptainTool.matrix.gaps.find((gap) => gap.kind === 'role-mismatch')
  check(
    mismatch !== undefined && mismatch.severity === 'high',
    `role-mismatch 的严重度应当是 high（观测：${mismatch === undefined ? '缺口不存在' : mismatch.severity}）`,
  )

  const captainOnCaptainTool = await evaluateAs(CAPTAIN, 'agent_teams_approve', 'plan_approval', enforceCfg)
  const captainKinds = kindsOf(captainOnCaptainTool)
  check(
    !captainKinds.includes('role-mismatch'),
    `captain 调 captain-only 的工具不该报 role-mismatch（观测：${JSON.stringify(captainKinds)}）`,
  )

  // 反向不对称：member 调 requires:'member' 的工具是合规的。
  const memberOnMemberTool = await evaluateAs(MEMBER, 'agent_teams_claim_task', 'ownership_claim', enforceCfg)
  const memberToolKinds = kindsOf(memberOnMemberTool)
  check(
    !memberToolKinds.includes('role-mismatch'),
    `member 调 requires:'member' 的工具是合规的，不该报 role-mismatch（观测：${JSON.stringify(memberToolKinds)}）`,
  )

  // roleAwareness='off' 才是不看角色的那一档。
  const offCfg = configMod.toRuntimeConfig({ mode: 'enforce', roleAwareness: 'off' })
  const offVerdict = await evaluateAs(MEMBER, 'agent_teams_approve', 'plan_approval', offCfg)
  const offKinds = kindsOf(offVerdict)
  check(
    !offKinds.includes('role-mismatch'),
    `roleAwareness='off' 时不看角色，不该报 role-mismatch（观测：${JSON.stringify(offKinds)}）`,
  )

  // 身份没解析出来时，enforce 档把它记成 role-unresolved。
  const unresolvedVerdict = await evaluateAs(UNRESOLVED, 'agent_teams_status', 'status_read', enforceCfg)
  const unresolvedKinds = kindsOf(unresolvedVerdict)
  check(
    unresolvedKinds.includes('role-unresolved'),
    `enforce 档下身份未解析必须报 role-unresolved（观测：${JSON.stringify(unresolvedKinds)}）`,
  )

  // 'advisory' 不是 roleAwareness 的合法取值：它不抑制缺口，而是静默退回 enforce。
  check(
    !configMod.ROLE_POLICIES.includes('advisory'),
    `roleAwareness 的合法取值里没有 'advisory'（观测：${JSON.stringify(configMod.ROLE_POLICIES)}）`,
  )
  const advisoryRoleCfg = configMod.toRuntimeConfig({ mode: 'enforce', roleAwareness: 'advisory' })
  check(
    advisoryRoleCfg.roleAwareness === 'enforce',
    `不合法的 roleAwareness 会退回默认 enforce（观测：${advisoryRoleCfg.roleAwareness}）`,
  )
  const advisoryRoleVerdict = await evaluateAs(MEMBER, 'agent_teams_approve', 'plan_approval', advisoryRoleCfg)
  const advisoryRoleKinds = kindsOf(advisoryRoleVerdict)
  check(
    advisoryRoleKinds.includes('role-mismatch'),
    `roleAwareness='advisory' 并不抑制 role-mismatch（观测：${JSON.stringify(advisoryRoleKinds)}）`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 十二、未知团队工具照样过闸
// ─────────────────────────────────────────────────────────────────────────────

{
  const unknownName = 'agent_teams_brand_new_tool'
  check(
    catalogMod.toolBindingFor(unknownName) === undefined,
    `未登记的工具在 toolBindingFor 里应当查不到（观测：${JSON.stringify(catalogMod.toolBindingFor(unknownName))}）`,
  )
  check(
    catalogMod.isTeamToolName(unknownName) === true,
    '带 agent_teams_ 前缀的名字必须被认成团队工具，否则它连闸口都不会进',
  )
  const unknownBinding = catalogMod.bindingForCall(unknownName, {})
  check(
    unknownBinding.gated === true,
    `未登记的工具必须退回保守默认 gated=true——index.ts 的 pre-execute 正是靠 binding.gated 决定放不放行（观测：${unknownBinding.gated}）`,
  )
  check(
    catalogMod.pointForCall(unknownName, {}) === 'unknown_team_tool',
    `未登记的工具应当落到 unknown_team_tool 决策点（观测：${catalogMod.pointForCall(unknownName, {})}）`,
  )
  check(
    catalogMod.DECISION_POINTS['unknown_team_tool'].gated === true,
    'unknown_team_tool 决策点本身必须是 gated',
  )

  // 已知的非闸门工具反过来必须放行，否则正常读状态都要被拦。
  check(
    catalogMod.bindingForCall('team_task_get', {}).gated === false,
    `team_task_get 是只读工具，不该过闸（观测：${catalogMod.bindingForCall('team_task_get', {}).gated}）`,
  )
  check(
    catalogMod.pointForCall('team_task_get', {}) === 'status_read',
    `team_task_get 应当落在 status_read（观测：${catalogMod.pointForCall('team_task_get', {})}）`,
  )
  check(
    catalogMod.bindingForCall('agent_teams_status', {}).gated === false,
    `agent_teams_status 是只读工具，不该过闸（观测：${catalogMod.bindingForCall('agent_teams_status', {}).gated}）`,
  )
  check(
    catalogMod.pointForCall('agent_teams_status', {}) === 'status_read',
    `agent_teams_status 应当落在 status_read（观测：${catalogMod.pointForCall('agent_teams_status', {})}）`,
  )
  check(
    catalogMod.DECISION_POINTS['status_read'].gated === false,
    'status_read 决策点本身不该是 gated',
  )

  // 真的驱一次：未知工具必须留下 unknown-team-tool 缺口，而不是无声通过。
  const ledger = new ledgerMod.Ledger()
  ledger.setBaseline(
    baselineMod.createBaseline({
      goal: '未知工具场景基线',
      items: [
        { id: 'item-u', requirement: '不留证据', phase: null, depth: 'declared', acceptance: [], scope: [] },
      ],
      frozenBy: 'captain',
      frozenAt: FIXED_NOW,
    }),
  )
  const verdict = await makeGate({
    config: configMod.toRuntimeConfig({ mode: 'enforce' }),
    ledger,
  }).evaluate({
    toolName: unknownName,
    args: {},
    actor: CAPTAIN,
    pointId: catalogMod.pointForCall(unknownName, {}),
    workspace: workspace('ws-unknown-tool'),
    probe: null,
  })
  const kinds = kindsOf(verdict)
  check(
    kinds.includes('unknown-team-tool'),
    `未知团队工具过闸时必须留下 unknown-team-tool 缺口（观测：${JSON.stringify(kinds)}）`,
  )
  const unknownGap = verdict.matrix.gaps.find((gap) => gap.kind === 'unknown-team-tool')
  check(
    unknownGap !== undefined && unknownGap.severity === 'low',
    `unknown-team-tool 的严重度是 low（观测：${unknownGap === undefined ? '缺口不存在' : unknownGap.severity}）`,
  )
  check(
    verdict.status === 'hold',
    `只有 low/high 缺口时状态是 hold（观测：${verdict.status}）`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 十三、验收条件判定绝不执行命令
// ─────────────────────────────────────────────────────────────────────────────

{
  const probeRoot = workspace('ws-evidence')
  writeFileSync(join(probeRoot, 'probe.txt'), 'MARKER-ALPHA\n第二行\n', 'utf8')

  const existsOk = await evidenceMod.evaluatePredicate(probeRoot, 'exists probe.txt')
  check(
    existsOk.checked === true && existsOk.passed === true,
    `exists 谓词对真实存在的文件应当判真（观测：${JSON.stringify(existsOk)}）`,
  )

  const existsMissing = await evidenceMod.evaluatePredicate(probeRoot, 'exists missing.txt')
  check(
    existsMissing.checked === true && existsMissing.passed === false,
    `exists 谓词对不存在的文件应当判假，但仍然是 checked（观测：${JSON.stringify(existsMissing)}）`,
  )

  const containsOk = await evidenceMod.evaluatePredicate(probeRoot, 'contains probe.txt MARKER-ALPHA')
  check(
    containsOk.checked === true && containsOk.passed === true,
    `contains 谓词对文件中真实存在的文本应当判真（观测：${JSON.stringify(containsOk)}）`,
  )

  const containsMissing = await evidenceMod.evaluatePredicate(probeRoot, 'contains probe.txt NOT-IN-FILE')
  check(
    containsMissing.checked === true && containsMissing.passed === false,
    `contains 谓词对文件中不存在的文本应当判假（观测：${JSON.stringify(containsMissing)}）`,
  )

  const shellLike = await evidenceMod.evaluatePredicate(probeRoot, 'npm test')
  check(
    shellLike.checked === false && shellLike.passed === false,
    `一条 shell 命令的验收条件只能记成 checked=false / passed=false（观测：${JSON.stringify(shellLike)}）`,
  )
  check(
    shellLike.detail.includes('门禁不执行命令'),
    `拒绝执行命令时应当在 detail 里说清楚（观测：${shellLike.detail}）`,
  )

  // 真正的行为检查：如果哪天门禁把验收条件交给了 shell，这条就会留下痕迹文件。
  const sideEffectSpec = `node -e "require('fs').writeFileSync('run-host-tests-spawn-marker.txt','x')"`
  const sideEffect = await evidenceMod.evaluatePredicate(probeRoot, sideEffectSpec)
  check(
    sideEffect.checked === false,
    `带副作用的验收条件同样只能记成 checked=false（观测：${JSON.stringify(sideEffect)}）`,
  )
  check(
    existsSync(SPAWN_MARKER) === false,
    `验收条件绝不能被交给 shell——若被执行，${SPAWN_MARKER} 就会被写出来`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 十四、appendEvent 不走去抖，schedule 走
// ─────────────────────────────────────────────────────────────────────────────

{
  const wsDebounce = workspace('ws-debounce')
  const store = new storeMod.LedgerStore({
    workspace: wsDebounce,
    stateDir: STATE_DIR,
    // 去抖长到这次测试不可能等到——只要差一点点时间就能分清谁落了盘。
    debounceMs: 60_000,
    persistEnabled: true,
  })

  const pending = {
    schemaVersion: typesMod.LEDGER_SCHEMA_VERSION,
    baseline: null,
    evidence: [],
    reports: [],
    verdicts: [{ id: 'vd-pending' }],
    attention: [],
    amendments: [],
    episodes: [],
    counts: { 'verdict:hold': 1 },
  }
  store.schedule(pending)
  await new Promise((settle) => setTimeout(settle, 40))

  check(
    existsSync(store.ledgerFile) === false,
    `debounceMs=60000 时 schedule() 之后账本不该立刻落盘（观测：${store.ledgerFile} ${existsSync(store.ledgerFile) ? '已存在' : '不存在'}）`,
  )

  let appended
  let threw = null
  try {
    appended = await store.appendEvent('intervention', { pointId: 'completion_report' })
  } catch (error) {
    threw = error
  }
  check(threw === null, `appendEvent 不该抛异常（观测：${threw === null ? '无' : String(threw)}）`)
  check(appended === undefined, 'appendEvent 没有返回值，落盘完成才 resolve')
  check(
    existsSync(store.eventsFile) === true,
    'appendEvent 必须立即落盘，不受 schedule 的去抖影响',
  )

  const lines = readFileSync(store.eventsFile, 'utf8').trim().split('\n')
  check(lines.length === 1, `一次 appendEvent 应当只写一行（观测：${lines.length} 行）`)
  const event = JSON.parse(lines[0])
  check(
    event.kind === 'intervention' && event.payload.pointId === 'completion_report',
    `事件行应当原样带上 kind 与 payload（观测：${lines[0]}）`,
  )
  check(
    typeof event.at === 'number',
    `事件行应当带上时间戳（观测：${typeof event.at}）`,
  )
  check(
    existsSync(store.ledgerFile) === false,
    'appendEvent 不该顺带把还没到点的账本快照也刷下去',
  )

  await store.flush()
  check(existsSync(store.ledgerFile) === true, 'flush() 之后账本才落盘')
  const back = await store.loadSnapshot()
  check(
    back !== null && sameJson(back.verdicts, [{ id: 'vd-pending' }]),
    `flush() 落盘的必须是那次 schedule() 的快照（观测：${back === null ? 'null' : JSON.stringify(back.verdicts)}）`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 收尾
// ─────────────────────────────────────────────────────────────────────────────

// 清掉本文件造出来的东西；上面那条「副作用」断言已经落过账，这里只是别留垃圾。
rmSync(TMP, { recursive: true, force: true })
if (existsSync(SPAWN_MARKER)) rmSync(SPAWN_MARKER, { force: true })

if (failed > 0) {
  process.stderr.write(`FAIL ${NAME}: ${failed} host assertion(s) failed\n`)
} else {
  ok(NAME, assertNonEmpty(`${passed} assertions passed`, 'assertion count'))
}
