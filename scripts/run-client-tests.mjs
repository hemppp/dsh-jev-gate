#!/usr/bin/env node
/**
 * run-client-tests.mjs —— client 半（浏览器 bundle）的门禁测试。
 *
 * `client/index.js` 不是可 import 的 ESM：它只调用
 * `window.__ModuleLoader__.load({ id, factory(require) {...} })`。
 * 所以这里用 node:vm 造一个最小宿主（window/document/console），把文件当脚本
 * 求值，截获传给 load 的记录，再以 stub require 调 factory 拿到真正的导出，
 * 然后逐条对照 host 源码做跨半一致性断言。
 *
 * 最重要的一组断言是"跨半镜像"：client 声明的 volatile 字段顺序与决策点
 * ceiling 必须与 host/ 完全一致——一边改名而另一边没改，必须在这里变红。
 *
 * 运行：node scripts/run-client-tests.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createContext, runInContext, Script } from 'node:vm'

import { assertNonEmpty, bundleHost, fail, importBundle, ok, repoRoot } from './lib/bundle.mjs'

const NAME = 'run-client-tests'
const CLIENT_ENTRY = resolve(repoRoot, 'client', 'index.js')

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

/** 按 id 缓存的万能 stub：既能当函数用，也能取任意属性。 */
function makeStubRequire() {
  const cache = new Map()
  const stubFor = (id) => {
    const cached = cache.get(id)
    if (cached !== undefined) return cached
    const proxy = new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === 'then') return undefined
        if (prop === Symbol.toPrimitive) return () => ''
        if (prop === 'name') return id
        return stubFor(`${id}.${String(prop)}`)
      },
      apply() {
        return stubFor(`${id}()`)
      },
      construct() {
        return stubFor(`new ${id}`)
      },
    })
    cache.set(id, proxy)
    return proxy
  }
  return (id) => stubFor(id)
}

/** 在 vm 沙箱里求值 client bundle，返回传给 `__ModuleLoader__.load` 的记录。 */
function evaluateClientModule(source) {
  let definition = null
  const sandbox = {
    console,
    window: {
      __ModuleLoader__: {
        load(record) {
          definition = record
        },
      },
    },
  }
  runInContext(source, createContext(sandbox), { filename: CLIENT_ENTRY, timeout: 5000 })
  return definition
}

/** 极简但结构完整的 config-form scope（构造函数会直接调 scope.subscribe）。 */
function makeScope() {
  return { subscribe: () => () => {}, dispose: () => {} }
}

/**
 * 假 ctx：记录每一次注册/注入/effect，用于断言 apply 的挂载协议。
 * options.served === false 模拟"宿主根本不提供该配置表单"；
 * options.form === 'null' 模拟 configForms.get() 返回 null。
 */
function makeContext(options = {}) {
  const log = {
    boundNs: null,
    formNs: null,
    servedNs: null,
    dictionaries: [],
    effects: [],
    cleanups: [],
    credentialHandlers: [],
    slotInjections: [],
    registrations: [],
  }
  const scope = options.scope ?? makeScope()
  const ctx = {
    effect(fn, label) {
      log.effects.push(label)
      const cleanup = fn()
      if (typeof cleanup === 'function') log.cleanups.push(cleanup)
      return cleanup
    },
    locale: {
      bind(ns) {
        log.boundNs = ns
        return (key) => key
      },
      register(ns, dictionary) {
        log.dictionaries.push({ ns, dictionary })
      },
    },
    remote: {
      $on(event, handler) {
        log.credentialHandlers.push({ event, handler })
        return () => {}
      },
      credentials: { describe: async () => ({ ok: false }) },
    },
    configForms: {
      get(ns) {
        log.formNs = ns
        return options.form === 'null' ? null : scope
      },
      whileServed(ns, fn) {
        log.servedNs = ns
        return options.served === false ? undefined : fn()
      },
    },
    slots: {
      inject(name, fn) {
        log.slotInjections.push(name)
        return fn()
      },
      register(record, component) {
        log.registrations.push({ record, component })
        return () => {}
      },
    },
  }
  return { ctx, log }
}

/* ------------------------------------------------------------------ *
 * 准备：源码、编译、host 侧镜像
 * ------------------------------------------------------------------ */

const source = await readFile(CLIENT_ENTRY, 'utf8')
const manifest = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8'))

const config = await importBundle(await bundleHost({ entry: 'host/config.ts', outfile: '.tmp/client/logic-host-config.mjs' }))
const catalog = await importBundle(await bundleHost({ entry: 'host/catalog.ts', outfile: '.tmp/client/logic-host-catalog.mjs' }))

/* ------------------------------------------------------------------ *
 * 1. 文件可编译（浏览器 bundle 的最低要求）
 * ------------------------------------------------------------------ */

// node --check 以 stdio:'ignore' 运行：本机受限模式下管道抓输出会失败，只看退出码。
let checkError = null
try {
  execFileSync(process.execPath, ['--check', CLIENT_ENTRY], { stdio: 'ignore' })
} catch (error) {
  checkError = error
}
check(checkError === null, `node --check client/index.js 失败：${checkError === null ? '' : String(checkError.message)}`)

// vm.Script 编译：证明它是一个自洽的脚本/模块体（与 --check 互为独立证据）。
let compileError = null
try {
  // eslint-disable-next-line no-new
  new Script(source, { filename: CLIENT_ENTRY })
} catch (error) {
  compileError = error
}
check(compileError === null, `client/index.js 无法被 vm.Script 编译：${compileError === null ? '' : String(compileError.message)}`)

const definition = evaluateClientModule(source)
check(definition !== null && typeof definition === 'object', 'client/index.js 必须调用 window.__ModuleLoader__.load 且传入记录')
check(typeof definition?.factory === 'function', 'load 记录必须带 factory 函数')

/* ------------------------------------------------------------------ *
 * 2. 插件 id 必须等于 package.json 的包名
 * ------------------------------------------------------------------ */

// id 是宿主定位这个 bundle 的唯一键：写错就挂不上任何页面。
check(definition?.id === manifest.name, `load id 应等于包名 ${manifest.name}，实际 ${String(definition?.id)}`)
check(manifest.name === 'dsh-jev-gate', `package.json name 应为 dsh-jev-gate，实际 ${String(manifest.name)}`)

/* ------------------------------------------------------------------ *
 * 3. factory 产出与 inject 服务清单
 * ------------------------------------------------------------------ */

const moduleRecord = { exports: {} }
const produced = definition.factory(makeStubRequire(), moduleRecord, moduleRecord.exports)
const api = produced ?? moduleRecord.exports

check(typeof api === 'object' && api !== null, 'factory 必须返回 exports 对象')
check(typeof api.apply === 'function', 'exports.apply 必须是函数')
check(Array.isArray(api.inject), 'exports.inject 必须是服务名数组')
// inject 就是发布出去的依赖清单；与源码逐项比对（五个名字，含子服务 remote.credentials）。
check(
  sameJson(api.inject, ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']),
  `inject 服务清单不符：${JSON.stringify(api.inject)}`,
)
// 槽位/命名空间常量：宿主与客户端必须共用同一批字符串。
check(api.SLOT === 'plugins.row.config', `SLOT 应为 plugins.row.config，实际 ${String(api.SLOT)}`)
check(api.NS === 'dsh-jev-gate.settings', `NS 应为 dsh-jev-gate.settings，实际 ${String(api.NS)}`)
check(api.ENTRY_NS === 'dsh-jev-gate', `ENTRY_NS 应为 dsh-jev-gate，实际 ${String(api.ENTRY_NS)}`)
check(api.ROW_KEY === 'dsh-jev-gate#dsh-jev-gate', `ROW_KEY 应为 dsh-jev-gate#dsh-jev-gate，实际 ${String(api.ROW_KEY)}`)
check(api.REF_FIELD === 'deciderCredentialRef', `REF_FIELD 应为 deciderCredentialRef，实际 ${String(api.REF_FIELD)}`)

/* ------------------------------------------------------------------ *
 * 4. 跨半镜像：volatile 字段顺序 + 决策点 ceiling
 * ------------------------------------------------------------------ */

// 字段顺序：一边改名/挪位而另一边没跟，此处必红（也正是 run-contract-check 的第二道防线）。
check(Array.isArray(api.FIELDS), 'exports.FIELDS 必须是数组')
check(
  sameJson(api.FIELDS, config.VOLATILE_FIELDS),
  `client FIELDS 与 host VOLATILE_FIELDS 不一致：\n  client=${JSON.stringify(api.FIELDS)}\n  host  =${JSON.stringify(config.VOLATILE_FIELDS)}`,
)
check(api.FIELDS.length === 22, `client FIELDS 应有 22 个字段，实际 ${api.FIELDS.length}`)
check(new Set(api.FIELDS).size === api.FIELDS.length, 'client FIELDS 存在重复字段')

// 决策点 ceiling：UI 展示的"最多能做什么"必须与 host 的判定完全一致。
const hostCeilings = {}
for (const [id, point] of Object.entries(catalog.DECISION_POINTS)) hostCeilings[id] = point.ceiling
check(Array.isArray(Object.keys(api.DECISION_POINTS)), 'exports.DECISION_POINTS 必须是对象')
check(
  sameJson(Object.keys(api.DECISION_POINTS), Object.keys(catalog.DECISION_POINTS)),
  `client DECISION_POINTS 键顺序与 host 不一致：\n  client=${JSON.stringify(Object.keys(api.DECISION_POINTS))}\n  host  =${JSON.stringify(Object.keys(catalog.DECISION_POINTS))}`,
)
check(
  sameJson(api.DECISION_POINTS, hostCeilings),
  `client DECISION_POINTS 的 ceiling 与 host 不一致：\n  client=${JSON.stringify(api.DECISION_POINTS)}\n  host  =${JSON.stringify(hostCeilings)}`,
)

// 秘密字段与配置字段是两套命名空间：密钥字段是凭据（写进凭据服务），
// 不是 volatile 配置字段。源码如此设计，故断言"两者不相交"而不是"包含于"。
check(Array.isArray(api.SECRET_FIELDS), 'exports.SECRET_FIELDS 必须是数组')
check(sameJson(api.SECRET_FIELDS, ['deciderApiKey']), `SECRET_FIELDS 应为 ['deciderApiKey']，实际 ${JSON.stringify(api.SECRET_FIELDS)}`)
check(
  api.SECRET_FIELDS.every((field) => !api.FIELDS.includes(field)),
  `SECRET_FIELDS 不得混进 volatile 配置字段：${JSON.stringify(api.SECRET_FIELDS)}`,
)
// 凭据引用名则必须是配置字段（用户要在表单里改它）。
check(api.FIELDS.includes(api.REF_FIELD), `REF_FIELD ${api.REF_FIELD} 必须是 volatile 配置字段`)

// 枚举选项镜像：UI 下拉框的取值集合必须与 host 的枚举逐一相同。
check(sameJson(api.MODE_OPTIONS, config.MODES), `MODE_OPTIONS 与 host MODES 不一致：${JSON.stringify(api.MODE_OPTIONS)}`)
check(sameJson(api.KIND_OPTIONS, config.DECIDER_KINDS), `KIND_OPTIONS 与 host DECIDER_KINDS 不一致：${JSON.stringify(api.KIND_OPTIONS)}`)
check(sameJson(api.AUTHORITY_OPTIONS, config.DECIDER_AUTHORITIES), `AUTHORITY_OPTIONS 与 host DECIDER_AUTHORITIES 不一致：${JSON.stringify(api.AUTHORITY_OPTIONS)}`)
check(sameJson(api.UNAVAILABLE_OPTIONS, config.UNAVAILABLE_POLICIES), `UNAVAILABLE_OPTIONS 与 host UNAVAILABLE_POLICIES 不一致：${JSON.stringify(api.UNAVAILABLE_OPTIONS)}`)
check(sameJson(api.ROLE_AWARENESS_OPTIONS, config.ROLE_POLICIES), `ROLE_AWARENESS_OPTIONS 与 host ROLE_POLICIES 不一致：${JSON.stringify(api.ROLE_AWARENESS_OPTIONS)}`)
check(sameJson(api.NARRATIVE_OPTIONS, config.NARRATIVE_POLICIES), `NARRATIVE_OPTIONS 与 host NARRATIVE_POLICIES 不一致：${JSON.stringify(api.NARRATIVE_OPTIONS)}`)

/* ------------------------------------------------------------------ *
 * 5. apply 挂载协议 + 语言表一致性
 * ------------------------------------------------------------------ */

const formPresent = makeContext()
let applyError = null
try {
  api.apply(formPresent.ctx)
} catch (error) {
  applyError = error
}
check(applyError === null, `apply(ctx) 在配置表单存在时抛错：${applyError === null ? '' : String(applyError.message)}`)
const log = formPresent.log

// locale 绑定/注册到同一个 NS，且两本语言表都发布出去。
check(log.boundNs === api.NS, `apply 应把 locale 绑定到 ${api.NS}，实际 ${String(log.boundNs)}`)
check(log.formNs === api.ENTRY_NS, `configForms.get 应查询 ${api.ENTRY_NS}，实际 ${String(log.formNs)}`)
check(sameJson(log.servedNs, [api.ENTRY_NS]), `whileServed 应只服务 [${api.ENTRY_NS}]，实际 ${JSON.stringify(log.servedNs)}`)
// 注册必须发生在 plugins.row.config 槽位（从源码读出的槽位 id）。
check(sameJson(log.slotInjections, [api.SLOT]), `slots.inject 应注入 ${api.SLOT}，实际 ${JSON.stringify(log.slotInjections)}`)
check(log.registrations.length === 1, `应恰好注册 1 个行页面，实际 ${log.registrations.length}`)
const registration = log.registrations[0]
check(registration?.record?.name === api.SLOT, `注册记录的 name 应为 ${api.SLOT}，实际 ${String(registration?.record?.name)}`)
check(registration?.record?.key === api.ROW_KEY, `注册记录的 key 应为 ${api.ROW_KEY}，实际 ${String(registration?.record?.key)}`)
check(registration?.record?.locale === api.NS, `注册记录的 locale 应为 ${api.NS}，实际 ${String(registration?.record?.locale)}`)
check(typeof registration?.component === 'function', '注册必须带上一个组件函数')
check(typeof registration?.record?.inject === 'function', '注册记录必须提供 inject()')

// inject() 必须给出卡片要的 hook（hooks.jevGate），否则行页面渲染时读不到状态。
let injected = null
try {
  injected = registration.record.inject()
} catch (error) {
  injected = null
}
check(injected !== null && typeof injected === 'object', 'record.inject() 必须返回 props 对象')
check(injected !== null && typeof injected.hooks === 'object' && injected.hooks !== null && 'jevGate' in injected.hooks, 'record.inject() 必须提供 hooks.jevGate')

// 凭据失效监听：凭据在其他页面被改动时这一行要刷新。
check(log.credentialHandlers.length === 1, `应注册 1 个凭据失效监听，实际 ${log.credentialHandlers.length}`)
check(log.credentialHandlers[0]?.event === 'credentials/reference-updated', `凭据失效事件名应为 credentials/reference-updated，实际 ${String(log.credentialHandlers[0]?.event)}`)
check(typeof log.credentialHandlers[0]?.handler === 'function', '凭据失效监听必须是函数')

// 清理函数（dispose）不得抛错，否则热重载会崩。
let cleanupError = null
try {
  for (const cleanup of log.cleanups) cleanup()
} catch (error) {
  cleanupError = error
}
check(cleanupError === null, `dispose 清理抛错：${cleanupError === null ? '' : String(cleanupError.message)}`)

// 语言表：en/zh 键集必须相同，且没有值是空串或原样回退成 key。
check(log.dictionaries.length === 1, `应注册 1 组语言表，实际 ${log.dictionaries.length}`)
const dictionary = log.dictionaries[0]?.dictionary
check(log.dictionaries[0]?.ns === api.NS, `语言表应注册到 ${api.NS}`)
check(dictionary !== null && typeof dictionary === 'object', '语言表必须是对象')
const enKeys = Object.keys(dictionary?.en ?? {})
const zhKeys = Object.keys(dictionary?.zh ?? {})
check(enKeys.length > 0, 'en 语言表不得为空')
check(zhKeys.length > 0, 'zh 语言表不得为空')
check(
  sameJson([...enKeys].sort(), [...zhKeys].sort()),
  `en/zh 键集不一致：\n  仅 en=${JSON.stringify(enKeys.filter((k) => !zhKeys.includes(k)))}\n  仅 zh=${JSON.stringify(zhKeys.filter((k) => !enKeys.includes(k)))}`,
)
const emptyValues = enKeys.filter((key) => {
  const en = dictionary.en[key]
  const zh = dictionary.zh[key]
  return typeof en !== 'string' || en.trim() === '' || typeof zh !== 'string' || zh.trim() === ''
})
check(emptyValues.length === 0, `语言表存在空值：${emptyValues.join(', ')}`)
// 未翻译的条目会在两种语言里都等于 key 本身（模板里会显示成裸字段名）。
const rawKeys = enKeys.filter((key) => dictionary.en[key] === key && dictionary.zh[key] === key)
check(rawKeys.length === 0, `语言表存在未翻译（value 等于 key）的条目：${rawKeys.join(', ')}`)

// 每个配置字段都必须有标签与提示，否则表单行会显示 undefined。
const missingLabels = api.FIELDS.filter((field) => !enKeys.includes(field) || !zhKeys.includes(field))
check(missingLabels.length === 0, `语言表缺少字段标签：${missingLabels.join(', ')}`)
const missingHints = api.FIELDS.filter((field) => !enKeys.includes(`${field}Hint`) || !zhKeys.includes(`${field}Hint`))
check(missingHints.length === 0, `语言表缺少字段提示：${missingHints.join(', ')}`)
// 决策点区块的三条界面文案必须在两本表里都存在（点 id 是直接渲染的字面量，
// 见 client/index.js:686-694，所以不该按 id 去找文案——那是另一套宿主侧标题）。
const pointUiKeys = ['decisionPointsHeading', 'decisionPointsHint', 'decisionPointCeiling']
const missingPointCopy = pointUiKeys.filter((key) => !enKeys.includes(key) || !zhKeys.includes(key))
check(missingPointCopy.length === 0, `语言表缺少决策点界面文案：${missingPointCopy.join(', ')}`)

/* ------------------------------------------------------------------ *
 * 6. 配置表单缺席时必须降级
 * ------------------------------------------------------------------ */

// 宿主不提供该行页面（whileServed 不回调）时：apply 不得抛错，也不得注册任何东西。
const notServed = makeContext({ served: false })
let notServedError = null
try {
  api.apply(notServed.ctx)
} catch (error) {
  notServedError = error
}
check(notServedError === null, `配置表单未被服务时 apply 抛错：${notServedError === null ? '' : String(notServedError.message)}`)
check(notServed.log.registrations.length === 0, '未被服务时不应注册行页面')
check(notServed.log.slotInjections.length === 0, '未被服务时不应注入槽位')

// configForms.get() 返回 null（该条目未被宿主注册）：apply 必须降级，不能把整个插件带崩。
// 这是一条**真契约**断言，不是烟雾测试：源码在 whileServed 之外无条件构造 JevGateForm
// （client/index.js:829 → 501 `scope.subscribe(...)`），所以这个场景会抛
// TypeError: Cannot read properties of null (reading 'subscribe')。
const noForm = makeContext({ form: 'null', served: false })
let noFormError = null
try {
  api.apply(noForm.ctx)
} catch (error) {
  noFormError = error
}
check(
  noFormError === null,
  `configForms.get() 返回 null 时 apply 抛错（缺失的表单必须降级而不是崩溃）：${noFormError === null ? '' : String(noFormError.message)}`,
)

/* ------------------------------------------------------------------ *
 * 7. 样式注入
 * ------------------------------------------------------------------ */

// 本 bundle 不注入任何样式表，因此"按 data-plugin-css 去重"在这里不适用。
// 断言写成"确实没有样式注入"，避免将来有人加了注入却没人管去重。
check(!source.includes('data-plugin-css'), 'client 不应存在 data-plugin-css 去重属性（当前源码没有样式注入）')
check(!/createElement\(\s*['"]style['"]/.test(source), 'client 不应动态创建 <style> 元素')
// 连 document 都不引用：证明这个 bundle 完全不碰 DOM/CSS，去重需求自然不存在。
check(!/\bdocument\s*\./.test(source), 'client 不应直接操作 document（当前源码无任何 DOM 注入）')

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

if (failed > 0) {
  process.stderr.write(`FAIL ${NAME}: ${failed} client assertion(s) failed (${passed} passed)\n`)
} else {
  const detail = assertNonEmpty(`${passed} assertions passed`, 'assertion count')
  ok(NAME, detail)
}
