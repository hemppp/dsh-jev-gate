/**
 * dsh-jev-gate — browser half: the configuration panel for this row on the Plugins page.
 *
 * ## Why this slot, and why this key
 *
 * The host dispatches three slots per Loader entry on the Plugins page:
 * `plugins.item` (the official plugin card), `plugins.bundle.config` (keyed by
 * bundle package name) and `plugins.row.config` (keyed by `<package name>#<row id>`,
 * which gives that one row a Configure control). This plugin is a profile bundle
 * whose own `cordis.patch.yml` row *is* its settings surface, so it registers into
 * `plugins.row.config` with the key `dsh-jev-gate#dsh-jev-gate` — package name and
 * row id are both `dsh-jev-gate`.
 *
 * ## Why every field is flat
 *
 * The panel is driven by the host's own `SettingsFormModel`, which hands each
 * field name to settings as a **single-segment path** (`path: [field]`). A nested
 * name such as `decider.baseUrl` therefore cannot be written — the host answers
 * `Config field "decider.baseUrl" is not volatile`. That is exactly why
 * `host/config.ts` flattens the decider settings into top-level fields
 * (`deciderKind` / `deciderProvider` / `deciderModel` / `deciderBaseUrl` /
 * `deciderEndpointPath` / `deciderCredentialRef` / `deciderAuthority` /
 * `deciderMaxQuestions`), and why the per-decision-point overrides arrive as a
 * single JSON string (`rulesJson`) rather than as a nested array of objects.
 *
 * ## Where the key goes
 *
 * The API key is **not** a config field and never reaches the settings file or any
 * response. Saving writes it through `ctx.remote.credentials.set(<reference>, <key>)`
 * into the host credential service (`$DSH_HOME/.credentials.yaml`), while
 * `deciderCredentialRef` keeps only that **name**. The page can ever learn only
 * whether a value exists under the reference — reading plaintext back is not
 * possible, by the credential service's own guarantee, not by choice here.
 *
 * So one "Save" does two things at once: it writes configuration into settings,
 * and it writes the secret into the credential service.
 */

window.__ModuleLoader__.load({
  id: 'dsh-jev-gate',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    let react_jsx_runtime = require('react/jsx-runtime')
    let primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const { jsx, jsxs } = react_jsx_runtime
    const {
      SettingsForm,
      SettingsFormModel,
      SettingsSecretField,
      SettingsValueField,
      Switch,
      settingsNumberField,
      settingsTextField,
    } = primitives

    /**
     * The settings namespace of this row.
     *
     * The host claims settings forms by **profile entry id**: `describe()` treats
     * `entry.options.id` as the namespace, and a plugin can neither register one of
     * its own nor choose a different one. The row this plugin inserts in
     * `cordis.patch.yml` carries the package name as its id, so both values are the
     * same string.
     */
    const ENTRY_NS = 'dsh-jev-gate'

    /** Key for `plugins.row.config`: `<package name>#<row id>`. */
    const ROW_KEY = 'dsh-jev-gate#dsh-jev-gate'

    /** Dictionary namespace of this page (unrelated to the settings namespace). */
    const NS = 'dsh-jev-gate.settings'

    /**
     * Field name of the secret input. It is deliberately **not** in `FIELDS`: it is
     * local-only state with a custom writer, not a settings path.
     */
    const API_KEY_FIELD = 'deciderApiKey'

    /** Reference name the secret is stored under: the config field that carries it. */
    const REF_FIELD = 'deciderCredentialRef'

    // ─────────────────────────────────────────────────────────── dictionaries

    const en = {
      title: 'Jev gate',
      description: 'Gate team actions against a frozen baseline: baseline / host model / your own HTTP decider.',
      gateSection: 'Gate',
      gateSectionHint: 'What this gate watches, how far it may go, and what it writes down. Off by default.',
      deciderSection: 'External decider',
      deciderSectionHint:
        'The plugin ships no API and no key: each user brings their own. Nothing configured here is shared between machines.',
      rulesSection: 'Rule overrides',
      rulesSectionHint:
        'Per-decision-point overrides. They may only ever lower the force of a built-in decision point, never raise it.',

      enabled: 'Enabled',
      enabledHint: 'Off by default: a plugin that can stop a team should not start doing so the moment it is installed.',
      mode: 'Mode',
      modeHint:
        'off / dry-run (ledger only) / advisory (notes only) / enforce (the full ladder) / lockdown (read-only actions only; the ceiling is capped at a note).',
      onUnavailable: 'When the decider is unavailable',
      onUnavailableHint: 'allow (fall back to the local baseline) / ask (hand it to a human) / deny (stop the action).',
      minConfidence: 'Minimum confidence',
      minConfidenceHint:
        'Below this, an outside opinion is not acted on. Under authority=sole this threshold is the whole policy.',
      maxGapsPerIntervention: 'Gaps per intervention',
      maxGapsPerInterventionHint: 'How many gaps one intervention may spell out one by one.',
      stateDir: 'Ledger directory',
      stateDirHint:
        'Ledger directory, relative to the workspace. It must not contain ".."; an absolute path is refused and the default is used instead.',
      persistEnabled: 'Persist the ledger',
      persistEnabledHint: 'When off, verdicts live only for this session and nothing is written to disk.',
      debounceMs: 'Ledger debounce (ms)',
      debounceMsHint: 'Ledger writes are batched over this window; 0 writes immediately.',
      interveneAtStateTransition: 'Gate state transitions',
      interveneAtStateTransitionHint: 'Gate the moment a state-transferring team call is about to happen.',
      interveneAtPreFinish: 'Gate turn completion',
      interveneAtPreFinishHint: 'Gate the moment a turn is about to stop.',
      roleAwareness: 'Role awareness',
      roleAwarenessHint:
        'off / observe (record who called) / enforce (refuse an action the established role may not perform at all).',
      narrativeWatch: 'Narrative claims',
      narrativeWatchHint:
        'off / note / steer / deny: how hard to react to a completion or pass claim made only in prose, with no tool call behind it. At the turn boundary the deny option behaves like steer — there is no way to refuse prose, only to keep talking.',
      requireBaseline: 'Require a frozen baseline',
      requireBaselineHint: 'When on, a gated action is refused until a scope baseline has been frozen.',

      deciderKind: 'Decider',
      deciderKindHint:
        'baseline (local, no network) / llm (the host model service — implemented here) / endpoint (a generic HTTP decider you point at).',
      deciderProvider: 'Provider (kind=llm)',
      deciderProviderHint: 'For kind=llm: provider override. Blank follows the session own route.',
      deciderModel: 'Model id',
      deciderModelHint:
        'For kind=llm or endpoint: model id. Blank follows that kind own default — for endpoint, the gateway alias, which can move under you.',
      deciderBaseUrl: 'Base URL (kind=endpoint)',
      deciderBaseUrlHint:
        'For kind=endpoint: base URL of your own HTTP decider, for example https://gateway.example.com. Blank falls back to the documented default.',
      deciderEndpointPath: 'Endpoint path (kind=endpoint)',
      deciderEndpointPathHint: 'For kind=endpoint: path appended to the base URL.',
      deciderCredentialRef: 'Credential reference',
      deciderCredentialRefHint:
        'The NAME of the credential, not the key itself (for example MY_GATEWAY_KEY). The key goes in the field below and is stored by the credential service, never in the settings file.',
      deciderAuthority: 'Authority',
      deciderAuthorityHint:
        'advisory (default): an outside opinion may only tighten or escalate to a human. sole: the decider alone may clear a gap and let the run proceed — you are handing over the pass/fail call.',
      deciderMaxQuestions: 'Max questions per consultation',
      deciderMaxQuestionsHint: 'How many questions one decider consultation may ask.',

      rulesJson: 'Rule overrides (JSON)',
      rulesJsonHint:
        'A JSON array of overrides, for example [{"pointId":"review_verdict","ceiling":"L2_continue"}]. An empty string means no overrides; the ids below are the only ones accepted.',

      decisionPointsHeading: 'Built-in decision points',
      decisionPointsHint:
        'These are the ids `rulesJson` refers to. The default ceiling is the strongest rung a hard contradiction at that point may reach before mode and rules cap it further.',
      decisionPointCeiling: 'default ceiling',

      apiKey: 'Decider API key',
      apiKeyHint:
        'Write-only: stored in the credential service under the reference name above, never written to the settings file and never returned to any page.',
      apiKeySet: 'A key is configured under this reference.',
      apiKeyUnset: 'No key is configured under this reference yet.',
      apiKeyNeedsRef: 'Fill in the credential reference above first; the key is stored under that name.',

      overridden: 'Overridden',
      reset: 'Reset to default',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This entry is not loaded, so it cannot be configured right now.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      invalidNumber: 'Enter a number, or leave blank to use the default.',
    }

    const zh = {
      title: 'Jev 门禁',
      description: '按冻结基线拦停团队动作：本地基线 / 宿主模型 / 你自己的 HTTP 裁决器。',
      gateSection: '闸口',
      gateSectionHint: '门禁盯什么、最多能拦到什么程度、记在什么地方。默认关闭。',
      deciderSection: '外部裁决器',
      deciderSectionHint: '插件不自带任何 API 与密钥：每个使用者提供自己的。这里填的东西不跨机器共享。',
      rulesSection: '规则覆盖',
      rulesSectionHint: '按决策点覆盖内置规则。它只能把某个决策点的力度往下压，不能往上抬。',

      enabled: '启用',
      enabledHint: '默认关闭：一个能拦停团队动作的插件，不该在装上的瞬间就开始拦。',
      mode: '模式',
      modeHint:
        'off / dry-run（只记账）/ advisory（只提醒）/ enforce（完整阶梯）/ lockdown（只允许只读动作，力度上限压到附注）。',
      onUnavailable: '裁决器不可用时',
      onUnavailableHint: 'allow（退回本地基线判定）/ ask（交回给人）/ deny（拦停这次动作）。',
      minConfidence: '置信度下限',
      minConfidenceHint: '低于它，外部意见不被采纳。authority=sole 时这个阈值就是全部政策。',
      maxGapsPerIntervention: '每次干预最多列出的缺口数',
      maxGapsPerInterventionHint: '一次干预最多把几个缺口逐条说出来。',
      stateDir: '账本目录',
      stateDirHint:
        '相对于工作区的账本目录。不得包含 ".."；填绝对路径会被拒绝并退回默认值。',
      persistEnabled: '持久化账本',
      persistEnabledHint: '关掉后判定只在本会话内有效，不往磁盘写任何东西。',
      debounceMs: '账本写入防抖（毫秒）',
      debounceMsHint: '窗口内的账本写入会合并成一次；填 0 表示立即写。',
      interveneAtStateTransition: '拦停状态转移',
      interveneAtPreFinish: '拦停回合收尾',
      interveneAtStateTransitionHint: '在某个会转移状态的团队调用即将发生时拦一道。',
      interveneAtPreFinishHint: '在一个回合即将停下时拦一道。',
      roleAwareness: '身份识别',
      roleAwarenessHint: 'off / observe（记录谁在调用）/ enforce（该身份根本不该做的动作直接拒绝）。',
      narrativeWatch: '正文宣告',
      narrativeWatchHint:
        'off / note / steer / deny：对「只在正文里宣布完成或通过、背后没有任何工具调用」这种说法的反应强度。收工边界上的 deny 实际表现与 steer 相同——正文拦不掉，只能接着说。',
      requireBaseline: '必须有冻结基线',
      requireBaselineHint: '开启后，在范围基线冻结之前，受门禁的动作会被拒绝。',

      deciderKind: '裁决器',
      deciderKindHint:
        'baseline（本地判定，不联网）/ llm（调用宿主自己的模型服务，本版本已实现）/ endpoint（你自己指定的通用 HTTP 裁决器）。',
      deciderProvider: '提供方（kind=llm）',
      deciderProviderHint: 'kind=llm 时用：覆盖提供方。留空则跟会话自己的路由走。',
      deciderModel: '模型 id',
      deciderModelHint:
        'kind=llm 或 endpoint 时用：模型 id。留空则跟各自默认值——endpoint 下那是网关别名，别名会漂。',
      deciderBaseUrl: '接口地址（kind=endpoint）',
      deciderBaseUrlHint:
        'kind=endpoint 时用：你自己那个 HTTP 裁决器的基地址，例如 https://gateway.example.com。留空则用文档里的默认地址。',
      deciderEndpointPath: '接口路径（kind=endpoint）',
      deciderEndpointPathHint: 'kind=endpoint 时用：拼在基地址后面的路径。',
      deciderCredentialRef: '凭据引用名',
      deciderCredentialRefHint:
        '这里填凭据的**名字**，不是密钥本身（例如 MY_GATEWAY_KEY）。密钥填在下面那一格，由凭据服务保管，永不写进设置文件。',
      deciderAuthority: '权限',
      deciderAuthorityHint:
        'advisory（默认）：外部意见只准收紧或交人复核。sole：裁决器说证据够就可以把那条缺失点销案、让判定放行——这是把放行权整体交出去。',
      deciderMaxQuestions: '每次咨询最多提问数',
      deciderMaxQuestionsHint: '一次裁决器咨询最多能问几个问题。',

      rulesJson: '规则覆盖（JSON）',
      rulesJsonHint:
        '一个 JSON 数组，例如 [{"pointId":"review_verdict","ceiling":"L2_continue"}]。留空表示不覆盖；只有下面这些 id 是合法的。',

      decisionPointsHeading: '内置决策点',
      decisionPointsHint:
        '上面 rulesJson 里的 pointId 就取自这里。默认上限是指：该决策点遇到硬矛盾时最多能到哪一档，之后还会被模式和规则继续压低。',
      decisionPointCeiling: '默认上限',

      apiKey: '裁决器 API 密钥',
      apiKeyHint: '只写不读：存进上面那个引用名下的凭据服务，不写进设置文件，也不会随任何响应回传。',
      apiKeySet: '这个引用名下已经配了密钥。',
      apiKeyUnset: '这个引用名下还没有密钥。',
      apiKeyNeedsRef: '请先在上面填凭据引用名——密钥是按那个名字存的。',

      overridden: '已覆盖',
      reset: '恢复默认',
      readOnly: '本部署的设置为只读。',
      unavailable: '该条目当前未加载，暂时无法配置。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      invalidNumber: '请填数字；留空表示使用默认值。',
    }

    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }
    }

    // ─────────────────────────────────────────────── decision-point reference

    /**
     * Read-only copy of `DECISION_POINTS` from `host/catalog.ts`: point id → the
     * default ceiling (the rung used when the finding is a hard contradiction).
     *
     * It is duplicated rather than imported because the browser half never loads
     * the host module, and it is **rendered** because `rulesJson` is a bare JSON
     * string — without this list a user has no way to see which `pointId` values
     * exist or what they are overriding. `scripts/run-contract-check.mjs` compares
     * this table against the catalog, so a drift is a build failure rather than a
     * silently wrong form.
     */
    const DECISION_POINTS = {
      scope_freeze: 'L3_deny',
      plan_approval: 'L3_deny',
      contract_health: 'L3_deny',
      roster_change: 'L3_deny',
      ownership_claim: 'L3_deny',
      task_dispatch: 'L2_continue',
      completion_report: 'L4_human',
      review_verdict: 'L4_human',
      contract_amendment: 'L3_deny',
      phase_advance: 'L3_deny',
      team_close: 'L3_deny',
      narrative_claim: 'L4_human',
      unknown_team_tool: 'L2_continue',
      status_read: 'L0_ledger',
    }

    // ───────────────────────────────────────────────────── field specifications

    /**
     * An enumerated field: the UI uses `<select>`, and the value written back must
     * be one of the options.
     * @param field - top-level settings field name.
     * @param options - the values it may take.
     */
    function choiceField(field, options) {
      return {
        field,
        format: (value) => (typeof value === 'string' ? value : ''),
        parse: (text) => {
          const trimmed = text.trim()
          if (trimmed === '') return { kind: 'clear' }
          return options.includes(trimmed)
            ? { kind: 'set', value: trimmed }
            : void 0
        },
      }
    }

    /** A boolean field: the UI uses `Switch`, while the spec still speaks text. */
    function boolField(field) {
      return {
        field,
        format: (value) => (typeof value === 'boolean' ? String(value) : ''),
        parse: (text) => {
          const trimmed = text.trim().toLowerCase()
          if (trimmed === '') return { kind: 'clear' }
          if (trimmed === 'true') return { kind: 'set', value: true }
          if (trimmed === 'false') return { kind: 'set', value: false }
          return void 0
        },
      }
    }

    const MODE_OPTIONS = ['off', 'dry-run', 'advisory', 'enforce', 'lockdown']
    const KIND_OPTIONS = ['baseline', 'llm', 'endpoint']
    const AUTHORITY_OPTIONS = ['advisory', 'sole']
    const UNAVAILABLE_OPTIONS = ['allow', 'ask', 'deny']
    const ROLE_AWARENESS_OPTIONS = ['off', 'observe', 'enforce']
    const NARRATIVE_OPTIONS = ['off', 'note', 'steer', 'deny']

    /** Option sets of the enumerated fields, keyed by field name. */
    const CHOICES = {
      mode: MODE_OPTIONS,
      onUnavailable: UNAVAILABLE_OPTIONS,
      roleAwareness: ROLE_AWARENESS_OPTIONS,
      narrativeWatch: NARRATIVE_OPTIONS,
      deciderKind: KIND_OPTIONS,
      deciderAuthority: AUTHORITY_OPTIONS,
    }

    const BOOL_KIND = 'bool'
    const CHOICE_KIND = 'choice'
    const NUMBER_KIND = 'number'
    const TEXT_KIND = 'text'

    /** Heading keys of the three form sections, keyed by the `section` tag. */
    const SECTIONS = {
      gate: { title: 'gateSection', hint: 'gateSectionHint' },
      decider: { title: 'deciderSection', hint: 'deciderSectionHint' },
      rules: { title: 'rulesSection', hint: 'rulesSectionHint' },
    }

    /**
     * Every configurable field, in `host/config.ts` declaration order.
     *
     * This table is the single source of truth for this page: `SPECS` (what the
     * settings form can write), `FIELDS` (what the contract check compares against
     * `VOLATILE_FIELDS`) and the rendered rows all come from it, so the page cannot
     * show a field it cannot save, nor save one it never shows.
     *
     * `label` and `hint` are dictionary keys, not display text — both dictionaries
     * must carry every one of them.
     */
    const FIELD_ROWS = [
      { field: 'enabled', kind: BOOL_KIND, section: 'gate', label: 'enabled', hint: 'enabledHint' },
      { field: 'mode', kind: CHOICE_KIND, section: 'gate', label: 'mode', hint: 'modeHint' },
      { field: 'onUnavailable', kind: CHOICE_KIND, section: 'gate', label: 'onUnavailable', hint: 'onUnavailableHint' },
      { field: 'minConfidence', kind: NUMBER_KIND, section: 'gate', label: 'minConfidence', hint: 'minConfidenceHint' },
      {
        field: 'maxGapsPerIntervention',
        kind: NUMBER_KIND,
        section: 'gate',
        label: 'maxGapsPerIntervention',
        hint: 'maxGapsPerInterventionHint',
      },
      { field: 'stateDir', kind: TEXT_KIND, section: 'gate', label: 'stateDir', hint: 'stateDirHint' },
      { field: 'persistEnabled', kind: BOOL_KIND, section: 'gate', label: 'persistEnabled', hint: 'persistEnabledHint' },
      { field: 'debounceMs', kind: NUMBER_KIND, section: 'gate', label: 'debounceMs', hint: 'debounceMsHint' },
      {
        field: 'interveneAtStateTransition',
        kind: BOOL_KIND,
        section: 'gate',
        label: 'interveneAtStateTransition',
        hint: 'interveneAtStateTransitionHint',
      },
      {
        field: 'interveneAtPreFinish',
        kind: BOOL_KIND,
        section: 'gate',
        label: 'interveneAtPreFinish',
        hint: 'interveneAtPreFinishHint',
      },
      { field: 'roleAwareness', kind: CHOICE_KIND, section: 'gate', label: 'roleAwareness', hint: 'roleAwarenessHint' },
      { field: 'narrativeWatch', kind: CHOICE_KIND, section: 'gate', label: 'narrativeWatch', hint: 'narrativeWatchHint' },
      { field: 'requireBaseline', kind: BOOL_KIND, section: 'gate', label: 'requireBaseline', hint: 'requireBaselineHint' },
      { field: 'deciderKind', kind: CHOICE_KIND, section: 'decider', label: 'deciderKind', hint: 'deciderKindHint' },
      { field: 'deciderProvider', kind: TEXT_KIND, section: 'decider', label: 'deciderProvider', hint: 'deciderProviderHint' },
      { field: 'deciderModel', kind: TEXT_KIND, section: 'decider', label: 'deciderModel', hint: 'deciderModelHint' },
      { field: 'deciderBaseUrl', kind: TEXT_KIND, section: 'decider', label: 'deciderBaseUrl', hint: 'deciderBaseUrlHint' },
      {
        field: 'deciderEndpointPath',
        kind: TEXT_KIND,
        section: 'decider',
        label: 'deciderEndpointPath',
        hint: 'deciderEndpointPathHint',
      },
      {
        field: 'deciderCredentialRef',
        kind: TEXT_KIND,
        section: 'decider',
        label: 'deciderCredentialRef',
        hint: 'deciderCredentialRefHint',
      },
      {
        field: 'deciderAuthority',
        kind: CHOICE_KIND,
        section: 'decider',
        label: 'deciderAuthority',
        hint: 'deciderAuthorityHint',
      },
      {
        field: 'deciderMaxQuestions',
        kind: NUMBER_KIND,
        section: 'decider',
        label: 'deciderMaxQuestions',
        hint: 'deciderMaxQuestionsHint',
      },
      { field: 'rulesJson', kind: TEXT_KIND, section: 'rules', label: 'rulesJson', hint: 'rulesJsonHint' },
    ]

    /**
     * Turn one row into the staging spec `SettingsFormModel` consumes.
     *
     * The host treats a field name as a single-segment path, so every spec here is
     * top-level by construction — a nested name would be rejected with
     * `Config field "x" is not volatile`.
     */
    function specFor(row) {
      if (row.kind === BOOL_KIND) return boolField(row.field)
      if (row.kind === CHOICE_KIND) return choiceField(row.field, CHOICES[row.field])
      if (row.kind === NUMBER_KIND) return settingsNumberField(row.field)
      return settingsTextField(row.field)
    }

    /**
     * Every field this page may write.
     *
     * **Must match the fields marked `.volatile()` in `host/config.ts` one for one**:
     * one missing is a knob the UI cannot change, one extra is a save the host will
     * always reject (the host answers `Config field "x" is not volatile`). That
     * invariant is computed from the host schema by `scripts/run-contract-check.mjs`,
     * so the two sides cannot drift apart silently.
     */
    const SPECS = FIELD_ROWS.map(specFor)

    /** Config field names, in declaration order (exposed for the contract check). */
    const FIELDS = FIELD_ROWS.map((row) => row.field)

    // ─────────────────────────────────────────────────────────────── controller

    /**
     * The form for this row: staging/saving/rollback go to the host's
     * `SettingsFormModel`, and the secret input is additionally wired to the
     * credential domain.
     */
    class JevGateForm {
      /**
       * @param scope - the host's config form service for `ENTRY_NS`.
       * @param ctx - the browser plugin context.
       */
      constructor(scope, ctx) {
        this.ctx = ctx
        this.scope = scope
        this.credential = { ref: '', configured: false, writable: true }
        this.form = new SettingsFormModel(
          scope,
          SPECS,
          [{ field: API_KEY_FIELD, write: (text) => this.writeKey(text) }],
        )
        this.store = this.form.bind(() => this.projection())
        this.unsubscribe = scope.subscribe(() => {
          this.readCredential()
        })
        this.readCredential()
      }

      /** The state the card reads. */
      projection() {
        const state = { ...this.form.shell() }
        for (const row of FIELD_ROWS) {
          state[row.field] = this.form.field(row.field)
        }
        state[API_KEY_FIELD] = this.form.field(API_KEY_FIELD)
        state.apiKeyConfigured = this.credential.configured
        state.apiKeyWritable = this.credential.writable && this.refName() !== ''
        return state
      }

      /**
       * The reference name the secret should be written under right now.
       *
       * It reads the name **currently shown in the form** (draft included): when a
       * user changes the reference and fills in a key in the same save, the key must
       * land on the new name. `SettingsFormModel.save()` runs the settings path
       * operations before the secret `write()`, but a refreshed snapshot is not
       * guaranteed, so this deliberately does not read the snapshot.
       */
      refName() {
        const view = this.form.field(REF_FIELD)
        return typeof view.text === 'string' ? view.text.trim() : ''
      }

      /** Ask the host whether this reference holds a value and may be written. */
      async readCredential() {
        const ref = this.refName()
        if (ref !== this.credential.ref) {
          this.credential = { ref, configured: false, writable: true }
          this.store.set(this.projection())
        }
        if (ref === '') return
        let response
        try {
          response = await this.ctx.remote.credentials.describe([ref])
        } catch (_error) {
          return
        }
        if (!response || !response.ok || ref !== this.refName()) return
        const view = response.value === void 0 ? void 0 : response.value[ref]
        if (view === void 0) return
        this.credential = { ref, configured: view.configured === true, writable: view.writable !== false }
        this.store.set(this.projection())
      }

      /** Invalidation notice when the credential changed elsewhere (another page). */
      refreshCredential(ref) {
        if (ref !== this.credential.ref) return
        this.readCredential()
      }

      /** Called by `SettingsFormModel` on save: write the secret into the credential service. */
      async writeKey(value) {
        const ref = this.refName()
        if (ref === '') return false
        await this.ctx.remote.credentials.set(ref, value)
        await this.readCredential()
        return this.credential.configured
      }

      /** Props the slot entry injects into the component. */
      inject() {
        const actions = this.form.actions()
        return {
          hooks: { jevGate: this.store },
          ...actions,
          /**
           * Editing the reference name changes which credential this panel talks
           * about, so the "already has a key / no key yet" badge has to be re-read
           * — otherwise a name that already holds a key keeps claiming it does not.
           * The scope only publishes on *external* writes, so the draft edit is the
           * only signal available here.
           */
          edit: (field, text) => {
            actions.edit(field, text)
            if (field === REF_FIELD) this.readCredential()
          },
          resetField: (field) => {
            actions.resetField(field)
            if (field === REF_FIELD) this.readCredential()
          },
        }
      }

      dispose() {
        this.unsubscribe()
        this.form.dispose()
      }
    }

    // ─────────────────────────────────────────────────────────────── components

    /** One row: label + control + hint + the "overridden / reset" affordance. */
    function fieldRow(props) {
      const overridden = props.overridden === true
      return jsxs(
        'div',
        {
          className: 'jev-gate-field',
          style: { display: 'flex', flexDirection: 'column', gap: '4px', margin: '0 0 14px' },
          children: [
            jsx('label', {
              htmlFor: props.id,
              style: { fontWeight: 600 },
              children: props.label,
            }),
            jsxs('div', {
              style: { display: 'flex', alignItems: 'center', gap: '8px' },
              children: [
                props.control,
                overridden
                  ? jsxs('span', {
                      className: 'jev-gate-overridden',
                      style: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
                      children: [
                        jsx('span', { className: 'jev-gate-badge', children: props.overriddenLabel }),
                        jsx('button', {
                          type: 'button',
                          disabled: props.disabled,
                          onClick: props.onReset,
                          children: props.resetLabel,
                        }),
                      ],
                    })
                  : null,
              ],
            }),
            props.hint
              ? jsx('p', { style: { margin: 0, opacity: 0.7, fontSize: '0.9em' }, children: props.hint })
              : null,
            props.invalid === true && props.invalidLabel
              ? jsx('p', { style: { margin: 0, color: 'var(--dsh-danger, crimson)' }, children: props.invalidLabel })
              : null,
          ],
        },
      )
    }

    /** Dropdown for an enumerated field. */
    function ChoiceRow(props) {
      return fieldRow({
        id: props.id,
        label: props.label,
        hint: props.hint,
        overridden: props.overridden,
        overriddenLabel: props.overriddenLabel,
        resetLabel: props.resetLabel,
        disabled: props.disabled,
        invalid: props.invalid,
        invalidLabel: props.invalidLabel,
        onReset: props.onReset,
        control: jsx('select', {
          id: props.id,
          disabled: props.disabled,
          value: props.text,
          onChange: (event) => props.onEdit(event.target.value),
          style: { minWidth: '12em' },
          children: props.options.map((option) =>
            jsx('option', { value: option.value, children: option.label }, option.value),
          ),
        }),
      })
    }

    /** On/off switch. */
    function SwitchRow(props) {
      return fieldRow({
        id: props.id,
        label: props.label,
        hint: props.hint,
        overridden: props.overridden,
        overriddenLabel: props.overriddenLabel,
        resetLabel: props.resetLabel,
        disabled: props.disabled,
        onReset: props.onReset,
        control: jsx(Switch, {
          checked: props.text === 'true',
          disabled: props.disabled,
          label: props.label,
          onChange: (next) => props.onEdit(next === true ? 'true' : 'false'),
        }),
      })
    }

    /**
     * The read-only table of built-in decision points.
     *
     * `rulesJson` is an opaque string in the form, so this is the only place a user
     * can see which `pointId` values are legal and how much force each one carries
     * by default. It is intentionally not editable: overrides belong in `rulesJson`,
     * where the host can validate them in one place.
     */
    function DecisionPointList(props) {
      const { t } = props
      return jsxs('div', {
        className: 'jev-gate-decision-points',
        style: { margin: '4px 0 14px' },
        children: [
          jsx('h5', { style: { margin: '0 0 4px' }, children: t('decisionPointsHeading') }),
          jsx('p', {
            style: { margin: '0 0 8px', opacity: 0.7, fontSize: '0.9em' },
            children: t('decisionPointsHint'),
          }),
          jsx('ul', {
            style: { margin: 0, paddingLeft: '1.2em', fontSize: '0.9em' },
            children: Object.entries(DECISION_POINTS).map(([pointId, ceiling]) =>
              jsx(
                'li',
                {
                  children: jsxs('code', {
                    children: [
                      pointId,
                      ' — ',
                      t('decisionPointCeiling'),
                      ': ',
                      ceiling,
                    ],
                  }),
                },
                pointId,
              ),
            ),
          }),
        ],
      })
    }

    /** One rendered field row, chosen by the row's kind. */
    function renderRow(row, props, t, state, disabled) {
      const field = row.field
      const label = t(row.label)
      const hint = t(row.hint)
      const overriddenLabel = t('overridden')
      const resetLabel = t('reset')
      const edit = (text) => props.edit(field, text)
      const reset = () => props.resetField(field)
      const current = state[field]

      if (row.kind === BOOL_KIND) {
        return jsx(SwitchRow, {
          key: field,
          id: field,
          label,
          hint,
          overriddenLabel,
          resetLabel,
          disabled,
          ...current,
          onEdit: edit,
          onReset: reset,
        })
      }
      if (row.kind === CHOICE_KIND) {
        return jsx(ChoiceRow, {
          key: field,
          id: field,
          label,
          hint,
          disabled,
          options: CHOICES[field].map((value) => ({ value, label: value })),
          overriddenLabel,
          resetLabel,
          ...current,
          onEdit: edit,
          onReset: reset,
        })
      }
      const value = row.kind === NUMBER_KIND ? { ...current, numeric: true } : current
      return jsx(SettingsValueField, {
        key: field,
        id: field,
        label,
        hint,
        disabled,
        overriddenLabel,
        resetLabel,
        invalidLabel: t('invalidNumber'),
        ...value,
        onEdit: edit,
        onReset: reset,
      })
    }

    /** The configuration panel for this row. */
    function JevGateCard(props) {
      const { t } = props
      const state = props.useJevGate((snapshot) => snapshot)

      if (props.view === 'summary') return t('description')

      const disabled = !state.writable
      const children = []
      let section = null

      for (const row of FIELD_ROWS) {
        if (row.section !== section) {
          section = row.section
          const keys = SECTIONS[section]
          children.push(jsx('h4', { key: `section:${section}`, style: { margin: '18px 0 4px' }, children: t(keys.title) }))
          children.push(
            jsx('p', {
              key: `section:${section}:hint`,
              style: { margin: '0 0 14px', opacity: 0.7, fontSize: '0.9em' },
              children: t(keys.hint),
            }),
          )
        }
        children.push(renderRow(row, props, t, state, disabled))
        if (row.field === REF_FIELD) {
          children.push(
            jsx(SettingsSecretField, {
              key: API_KEY_FIELD,
              id: API_KEY_FIELD,
              label: t('apiKey'),
              hint: state.apiKeyWritable ? t('apiKeyHint') : `${t('apiKeyNeedsRef')} ${t('apiKeyHint')}`,
              disabled: disabled || !state.apiKeyWritable,
              text: state[API_KEY_FIELD].text,
              configured: state.apiKeyConfigured,
              stateLabel: state.apiKeyConfigured ? t('apiKeySet') : t('apiKeyUnset'),
              onEdit: (text) => props.edit(API_KEY_FIELD, text),
            }),
          )
        }
      }

      children.push(jsx(DecisionPointList, { key: 'decision-points', t }))

      return jsx(SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: jsx('div', { children }),
      })
    }

    // ───────────────────────────────────────────────────────────────── mounting

    /** Required services (cordis fiber inject). */
    const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

    /**
     * Mount the configuration panel for this row.
     *
     * Nothing that depends on the form scope is built until `whileServed` says the
     * host really serves `ENTRY_NS`: a deployment that does not configure this
     * plugin gets no panel, and — because the card subscribes to that scope — no
     * crash either. The dictionaries are registered unconditionally, so a panel
     * appearing later still has its strings.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        'dsh-jev-gate: dictionaries',
      )
      /**
       * The form card — built only while the host actually serves `ENTRY_NS`.
       *
       * This is not defensive padding. `configForms.get()` legitimately returns
       * `null` for a deployment that does not configure this plugin, and the card's
       * constructor subscribes to that scope (`scope.subscribe(...)`). Building the
       * card outside `whileServed` therefore takes the whole browser half down with
       * a `TypeError` in exactly the deployment that was supposed to see no panel at
       * all. `null` here means "no panel", not "broken plugin".
       */
      let card = null
      const dropCard = () => {
        if (card === null) return
        card.dispose()
        card = null
      }

      // A card left over from an earlier serving must not outlive it.
      ctx.effect(() => dropCard, 'dsh-jev-gate: form subscription')
      ctx.effect(
        () =>
          ctx.remote.$on('credentials/reference-updated', (ref) => {
            // No panel, nothing to refresh; the event itself is not an error.
            card?.refreshCredential(ref)
          }),
        'dsh-jev-gate: credential invalidations',
      )
      ctx.effect(
        () =>
          ctx.configForms.whileServed([ENTRY_NS], () => {
            const scope = ctx.configForms.get(ENTRY_NS)
            if (scope === null || scope === undefined) return undefined
            dropCard()
            const created = new JevGateForm(scope, ctx)
            card = created
            return ctx.slots.inject('plugins.row.config', () =>
              ctx.slots.register(
                { name: 'plugins.row.config', key: ROW_KEY, locale: NS, inject: () => created.inject() },
                JevGateCard,
              ),
            )
          }),
        'dsh-jev-gate: row page',
      )
    }

    exports.NS = NS
    exports.ENTRY_NS = ENTRY_NS
    exports.ROW_KEY = ROW_KEY
    exports.SLOT = 'plugins.row.config'
    exports.FIELDS = FIELDS
    exports.DECISION_POINTS = DECISION_POINTS
    exports.SECRET_FIELDS = [API_KEY_FIELD]
    exports.REF_FIELD = REF_FIELD
    exports.MODE_OPTIONS = MODE_OPTIONS
    exports.KIND_OPTIONS = KIND_OPTIONS
    exports.AUTHORITY_OPTIONS = AUTHORITY_OPTIONS
    exports.UNAVAILABLE_OPTIONS = UNAVAILABLE_OPTIONS
    exports.ROLE_AWARENESS_OPTIONS = ROLE_AWARENESS_OPTIONS
    exports.NARRATIVE_OPTIONS = NARRATIVE_OPTIONS
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
