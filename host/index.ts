/**
 * dsh-jev-gate — 宿主入口。
 *
 * 一个**跨团队的裁决层**：它不派发成员、不建 DAG、不调度任务，只在团队工作流的
 * 十四个决策点上读一本账，并按需记账、附注、拦停或交回给人。
 *
 * ## 力度落在哪个事件上
 *
 * | 力度 | 事件 | 机制 |
 * | --- | --- | --- |
 * | `L0_ledger` | 判定内部 | 只记账，零干扰 |
 * | `L1_note` | `tools/post-execute` | `{kind:'accept', additionalContexts:[…]}` |
 * | `L2_continue` | `agent/turn-stopping` | `agent.steer(…)`，同一 turn 继续 |
 * | `L3_deny` | `tools/pre-execute` | `{kind:'deny', reason}` |
 * | `L4_human` | `tools/pre-execute` | `{kind:'ask', reason, displayReason}` |
 *
 * `PreToolDecision` **没有** `additionalContexts`，所以 `L1` 的附注在 pre-execute
 * 阶段无处安放：它先寄存在 `pendingNotes` 里，等那次调用的结果回来时再贴上去。
 * 这反而让附注天然贴紧「刚刚发生的那件事」。
 *
 * ## 正文也是一条 claim 通道
 *
 * `agent/assistant-stream` 只做一件事：把模型正文按 agent 缓存起来。判定发生在
 * `agent/turn-stopping`——一轮话说完、工具都停了、准备收工的那一刻，正好是
 * 「你说完了，那我们来看你说的是不是真的」的时机。缓存是**取走式**的
 * （`NarrativeWatch.take`），所以一段正文只会被审判一次，也不会无限增长。
 *
 * ## 除拦停外一律 `await next()`
 *
 * `tools/pre-execute` 与 `tools/post-execute` 都是 **waterfall**：谁返回非
 * `next()` 的决定，谁就短路掉后面所有监听器。本插件只在真的要拒绝或交人时才抢断。
 *
 * ## 出错不许拦路
 *
 * 门禁是**附加**的一层，不是必经之路。任何一个监听器自己抛错，都必须是「本次放行 +
 * 记一条 warning」，而不是「工具调用失败」。所有判定入口都包了 fail-safe，理由很
 * 简单：一个记账插件没有资格因为自己坏了而拦住别人的工作。
 *
 * @module dsh-jev-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { bindingForCall, isTeamToolName, pointForCall } from './catalog.ts'
import { Config, toRuntimeConfig, allowsBlocking, type RuntimeConfig } from './config.ts'
import { discoverModels, type DiscoveryRequest } from './discovery.ts'
import { decisionKindFor } from './intervene.ts'
import { isActionableClaim, NarrativeWatch } from './narrative.ts'
import { Roster, workspaceFor } from './roster.ts'
import { RuntimeHub } from './runtime.ts'
import { LedgerStoreHub } from './store.ts'
import { registerTools } from './tools.ts'
import type { InterventionLevel } from './types.ts'

export { Config }

/** 入口名必须等于包名（合同：`package.json#name` == `cordis.patch.yml` 里的 id/name）。 */
export const name = 'dsh-jev-gate'

/**
 * 严格注入。
 *
 * `agents` 用于接收 `agent/*` 这类**作用域化**事件——本插件必须真正订阅 agent
 * 作用域，才能在同一轮话收工前听到「正文说完了」。
 */
export const inject = ['tools', 'agents']

/**
 * 收工边界能送出去的最高力度。
 *
 * `agent/turn-stopping` 只有 `agent.steer(…)` 这一个出口，没有 deny、没有 ask。
 * 于是这里做一次显式的**通道削平**：本该 deny/ask 的判定，在收工边界只能以附注的
 * 形式说出来。计划的力度仍然原样记进账本（账本要留下「我们本会说什么」），削平的
 * 只是这一条通道上真的送得出去的那部分。
 */
function forTurnStop(level: InterventionLevel): InterventionLevel {
  return level === 'L3_deny' || level === 'L4_human' ? 'L1_note' : level
}

export function apply(ctx: Context, config: Config): void {
  const runtime: RuntimeConfig = toRuntimeConfig(config)
  const info = (message: string): void => ctx.logger.info(message)
  const warn = (message: string): void => ctx.logger.warn(message)

  /**
   * 让设置页能「填一个地址就把模型列出来」。
   *
   * 注册在两个早退**之前**：`enabled: false` 的部署（插件在场但不干预）照样要能
   * 在设置页里配好接口，那正是刚装上的人第一次打开这张卡片的时刻。这不是干预，
   * 只是回答「这个地址上有哪些模型」。
   *
   * 用 `ctx.inject(['llm'], …)` 而不是把它塞进 `export const inject`：宿主 `llm`
   * 服务缺失时插件本身仍然该能装上、只是设置页退回手填模型 id，而不是整个插件
   * 加载失败。
   */
  ctx.inject(['llm'], (llmCtx) => {
    llmCtx.effect(() => {
      const llm = llmCtx.get('llm') as {
        registerModelDiscovery?: (
          settingsNs: string,
          discover: (
            request: DiscoveryRequest,
            signal?: AbortSignal,
          ) => Promise<readonly { id: string; name: string; contextWindow?: number; maxTokens?: number }[]>,
        ) => () => void
      }
      if (llm === undefined || typeof llm.registerModelDiscovery !== 'function') {
        warn('dsh-jev-gate: llm.registerModelDiscovery() 不可用，设置页退回手填模型 id。')
        return () => {}
      }
      return llm.registerModelDiscovery('dsh-jev-gate', (request, signal) =>
        // 端点是使用者自己敲进来的地址，出网的是宿主进程而不是浏览器：既绕开
        // CORS，也让这次一次性密钥从表单到请求头只存在这一次调用里。
        discoverModels(request, signal, (url, init) => fetch(url, init)),
      )
    }, 'dsh-jev-gate: model discovery')
  })

  // 默认是「装好了但什么都不做」：`enabled` 默认 false，`mode` 默认 dry-run。
  // 两个开关只要有一个说停就停——`enabled: false` 却仍在记账会让人以为插件关着，
  // 而 `mode: 'off'` 却仍在注册工具会让人以为 `mode` 只是提醒强度。
  if (!runtime.enabled) {
    info('dsh-jev-gate: enabled=false，不注册任何工具与监听（插件在场但不干预）。')
    return
  }
  if (runtime.mode === 'off') {
    info('dsh-jev-gate: 模式为 off，不注册任何工具与监听（插件在场但不干预）。')
    return
  }

  const roster = new Roster()
  const store = new LedgerStoreHub({
    stateDir: runtime.stateDir,
    debounceMs: runtime.debounceMs,
    persistEnabled: runtime.persistEnabled,
  })
  const runtimes = new RuntimeHub({ ctx, config: runtime, store, roster })

  /**
   * pre-execute 审出来、要贴到这次调用结果上的附注。
   *
   * 正常流程里 `post-execute` 会取走并删掉自己的条目，但**不是每次登记都有结果可贴**：
   * 下游监听器可能否决这次调用（`post-execute` 不再触发），调用也可能中途被取消。
   * 条目因此超限即按插入顺序淘汰——附注是尽力而为的提醒，宁可丢最老的一条，
   * 也不让一张没有上限的表在长会话里悄悄长大。
   */
  const pendingNotes = new Map<string, string>()
  const MAX_PENDING_NOTES = 64
  /** 每个 agent 的正文缓冲。键是 agent 本身，不是它的名字——名字会重，会话不会。 */
  const watch = new NarrativeWatch()
  const agentKeys = new WeakMap<object, string>()
  let nextAgentKey = 1
  const agentKey = (agent: object): string => {
    const existing = agentKeys.get(agent)
    if (existing !== undefined) return existing
    const created = `agent#${nextAgentKey}`
    nextAgentKey += 1
    agentKeys.set(agent, created)
    return created
  }

  const failSafe = (label: string, error: unknown): void => {
    warn(
      `dsh-jev-gate: ${label} 自身出错，这一次放行（门禁是附加层，不因自己坏了而拦路）：` +
        (error instanceof Error ? error.message : String(error)),
    )
  }

  ctx.effect(() => {
    const disposers: Array<() => void> = []

    // 1) 四个工具。
    for (const dispose of registerTools({ ctx, config: runtime, runtimes, store, roster })) {
      disposers.push(dispose)
    }

    // 2) 正文流：只缓存，不判定。判定等到「要收工了」那一刻。
    disposers.push(
      ctx.on('agent/assistant-stream', (payload) => {
        // Nothing to watch, nothing to buffer: an operator who turned the
        // pre-finish gate off must not pay for a transcript that never gets read.
        if (!runtime.interveneAtPreFinish) return
        if (runtime.narrativeWatch === 'off') return
        const frame = payload.frame
        if (frame.type !== 'chunk') return
        if (frame.chunk.type !== 'text-delta') return
        watch.append(agentKey(payload.agent), frame.chunk.text)
      }),
    )

    // 3) L3 / L4 /（L1 的筹备）：即将转移状态时的闸口。
    disposers.push(
      ctx.on('tools/pre-execute', async (exec, next) => {
        if (!runtime.interveneAtStateTransition) return next()
        if (!isTeamToolName(exec.name)) return next()
        // 未登记的团队工具不在表内，`bindingForCall` 会退回保守默认（gated），
        // 这正是我们要的：新出现的团队工具默认要过闸。
        if (!bindingForCall(exec.name, exec.arguments).gated) return next()

        const agent = exec.agent
        if (agent === undefined) return next()

        try {
          const workspace = workspaceFor(ctx, agent)
          const resolution = await roster.resolve(ctx, agent, workspace)
          const wsRuntime = await runtimes.load(workspace)
          const verdict = await wsRuntime.gate.evaluate({
            toolName: exec.name,
            args: exec.arguments,
            actor: resolution.actor,
            pointId: pointForCall(exec.name, exec.arguments),
            workspace,
            probe: resolution.probe,
            signal: exec.signal,
          })

          const kind = decisionKindFor(verdict.level)
          if (kind !== 'none') {
            void wsRuntime.store.appendEvent('intervention', {
              at: verdict.at,
              pointId: verdict.pointId,
              toolName: verdict.toolName,
              actorKey: verdict.actor.actorKey,
              status: verdict.status,
              level: verdict.level,
              gapKinds: verdict.matrix.gaps.map((gap) => gap.kind),
            })
          }
          wsRuntime.store.schedule(wsRuntime.ledger.snapshot())

          if (kind === 'deny') return { kind: 'deny', reason: verdict.message }
          if (kind === 'ask') {
            return {
              kind: 'ask',
              reason: verdict.message,
              displayReason: {
                en: `dsh-jev-gate: ${verdict.pointId} is ${verdict.status} — ${verdict.matrix.gaps.length} gap(s)`,
              },
            }
          }
          if (kind === 'note') {
            pendingNotes.set(exec.callId, verdict.message)
            if (pendingNotes.size > MAX_PENDING_NOTES) {
              pendingNotes.delete(pendingNotes.keys().next().value as string)
            }
          }
          return next()
        } catch (error) {
          failSafe('状态转移闸口', error)
          return next()
        }
      }),
    )

    // 4) L1：把附注贴在这次调用的结果旁边。
    //
    // `tools/post-execute` 是 waterfall：无论有没有附注，都必须先把决定交给后面
    // 的监听器（`await next()`），再在它的结果上加东西。先拿决定、后贴附注，
    // 顺序不能反——否则本插件会替别人做决定。
    disposers.push(
      ctx.on('tools/post-execute', async (exec, _result, next) => {
        const note = pendingNotes.get(exec.callId)
        const decision = await next()
        if (note === undefined) return decision
        pendingNotes.delete(exec.callId)
        if (decision.kind !== 'accept') return decision

        const message = createUserMessage({
          content: [{ type: 'text', text: note }],
          // 本机 harness 的 `MessageSourceMap` 没有插件源类型，用 user 源并在正文
          // 里以 `dsh-jev-gate` 自报身份；一旦出现插件源类型就切过去。
          source: { kind: 'user' },
        })
        const additionalContexts = decision.additionalContexts
          ? [...decision.additionalContexts, message]
          : [message]

        if ('value' in decision && decision.value !== undefined) {
          return { kind: 'accept', value: decision.value, additionalContexts }
        }
        return {
          kind: 'accept',
          ...(decision.content ? { content: decision.content } : {}),
          additionalContexts,
        }
      }),
    )

    // 5) 收工闸口：正文宣称的落点。
    //
    // `agent/turn-stopping` **不是** waterfall——签名只有 `payload`，没有 `next`。
    // 所以这里没有「交还给下一个监听器」这回事：本插件只是众多收工掂量者之一，
    // 各自独立发言，谁要续步谁就 `agent.steer(...)`。
    disposers.push(
      ctx.on('agent/turn-stopping', async (payload) => {
        if (!runtime.interveneAtPreFinish) return
        if (runtime.narrativeWatch === 'off') return
        const agent: Agent = payload.agent
        // 取走式：一段正文只审一次，缓冲也不会无限长。`take` 已经切好句，
        // 这里只筛掉那些没点名任何产物的句子。
        //
        // 没有一条正文点名了具体产物时**什么都不做**。理由不是省事：`narrative_claim`
        // 的 floor 是 `L1_note`，而 floor 会把一个零缺口的判定也抬成一条附注——
        // 于是每一个普通回合都会多出一条空话。只在该说话时才说话。
        const claims = watch.take(agentKey(agent)).filter(isActionableClaim)
        if (claims.length === 0) return

        try {
          const workspace = workspaceFor(ctx, agent)
          const resolution = await roster.resolve(ctx, agent, workspace)
          const wsRuntime = await runtimes.load(workspace)
          const verdict = await wsRuntime.gate.evaluate({
            toolName: 'assistant-prose',
            args: undefined,
            actor: resolution.actor,
            pointId: 'narrative_claim',
            workspace,
            probe: resolution.probe,
            prose: claims,
          })

          const kind = decisionKindFor(forTurnStop(verdict.level))
          if (kind === 'none') return
          // `note` 的意思是「记下来就好，别去打断他」：账本里留着，这一轮不 steer。
          if (runtime.narrativeWatch === 'note') return

          agent.steer(
            createUserMessage({
              content: [{ type: 'text', text: verdict.message }],
              source: { kind: 'user' },
            }),
          )
          void wsRuntime.store.appendEvent('narrative', {
            at: verdict.at,
            status: verdict.status,
            level: verdict.level,
            characters: claims.reduce((sum, claim) => sum + claim.sentence.length, 0),
            gapKinds: verdict.matrix.gaps.map((gap) => gap.kind),
          })
          wsRuntime.store.schedule(wsRuntime.ledger.snapshot())
        } catch (error) {
          failSafe('收工闸口', error)
        }
      }),
    )

    return [
      ...disposers,
      () => {
        // 卸载时每份 `LedgerStore.dispose()` 都会先 flush 再释放去抖定时器——
        // 账本是跨会话资产，不能随插件消失。
        void store.disposeAll()
        pendingNotes.clear()
      },
    ]
  }, 'dsh-jev-gate')

  info(
    `dsh-jev-gate: 已启用（mode=${runtime.mode}，规则 ${runtime.rules.length} 条，` +
      `裁决器 ${runtime.deciderKind}/${runtime.deciderAuthority}，叙事 ${runtime.narrativeWatch}，` +
      `角色 ${runtime.roleAwareness}，状态目录 ${runtime.stateDir}）。`,
  )

  // 配置不许谎报行为：说出来的每一句，都必须是这个插件真的会做的事。
  if (!allowsBlocking(runtime.mode)) {
    warn(
      `dsh-jev-gate: mode=${runtime.mode} 不会拦停任何东西——判定照记，力度照削，` +
        '但没有任何一次调用会被拒绝或交回给人。要看「本会拦住什么」，用 jev_gate_status 读账。',
    )
  }
  if (runtime.narrativeWatch === 'deny') {
    warn(
      "dsh-jev-gate: narrativeWatch='deny' 在收工边界**做不到**拒绝：`agent/turn-stopping` " +
        '只有 steer 一个出口，没有 deny/ask。这一档在这里的实际行为与 steer 相同，' +
        '账本里记的仍是原本的力度。',
    )
  }
  if (runtime.rulesError !== null) {
    warn(`dsh-jev-gate: rulesJson 解析失败，已整体退回默认规则：${runtime.rulesError}`)
  }
  if (runtime.deciderProblem !== null) {
    warn(`dsh-jev-gate: 裁决器配置有问题，已按安全一侧退让：${runtime.deciderProblem}`)
  }
  if (runtime.unimplementedDecider !== null) {
    warn(`dsh-jev-gate: 配置声明的裁决器 '${runtime.unimplementedDecider}' 尚未实现，已退回 baseline。`)
  }
  if (runtime.deciderKind === 'endpoint' && runtime.deciderCredentialRef === '') {
    warn(
      'dsh-jev-gate: 裁决器是 endpoint，但没有填凭据引用名——**本机没有配置你自己的密钥**。' +
        '插件不自带任何 API 与密钥：请在宿主凭据服务里起一个引用名（环境变量名形态），' +
        '再把那个名字填进 deciderCredentialRef。在此之前，每次过闸口都会按 ' +
        `onUnavailable=${runtime.onUnavailable} 表态。`,
    )
  }
  if (runtime.deciderAuthority === 'sole' && runtime.deciderKind === 'baseline') {
    warn(
      "dsh-jev-gate: deciderAuthority='sole' 只有在挂了一个真正的裁决器（llm / endpoint）时才有对象可授权，" +
        "当前 deciderKind='baseline'——本地确定性基线永远只是收紧，不会被授权销案。",
    )
  }
}
