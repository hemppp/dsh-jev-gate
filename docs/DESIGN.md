# 设计说明

这份文档回答「为什么是这样，而不是看起来更省事的那样」。具体的字段与默认值在
`docs/CONFIGURATION.md`；门禁能证明什么、不能证明什么在 `docs/GATES.md`。

---

## 一、三条不变式

`host/types.ts` 的文件头把整个插件的立场压成三句话，其余所有设计都是它们的推论：

1. **自述不是证据。**
2. **判定永远是「相对于一份已冻结的基线」的。** 所以 `Verdict.matrix` 里的 `baselineId`
   不是可选的，`Baseline` 在类型系统里没有「缺省」这个形态。
3. **外部意见只能收紧，不能放宽。** 要放宽，必须有一份被记录下来的 `sole` 授权。

---

## 二、证据分层：为什么「参数」是 C，而「调用发生过」是 A

`host/evidence.ts` 定义的 A / B / C 三档不是分级打分，是**可采信性**的硬边界：

| 等级 | 判据 | 来源 |
| --- | --- | --- |
| A | 门禁自己观察到的事实 | `probeFile()` 的返回值、`workspace-diff` / `workspace-summary` 通道 |
| B | 开工前就写在账上的谓词，真的求过值 | `evaluatePredicate()` 的 `checked === true` |
| C | 有人写下来了 | `tool-arguments` / `self-report` / `narrative` 通道 |

### 为什么一次工具调用的参数只是 C

门禁观察到两件**不同**的事：

- 「有人调用了 `agent_teams_update_task`」——这是**动作**，门禁亲眼看到它发生，是 A。
- 「这个人说他改了 `host/gate.ts`、跑了 `npm test`、验收条目全部通过」——这是**内容**，
  是模型自己写进参数里的字，是 C。

两者被拆成两条不同的记录，而不是一条。`host/gate.ts` 的 `collectObservations()` 在读到
上报类调用（`completion_report` / `review_verdict`）时，会显式记下这条 C 级记录的说明：
「门禁观察到调用发生了，但清单内容只是调用方自己的话」。

`host/gate.ts` 的头部注释把这条纪律说得更重：先观察、**再**读申报，然后才测量——
"merging them here is the single easiest way to reintroduce the bug this plugin exists to fix"。

### 为什么每个上报都强制再过一遍 A 级实测

C 级申报不会单独成立，它会**触发**门禁去工作区找 A 级事实：

- `claimedFiles` 里的每个路径都过 `probeFile()`（上限 `MAX_PROBED_FILES = 40`）。
- 每条基线要求的 `acceptance` 谓词都过 `evaluatePredicate()`，能求值的升到 B，
  求不了值的留在 C，并附注「（因此这条只是声明，不是证据）」。
- 声称了 `scope` 却完全没有证据时，浅列一遍目录（`probeScope()`，上限 `MAX_SCOPE_ENTRIES = 120`）。

`probeScope()` 的返回值被刻意分成两种「没有」：`null` 表示**看不了**（那个目录根本不存在），
`{ files: 0 }` 表示**看了、确实没有**。这个区分很重要——前者不能被当成指控，否则 scope 前缀
里一个拼写错误就会变成一次诬告。

### 为什么「占位」判定要求两个条件同时成立

`host/evidence.ts` 的 `stub` 判定是：

```ts
stub = !binary && (substantialLines === 0 || (substantialLines < 5 && hasMarker && info.size < 8192))
```

`STUB_MARKERS` 是 `['todo','fixme','not implemented','unimplemented','placeholder','coming soon']`。
只有**标记词**与**近乎为零的实质内容**同时出现才算占位，注释里的理由是一句工程常识：
"a gate that cries wolf on a two-line config gets switched off"。

---

## 三、门禁为什么不执行命令，而是自带一门谓词语言

`verify` 字段在契约里是**必填**的，但门禁**从不执行**它。这不是偷懒，是边界：

> 把模型写的一串字符串拿去执行，就是把门禁自己变成攻击面。

所以 `host/evidence.ts` 只认一门**封闭**的谓词语言，作用域被限制在单个工作区文件上：

| 写法 | 语义 |
| --- | --- |
| `exists <path>` 或裸路径 | 该文件存在且有内容（`looksLikePath` 拒绝含空格的字符串） |
| `contains <path> <文本>` | 该文件包含这段文本 |
| 其它任何东西 | `{ checked: false }`，附注「门禁不执行命令，也不认识这条验收条件：…」 |

判不出值不等于失败：它只是**回到 C 级**，即「这条只是声明」。这样一来，`verify` 的价值
被重新定义成两件事，而不是「让门禁去跑」：

1. 让人能复核这份契约是否可判；
2. 让执行者在动手**之前**就承诺了一件可被证伪的事。

这就是 `host/gate.ts` 里 `counterfactual-failed` 这个缺口种类的全部来源：谓词是**先声明、
后求值**的，所以它是一次真正的反事实检验，而不是事后编出来的验收词。

---

## 四、顺序即设计：一次判定的五个阶段

`host/gate.ts` 的头部注释说，这里的**顺序本身就是设计**，而且刻意不是那个最显然的顺序。
`Gate.evaluate()` 的顺序是：

1. **先找尺子。** `ensureBaseline()`：显式冻结的基线（`jev_gate_freeze` 或从盘上恢复）优先；
   只有在完全没有的时候，才从团队自身状态推导一份（`baselineFromTeam`），并且**立刻冻结**
   这份推导结果——尺子不能在团队跑起来之后继续漂移。推导不出来就是 `null`，
   于是「没有基线」成为一个一等结果（`insufficient`），而不是一个默默生效的默认值。
2. **先观察，再读申报。** 观察是门禁自己的账（`collectObservations`），申报是单独解析出来的
   C 级材料。
3. **测量。** 交给 `host/matrix.ts`，对着**冻结的条目**逐条算最强证据与覆盖状态。
4. **先问，再判。** 判定器最后才被咨询，只被告知封闭好的问题，并且**无权降低力度**。
5. **先记账，再投递。** `Verdict` 先写进账本（`host/ledger.ts`），然后才投递。这样即使投递
   路径崩了，「曾经存在过一条缺口」这件事也不会丢。

第 5 条在读账本的时候特别明显：`host/ledger.ts` 的头部写着**判定从不被改写**，后来的判定是
追加而不是覆盖。"this team claimed completion four times and was contradicted twice"
这种事实，只能从一份只追加的记录里读出来。

### 账本之外的三份持久化状态

`host/store.ts` 坚持用三个文件而不是一个，因为它们的**寿命不同**：

| 文件 | 性质 | 为什么必须这样 |
| --- | --- | --- |
| `baseline.json` | 写一次（`O_EXCL`） | 让「已冻结」成为文件系统的事实，而不是注释里的承诺；第二次冻结会被拒绝 |
| `ledger.json` | 可重写的快照 | 可恢复的状态，且写入被去抖（`debounceMs`），话唠的门禁不该把磁盘也变成话唠 |
| `events.jsonl` | 只追加、永不重写 | 快照谁拿着笔都能改，只追加的日志改一笔就会留下痕迹；这份是人事后读的 |

写失败**不会被吞掉**：每个写入结果都落进 `problems`，并由 `jev_gate_status` 暴露出来。
理由是 "A gate whose own bookkeeping silently stopped working is worse than no gate,
because it keeps producing confident verdicts against state it is no longer recording."

### 运行时按工作区分区

`host/runtime.ts` 的 `RuntimeHub` 让**每个工作区根目录**各有一份 `Ledger` + `LedgerStore` +
`Gate`。原因写在那个文件的头部：账本、审计日志、冻结基线都属于某一个工作区；两个不同项目的
会话共用一份账本，意味着在 A 项目冻结的验收条件会去判定 B 项目的完成报告——"那不是「跨团队」，
那是「串台」"。

它还刻意不需要锁：`for()` 是同步的，`load()` 只在第一次真的读盘，并且把「正在读」这个 promise
也记在同一张表里，所以同一工作区被两个 agent 同时首次触达时，两边拿到的是**同一个**运行时对象。

---

## 五、瀑布纪律：只为了「真的拦停」或「真的交人」才抢决定权

宿主在 `tools/pre-execute` 上暴露的是一个瀑布：每个监听者拿到 `ToolExecution` 和一个
`next()`，返回自己的决定，也可以 `await next()` 把决定权交还给后面的监听者。

本插件的纪律是：**只有在准备给出 `L3_deny`（真的拒绝）或 `L4_human`（真的交人）时才抢；否则
一律 `await next()`。**

- 默认姿态下（`mode: 'dry-run'`），`capForMode()` 会把任何力度压到 `L0_ledger`，
  `decisionKindFor()` 于是返回 `'none'`——**这种时候一个中间件就绝不该存在**。挂上去只为
  记账却返回 decide，等于让一个观测者伪装成决策者，还会盖掉后面真正有意见的中间件。
- `host/intervene.ts` 提供了 `blockingAllowed(config)` 这个守卫：它直接看
  `allowsBlocking(mode)`（只有 `enforce` / `lockdown` 为真），保证 `ask` 这种决定**不可能**
  在 `advisory` 里冒出来。

一句话概括：**门禁不能因为「我想说话」而介入，只能因为「我拦得住」或「我交得出」而介入。**

### 接线层怎么落实这条纪律

`host/index.ts` 的 `apply()` 就是这条纪律的可执行版本。它注册的 `tools/pre-execute` 监听器
只有三个出口：`deny`、`ask`、以及 `return next()`；`note` 这一级**不返回决定**，只是把消息
存进 `pendingNotes` 等 `post-execute` 贴上去。四个提前放行的条件写在最前面：

```ts
if (!runtime.interveneAtStateTransition) return next()
if (!isTeamToolName(exec.name)) return next()
if (!bindingForCall(exec.name, exec.arguments).gated) return next()
const agent = exec.agent
if (agent === undefined) return next()
```

注意第三个条件用的是 `bindingForCall()` 而不是 `toolBindingFor()`：未登记的 `agent_teams_*`
工具会退回保守默认（`gated: true`），所以新出现的团队工具默认要过闸，而 `status_read`
这类明确标为不过闸的调用连判定都不会触发。

### 自己坏掉时不许拦路

`host/index.ts` 的头部把这条写成第二条纪律：门禁是**附加**的一层，不是必经之路。
每个判定入口都被 `failSafe(label, error)` 包住，抛错时的动作固定是
`ctx.logger.warn('…自身出错，这一次放行…')` + `return next()`，而不是让工具调用失败。
理由是原文那句：**一个记账插件没有资格因为自己坏了而拦住别人的工作。**

这与「外部意见不可达不能默认放行」并不矛盾：判定器不可达是**判定内容**的一部分（要按
`onUnavailable` 表态），而门禁自身崩溃是**基础设施故障**，两者必须分开处置。

> **接线现状。** 上面两段已经从宿主类型与 `host/index.ts` 的实际代码核对过。
> `host/index.ts` 存在、导出 `name` / `inject` / `Config` / `apply`，`npm run typecheck`
> 与 `npm run build` 都能通过，并且 `scripts/run-host-tests.mjs`（153 条断言）会真的把
> `host/**` 打包后执行 `Gate.evaluate` / `LedgerStore` / `RuntimeHub`。
>
> 但它**没有证明"在真实宿主里接对了"**：那份测试注入的宿主 Service 是一个
> **访问任何属性就抛错**的 `Proxy`，所以 `ctx.effect(...)` 的注册与回滚、
> `agent/assistant-stream` 与 `agent/turn-stopping` 的真实投递，都仍在门禁的视野之外。
> 详见 `docs/GATES.md` 第八节。

---

## 六、为什么 `L1_note` 必须在 `tools/post-execute` 投递

这不是风格选择，是宿主类型系统决定的。`node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts` 里：

```ts
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; info?: ToolErrorInfo }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string; displayReason?: {...} }
```

**`PreToolDecision` 没有 `additionalContexts`**。它只能 allow / deny / cancel / ask 四选一，
没有任何「附一句话」的位置；它甚至明确排除了改写输入（"Input rewriting is excluded because
arguments are already logged and presented"）。

而 `PostToolDecision` 的三种形态（两种 `accept` 与一种 `block`）**都**带可选的
`additionalContexts?: UserMessage[]`：

```ts
export type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; additionalContexts?: UserMessage[] }
  | { kind: 'accept'; value: JsonValue; additionalContexts?: UserMessage[] }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: UserMessage[] }
```

所以阶梯被劈成两半各走各的出口：

| 级别 | 出口 | 为什么是这个出口 |
| --- | --- | --- |
| `L1_note` | `tools/post-execute` | 它天然就是「往工具结果旁边挂一段上下文」，而这是只有 post 才有的能力 |
| `L2_continue` | `agent/turn-stopping` 的 `agent.steer(…)` | 它不拦这一次调用，只要求在本回合结束处补一轮 |
| `L3_deny` | `tools/pre-execute` | 要在调用**发生之前**拒绝 |
| `L4_human` | `tools/pre-execute` 的 `ask` | 审批只能发生在前置阶段：`ask` 的语义是「审批服务返回 `allowed-once` 才继续」 |

如果硬把 `L1_note` 塞进 pre，唯一能用的形态是 `deny`——那就是把一个「提醒」实现成了「拦停」，
在同一套配置下行为完全不同。这正是 `capForMode()` 存在的意义：**投递的级别必须由投递通道
的能力决定**，不能反过来。

### 附注为什么先寄存、后粘贴

`host/index.ts` 用一个 `pendingNotes: Map<string, string>`（键是 `exec.callId`）把 `pre` 阶段
审出来的附注寄存起来，等同一个 `callId` 的结果回来再贴：

```ts
const note = pendingNotes.get(exec.callId)
const decision = await next()
if (note === undefined) return decision
pendingNotes.delete(exec.callId)
if (decision.kind !== 'accept') return decision
```

三个细节都是刻意的：

1. **顺序不能反。** 先 `await next()` 拿到自己的决定，再在它的结果上加东西。反过来就是
   先返回决定、再补内容，等于本插件替后面的监听器做了决定。
2. **只在 `accept` 上贴。** 别人已经把这次调用 `block` 掉了，再挂一条附注只会让消息更乱。
3. **保持原决定的形态。** 返回时区分 `'value' in decision` 与 `content` 两条分支，
   不改写别处已经定好的载荷。

宿主返回的消息源只有 `{ kind: 'user' }` 可用（本机 `MessageSourceMap` 没有插件源类型），
所以附注以 user 源投递，并在正文里用 `dsh-jev-gate` 前缀自报身份；代码注释写明
「一旦出现插件源类型就切过去」。

### 收工边界的通道削平

`agent/turn-stopping` **不是** waterfall——它的签名只有 `payload`，没有 `next()`，唯一的出口是
`agent.steer(…)`：既不能 deny，也不能 ask。所以 `host/index.ts` 做了一次显式的削平：

```ts
function forTurnStop(level: InterventionLevel): InterventionLevel {
  return level === 'L3_deny' || level === 'L4_human' ? 'L1_note' : level
}
```

账本里记的仍然是**原本计划的力度**（账本要留下「我们本会说什么」），削平的只是这条通道上真的
送得出去的那部分。这与 `capForMode()` 是同一思想的第二次应用：通道能力决定投递形态。
`apply()` 末尾还会为 `narrativeWatch: 'deny'` 专门发一条 warning，明说这一档在收工边界
「**做不到**拒绝」，实际行为等同于 `steer`——配置不许谎报行为。

---

## 七、正文通道：为什么它最高只能到 note / continue

`host/narrative.ts` 处理的是工具调用**看不见**的那一层：团队账本可以完全自洽，而人真正读到
的那段总结说的却是另一件事。任何只看工具调用的检查都发现不了这个缝，而它偏偏最重要，因为
**人相信的是散文**。

它只问一个很窄的问题：*这一回合里到底有没有哪个动作撑得起这句话？* 它不判语气，也不拦每一个
「done」。`CLAIM_PATTERNS` 的 7 条模式都要求过去时的完成断言，`NEGATIVE_PATTERNS` 的 7 条
（否定、不能、将来/计划、反问、定义）**优先否决**；注释解释了为什么否定过滤要慷慨：
"a watcher that fires on conditionals gets muted, and a muted watcher is worse than none"。

两个更细的取舍：

- **只有点名了工件才判定。** `isActionableClaim()` 就是 `claim.mentionsArtifacts`。
  注释的理由："a claim that names no artifact is a summary, and summaries are cheap；
  点名了文件或命令的断言，是工作区能裁决的事实性断言——那才值得打断。"工件只用来**排序**，
  从不用来决定。
- **分句宁可粗糙。** `splitSentences()` 按 `(?<=[。！？!?；;])|\n+` 切，且承认这是近似的：
  没有一个 tokenizer 的情况下，"a slightly wrong split only means a slightly different quote,
  never a wrong verdict, because the negative filter runs per candidate"。

**它永远不能 block。** 因为正文是在回合收尾处才被看到的，那时候已经无法回退一次调用——一个
「拒绝」在时序上是不成立的。所以 `narrative_claim` 的实际输出只能落在 `L1_note` 或
`L2_continue`（要求补一轮）。决策点的 `ceiling` 虽然写着 `L4_human`，那表示「这个点最多能
把决定交给人」，而不是「门禁会替人拍板」。

`NarrativeWatch` 是每 `actorKey` 一份缓冲（`MAX_BUFFER = 6000`），`peek()` 不消费、`take()`
消费——注释写明 `take()` 的语义是 "the turn is being judged once"，避免同一条断言被反复判。

---

## 八、floor、ceiling 与 `capForMode` 的三层夹逼

`host/intervene.ts` 的头部把三件**绝不能合并**的东西分开：严重度、决策点自带的边界
（`floor` / `ceiling`）、以及当前 `mode` 允许投递到哪一级。合并它们就是旧版所有怪行为的来源。

`planLevel()` 的算式是固定顺序的：

```
worstSeverity → SEVERITY_LEVEL → clampLevel(floor, ceiling) → capForMode(mode) = delivered
```

- `SEVERITY_LEVEL`（`host/intervene.ts`）：`low`/`medium` → `L1_note`，`high` → `L2_continue`，
  `blocker` → `L3_deny`。严重度本身来自 `host/types.ts` 的 `GAP_SEVERITY`，是**数据**。
- `status === 'insufficient'`（没有基线可用）时，计划级别被钉在 `L1_note`。理由很实际：
  "blocking on ignorance would make it unusable exactly when a team is still forming"。
- `clampLevel(level, floor, ceiling)` **先压天花板，再抬地板**，且抬地板有一个前置条件：
  `LEVEL_RANK[ceiling] >= LEVEL_RANK[floor]` 才允许。原注释：

  > A floor never overrides a ceiling: in a dry-run the ceiling is L0,
  > and restoring the floor there would turn a rehearsal into the real thing.

  这正是 dry-run 能不能做「演习」的关键：**演习要看到和真事一样的缺口，只是不做真事。**
- `capForMode(level, mode)` 是最后一道，也是 `host/config.ts` 里被标为「这里最重要的一个纯
  函数」的那一个：`enforce` / `lockdown` 原样通过；`advisory` 把 `L3_deny` / `L4_human` 压成
  `L1_note`；`dry-run` / `off` 一律压到 `L0_ledger`。

**账本记录的是「计划级别」，投递的是被压过的「投递级别」。** 所以一次 dry-run 事后仍然能回答
「我本来会说什么」——这正是 `PlannedLevel { planned, delivered }` 这个返回形态存在的理由。
`lockdown` 与 `dry-run` 的区别也在同一层：`lockdown` 保留完整阶梯（它靠**更早**地拒绝扩大
范围来收紧），而 `dry-run` 靠压掉投递来收紧。

`ceilingFor(pointId, config)` 则负责把配置注入进来，顺序是：决策点自带的 `ceiling` →
叠加匹配的 `rulesJson` 覆盖（`enabled: false` 直接把天花板钉到 `L0_ledger`；更低的
`ceiling` 胜出；**没有任何一条覆盖可以抬高**）→ `lockdown` 把 `L1_note` 以上的天花板压回
`L1_note` → 最后 `capForMode()`。

---

## 九、矩阵的悲观主义

`host/matrix.ts` 的四种状态按**证据强度**排序，而不是按完成度：

| 状态 | 含义 |
| --- | --- |
| `contradicted` | A/B 级证据**反驳**了申报（最强信号，也是自述式清单永远产生不了的信号） |
| `covered` | 有 A/B 级证据**支持**申报 |
| `self-only` | 只有执行者自己的话 |
| `unreported` | 什么都没有 |

两个刻意的悲观之处：

1. **`coverageRatio` 只数 `covered`**，而 `deep` 深度的条目需要**多于一条**支持性观察
   （`requiredSupport(item) = item.depth === 'deep' ? 2 : 1`）。注释承认这个数字在正常使用下
   "depressingly low, which is correct: the alternative is a dashboard that says 95% because
   the model said so 95% of the time."
2. **空基线不是 100%。** `summarize()` 在 `total === 0` 时返回 `coverageRatio: 0`
   ——"A baseline with no items is not '100% covered'… 0 is the only honest number for it."

「这是一次反驳」这件事被编码在证据记录的 `detail` **前缀**里（`CONTRADICTION_PREFIX = '✗ '`），
而不是放在一张平行的失败表里。理由值得抄下来：记录才是人审计判定时读的东西，另建一张
「这次是失败」的映射表，会让两者有机会互相矛盾。

`contradictionKind()` 按**门禁去看的地方**（通道）来命名缺口种类：`predicate` 通道失败 →
`counterfactual-failed`；`workspace-diff` 失败 → `skeleton`；其余 → `claim-mismatch`。
"The channel is where the gate *looked*, so it is the honest thing to name."

### 缺口的呈现顺序

`rankGaps()` / `orderGaps()`：最严重的在前，其次按基线声明顺序。"a `blocker` must never be
pushed out of view by a pile of `low` notes." 另外 `maxGapsPerIntervention`（默认 3）会截断
呈现，但被隐藏的数量会在消息尾部明说（`composeMessage` 的尾行）。

---

## 十、判定器：被问，不被服从

`host/decider.ts` 面对的核心风险是「不可达等于默认放行」：

> If the decider is unreachable, a gate that defaults to 'carry on' has silently become a
> no-op — and it *will look* like it is working, because it still writes verdicts.

于是：

- **不可达是一等结果**（`Advice.available === false`），配上 `onUnavailable` 策略
  （`allow` / `ask` / `deny`）。它永远不会被当成「没事」。
- **只问封闭题。** `QUESTION_TYPES = ['noul']`，一问一缺口，问题被措辞成「答 yes 会让缺口
  **更紧**」。系统提示里明确写着 "You do not see source code and must not ask for it"，
  以及 "Returning a low number TIGHTENS nothing; it can only suggest relaxing a block,
  which a human must authorise."。自由形式的 "review this work" 会诱使模型去**总结代码**，
  而那恰好是本插件拒绝采信的输入。
- **放宽是具名的显式动作。** 一个更弱的建议会被记下来、标成 `loosened`，并且**除非**
  `deciderAuthority: 'sole'`，不生效；否则 `isLooseningAdvice()` 会补上
  `loosening-not-authorized`。注释："Loosening is an explicit act with a name, not a default."
- **失败向关闭方向倒。** 无法解析或形态意外的响应是 `available: false`，不是一次猜测。

诚实的能力边界（`host/decider.ts` 头部自陈）：`llm` 走会话自己的模型路由；`endpoint` 说一种
很小的、有文档的 JSON 形状，指向运维配置的 URL，**在本检出里从未对一个真实的第三方服务跑过**。

---

## 十一、身份：未知是一个发现，不是默认值

`host/roster.ts` 的立场只有一句：**unknown is a finding, not a default**。
两套团队实现互不权威，也都不对对方负责；当两边都答不上来时，角色是 `unknown`、
`provenance` 是 `none`，并且记一条 `role-unresolved`。理由在文件头：

> silently assuming `member` would let a captain's overreach through and silently assuming
> `captain` would block honest members.

`roleAwareness: 'off'` 时这一切是空操作；`'observe'` 与 `'enforce'` 的差别在于
`role-mismatch` 是否真的产生缺口。`unknown` 被当成「需要小心」而不是「违规」——一个门禁读不懂的
团队实现是真实存在的可能性。

`host/workspace.ts` 说明了为什么「读别人的状态目录」不算越界：`@nanmicoder/dsh-agent-teams`
不提供任何 Service，它的工具描述禁止的是**模型**去碰这些文件；一个只读、只为回答「调用方是谁」
的宿主侧插件是另一回事。并且**每次读都容错**：解析失败等于「我判断不出来」，
绝不等于「所以他是队员」；这也解释了为什么 `Roster` 只有 750ms 的短缓存——
"a stale role is exactly the kind of error this plugin exists to catch"。

---

## 十二、重写时被刻意换掉的两个默认值

1. **默认姿态是「装了但不动」**：`enabled: false`、`mode: 'dry-run'`。`host/config.ts` 的理由：
   "a plugin that can stop team actions must not start stopping them the moment it is installed"。
   `cordis.patch.yml` 也因此刻意**不带 `config`**，并由契约门禁断言它不带。
2. **所有可调项都是 `.volatile()`**（22/22）。这不是随意的：只有 volatile 字段会出现在设置表单上，
   而"leaving a knob off the form is how the previous version ended up with rules nobody could edit"。
   代价是规则不能作为数组进配置（宿主把字段名当单段路径），所以它们以 `rulesJson` 一个字符串
   进来，由 `parseRuleOverrides()` 解析，并由浏览器半边在下方渲染一张只读的决策点参照表来补足
   可发现性。
