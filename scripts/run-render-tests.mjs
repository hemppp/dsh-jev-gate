#!/usr/bin/env node
/**
 * run-render-tests.mjs —— 配置面板的**真实渲染**门禁。
 *
 * ## 为什么要有这一关
 *
 * 缺陷 #2：在此之前，`client/index.js` 从未被渲染过一次。`run-client-tests.mjs`
 * 只用万能 Proxy 当 `require`，于是它证明的是「文本一致」（字段顺序、字典键集、
 * 决策点表对得上），**不是**「面板画得出来、保存按得住」。以下几类错误在文本比对
 * 下一律看不见：
 *
 * - `jsx(...)` 的参数顺序写反（`jsx(Switch, {...})` 写成了 `jsx({...}, Switch)`）；
 * - `fieldRow` 里 `props.control` 漏传 / `props.hint` 拼错键；
 * - 保存按钮永远 disabled（`state.dirty` 从没被算出来）；
 * - 密钥框在 `ref` 为空时反而可写；
 * - `SettingsFormModel` 的 stage → plan → save → 回读链路断在某一环。
 *
 * 本关把这些路径真的跑一遍，产出可断言的元素树。
 *
 * ## 方法（以及它的诚实边界）
 *
 * 真实原语包 `@deepseek-ai/dsh-client-ui-primitives` 不能在 node 里直接加载：它的
 * bundle 顶层 `import` 了 react / react-dom / shiki / katex / simple-icons /
 * micromark 系等 15+ 外部包，还带 30+ 个 CSS module。为守住「门禁只依赖 node 与本包
 * 已装依赖」这条底线，本文件里内联**逐行忠实的桩**，每个桩上方注明它对应宿主 asar
 * 里真实实现的位置（`lib/types/settings-form/*` 等）。宿主真实实现的源码已逐字核对：
 *
 *   Switch                  primitives/index.js:3394
 *   SettingsForm            primitives/index.js:6918
 *   SettingsValueField      primitives/index.js:6973
 *   SettingsSecretField     primitives/index.js:7052
 *   settingsNumberField     primitives/index.js:7110
 *   settingsTextField       primitives/index.js:7131
 *   SettingsFormModel       primitives/index.js:7151-7377
 *   createSnapshotStore     dsh-client-store
 *
 * 因此这一关证明的是：**client 半的组件树与接线正确，且与原语的公开接口契约吻合**。
 * 它不证明 CSS 长得好看——那属于真机安装验证，本轮明确不在范围内。
 *
 * 运行：node scripts/run-render-tests.mjs
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createContext, runInContext } from 'node:vm'

import { bundleHost, fail, importBundle, ok, repoRoot } from './lib/bundle.mjs'

const NAME = 'run-render-tests'
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

/* ================================================================== *
 * 1. 原语桩（逐行忠实于宿主 asar 内的真实实现）
 * ================================================================== */

/** `react/jsx-runtime` 的最小等价：元素是纯数据，key 是第三个实参。 */
const Fragment = Symbol('Fragment')
function jsx(type, props, key) {
  return { type, props: props ?? {}, key: key ?? null }
}
const jsxs = jsx

/** primitives/index.js:3394 */
function Switch({ checked, onChange, label, disabled = false, title, className }) {
  return jsx('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': checked,
    'aria-label': label,
    title,
    disabled,
    className,
    onClick: () => {
      onChange(!checked)
    },
    children: jsx('span', { className: 'switch-thumb' }),
  })
}

/** `Tag` 在真实包里只是一个带 tone 的小徽章；这里只保留渲染契约。 */
function Tag({ tone = 'quiet', children }) {
  return jsx('span', { 'data-tone': tone, children })
}

/** primitives/index.js:6918 —— 卸载时丢弃草稿的 useEffect 在桩里省略（不产生 DOM）。 */
function SettingsForm(props) {
  const { state, labels } = props
  if (!state.available) {
    return jsx('p', { role: 'status', className: 'unavailable', children: labels.unavailable })
  }
  const blocked = !state.dirty || state.invalid || state.saving
  return jsx('div', {
    className: 'form',
    children: [
      !state.writable ? jsx('p', { role: 'status', className: 'readOnly', children: labels.readOnly }) : null,
      props.children,
      jsx('div', {
        className: 'footer',
        children: [
          state.failed
            ? jsx('p', { role: 'status', className: 'failed', children: labels.saveFailed })
            : null,
          jsx('button', {
            type: 'button',
            className: 'save',
            disabled: blocked,
            onClick: props.onSave,
            children: state.saving ? labels.saving : labels.save,
          }),
        ],
      }),
    ],
  })
}

/** primitives/index.js:6973 —— client 从不传 `help`，故 help 折叠分支省去。 */
function SettingsValueField(props) {
  const messageId = `${props.id}-message`
  const hasMessage = props.invalid || Boolean(props.hint)
  return jsx('div', {
    className: 'field',
    children: [
      jsx('div', {
        className: 'head',
        children: [
          jsx('label', { className: 'label', htmlFor: props.id, children: props.label }),
          props.overridden
            ? jsx('span', {
                className: 'badges',
                children: [
                  jsx(Tag, { tone: 'neutral', children: props.overriddenLabel }),
                  jsx('button', {
                    type: 'button',
                    className: 'reset',
                    disabled: props.disabled,
                    onClick: props.onReset,
                    children: props.resetLabel,
                  }),
                ],
              })
            : null,
        ],
      }),
      jsx('input', {
        id: props.id,
        className: 'input',
        type: 'text',
        ...(props.numeric === true ? { inputMode: 'numeric' } : {}),
        ...(props.invalid ? { 'aria-invalid': true } : {}),
        'aria-describedby': hasMessage ? messageId : undefined,
        value: props.text,
        placeholder: props.placeholder ?? '',
        disabled: props.disabled,
        onChange: (event) => {
          props.onEdit(event.target.value)
        },
      }),
      hasMessage
        ? jsx('p', {
            id: messageId,
            className: props.invalid ? 'invalid' : 'hint',
            children: props.invalid ? props.invalidLabel : props.hint,
          })
        : null,
    ],
  })
}

/** primitives/index.js:7052 */
function SettingsSecretField(props) {
  return jsx('div', {
    className: 'field',
    children: [
      jsx('div', {
        className: 'head',
        children: [
          jsx('label', { className: 'label', htmlFor: props.id, children: props.label }),
          jsx('span', {
            className: 'badges',
            children: jsx(Tag, { tone: props.configured ? 'neutral' : 'quiet', children: props.stateLabel }),
          }),
        ],
      }),
      jsx('input', {
        id: props.id,
        className: 'input',
        type: 'password',
        autoComplete: 'new-password',
        value: props.text,
        disabled: props.disabled,
        onChange: (event) => {
          props.onEdit(event.target.value)
        },
      }),
      jsx('p', { className: 'hint', children: props.hint }),
    ],
  })
}

/** primitives/index.js:7110 */
function settingsNumberField(field) {
  return {
    field,
    format: (value) => (typeof value === 'number' ? String(value) : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : void 0
    },
  }
}

/** primitives/index.js:7131 */
function settingsTextField(field) {
  return {
    field,
    format: (value) => (typeof value === 'string' ? value : ''),
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
    },
  }
}

/** `createSnapshotStore`（@deepseek-ai/dsh-client-store）的等价物。 */
function createSnapshotStore(init) {
  let snapshot = init
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    update(updater) {
      snapshot = typeof updater === 'function' ? updater(snapshot) : updater
      for (const listener of listeners) listener()
    },
    set(next) {
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

/** primitives/index.js:7151-7377 */
const SettingsFormModel = class {
  constructor(scope, specs, secrets = []) {
    this.scope = scope
    this.specs = new Map(specs.map((spec) => [spec.field, spec]))
    this.secretSpecs = new Map(secrets.map((spec) => [spec.field, spec]))
    this.staged = new Map()
    this.listeners = new Set()
    this.baseline = void 0
    this.unsubscribe = scope.subscribe(() => {
      this.publish()
    })
    this.saving = false
    this.failed = false
  }

  bind(project) {
    const store = createSnapshotStore(project())
    this.listeners.add(() => {
      store.set(project())
    })
    return store
  }

  shell() {
    const snapshot = this.scope.getSnapshot()
    const plan = this.plan()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some((item) => item.run === void 0 && item.op === void 0),
      saving: this.saving,
      failed: this.failed,
    }
  }

  field(field) {
    const staged = this.staged.get(field)
    if (this.secretSpecs.has(field)) {
      return { text: staged?.text ?? '', overridden: false, invalid: false }
    }
    const spec = this.spec(field)
    if (staged === void 0) {
      return {
        text: spec.format(this.sectionValue(field)),
        overridden: this.stored(field),
        invalid: false,
      }
    }
    const write = staged.clear ? { kind: 'clear' } : spec.parse(staged.text)
    return {
      text: staged.text,
      overridden: write?.kind === 'set',
      invalid: write === void 0,
    }
  }

  actions() {
    return {
      edit: (field, text) => {
        this.stage(field, { text, clear: false })
      },
      resetField: (field) => {
        this.stage(field, { text: this.spec(field).format(this.baseValue(field)), clear: true })
      },
      save: () => {
        void this.save()
      },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.baseline = void 0
        this.failed = false
        this.publish()
      },
    }
  }

  async save() {
    const plan = this.plan()
    if (
      !plan.length ||
      this.saving ||
      !this.scope.getSnapshot().writable ||
      plan.some((item) => item.run === void 0 && item.op === void 0)
    ) {
      return
    }
    this.saving = true
    this.failed = false
    this.publish()
    try {
      const ops = plan.flatMap((item) => (item.op === void 0 ? [] : [item.op]))
      let landed = !ops.length || (await this.scope.mutate(ops, this.baseline?.revision))
      if (!landed) {
        this.failed = true
        return
      }
      for (const item of plan) if (item.run) landed = (await item.run()) && landed
      if (landed) {
        this.staged.clear()
        this.baseline = void 0
      }
      this.failed = !landed
    } catch (_error) {
      this.failed = true
    } finally {
      this.saving = false
      this.publish()
    }
  }

  dispose() {
    this.unsubscribe()
    this.listeners.clear()
  }

  plan() {
    const plan = []
    for (const [field, staged] of this.staged) {
      const secret = this.secretSpecs.get(field)
      if (secret !== void 0) {
        const value = staged.text.trim()
        if (value !== '') plan.push({ field, run: () => secret.write(value) })
        continue
      }
      const spec = this.spec(field)
      if (staged.clear) {
        if (this.stored(field)) plan.push({ field, op: { op: 'unset', path: [field] } })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue
      const write = spec.parse(staged.text)
      if (write === void 0) plan.push({ field })
      else if (write.kind === 'clear') plan.push({ field, op: { op: 'unset', path: [field] } })
      else plan.push({ field, op: { op: 'set', path: [field], value: write.value } })
    }
    return plan
  }

  stage(field, edit) {
    this.baseline ??= this.scope.getSnapshot()
    this.staged.set(field, edit)
    this.failed = false
    this.publish()
  }

  spec(field) {
    const spec = this.specs.get(field)
    if (spec === void 0) throw new Error(`plugin card has no field ${field}`)
    return spec
  }

  snapshotOf() {
    return this.scope.getSnapshot()
  }

  sectionValue(field) {
    return this.snapshotOf().value?.[field]
  }

  baseValue(field) {
    return this.snapshotOf().base?.[field]
  }

  userLayer() {
    return this.snapshotOf().user
  }

  stored(field) {
    const user = this.userLayer()
    return user !== void 0 && Object.hasOwn(user, field)
  }

  publish() {
    for (const listener of this.listeners) listener()
  }
}

const primitives = {
  SettingsForm,
  SettingsFormModel,
  SettingsSecretField,
  SettingsValueField,
  Switch,
  settingsNumberField,
  settingsTextField,
}

/* ================================================================== *
 * 2. 渲染器：函数组件递归求值 → 元素树 → 确定性 HTML
 * ================================================================== */

/**
 * 展开函数组件，产出宿主元素构成的树（`{type, props, children}`，type 为字符串）。
 * 数组 children 原样保留，方便断言时按顺序遍历。
 */
function resolveTree(node) {
  if (Array.isArray(node)) return node.map((child) => resolveTree(child))
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (typeof node.type === 'function') return resolveTree(node.type(node.props ?? {}))
  return {
    type: node.type,
    props: node.props ?? {},
    children: resolveTree(node.props?.children),
  }
}

const ATTRIBUTE_NAMES = { className: 'class', htmlFor: 'for', inputMode: 'inputmode', autoComplete: 'autocomplete' }

// React 的行内样式在真实渲染里会变成 style 属性。门禁要看的是**结构与文案**，
// 不是像素，所以这里取第一条声明来占位——足以断言「这个节点带行内样式」，
// 又不至于在 HTML 里刷出一片 [object Object]。
function serializeStyle(style) {
  return Object.entries(style)
    .map(([name, value]) => `${name.replaceAll(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${value}`)
    .join('; ')
}

function serializeAttributes(props) {
  const parts = []
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || value === null || value === undefined) continue
    // `disabled` 之类的布尔属性写 false 时应当整个消失，但 aria-* 必须原样写出
    // 「false」——`aria-checked="false"` 与「没有 aria-checked」对读屏软件是两件事。
    if (value === false && !key.startsWith('aria-')) continue
    if (key === 'style' && typeof value === 'object') {
      parts.push(`style="${serializeStyle(value)}"`)
      continue
    }
    const name = ATTRIBUTE_NAMES[key] ?? key
    if (value === true) parts.push(name)
    else parts.push(`${name}="${String(value).replaceAll('"', '&quot;')}"`)
  }
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`
}

/** 出确定性 HTML，供抽样比对与失败诊断。 */
function toHtml(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(toHtml).join('')
  return `<${node.type}${serializeAttributes(node.props)}>${toHtml(node.children)}</${node.type}>`
}

/** 深度优先遍历所有宿主元素节点。 */
function findAll(node, predicate) {
  const found = []
  const walk = (current) => {
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    if (current === null || current === undefined || typeof current !== 'object') return
    if (typeof current.type !== 'string') return
    if (predicate(current)) found.push(current)
    walk(current.children)
  }
  walk(node)
  return found
}

function findByTag(tree, tag) {
  return findAll(tree, (node) => node.type === tag)
}

function findById(tree, id) {
  return findAll(tree, (node) => node.props.id === id)[0] ?? null
}

/** 元素内的纯文本内容（拼接所有文本后代）。 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

/** 整个树的文本内容。 */
function treeText(tree) {
  return textOf(tree)
}

/* ================================================================== *
 * 3. 宿主侧替身：config scope / locale / credentials / slots
 * ================================================================== */

/**
 * 结构完整的 config-form scope：`{status, writable, value, base?, user?, revision}`。
 *
 * `mutate` 把 op 应用到 user 层（设置面的覆盖层）并推进 revision——这正是宿主
 * 「有效值 = user 层盖住 base 层」的语义，`SettingsFormModel.stored()` 判的就是
 * user 层有没有这个键。
 */
function makeScope({ base, user = {}, writable = true, status = 'ready', mutateFails = false } = {}) {
  const state = {
    status,
    writable,
    base,
    user: { ...user },
    value: { ...base, ...user },
    revision: 1,
  }
  const listeners = new Set()
  return {
    log: { mutates: [] },
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    mutate(ops, revision) {
      this.log.mutates.push({ ops, revision })
      if (mutateFails) return Promise.resolve(false)
      if (revision !== void 0 && revision !== state.revision) return Promise.resolve(false)
      for (const op of ops) {
        const field = op.path[0]
        if (op.op === 'set') state.user[field] = op.value
        else if (op.op === 'unset') delete state.user[field]
      }
      state.value = { ...state.base, ...state.user }
      state.revision += 1
      for (const listener of listeners) listener()
      return Promise.resolve(true)
    },
    /** 宿主侧另一次写入（别的页面改了同一份设置）：通知订阅者。 */
    patchUser(field, value) {
      state.user[field] = value
      state.value = { ...state.base, ...state.user }
      state.revision += 1
      for (const listener of listeners) listener()
    },
  }
}

/** 会真正查字典的 locale 服务：缺键立刻抛错（缺字典必须在这里变红，而不是显示 "undefined"）。 */
function makeLocale() {
  const dictionaries = new Map()
  let current = 'zh'
  return {
    dictionaries,
    setLocale(next) {
      current = next
    },
    locale: {
      register(ns, dictionary) {
        dictionaries.set(ns, dictionary)
      },
      bind(ns) {
        return (key) => {
          const dictionary = dictionaries.get(ns)?.[current]
          const value = dictionary?.[key]
          if (typeof value !== 'string' || value === '') {
            throw new Error(`missing translation ${ns}.${current}.${key}`)
          }
          return value
        }
      },
    },
  }
}

function makeContext(scope, { form = 'scope' } = {}) {
  const localeService = makeLocale()
  const registered = []
  const credentialCalls = { describe: [], set: [] }
  /** 凭据服务的状态：哪些引用名下面已经配了密钥。 */
  const credentials = new Set()
  const log = {
    boundNs: [],
    servedNs: [],
    formNs: [],
    dictionaries: [],
    effects: [],
    cleanups: [],
    slotInjections: [],
    credentialHandlers: [],
    registered,
    credentialCalls,
  }
  const ctx = {
    effect(fn, label) {
      log.effects.push(label)
      const cleanup = fn()
      if (typeof cleanup === 'function') log.cleanups.push(cleanup)
      return cleanup
    },
    locale: {
      bind(ns) {
        log.boundNs.push(ns)
        return localeService.locale.bind(ns)
      },
      register(ns, dictionary) {
        log.dictionaries.push({ ns, dictionary })
        localeService.locale.register(ns, dictionary)
      },
    },
    remote: {
      $on(event, handler) {
        log.credentialHandlers.push({ event, handler })
        return () => {}
      },
      credentials: {
        async describe(refs) {
          credentialCalls.describe.push([...refs])
          const value = {}
          for (const ref of refs) value[ref] = { configured: credentials.has(ref), writable: true }
          return { ok: true, value }
        },
        async set(ref, key) {
          credentialCalls.set.push([ref, key])
          if (typeof key === 'string' && key !== '') credentials.add(ref)
        },
      },
    },
    configForms: {
      get(ns) {
        log.formNs.push(ns)
        return form === 'null' ? null : scope
      },
      whileServed(namespaces, fn) {
        // 宿主传进来的是命名空间数组；展开后与单值一起记录，便于逐项断言。
        log.servedNs.push(...namespaces)
        return fn()
      },
    },
    slots: {
      inject(name, fn) {
        log.slotInjections.push(name)
        return fn()
      },
      register(record, component) {
        registered.push({ record, component })
        return () => {}
      },
    },
  }
  return { ctx, log, locale: localeService }
}

/** 让所有 pending 的 promise 落定（save / describe / writeKey 都是 async）。 */
async function flush() {
  for (let round = 0; round < 8; round += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/* ================================================================== *
 * 4. 装载 client 半
 * ================================================================== */

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

const source = await readFile(CLIENT_ENTRY, 'utf8')
const definition = evaluateClientModule(source)
check(definition !== null && typeof definition === 'object', 'client/index.js 必须调用 window.__ModuleLoader__.load 并传入记录')

const moduleRecord = { exports: {} }
const api = definition.factory(
  (id) => {
    if (id === 'react/jsx-runtime') return { Fragment, jsx, jsxs }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`渲染测试没有为 ${id} 提供模块`)
  },
  moduleRecord,
  moduleRecord.exports,
) ?? moduleRecord.exports

check(typeof api.apply === 'function', 'exports.apply 必须是函数')

// 真实默认值取自 host/config.ts：面板打开时画出来的就是这些值，不是桩里编的数。
const hostConfig = await importBundle(
  await bundleHost({ entry: 'host/config.ts', outfile: '.tmp/render/logic-host-config.mjs' }),
)
const DEFAULTS = hostConfig.DEFAULT_CONFIG

/**
 * 按宿主槽位机器的约定把 `inject()` 的东西接成组件 props：
 * `hooks.jevGate` → `useJevGate(selector)`，`view`/`t` 由宿主提供。
 */
function mountPanel(scope, options = {}) {
  const { ctx, log, locale } = makeContext(scope, options)
  api.apply(ctx)
  const entry = log.registered[0]
  // 宿主不提供这个配置表单时根本没有面板——那一路断言只该看「没注册」，
  // 不该顺手去取一条并不存在的记录。
  if (entry === undefined) return { ctx, log, locale, props: null, entry: null, render: () => null, html: () => '' }
  const injected = entry.record.inject()
  const props = {
    view: options.view,
    t: locale.locale.bind(api.NS),
    useJevGate: (selector) => selector(injected.hooks.jevGate.getSnapshot()),
    edit: injected.edit,
    resetField: injected.resetField,
    save: injected.save,
    discard: injected.discard,
  }
  return {
    ctx,
    log,
    locale,
    props,
    entry,
    /** 每次调用都重新渲染：函数组件重新执行，snapshot 重新读。 */
    render: () => resolveTree(jsx(entry.component, props)),
    html: () => toHtml(resolveTree(jsx(entry.component, props))),
  }
}

/* ================================================================== *
 * 5. 挂载协议
 * ================================================================== */

const probeScope = makeScope({ base: DEFAULTS })
const panel = mountPanel(probeScope)

check(sameJson(panel.log.boundNs, [api.NS]), `locale.bind 应只绑定 ${api.NS}，实际 ${JSON.stringify(panel.log.boundNs)}`)
check(sameJson(panel.log.dictionaries.map((entry) => entry.ns), [api.NS]), '必须注册且只注册一个字典命名空间')
check(
  sameJson(panel.log.dictionaries[0]?.dictionary && Object.keys(panel.log.dictionaries[0].dictionary), ['zh', 'en']),
  '字典必须同时带 zh 与 en',
)
check(sameJson(panel.log.servedNs, [api.ENTRY_NS]), `whileServed 应以 ${api.ENTRY_NS} 为准`)
check(sameJson(panel.log.formNs, [api.ENTRY_NS]), `configForms.get 应取 ${api.ENTRY_NS}`)
check(sameJson(panel.log.slotInjections, [api.SLOT]), `槽位名应为 ${api.SLOT}`)
check(panel.log.registered.length === 1, `槽位应只注册一条记录，实际 ${panel.log.registered.length}`)
check(panel.entry.record.key === api.ROW_KEY, `记录 key 应为 ${api.ROW_KEY}，实际 ${String(panel.entry.record.key)}`)
check(panel.entry.record.locale === api.NS, '记录应声明自己的字典命名空间')
check(panel.entry.record.name === api.SLOT, '记录 name 应等于槽位名')
check(typeof panel.entry.component === 'function', '槽位应注册一个组件函数')
check(
  sameJson(panel.log.effects, ['dsh-jev-gate: dictionaries', 'dsh-jev-gate: form subscription', 'dsh-jev-gate: credential invalidations', 'dsh-jev-gate: row page']),
  `effect 清单不符：${JSON.stringify(panel.log.effects)}`,
)
check(
  sameJson(panel.log.credentialHandlers.map((handler) => handler.event), ['credentials/reference-updated']),
  '必须订阅凭据失效事件',
)

const injected = panel.entry.record.inject()
check(injected !== null && typeof injected === 'object', 'inject() 应返回一个对象')
check(injected.hooks !== null && typeof injected.hooks === 'object' && injected.hooks.jevGate !== undefined, 'inject() 必须交出 jevGate 这个 hook store')
check(typeof injected.hooks.jevGate.getSnapshot === 'function', 'hook store 必须能取快照')
check(typeof injected.hooks.jevGate.subscribe === 'function', 'hook store 必须能被订阅')
check(
  ['edit', 'resetField', 'save', 'discard'].every((name) => typeof injected[name] === 'function'),
  `inject() 必须交出四个动作：${JSON.stringify(Object.keys(injected))}`,
)

// 宿主停止提供该配置表单时不得建卡（这是真机上「不装插件的部署不该看到面板」的保证）。
{
  const absent = mountPanel(probeScope, { form: 'null' })
  check(absent.log.registered.length === 0, 'configForms.get 返回 null 时不得注册任何面板')
}

/* ================================================================== *
 * 6. summary 视图
 * ================================================================== */

{
  const summary = mountPanel(probeScope, { view: 'summary' })
  const rendered = summary.render()
  check(typeof rendered === 'string', 'summary 视图应直接返回一个字符串（不是元素树）')
  check(
    rendered === summary.locale.locale.bind(api.NS)('description'),
    `summary 视图应返回 description 文案，实际 ${JSON.stringify(rendered)}`,
  )
}

/* ================================================================== *
 * 7. 完整表单的结构
 * ================================================================== */

const form = panel.render()

const headings = findByTag(form, 'h4').map((node) => textOf(node))
check(
  sameJson(headings, ['闸口', '外部裁决器', '规则覆盖']),
  `三个分区标题应按 FIELD_ROWS 的 section 顺序出现，实际 ${JSON.stringify(headings)}`,
)

const labels = findByTag(form, 'label').map((node) => node.props.htmlFor)
// 密钥框的 label 夹在 `deciderCredentialRef` 与 `deciderAuthority` 之间——面板就是把它
// 插在引用名那一行后面的。这条断言顺带钉住了这个位置。
check(
  sameJson(labels, [...api.FIELDS.slice(0, api.FIELDS.indexOf(api.REF_FIELD) + 1), api.SECRET_FIELDS[0], ...api.FIELDS.slice(api.FIELDS.indexOf(api.REF_FIELD) + 1)]),
  `23 个 label 应按 FIELD_ROWS 顺序出现、密钥框紧随引用名，实际 ${JSON.stringify(labels)}`,
)
check(labels.length === 23, `面板应有 22 个配置字段 + 1 个密钥框的 label，实际 ${labels.length}`)

for (const field of ['enabled', 'persistEnabled', 'interveneAtStateTransition', 'interveneAtPreFinish', 'requireBaseline']) {
  const control = findByTag(form, 'button').filter((node) => node.props['aria-label'] === findById(form, field)?.props !== void 0)
  void control
}

// 每个 bool 字段：label 之后必须是一个 role=switch 的按钮，其 aria-checked 等于默认值。
const switches = findByTag(form, 'button').filter((node) => node.props.role === 'switch')
check(switches.length === 5, `应有 5 个开关，实际 ${switches.length}`)
check(
  sameJson(switches.map((node) => node.props['aria-checked']), [false, true, true, true, true]),
  `开关初值应等于 DEFAULT_CONFIG，实际 ${JSON.stringify(switches.map((node) => node.props['aria-checked']))}`,
)
check(
  sameJson(
    switches.map((node) => node.props['aria-label']),
    ['启用', '持久化账本', '拦停状态转移', '拦停回合收尾', '必须有冻结基线'],
  ),
  '每个开关的可访问名应是该字段的标签',
)
check(
  switches.every((node) => node.props.type === 'button' && node.props.disabled === false),
  '可写部署里开关不应是 disabled',
)

// 每个 choice 字段：<select> 的选项必须正好等于该字段的合法取值。
const selects = findByTag(form, 'select')
check(selects.length === 6, `应有 6 个下拉框，实际 ${selects.length}`)
check(
  sameJson(selects.map((node) => node.props.id), ['mode', 'onUnavailable', 'roleAwareness', 'narrativeWatch', 'deciderKind', 'deciderAuthority']),
  `下拉框 id 应覆盖 6 个枚举字段，实际 ${JSON.stringify(selects.map((node) => node.props.id))}`,
)
for (const [id, options] of [
  ['mode', api.MODE_OPTIONS],
  ['onUnavailable', api.UNAVAILABLE_OPTIONS],
  ['roleAwareness', api.ROLE_AWARENESS_OPTIONS],
  ['narrativeWatch', api.NARRATIVE_OPTIONS],
  ['deciderKind', api.KIND_OPTIONS],
  ['deciderAuthority', api.AUTHORITY_OPTIONS],
]) {
  const select = findById(form, id)
  const rendered = findAll(select.children, (node) => node.type === 'option').map((node) => node.props.value)
  check(sameJson(rendered, [...options]), `${id} 的选项应等于 ${JSON.stringify(options)}，实际 ${JSON.stringify(rendered)}`)
  check(select.props.value === DEFAULTS[id], `${id} 的当前值应等于默认值 ${DEFAULTS[id]}`)
}

// 数字字段：numeric 只影响 inputMode，且必须真的落在四个数字字段上。
const numeric = findByTag(form, 'input').filter((node) => node.props.inputMode === 'numeric')
check(
  sameJson(numeric.map((node) => node.props.id), ['minConfidence', 'maxGapsPerIntervention', 'debounceMs', 'deciderMaxQuestions']),
  `四个数字字段才该有 inputMode=numeric，实际 ${JSON.stringify(numeric.map((node) => node.props.id))}`,
)
for (const node of numeric) check(node.props.value === String(DEFAULTS[node.props.id]), `${node.props.id} 的初值应是 ${DEFAULTS[node.props.id]}`)

// 文本输入框：11 个（4 个数字字段在原语里同样是 type="text"，靠 inputMode 区分）。
const textInputs = findByTag(form, 'input').filter((node) => node.props.type === 'text')
check(
  sameJson(textInputs.map((node) => node.props.id), [
    'minConfidence',
    'maxGapsPerIntervention',
    'stateDir',
    'debounceMs',
    'deciderProvider',
    'deciderModel',
    'deciderBaseUrl',
    'deciderEndpointPath',
    'deciderCredentialRef',
    'deciderMaxQuestions',
    'rulesJson',
  ]),
  `文本输入框应有 11 个且顺序正确，实际 ${JSON.stringify(textInputs.map((node) => node.props.id))}`,
)
check(findById(form, 'stateDir').props.value === '.dsh-jev-gate', '账本目录初值应取默认值')
check(findById(form, 'deciderEndpointPath').props.value === '/v1/systemone', '接口路径初值应取默认值')

// 密钥框：紧跟在凭据引用名那一行之后，是 password，且 ref 为空时不可写。
const secret = findById(form, api.SECRET_FIELDS[0])
check(secret !== null, '必须渲染密钥输入框')
check(secret.props.type === 'password', '密钥框必须是 type=password')
check(secret.props.autoComplete === 'new-password', '密钥框应劝浏览器别拿登录密码来填')
check(secret.props.disabled === true, '凭据引用名为空时密钥框必须不可写（否则密钥存不到任何名字下）')
// 提示文字是密钥框所在 div 里的 p（`SettingsSecretField` 自己的 hint），不是包着它的
// fieldRow 段落——所以按「input 的父节点」取，而不是在整棵树里搜。
const secretField = findAll(form, (node) => node.type === 'div').filter((node) => findById(node, api.SECRET_FIELDS[0]) !== null)[0]
const secretParagraphs = findByTag(secretField, 'p').map((node) => textOf(node))
check(
  secretParagraphs.some((line) => line.includes('请先在上面填凭据引用名')),
  `ref 为空时密钥框的提示必须说明要先填引用名，实际 ${JSON.stringify(secretParagraphs)}`,
)
check(
  treeText(form).includes('这个引用名下还没有密钥。'),
  '未配置密钥时应显示「还没有密钥」',
)

// 决策点参照表：14 条，只读。
const listItems = findByTag(form, 'li')
check(listItems.length === 14, `决策点参照表应有 14 条，实际 ${listItems.length}`)
const listedPoints = listItems.map((node) => textOf(findByTag(node, 'code')[0] ?? node))
check(
  sameJson(listedPoints, Object.entries(api.DECISION_POINTS).map(([pointId, ceiling]) => `${pointId} — 默认上限: ${ceiling}`)),
  '参照表应逐条列出 pointId 与默认上限',
)

// 保存按钮：没改过任何东西时必须不可点。
const saveButtons = findByTag(form, 'button').filter((node) => node.props.className === 'save')
check(saveButtons.length === 1, '应恰好有一个保存按钮')
check(saveButtons[0].props.disabled === true, '没有改动时保存按钮必须禁用')
check(saveButtons[0].props.children === '保存', `保存按钮文案应为「保存」，实际 ${JSON.stringify(saveButtons[0].props.children)}`)
check(treeText(form).includes('本部署没有接受这些值') === false, '还没保存过就不该出现「保存失败」')

// 抽样：HTML 序列化必须是确定的、结构正确的。
{
  const html = panel.html()
  check(html.startsWith('<div class="form">'), '表单根应是 SettingsForm 的 div')
  check(html.includes('<button type="button" role="switch" aria-checked="false"'), 'HTML 里开关应带上 role 与 aria-checked')
  check(html.includes('>闸口</h4>'), 'HTML 里应能看出分区标题')
check(html.includes('role="switch"'), '开关的可访问性角色必须落到 HTML 上')
check(!html.includes('undefined') && !html.includes('[object Object]'), 'HTML 里不得出现 undefined 或 [object Object]')
  check(panel.html() === html, '同一状态两次渲染必须逐字节相同')
}

/* ================================================================== *
 * 8. 改动 → 保存 → 回读
 * ================================================================== */

{
  const scope = makeScope({ base: DEFAULTS })
  const editing = mountPanel(scope)
  let tree = editing.render()

  // 从元素树里驱动 onChange：这一条断言的是 client 自己的接线（select 的 onChange
  // → props.edit），而不是直接调 actions 绕开控件。
  findById(tree, 'mode').props.onChange({ target: { value: 'enforce' } })

  tree = editing.render()
  check(findById(tree, 'mode').props.value === 'enforce', '改动后下拉框应显示新值')
  const saveAfterEdit = findByTag(tree, 'button').filter((node) => node.props.className === 'save')[0]
  check(saveAfterEdit.props.disabled === false, '有改动后保存按钮必须可点')
  check(treeText(tree).includes('已覆盖'), '改成非默认值后应标出「已覆盖」')

  await editing.props.save()
  await flush()

  check(
    sameJson(scope.log.mutates, [{ ops: [{ op: 'set', path: ['mode'], value: 'enforce' }], revision: 1 }]),
    `保存应提交一条 set op 并带上基线 revision，实际 ${JSON.stringify(scope.log.mutates)}`,
  )
  check(scope.getSnapshot().user.mode === 'enforce', '保存后 user 层应记下新值')
  check(scope.getSnapshot().value.mode === 'enforce', '保存后有效值应变成新值')

  tree = editing.render()
  check(findById(tree, 'mode').props.value === 'enforce', '保存回读后仍应显示新值')
  check(findByTag(tree, 'button').filter((node) => node.props.className === 'save')[0].props.disabled === true, '保存成功后按钮应回到禁用')
  check(treeText(tree).includes('已覆盖'), '保存后 user 层仍持有该字段，应继续标「已覆盖」')

  // resetField 回到 base 值：暂存的是 base 的文本 + clear 标记。
  editing.props.resetField('mode')
  tree = editing.render()
  check(findById(tree, 'mode').props.value === 'dry-run', '重置后面板显示 base 值')
  await editing.props.save()
  await flush()
  check(
    sameJson(scope.log.mutates[1], { ops: [{ op: 'unset', path: ['mode'] }], revision: 2 }),
    `重置保存应提交 unset op，实际 ${JSON.stringify(scope.log.mutates[1])}`,
  )
  check(scope.getSnapshot().user.mode === undefined, 'unset 后 user 层不该再有该字段')
  tree = editing.render()
  check(treeText(tree).includes('已覆盖') === false, 'unset 后不该再标「已覆盖」')
}

/* ================================================================== *
 * 9. 数字字段：无效值挡住保存，清空即 unset
 * ================================================================== */

{
  const scope = makeScope({ base: DEFAULTS })
  const numericPanel = mountPanel(scope)
  let tree = numericPanel.render()

  findById(tree, 'minConfidence').props.onChange({ target: { value: 'abc' } })
  tree = numericPanel.render()
  const badInput = findById(tree, 'minConfidence')
  check(badInput.props['aria-invalid'] === true, '非法数字必须标 aria-invalid')
  // 提示语由原语渲染在 input 所在 field 容器内的 p 里。
  const badField = findAll(tree, (node) => node.type === 'div').filter((node) => findById(node, 'minConfidence') !== null).at(-1)
  check(textOf(badField).includes('请填数字'), `非法数字必须给出人话提示，实际 ${JSON.stringify(textOf(badField))}`)
  check(
    findByTag(tree, 'button').filter((node) => node.props.className === 'save')[0].props.disabled === true,
    '存在非法草稿时保存必须被挡住（宁可什么都不写，也不替用户改写输入）',
  )

  await numericPanel.props.save()
  await flush()
  check(scope.log.mutates.length === 0, '非法草稿下不得向宿主提交任何写入')
  check(badInput.props.value === 'abc', '控件不得静默改写用户输入')

  // 清空 = unset。
  findById(tree, 'minConfidence').props.onChange({ target: { value: '' } })
  tree = numericPanel.render()
  check(findById(tree, 'minConfidence').props['aria-invalid'] === undefined, '清空不是非法值')
  await numericPanel.props.save()
  await flush()
  check(
    sameJson(scope.log.mutates, [{ ops: [{ op: 'unset', path: ['minConfidence'] }], revision: 1 }]),
    `清空数字字段应提交 unset，实际 ${JSON.stringify(scope.log.mutates)}`,
  )
  check(scope.getSnapshot().user.minConfidence === undefined, 'unset 后 user 层不该保留置信度')
  check(findById(numericPanel.render(), 'minConfidence').props.value === '0.6', 'unset 后应回落到 base 值')
}

/* ================================================================== *
 * 10. 文本字段的 trim 与失败回读
 * ================================================================== */

{
  const scope = makeScope({ base: DEFAULTS })
  const textPanel = mountPanel(scope)
  let tree = textPanel.render()
  findById(tree, 'stateDir').props.onChange({ target: { value: '  ledger/  ' } })
  await textPanel.props.save()
  await flush()
  check(
    scope.getSnapshot().user.stateDir === 'ledger/',
    `文本应先 trim 再保存（内部的斜杠保留），实际 ${JSON.stringify(scope.getSnapshot().user.stateDir)}`,
  )

  // 宿主拒收：failed 置位，草稿保留，保存按钮仍可点。
  const failing = makeScope({ base: DEFAULTS, mutateFails: true })
  const failingPanel = mountPanel(failing)
  tree = failingPanel.render()
  findById(tree, 'mode').props.onChange({ target: { value: 'lockdown' } })
  await failingPanel.props.save()
  await flush()
  tree = failingPanel.render()
  check(treeText(tree).includes('本部署没有接受这些值'), '宿主拒收后必须显示失败提示')
  check(findById(tree, 'mode').props.value === 'lockdown', '失败后草稿必须保留，让用户改而不是重打')
  check(findByTag(tree, 'button').filter((node) => node.props.className === 'save')[0].props.disabled === false, '失败后仍应可重试保存')

  // discard 丢弃草稿。
  failingPanel.props.discard()
  tree = failingPanel.render()
  check(findById(tree, 'mode').props.value === 'dry-run', 'discard 后应回到原值')
  check(treeText(tree).includes('本部署没有接受这些值') === false, 'discard 后失败提示应消失')
  check(findByTag(tree, 'button').filter((node) => node.props.className === 'save')[0].props.disabled === true, 'discard 后按钮应回到禁用')
}

/* ================================================================== *
 * 11. 密钥全流程
 * ================================================================== */

{
  const scope = makeScope({ base: DEFAULTS })
  const secretPanel = mountPanel(scope)
  let tree = secretPanel.render()

  check(findById(tree, api.SECRET_FIELDS[0]).props.disabled === true, '没有引用名时密钥框不可写')
  check(secretPanel.log.credentialCalls.describe.length === 0, '引用名为空时不必去问凭据服务')

  // 先改引用名：面板应立刻解锁密钥框。
  findById(tree, 'deciderCredentialRef').props.onChange({ target: { value: 'MY_GATEWAY_KEY' } })
  await flush()
  tree = secretPanel.render()
  check(findById(tree, api.SECRET_FIELDS[0]).props.disabled === false, '填了引用名后密钥框应可写')
  check(secretPanel.log.credentialCalls.describe.length === 1, '引用名变化后应向凭据服务问一次')
  check(treeText(tree).includes('这个引用名下还没有密钥。'), '未配置时应显示「还没有密钥」')

  // 同一次保存里既改引用名又填密钥：密钥必须落到新名字下（这是 JevGateForm.refName
  // 刻意读草稿而非快照的原因）。
  findById(tree, api.SECRET_FIELDS[0]).props.onChange({ target: { value: 'sk-live-1' } })
  await secretPanel.props.save()
  await flush()

  check(
    sameJson(secretPanel.log.credentialCalls.set, [['MY_GATEWAY_KEY', 'sk-live-1']]),
    `密钥必须写到当前草稿里的引用名下，实际 ${JSON.stringify(secretPanel.log.credentialCalls.set)}`,
  )
  check(
    sameJson(secretPanel.log.credentialCalls.describe.at(-1), ['MY_GATEWAY_KEY']),
    '写入后应回读一次状态',
  )
  check(
    secretPanel.log.credentialCalls.describe.every(([ref]) => ref === 'MY_GATEWAY_KEY'),
    '任何一次 describe 都不该问空引用名',
  )
  tree = secretPanel.render()
  check(treeText(tree).includes('这个引用名下已经配了密钥。'), '写入成功后应显示「已经配了密钥」')
  check(findById(tree, api.SECRET_FIELDS[0]).props.value === '', '密钥明文不得回填进输入框')

  // 别的页面改了同一个引用 → reference-updated 应触发回读。
  const describesBefore = secretPanel.log.credentialCalls.describe.length
  for (const handler of secretPanel.log.credentialHandlers) {
    if (handler.event === 'credentials/reference-updated') handler.handler('MY_GATEWAY_KEY')
  }
  await flush()
  check(secretPanel.log.credentialCalls.describe.length === describesBefore + 1, '凭据失效事件应触发一次回读')

  // 与本面板无关的引用名不该惊动它。
  const unrelated = secretPanel.log.credentialCalls.describe.length
  for (const handler of secretPanel.log.credentialHandlers) {
    if (handler.event === 'credentials/reference-updated') handler.handler('SOMETHING_ELSE')
  }
  await flush()
  check(secretPanel.log.credentialCalls.describe.length === unrelated, '无关引用名的事件不得触发回读')
}

{
  // 把引用名清空却带着密钥草稿去保存：writeKey 返回 false，保存必须如实报失败，
  // 而不是「显示成功但密钥丢了」。
  const scope = makeScope({ base: DEFAULTS, user: { deciderCredentialRef: 'OLD_KEY' } })
  const orphanPanel = mountPanel(scope)
  let tree = orphanPanel.render()
  check(findById(tree, api.SECRET_FIELDS[0]).props.disabled === false, '已有引用名时密钥框可写')

  findById(tree, 'deciderCredentialRef').props.onChange({ target: { value: '' } })
  findById(orphanPanel.render(), api.SECRET_FIELDS[0]).props.onChange({ target: { value: 'sk-orphan' } })
  await orphanPanel.props.save()
  await flush()

  check(orphanPanel.log.credentialCalls.set.length === 0, '引用名为空时不得调用凭据写入')
  tree = orphanPanel.render()
  check(treeText(tree).includes('本部署没有接受这些值'), '密钥无处可写时必须报失败')
  check(findById(tree, 'deciderCredentialRef').props.value === '', '失败后引用名草稿应保留')
}

/* ================================================================== *
 * 12. 宿主侧的两个降级态
 * ================================================================== */

{
  const unavailableScope = makeScope({ base: DEFAULTS, status: 'loading' })
  const unavailable = mountPanel(unavailableScope)
  const tree = unavailable.render()
  const statuses = findByTag(tree, 'p').filter((node) => node.props.role === 'status')
  check(statuses.length === 1, `未就绪时应只有一条状态说明，实际 ${statuses.length}`)
  check(textOf(statuses[0]) === '该条目当前未加载，暂时无法配置。', `状态文案不对：${JSON.stringify(textOf(statuses[0]))}`)
  check(findByTag(tree, 'input').length === 0, '未就绪时不得画出会写不进去的控件')
  check(findByTag(tree, 'button').length === 0, '未就绪时不得画保存按钮')
}

{
  const readOnlyScope = makeScope({ base: DEFAULTS, writable: false })
  const readOnly = mountPanel(readOnlyScope)
  const tree = readOnly.render()
  check(treeText(tree).includes('本部署的设置为只读。'), '只读部署必须说明这一点')
  check(
    findByTag(tree, 'input').every((node) => node.props.disabled === true),
    '只读部署里所有输入框都应禁用',
  )
  check(
    findByTag(tree, 'select').every((node) => node.props.disabled === true),
    '只读部署里所有下拉框都应禁用',
  )
  check(
    findByTag(tree, 'button').filter((node) => node.props.role === 'switch').every((node) => node.props.disabled === true),
    '只读部署里所有开关都应禁用',
  )
  check(
    findByTag(tree, 'button').filter((node) => node.props.className === 'save')[0].props.disabled === true,
    '只读部署里不得有可点的保存',
  )

  // 只读下即使用户（经注入的 action）改了东西，也一个字节都不该写出去。
  readOnly.props.edit('mode', 'enforce')
  await readOnly.props.save()
  await flush()
  check(readOnlyScope.log.mutates.length === 0, '只读部署不得提交任何写入')
}

/* ================================================================== *
 * 13. 语言切换
 * ================================================================== */

{
  const scope = makeScope({ base: DEFAULTS })
  const localized = mountPanel(scope)
  localized.locale.setLocale('en')
  const tree = localized.render()
  const headings = findByTag(tree, 'h4').map((node) => textOf(node))
  check(sameJson(headings, ['Gate', 'External decider', 'Rule overrides']), `切到 en 后分区标题应变英文，实际 ${JSON.stringify(headings)}`)
  check(findByTag(tree, 'button').filter((node) => node.props.className === 'save')[0].props.children === 'Save', '切到 en 后保存按钮应为 Save')
  const points = findByTag(tree, 'li')[0]
  check(textOf(points).includes('default ceiling'), '切到 en 后决策点表的列名应变英文')
  check(findByTag(tree, 'label').some((node) => textOf(node) === 'Ledger directory'), '切到 en 后字段标签应变英文')
}

/* ================================================================== *
 * 14. 收尾
 * ================================================================== */

if (failed === 0) ok(NAME, `${passed} 条断言全通过（配置面板真实渲染：结构、保存、密钥、降级态）`)
else fail(NAME, `${failed} 条断言失败（共 ${passed + failed} 条）`)