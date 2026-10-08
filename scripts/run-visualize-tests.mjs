#!/usr/bin/env node
/**
 * run-visualize-tests.mjs —— docs/visualize.html 的门禁测试。
 *
 * 这个页面把 dsh-jev-gate 的裁决逻辑**重抄**了一遍：决策点表、缺口表、mode 帽、
 * rules 天花板、planLevel、statusFrom。抄写就会漂移，而漂移的演示比没有演示更糟——
 * 它会用一套早已不成立的口径去骗看它的人。所以这里做四件事：
 *
 *   1. 证明它真的能跑。抽出内联 <script>，node --check 与 vm.Script 双重编译，
 *      再在 node:vm 里用 document/canvas 桩把它**跑起来并驱动若干帧**，断言
 *      canvas 上确实发生了绘制、账本面板确实被写进了内容、有调用真的交付完成。
 *   2. 证明它不漂移。页面里的五个纯函数与四张表逐条对照 host/ 的真实导出
 *      （capForMode / configuredCeilingFor / planLevel / statusFrom、
 *      INTERVENTION_LEVELS / LEVEL_RANK / GAP_* / DECISION_POINTS）。
 *   3. 证明面板上那些控件不是摆设。「同屏呼入」必须真的限制在途条数、
 *      rules 必须真的压低天花板、账本累计必须真的有数字。
 *   4. 证明每条剧本都走真实绑定：pointForCall(tool, args) 必须落在剧本自己
 *      声明的决策点上，且 actor 满足该绑定要求的身份。
 *
 * host 侧一律用 scripts/lib/bundle.mjs 现 bundle 现 import，不重写一遍宿主逻辑：
 * 对照的基准必须是这个包真正会加载的代码。
 *
 * 运行：node scripts/run-visualize-tests.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createContext, runInContext, Script } from 'node:vm'

import { assertNonEmpty, bundleHost, fail, importBundle, ok, repoRoot } from './lib/bundle.mjs'

const NAME = 'run-visualize-tests'
const PAGE = resolve(repoRoot, 'docs', 'visualize.html')
const SCRIPT_OUT = resolve(repoRoot, '.tmp', 'visualize', 'visualize.js')

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

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function sortedKeys(record) {
  return Object.keys(record).slice().sort()
}

/* ------------------------------------------------------------------ *
 * 桩：让这个页面在一个没有浏览器的进程里真的跑起来
 * ------------------------------------------------------------------ */

/** 一个够用的元素桩：能当容器、能存文本、也能当 <select> 用。 */
function makeElement(id) {
  const el = {
    id,
    children: [],
    options: [],
    innerHTML: '',
    textContent: '',
    className: '',
    value: '',
    style: {},
    onclick: null,
    oninput: null,
    listeners: {},
    appendChild(child) {
      el.children.push(child)
      return child
    },
    // 桩不解析 innerHTML，所以 rules 列表里那个「删掉」链接不会被真的连上；
    // rules 本身的增删由下面的断言直接驱动 state.rules 来覆盖。
    querySelectorAll() {
      return []
    },
    getAttribute() {
      return null
    },
    setAttribute() {},
    addEventListener(type, fn) {
      ;(el.listeners[type] ??= []).push(fn)
    },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getBoundingClientRect() {
      return { width: 1440, height: 860, left: 0, top: 0 }
    },
  }
  // <select> 的 options 与 children 是同一个数组：页面用 options.length 判断是否已填过。
  el.options = el.children
  return el
}

/**
 * 2D 上下文的桩。
 *
 * 关键不是"能画"，而是**记下画了多少笔**：一个只会返回 undefined 的桩能让
 * 有渲染 bug 的页面照样"跑通"，`stats.ops` 才让"确实往 canvas 上画了东西"
 * 变成可断言的事实。
 */
function makeContext2d(stats) {
  const props = { canvas: null }
  return new Proxy(props, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'symbol') return undefined
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return () => ({ addColorStop() {} })
      }
      if (prop === 'measureText') return (text) => ({ width: String(text).length * 7 })
      return () => {
        stats.ops += 1
      }
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    },
  })
}

/** 在 vm 沙箱里把页面脚本跑起来，并交回手动驱动帧的能力。 */
function runPage(html, script) {
  const stats = { ops: 0, frames: 0 }
  const ctx = makeContext2d(stats)

  const byId = new Map()
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) byId.set(match[1], makeElement(match[1]))

  const stage = byId.get('stage')
  if (stage !== undefined) {
    stage.width = 1440
    stage.height = 860
    stage.getContext = () => ctx
    stage.parentElement = byId.get('left') ?? makeElement('left')
  }

  // 页面每要一个 id 都记一笔：要了 HTML 里不存在的 id 就是真 bug，不是桩的问题。
  const missingIds = []
  const listeners = {}
  const document = {
    getElementById(id) {
      const found = byId.get(id)
      if (found !== undefined) return found
      missingIds.push(id)
      const made = makeElement(id)
      byId.set(id, made)
      return made
    },
    createElement(tag) {
      return makeElement(`<${tag}>`)
    },
    addEventListener(type, fn) {
      ;(listeners[type] ??= []).push(fn)
    },
  }

  let clock = 0
  let pending = null
  const sandbox = {
    document,
    window: { devicePixelRatio: 2, addEventListener() {} },
    performance: { now: () => clock },
    requestAnimationFrame(callback) {
      pending = callback
      return 1
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  }

  const probe = `
;globalThis.__probe = {
  LEVELS, RANK, LEVEL_CN, LEVEL_KIND, LEVEL_ACTION, SEVERITY_LEVEL, GAPS, POINTS, SCENARIOS,
  STATUS_CN, TL, MODE_NOTE, W, H, SIEVE, SHAFT_CX, levelY, plateBottom,
  state, calls, chips, sparks, mesh,
  capForMode, configuredCeilingFor, clampLevel, planLevel, statusFrom,
  liveCalls, inflightLimit, spawn, runOne, maybeSpawn, settleCall,
  renderVerdict, renderTally, renderInflight, reExplainAll, buildRules, el,
};
`

  let runError = null
  try {
    runInContext(script + probe, createContext(sandbox), { filename: 'docs/visualize.html', timeout: 60000 })
  } catch (error) {
    runError = error
  }

  /** 手动推进若干帧：页面自己的 frame() 每次收尾都会再挂一次 rAF。 */
  const advance = (seconds, stepMs = 16) => {
    const frames = Math.round((seconds * 1000) / stepMs)
    for (let i = 0; i < frames; i += 1) {
      clock += stepMs
      stats.frames += 1
      const callback = pending
      pending = null
      if (typeof callback === 'function') callback(clock)
    }
  }

  const fire = (type, event) => {
    for (const fn of listeners[type] ?? []) fn(event)
  }

  return { stats, runError, probe: sandbox.__probe, byId, missingIds, advance, fire }
}

/* ------------------------------------------------------------------ *
 * 准备：页面脚本 + host 侧真值
 * ------------------------------------------------------------------ */

const html = await readFile(PAGE, 'utf8')

const openTags = [...html.matchAll(/<script\b[^>]*>/g)]
check(openTags.length === 1, `docs/visualize.html 应只含一个 <script> 块，实际 ${openTags.length}`)
check((html.match(/<\/script>/g) ?? []).length === 1, 'docs/visualize.html 应有且只有一个 </script>')

const bodyStart = html.indexOf('>', openTags[0]?.index ?? 0) + 1
const bodyEnd = html.indexOf('</script>', bodyStart)
const script = assertNonEmpty(html.slice(bodyStart, bodyEnd), '内联 <script> 内容')

await writeFile(SCRIPT_OUT, script, 'utf8')

// node --check 以 stdio:'ignore' 运行：本机受限模式下管道抓输出会失败，只看退出码。
let checkError = null
try {
  execFileSync(process.execPath, ['--check', SCRIPT_OUT], { stdio: 'ignore' })
} catch (error) {
  checkError = error
}
check(checkError === null, `node --check 失败：${checkError === null ? '' : String(checkError.message)}`)

// vm.Script 编译：与 --check 互为独立证据。
let compileError = null
try {
  // eslint-disable-next-line no-new
  new Script(script, { filename: 'docs/visualize.html' })
} catch (error) {
  compileError = error
}
check(compileError === null, `内联脚本无法被 vm.Script 编译：${compileError === null ? '' : String(compileError.message)}`)

/**
 * 打包一个宿主模块并 import 进来。
 *
 * `@deepseek-ai/dsh-llm` 必须保持 external（与 run-host-tests.mjs 同一处理）：那个包
 * 用 `createRequire(import.meta.url)('../package.json')` 读自己的清单，一旦被内联进
 * `.tmp/visualize/`，这个相对路径就会指到不存在的地方。保持 external 之后 Node 从产物
 * 所在目录往上找 `node_modules`，拿到的仍是本包真正安装的那一份依赖。
 */
const EXTERNAL_PACKAGES = ['@deepseek-ai/dsh-llm']
const loadHost = async (entry, name) =>
  importBundle(await bundleHost({ entry, outfile: `.tmp/visualize/${name}.mjs`, external: EXTERNAL_PACKAGES }))

const config = await loadHost('host/config.ts', 'host-config')
const catalog = await loadHost('host/catalog.ts', 'host-catalog')
const types = await loadHost('host/types.ts', 'host-types')
const intervene = await loadHost('host/intervene.ts', 'host-intervene')
const matrix = await loadHost('host/matrix.ts', 'host-matrix')
const gate = await loadHost('host/gate.ts', 'host-gate')

/* ------------------------------------------------------------------ *
 * 1. 跑起来：驱动若干帧，页面自己不能抛
 * ------------------------------------------------------------------ */

const page = runPage(html, script)
check(page.runError === null, `页面脚本求值抛错：${page.runError === null ? '' : String(page.runError.stack ?? page.runError.message)}`)
const probe = page.probe
check(probe !== undefined && typeof probe === 'object', '页面脚本必须能交出内部探针（内联脚本被改动过？）')

if (probe === undefined) {
  process.stderr.write(`FAIL ${NAME}: 探针缺失，后续断言无法进行\n`)
  process.exit(1)
}

check(page.missingIds.length === 0, `页面索取了 HTML 中不存在的 id：${page.missingIds.join('、')}`)

page.advance(9)
check(page.stats.frames > 500, `应驱动了 500 帧以上，实际 ${page.stats.frames}`)
check(page.stats.ops > 5000, `canvas 上应有成规模的绘制调用，实际 ${page.stats.ops} 笔`)
check(probe.state.doneCalls >= 1, `9 秒里至少应有一条调用交付完成，实际 ${probe.state.doneCalls}`)
check(
  probe.state.totals.credited + probe.state.totals.discarded >= 1,
  `9 秒里至少应有一块证据落进某个桶，实际 ${probe.state.totals.credited}/${probe.state.totals.discarded}`,
)

/* ------------------------------------------------------------------ *
 * 2. 面板控件不是摆设
 * ------------------------------------------------------------------ */

// 「同屏呼入」滑块：这是本次补完的整块能力，死了就必须变红。
check(probe.inflightLimit() === 3, `burst=2 时在途上限应为 3，实际 ${probe.inflightLimit()}`)
check(
  sameJson([0, 1, 2, 3, 4, 5, 6].map((n) => (probe.state.burst = n, probe.inflightLimit())), [1, 2, 3, 4, 5, 6, 7]),
  'burst 0..6 应依次映射到在途上限 1..7',
)

// 上限必须真的拦住：填满之后 maybeSpawn 必须拒绝再放人进来。
probe.state.burst = 4
let forced = 0
while (probe.maybeSpawn() && forced < 24) forced += 1
check(probe.liveCalls().length === 5, `burst=4 应恰好填满 5 条在途，实际 ${probe.liveCalls().length}`)
check(probe.maybeSpawn() === false, '在途已满时 maybeSpawn 必须拒绝')
check(forced >= 3, `从 3 条填到 5 条应需要若干次生成，实际新增 ${forced}`)

// burst=0 时必须退回"一次只放一条"。
probe.state.burst = 0
page.advance(18)
probe.state.burstPeak = 0
page.advance(9)
check(probe.state.burstPeak === 1, `burst=0 时在途峰值应恒为 1，实际 ${probe.state.burstPeak}`)

// 账本累计：之前是一个永远空着的框。
const tally = probe.el('tally').innerHTML
check(tally.includes('已交付的调用'), `账本累计面板应写入内容，实际「${tally.slice(0, 60)}」`)
check(probe.state.doneCalls >= 2, `账本应已结算多条调用，实际 ${probe.state.doneCalls}`)
check(/<span>\d+<\/span>/.test(tally), '账本累计面板应有数字')

// 在途列表走的是 appendChild（桩不解析 innerHTML），所以断言子节点数。
check(
  probe.el('inflight').children.length >= 1 || probe.el('inflight').innerHTML.length > 0,
  '在途列表应被写入（至少一个在途条目）',
)

// rules：按决策点压低天花板必须真的改变 ceiling。
const rulePoint = probe.el('rulePoint')
const ruleLevel = probe.el('ruleLevel')
check(rulePoint.children.length === Object.keys(probe.POINTS).length, 'rules 面板的决策点下拉应列出全部决策点')
check(ruleLevel.children.length === probe.LEVELS.length, 'rules 面板的天花板下拉应列出全部力度')
check(typeof probe.el('ruleAdd').onclick === 'function', 'rules 面板的「加一条规则」必须已接线')

const beforeRule = probe.configuredCeilingFor('completion_report', [], 'enforce')
rulePoint.value = 'completion_report'
ruleLevel.value = 'L1_note'
probe.el('ruleAdd').onclick()
const afterRule = probe.configuredCeilingFor('completion_report', probe.state.rules, 'enforce')
check(probe.state.rules.length === 1, `加规则后 state.rules 应有一条，实际 ${probe.state.rules.length}`)
check(beforeRule === 'L4_human' && afterRule === 'L1_note', `规则应把 completion_report 从 ${beforeRule} 压到 L1_note，实际 ${afterRule}`)
check(
  probe.el('ruleList').children.length === 1 &&
    String(probe.el('ruleList').children[0].innerHTML).includes('completion_report'),
  'rules 列表应列出刚加的规则',
)

// 收回去，免得影响后面的断言。
probe.state.rules = []
probe.buildRules()
check(probe.configuredCeilingFor('completion_report', probe.state.rules, 'enforce') === 'L4_human', '清掉规则后天花板应回到目录值')

// 滑块读数
probe.el('burst').oninput({ target: { value: '5' } })
check(probe.el('burstRd').textContent === '6 条', `burst=5 的读数应为 6 条，实际「${probe.el('burstRd').textContent}」`)
probe.el('burst').oninput({ target: { value: '2' } })

/* ------------------------------------------------------------------ *
 * 3. 与 host/ 不漂移
 * ------------------------------------------------------------------ */

check(sameJson(probe.LEVELS, types.INTERVENTION_LEVELS), `页面的 LEVELS 与 INTERVENTION_LEVELS 不一致：${probe.LEVELS.join(',')}`)
check(sameJson(probe.RANK, types.LEVEL_RANK), '页面的 RANK 与 LEVEL_RANK 不一致')
check(
  probe.LEVELS.every((level) => intervene.decisionKindFor(level) === probe.LEVEL_KIND[level]),
  `LEVEL_KIND 与 decisionKindFor 不一致：${probe.LEVELS.map((l) => `${l}=${probe.LEVEL_KIND[l]}/${intervene.decisionKindFor(l)}`).join(' ')}`,
)

const pageGapKinds = sortedKeys(probe.GAPS)
check(sameJson(pageGapKinds, [...types.GAP_KINDS].slice().sort()), `GAPS 的缺口种类与 GAP_KINDS 不一致：${pageGapKinds.join(',')}`)
// 严重度必须逐条等于 GAP_SEVERITY：它才是驱动 planLevel 的东西，错了演示就在骗人。
// 中文说明（cn）**故意不比**：面板上的措辞是这个演示自己写的，比 GAP_LABEL 更口语化，
// 钉住文案只会让以后改一句人话就得改门禁；只要求它是一句真的说明。
check(
  types.GAP_KINDS.every((kind) => probe.GAPS[kind].sev === types.GAP_SEVERITY[kind]),
  `每个缺口的 sev 必须与 GAP_SEVERITY 一致（页面：${types.GAP_KINDS.map((k) => `${k}=${probe.GAPS[k]?.sev}`).join(' ')}）`,
)
check(
  types.GAP_KINDS.every((kind) => typeof probe.GAPS[kind].cn === 'string' && probe.GAPS[kind].cn.trim().length >= 4),
  '每个缺口都应有一句中文说明',
)

const hostPointIds = Object.keys(catalog.DECISION_POINTS)
check(sameJson(sortedKeys(probe.POINTS), hostPointIds.slice().sort()), '页面的决策点集合与 DECISION_POINTS 不一致')
check(
  hostPointIds.every((id) => {
    const host = catalog.DECISION_POINTS[id]
    const mine = probe.POINTS[id]
    return mine.title === host.title && mine.floor === host.floor && mine.ceiling === host.ceiling && mine.gated === host.gated
  }),
  '每个决策点的 title/floor/ceiling/gated 必须与 DECISION_POINTS 逐条一致',
)

// capForMode：全量穷举。
const modes = [...config.MODES]
const capMismatch = probe.LEVELS.flatMap((level) => modes.map((mode) => [level, mode, config.capForMode(level, mode), probe.capForMode(level, mode)]))
  .filter(([, , host, mine]) => host !== mine)
check(capMismatch.length === 0, `capForMode 有 ${capMismatch.length} 处不一致：${capMismatch.slice(0, 3).map((r) => r.join('/')).join(' ')}`)

// configuredCeilingFor：14 个点 × 全部模式 × 若干规则组合（含别人的规则、enabled:false、收窄与放宽）。
const otherPoint = (pointId) => hostPointIds.find((id) => id !== pointId) ?? pointId
const ruleVariantsFor = (pointId) => [
  [],
  [{ pointId, enabled: false }],
  [{ pointId, ceiling: 'L1_note' }],
  [{ pointId, ceiling: 'L4_human' }],
  [{ pointId: otherPoint(pointId), enabled: false }],
  [{ pointId, enabled: false }, { pointId, ceiling: 'L1_note' }],
]
const ceilingMismatch = []
for (const pointId of hostPointIds) {
  for (const mode of modes) {
    for (const rules of ruleVariantsFor(pointId)) {
      const runtime = config.toRuntimeConfig({ mode, rulesJson: JSON.stringify(rules) })
      const host = config.configuredCeilingFor(pointId, runtime)
      const mine = probe.configuredCeilingFor(pointId, rules, mode)
      if (host !== mine) ceilingMismatch.push(`${pointId}/${mode}/${JSON.stringify(rules)}=${host}≠${mine}`)
    }
  }
}
check(ceilingMismatch.length === 0, `configuredCeilingFor 有 ${ceilingMismatch.length} 处不一致：${ceilingMismatch.slice(0, 3).join(' ')}`)

// planLevel：14 点 × 5 模式 × 4 状态 × 缺口组合 × 规则组合。
const GAP_SETS = [
  [],
  ...types.GAP_KINDS.map((kind) => [kind]),
  ...types.GAP_KINDS.slice(0, 5).flatMap((a) => types.GAP_KINDS.slice(0, 5).map((b) => [a, b])),
  [types.GAP_KINDS[0], types.GAP_KINDS[3], types.GAP_KINDS[9]],
]
const STATUSES = ['advance', 'hold', 'halt', 'insufficient']
let planSamples = 0
const planMismatch = []
for (const pointId of hostPointIds) {
  for (const mode of modes) {
    for (const rules of ruleVariantsFor(pointId)) {
      const runtime = config.toRuntimeConfig({ mode, rulesJson: JSON.stringify(rules) })
      for (const status of STATUSES) {
        for (const kinds of GAP_SETS) {
          const host = intervene.planLevel({
            pointId,
            status,
            gaps: kinds.map((kind) => matrix.makeGap(kind, pointId, null, '')),
            config: runtime,
          })
          const mine = probe.planLevel(pointId, status, kinds.map((kind) => ({ kind, item: null })), rules, mode)
          planSamples += 1
          if (host.planned !== mine.planned || host.delivered !== mine.delivered) {
            if (planMismatch.length < 3) {
              planMismatch.push(`${pointId}/${mode}/${status}/${kinds.join('+') || '无缺口'} → host ${host.planned}/${host.delivered} 页面 ${mine.planned}/${mine.delivered}`)
            }
          }
        }
      }
    }
  }
}
check(planSamples > 1000, `planLevel 对照样本太少：${planSamples}`)
check(planMismatch.length === 0, `planLevel 与 host/intervene.ts 不一致：${planMismatch.join(' ｜ ')}`)

// statusFrom：全部单一缺口 + 全部两两组合。
const statusCombos = []
for (const a of types.GAP_KINDS) {
  statusCombos.push([a])
  for (const b of types.GAP_KINDS) statusCombos.push([a, b])
}
const statusMismatch = statusCombos.filter(
  (combo) =>
    gate.statusFrom(combo.map((kind) => matrix.makeGap(kind, 'completion_report', null, ''))) !==
    probe.statusFrom(combo.map((kind) => ({ kind, item: null }))),
)
check(statusMismatch.length === 0, `statusFrom 有 ${statusMismatch.length} 处不一致（例：${statusMismatch.slice(0, 2).map((c) => c.join('+')).join(' ')}）`)

/* ------------------------------------------------------------------ *
 * 4. 剧本必须走真实绑定
 * ------------------------------------------------------------------ */

check(probe.SCENARIOS.length >= 8, `剧本数量太少：${probe.SCENARIOS.length}`)
check(new Set(probe.SCENARIOS.map((s) => s.key)).size === probe.SCENARIOS.length, '剧本 key 不能重复')

const badScenario = []
for (const scenario of probe.SCENARIOS) {
  if (!hostPointIds.includes(scenario.point)) {
    badScenario.push(`${scenario.key}: 决策点 ${scenario.point} 不存在`)
    continue
  }
  for (const gap of scenario.gaps) {
    if (!types.GAP_KINDS.includes(gap.kind)) badScenario.push(`${scenario.key}: 缺口 ${gap.kind} 不存在`)
  }
  for (const chip of scenario.chips) {
    if (!['A', 'B', 'C'].includes(chip.level)) badScenario.push(`${scenario.key}: 证据档 ${chip.level} 不存在`)
  }
  // 只有带 tool 的剧本才谈得上"走哪个绑定"；正文剧本（tool 为 null）走 narrativeClaim 通道。
  if (typeof scenario.tool !== 'string') {
    if (scenario.point !== 'narrative_claim') {
      badScenario.push(`${scenario.key}: 没有工具调用的剧本应落在 narrative_claim，剧本却写了 ${scenario.point}`)
    }
    continue
  }

  const point = catalog.pointForCall(scenario.tool, scenario.args)
  if (point !== scenario.point) badScenario.push(`${scenario.key}: ${scenario.tool} 实际落在 ${point}，剧本却写了 ${scenario.point}`)
  const binding = catalog.bindingForCall(scenario.tool, scenario.args)
  const requires = binding?.requires
  if (requires === 'captain' && scenario.actor !== 'captain') badScenario.push(`${scenario.key}: ${scenario.tool} 只允许队长，剧本身份是 ${scenario.actor}`)
  if (requires === 'member' && scenario.actor !== 'member') badScenario.push(`${scenario.key}: ${scenario.tool} 只允许队员，剧本身份是 ${scenario.actor}`)
}
check(badScenario.length === 0, `剧本与真实绑定不一致：${badScenario.slice(0, 4).join(' ｜ ')}`)

// 门禁不拦自己的工具：剧本里若声称 jev_gate_* 走闸口，演示就失真了。
const selfTool = probe.SCENARIOS.filter((s) => typeof s.tool === 'string' && s.tool.startsWith('jev_gate_') && catalog.isTeamToolName(s.tool))
check(selfTool.length === 0, `剧本把插件自己的工具当成受拦动作：${selfTool.map((s) => s.key + '/' + s.tool).join('、')}`)

/* ------------------------------------------------------------------ *
 * 5. 物理量必须有限（NaN 会静默地画出一片空白）
 * ------------------------------------------------------------------ */

page.advance(6)
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const nanCalls = probe.calls.filter((c) => !finite(c.x) || !finite(c.y) || !finite(c.t))
const nanChips = probe.chips.filter((c) => !finite(c.x) || !finite(c.y) || !finite(c.r))
const nanMesh = probe.mesh.nodes.filter((n) => !finite(n.y) || !finite(n.vy))
check(nanCalls.length === 0, `有 ${nanCalls.length} 条调用的坐标/时间为非有限值`)
check(nanChips.length === 0, `有 ${nanChips.length} 块证据碎片的坐标为非有限值`)
check(nanMesh.length === 0, `筛面有 ${nanMesh.length} 个节点为非有限值`)
check(probe.chips.length < 400, `证据碎片不应无限堆积，实际 ${probe.chips.length}`)

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

if (failed > 0) {
  process.stderr.write(`FAIL ${NAME}: ${failed} visualize assertion(s) failed (${passed} passed)\n`)
} else {
  const detail = assertNonEmpty(`${passed} assertions passed`, 'assertion count')
  ok(NAME, detail)
}
