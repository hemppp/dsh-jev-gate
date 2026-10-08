# dsh-jev-gate

跨团队的裁决与优雅干预层。它**不是调度器**：不会创建成员、不会编排 DAG、不会派活，也不会替你推进任何阶段。它做的是在团队工作流的 14 个决策点上读取一本账，然后**记账、附注、拦停**，或者**把决定交回给人**。

它管的是「你说你做了」和「门禁看到你做了」之间的那道缝。

---

## 一、唯一不变式：自述不是证据

整个插件只有一条不可协商的规则：

> **执行者写下来的话，永远只算 C 级。**

`host/evidence.ts` 的头部注释把它拆成三档，这三档决定了某条基线要求到底算不算被覆盖：

| 等级 | 名称 | 含义 | 能否支撑覆盖 |
| --- | --- | --- | --- |
| **A** | 门禁亲自观察 | 门禁自己看到的事实：工具调用确实发生过、文件确实存在且门禁读过它的字节 | 可以 |
| **B** | 预声明谓词实测 | **开工前就写在账上的**谓词，真的被拿到真实工作区上求值过 | 可以 |
| **C** | 执行者自述 | 有人把它写下来了（调用参数里的文件清单、正文里的结论） | **不可以** |

两条直接推论，值得单独记住：

1. **一次工具调用的「参数」是 C 级，但「调用发生过」这个事实是 A 级。** 门禁亲眼看到有人调了 `agent_teams_update_task`（A：动作确实发生），但参数里那串 `changedPaths` 是模型自己写的话（C：内容不可信）。把这两件事合并，正是这个插件存在的意义所在——所以它们被刻意分开记录。
2. **命令跑成功了，也不自动是 A 级。** 门禁**不执行** `verify` 字段里的任何命令。理由在 `host/evidence.ts` 里写得很直白：把模型写的一串字符串拿去执行，"running whatever a model wrote into a `verify` field is how a gate becomes an attack surface"。

A 级观察的落地方式是 `host/evidence.ts` 的 `probeFile()`（存在性、行数、是否有实质代码、是否占位、摘要）与 `evaluatePredicate()`；门禁自己的观察永远走这两条路，从不采信文本。

---

## 二、这次重写解决的 7 个问题

v0.2.0（归档于 `F:\DSH pulls\_ref-dsh-jev-gate-v0.2.0`）被评为「太简陋」。下面是用户逐条确认的 7 个问题，以及 v1.0.0 里对应的机制。

### 1. 覆盖面太窄

**旧版**：只按 4 个字面工具名匹配，其余共享工具**静默放行**——这是一个不安全的默认值。`agent_teams_resume`（恢复已 halted 的团队）、`add_member` / `remove_member`（改名册）、`claim_task`（认领）连 L0 记账都没有。

**现在**：`host/catalog.ts` 把「工具」变成「决策点的绑定（binding）」，而不是一张闸门名单：

- `DECISION_POINTS` 定义 **14** 个决策点，每个点自带 `floor` / `ceiling` / `gated`。
- `TOOL_BINDINGS` 是 **23** 条工具→决策点绑定（9 条内置团队工具 + 14 条 `@nanmicoder/dsh-agent-teams` 工具），每条声明 `requires`（captain / member / any / observer）与是否 `gated`。
- 一个决策点可以由**两套工具词汇**分别抵达（例如 `completion_report` 同时来自 `team_task_update` 与 `agent_teams_update_task`），所以覆盖面的单位是决策点，不是工具名。
- `discriminateUpdate()` 处理工具语义分叉：同一个 `update_task` 带 `verdict` 就是「评审结论」，带 `status` 就是「宣布完成」。
- `isTeamToolName()` 故意**比表更宽**：任何 `agent_teams_` 前缀的名字都算团队动作，于是未登记的新工具落到 `unknown_team_tool`，而不是无声穿过。
- `BY_TOOL` 在重复绑定时直接抛错（`dsh-jev-gate: duplicate tool binding for "<tool>"; the catalog must name each tool exactly once`），这正是旧版 `team_task_create` 被手抄两遍的修复。

### 2. 不认身份

**旧版**：`rules.ts` 只按工具名匹配，队长的对账和队员的上报走同一条闸。

**现在**：`host/roster.ts` 的 `Roster.resolve()` 按顺序问两个团队实现——内置的 `agentTeams` Service（`AgentTeamsSeam.tryMembership`），再是磁盘上的 `@nanmicoder/dsh-agent-teams` 状态目录（`findPluginTeam`）——产出带 `provenance` 的 `ActorRef`（`builtin-roster` / `plugin-state` / `capability-inference` / `none`）。然后 `host/gate.ts` 的 `roleGaps()` 拿 `ToolBinding.requires` 对账：

- `requires: 'captain'` 而调用方是 `member` → `role-mismatch`（点名工具、队员和身份来源）。
- 两套名册都答不上来 → 角色是 `unknown`，`provenance: 'none'`，记 `role-unresolved`，而**不是**默认成 either：`host/roster.ts` 的注释写着 "silently assuming `member` would let a captain's overreach through and silently assuming `captain` would block honest members"。
- `Roster` 有一份 750ms 的短缓存（`ttlMs = 750`），并在任何可能改名册的调用后 `invalidate()`。

### 3. 只看工具、看不见话

**旧版**：队长在**正文里**自行宣布「已对账通过」而没调任何工具时，完全拦不到。

**现在**：`host/narrative.ts` 把「散文」当成一条独立的、可判定的申报通道，落在决策点 `narrative_claim` 上：

- `detectClaims()` 用 7 条 `CLAIM_PATTERNS` 匹配过去时的完成断言（"已完成"、"tests pass now"…），并用 7 条 `NEGATIVE_PATTERNS` 否决未来时/否定/疑问/定义（"我会完成"、"还没完成"、"完成了吗？"、"已完成的定义是…"）。注释解释了为什么否定过滤要慷慨：`"a watcher that fires on conditionals gets muted, and a muted watcher is worse than none"`。
- `isActionableClaim()` 只在断言**点名了工件**（文件名或命令词，`ARTIFACT_PATTERN`）时才判定——"a claim that names no artifact is a summary, and summaries are cheap"。
- `NarrativeWatch` 按 `actorKey` 缓冲（`MAX_BUFFER = 6000`），`take()` 消费即判定一次。
- 关键的限制被明说：**它最高只能产生 note / continue，永远不能 block**，因为一个回合的收尾处已经无法回退（详见 `docs/DESIGN.md`）。

### 4. 证据太薄

**旧版**：A 级证据只来自工具结果，从不核对实际改动。

**现在**：`host/gate.ts` 的 `collectObservations()` 会**主动去工作区取事实**，而不只是读工具返回：

- 逐个 `probeFile()` 声称改过的文件（上限 `MAX_PROBED_FILES = 40`）。文件不存在 → `contradicted('<path> 不存在，但被声称改过。')`，归到 `skeleton` 或 `claim-mismatch`；文件存在但只有占位内容 → 同样被反驳。
- 逐条求值基线条目**开工前就写好的** `acceptance` 谓词（B 级）。求不了值的落到 C 级，并附注「（因此这条只是声明，不是证据）」。
- 条目声明了 `scope` 却拿不到任何证据时，去 `probeScope()` 浅列一遍（上限 `MAX_SCOPE_ENTRIES = 120`）；一个实质文件都没有 → 反驳。
- `claimedCommands` 与 `claimedAcceptance` 一律只记 C 级自述，附注「门禁不执行命令，所以这只能是自述」。
- 一次上报**什么文件、验收条目、命令都没给** → `claim-mismatch`「这次上报没有给出任何文件、验收条目或命令：没有任何可核对的东西。」
- 怎么算「占位」是明写的：`host/evidence.ts` 要求**同时**命中 `STUB_MARKERS`（todo / fixme / not implemented…）**且**实质行数极低，理由是 `"a gate that cries wolf on a two-line config gets switched off"`。

### 5. 裁决器太弱

**旧版**：`deciderKind` 声明了 `llm` 却没实现，实际只有 `native-jev` 一条路。

**现在**：`host/decider.ts` 接上了宿主路由，并保留本地确定性基线作为**不可绕过的底**：

- `deciderKind` 走 `baseline`（本地、不联网）/ `llm`（宿主模型服务的会话路由）/ `endpoint`（运维指定的 HTTP 判定器），`IMPLEMENTED_DECIDERS` 三个都在。
- 判定器**只被「问」，不被「服从」**：`consult()` 只把 high 及以上的缺口拿出去问，一问一缺口，问题都是**封闭且预先打分**的（`QUESTION_TYPES = ['noul']`），请求里**不含源码**。
- 外部意见**只能收紧，不能放宽**（不变式 3）。放宽会被记成 `Advice.loosened`，并且**除非** `deciderAuthority: 'sole'`，一律不生效——放宽要变成具名的、显式的动作，而不是默认值。
- 失败一律**向关闭方向倒**：判定器不可达是 `available: false` 这个一等结果，绝不会被当作「没事」。

### 6. 配置面板残废

**旧版**：GUI 只能改 9 个扁平字段；`rules[]` 完全改不了，因为表单模型表达不了数组。

**现在**：`client/index.js` 的 `FIELD_ROWS` 把 `host/config.ts` 里 `.volatile()` 的 **22 个字段全部**铺成表单，`FIELDS` 就是它们的字段名序列，顺序与宿主声明顺序一致；`scripts/run-contract-check.mjs` 按顺序逐项比对两边，缺一个（面板改不了）或多一个（宿主必然拒绝保存）都会让构建失败。

诚实地说清楚规则的边界：宿主把字段名当作**单段路径**（`path: [field]`），嵌套名会被回答 `Config field "decider.baseUrl" is not volatile`，所以规则覆盖只能以一个 JSON 字符串 `rulesJson` 进来，由 `host/config.ts` 的 `parseRuleOverrides()` 解析（永不抛错，坏 JSON/非数组/未知 `pointId`/未知 `ceiling` 各自产出中文 `rulesError`）。面板因此**不是**结构化的数组编辑器：它是「JSON 文本框 + 下方只读的决策点参照表」（`client/index.js` 的 `DECISION_POINTS` 常量，由契约门禁与 `host/catalog.ts` 逐项比对）。**规则覆盖只允许降低力度，永远不能提高**，例如：

```json
[{ "pointId": "review_verdict", "ceiling": "L2_continue" }]
```

另外，密钥不是配置字段：面板上的输入框（`API_KEY_FIELD = 'deciderApiKey'`）**不在** `FIELDS` 里，保存时走宿主的凭据服务 `ctx.remote.credentials.set(<deciderCredentialRef>, <值>)`，读回来只拿 `{ configured, writable? }`，明文从不回到页面。

### 7. 工程太糙

**旧版**：`lib/` 是 tsc 产物却没有 CI 强制同步、工具名单靠手抄（`team_task_create` 重复）、没有契约快照测试、没有密钥扫描门禁。

**现在**：`package.json` 的 `gates` 把四类检查串成一条链（`npm run typecheck && … && npm run check:libsync`）：

- **契约漂移** `scripts/run-contract-check.mjs`：把真的 `host/catalog.ts` / `host/config.ts` / `host/types.ts` 打包**执行**，再与 `package.json`、`cordis.patch.yml`、浏览器半边逐项比对（决策点注册表、ceiling ≥ floor、patch 行不带 `config`、导出口、声明的路径存在、`FIELDS` 与 `VOLATILE_FIELDS`、判定器种类都已实现、安全默认值、客户端决策点表）。
- **名册自检** `host/catalog.ts` 的 `catalogIssues()`：重复绑定、指向不存在的决策点、声明了工具却没绑定、把 member 工具标成 captain-only、flavor 与自己声明的清单打架——任何一条都算失败。
- **密钥门禁** `scripts/run-secret-scan.mjs`：五类凭据形状检测 + 一条结构性规则（`host/` 与 `client/` 里出现 `process.env` **读取**即硬失败），`ALLOWLIST` 刻意为空。
- **`lib/` 新鲜度** `scripts/run-lib-sync.mjs`：把 `host/` 重新编译到 `.tmp/libsync`，与仓库里的 `lib/` 逐字节对比。旧版正是发布了「与源码漂移的 `lib/`」，跑的不是仓库里的代码。

契约门禁与 `lib` 门禁的边界，写在 `docs/GATES.md` 里，不在这里含糊。

---

## 三、14 个决策点

表里的「工具」是当前登记的全部入口；同一格出现两个名字，说明这个点由两套词汇分别抵达。`floor → ceiling` 是该点能到达的力度区间（见下一节），`gated` 表示这个点是否真的会拦停。

| 决策点 | 触发者（工具） | 要求身份 | floor → ceiling | gated |
| --- | --- | --- | --- | --- |
| `scope_freeze` 划定范围并冻结基线 | `agent_teams_create` | captain | L0 → L3 | 是 |
| `plan_approval` 批准计划并开始执行 | `agent_teams_approve` | captain | L1 → L3 | 是 |
| `contract_health` 登记一条工作契约 | `team_task_create`、`agent_teams_create_task` | captain | L0 → L3 | 是 |
| `roster_change` 增删团队成员 | `spawn_teammate`、`agent_teams_add_member`、`agent_teams_remove_member` | captain | L1 → L3 | 是 |
| `ownership_claim` 认领、改派或接管任务 | `interrupt_agent`、`agent_teams_reassign_task`、`agent_teams_claim_task` | captain（`claim_task` 为 member） | L0 → L3 | 是 |
| `task_dispatch` 派活或催办 | `send_message`（两套） | any（插件侧 member） | L0 → L2 | 否 |
| `completion_report` 宣布一项工作完成 | `team_task_update`、`agent_teams_update_task` | any / member | L1 → **L4** | 是 |
| `review_verdict` 给出评审结论 | `team_task_update`、`agent_teams_update_task` | any / member | L1 → **L4** | 是 |
| `contract_amendment` 修改已登记的契约 | `agent_teams_amend_task` | captain | L1 → L3 | 是 |
| `phase_advance` 推进阶段或恢复团队 | `agent_teams_edit_plan`、`agent_teams_resume` | captain | L1 → L3 | 是 |
| `team_close` 收队或归档 | `agent_teams_delete` | captain | L1 → L3 | 是 |
| `narrative_claim` 用正文宣布结论 | （无工具；正文） | any | L1 → **L4** | 是 |
| `unknown_team_tool` 未登记的团队动作 | 任何未登记的 `agent_teams_*` | any | L0 → L2 | 是 |
| `status_read` 查看状态 | `team_task_get`、`team_task_list`、`list_agents`、`wait_agent`、`agent_teams_status` | any | L0 → L0 | 否 |

两点读表的注意：

- **`ceiling` 是「最多能到哪一级」，不是「一定会到」**。绝大多数正常调用只落在 L0（记账）。力度由缺口的最坏严重度决定，而严重度由 `host/types.ts` 的 `GAP_SEVERITY` 固定下来。
- `completion_report` / `review_verdict` / `narrative_claim` 的上限是 **L4_human**：宣布完成和给出评审结论是「人应该拍板」的两件事，门禁到这里就应该把手交出去，而不是自己判。

## 四、干预阶梯（5 级）

| 级别 | 含义（原文） | 投递通道 | 调用方看到什么 |
| --- | --- | --- | --- |
| `L0_ledger` | 只记账，不打扰任何人 | 账本 + `jev_gate_status` | 当前回合什么都不看到 |
| `L1_note` | 把缺口作为附注挂在工具结果旁，下一轮可见 | `tools/post-execute` | 工具结果旁边的附注文本 |
| `L2_continue` | 在当前回合的收尾处补一轮，要求补齐证据 | 回合收尾（pre-finish） | 一次「补齐证据」的续跑 |
| `L3_deny` | 拦停这一次调用并给出理由 | `tools/pre-execute` 拒绝 | 这次调用没发生，外加理由 |
| `L4_human` | 交给人决定，不代替人拍板 | 宿主的人工确认通道 | 一个等待人拍板的问询 |

级别由 `host/intervene.ts` 的 `planLevel()` 算出：缺口的最坏严重度先过 `SEVERITY_LEVEL`（low/medium → `L1_note`，high → `L2_continue`，blocker → `L3_deny`），再被决策点自己的 `floor` / `ceiling` 夹一次，最后被当前 `mode` 用 `capForMode()` 压一次。`off` 模式下天花板是 L0，于是**记账照做、力度归零**。

---

## 五、两套团队都覆盖

本机并排装着两套互不共享状态的团队实现，本插件两套都认：

| 编号 | 实现 | 本插件看到的工具 | 身份来源 |
| --- | --- | --- | --- |
| 一号 | DSH 内置团队（`spawn_teammate`、`team_task_*`…） | 9 条内置绑定 | `agentTeams` Service |
| 二号 | `@nanmicoder/dsh-agent-teams` | 14 条插件绑定 | `<workspace>/.agent-teams/<teamId>/team.json`（只读） |

三件需要说清楚的事：

1. **目录是数据，不是代码里的 if。** 决策点与绑定都在 `host/catalog.ts` 的 `DECISION_POINTS` / `TOOL_BINDINGS` 两张表里声明，`bindingForCall()` 按名字查表，`decisionPoint()` 按 id 取点。加一个工具是改表，不是改闸门逻辑。
2. **未登记的 `agent_teams_*` 一律当团队动作处理。** `isTeamToolName()` 判定为 `BY_TOOL.has(name) || name.startsWith('agent_teams_')`，故意比表更宽；没命中的调用落在 `UNKNOWN_PLUGIN_BINDING`（`unknown_team_tool`，`any`，gated）。新工具出现时默认**不过闸 = 危险**，而不是默认放行。
3. **读别人的状态目录是「读」。** `host/workspace.ts` 的头部注释解释了为什么这不算越界：`@nanmicoder/dsh-agent-teams` 没有任何 Service，而工具描述禁止的是**模型**去碰那些文件；一个只读、只为回答「调用方是谁」的宿主侧插件是另一回事。并且每次读都容错——解析失败等于「我判断不出来」，绝不等于「所以他是队员」。

---

## 六、安装与运行

先装依赖，再跑门禁：

```bash
npm ci
npm run gates
```

`npm run gates` 依次执行：

| 步骤 | 命令 | 证明什么 |
| --- | --- | --- |
| 类型 | `npm run typecheck` | `host/` 在 `tsconfig.json` 的严格模式下编译通过 |
| 逻辑测试 | `npm run test:logic` | 纯函数层（`toRuntimeConfig`、`capForMode`、`planLevel`…）行为正确 |
| 宿主测试 | `npm run test:host` | 依赖宿主 Service 的一层行为正确 |
| 客户端测试 | `npm run test:client` | 浏览器半边行为正确 |
| 演示页 | `npm run test:visualize` | `docs/visualize.html` 真的能跑，且它抄过去的决策点/缺口/力度/绑定与 `host/` 逐条一致 |
| 面板渲染 | `npm run test:render` | 配置面板真的被渲染并驱动：结构、控件初值、改动→保存→回读、密钥全流程、降级态 |
| 契约 | `npm run check:contract` | 目录/配置/两半边之间没有漂移 |
| 密钥 | `npm run check:secrets` | 没有凭据形状的字符串，`host/`+`client/` 没有 `process.env` 读取 |
| 构建 | `npm run build` | `tsc` 把 `host/` 编译到 `lib/` |
| `lib` 同步 | `npm run check:libsync` | 仓库里的 `lib/` 与一次全新编译逐字节一致 |

### 本机逐条实测结果

下面的数字是**实际跑出来的**（`npm run gates` 的每一步单独执行、记录退出码），不是预期值：

| 步骤 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | 0 | 通过 |
| `npm run test:logic` | 0 | 通过：`OK run-logic-tests: 239 assertions passed` |
| `npm run test:host` | 0 | 通过：`OK run-host-tests: 153 assertions passed` |
| `npm run test:client` | 0 | 通过：`OK run-client-tests: 67 assertions passed` |
| `npm run test:visualize` | 0 | 通过：`OK run-visualize-tests: 50 assertions passed` |
| `npm run test:render` | 0 | 通过：`OK run-render-tests: 129 条断言全通过（配置面板真实渲染：结构、保存、密钥、降级态）` |
| `npm run check:contract` | 0 | 通过：`OK run-contract-check: 9 contract assertions passed` |
| `npm run check:secrets` | 0 | 通过：`33 file(s) scanned, 0 findings, 0 process.env reads, 146 exemption(s)` |
| `npm run build` | 0 | 通过（产出 `lib/`） |
| `npm run check:libsync` | 0 | 通过：`lib/ matches a fresh tsc build byte-for-byte (76 file(s) compared)` |

`npm run gates` 也整体跑过一次，退出码 0。写作期间它曾经是三处红的——`test:host` 是脚本缺口、
`check:contract` 的解析器不认 bundle 的 `insert:` 形状、`check:libsync` 的镜像目录比 `lib/` 深一层——
三处都已修好。更要紧的是，**host 测试跑起来之后又暴露出两条宿主真缺陷**：`rulesJson` 在有基线时
完全不起作用（第 6 项简陋点的实质被架空），以及验收条件证据会因为条目的 `requirement` 里没有
自己的 id 而**归不了属**（于是判否的验收条件被误报成"未上报"）。两条都已修好，逐条经过与证据
写在 `docs/GATES.md` 第七节。

`test:render` 是后加的第十步。它的来历同样是一次「门禁逼出真缺陷」：写它之前配置面板从未被渲染过，
它当场抓出了 `inject()` 不在改引用名时重新读凭据状态这一条（见上一节）。

### ⚠️ 交付的事实边界

以下每一条都是**实际检查过**的，不是免责声明：

- **本插件没有装进任何 profile。** 用户明确要求不安装，没有任何 profile 被改动；`cordis.patch.yml`
  里只有一行 `insert`，且刻意不带 `config`。安装方式见 `docs/GATES.md` 末尾。
- **配置面板没有在任何浏览器里被渲染过（这一点仍然成立，但含义已变）。** 本包不依赖 `react`，
  `test:client` 与 `test:render` 都只依赖 `node`：前者把 `client/index.js` 当文本丢进 `node:vm`，
  后者把它挂载成真实元素树。**没有任何一次真实浏览器渲染证据**——CSS、焦点顺序、真实浏览器对
  `aria-*` 的播报都还没有门禁背书。
- **宿主入口 `host/index.ts` 存在、可编译，并且现在有门禁执行它。** `scripts/run-host-tests.mjs`
  （153 条断言）会真的把 `host/` 打包起来跑 `Gate.evaluate`、`LedgerStore`、`RuntimeHub`、角色缺口、
  未知团队工具过闸等。但它是**进程内**的：宿主 Service 用一个「访问任何属性就抛错」的 `Proxy` 顶替，
  所以"在真实 DSH 宿主里接对了没有"仍然只是**类型级 + 契约级**证据，不是一次真实宿主集成。
- **配置面板在真实浏览器里被渲染过，但那是人工检查，不是门禁。** 现在有 `npm run test:render`
  （129 条断言）真的把 `client/index.js` 挂载成一个元素树并驱动它——控件初值、改动→保存→回读、
  密钥全流程、`unavailable` / `readOnly` 两个降级态、语言切换都跑在里面。**但它用的是逐行忠实的
  桩**（宿主 asar 里真实原语 `Switch`/`SettingsForm`/`SettingsValueField`/`SettingsSecretField`/
  `settingsNumberField`/`settingsTextField`/`SettingsFormModel` 的位置都注在桩上方），因为真实原语包
  顶层 import 了 react / shiki / katex 等 15+ 外部包，把它们拉进 `gates` 就等于让门禁依赖浏览器工具链。
  所以这条门禁证明的是**组件树与接线正确、且与原语的公开接口契约吻合**，**不证明 CSS 长得好看**。
  本轮没有做真机安装验证（用户明确暂缓）。
- **`test:client` 与 `test:render` 分工不同，不能互相替代。** `test:client` 用万能 Proxy 顶替
  `require`，跑在桩宿主上，证明的是**文本一致**（字段顺序、字典键集、决策点表对得上）；
  `test:render` 换掉 Proxy、提供真实原语桩与真实元件级查询，证明的是**控件真的能被驱动**。
  在 `test:render` 写起来之前，`jsx` 参数顺序写反、保存按钮永远 `disabled`、密钥框在引用名为空时
  反而可写这几类缺陷，文本比对一律看不见——其中「改了引用名不重新问凭据服务，导致徽章对已有密钥的
  引用名谎报『还没有密钥』」就是这道门禁当场抓出来并修掉的。
- **演示页 `docs/visualize.html` 在真实浏览器里被渲染过，但那是人工检查，不是门禁。** 本机用一次隔离
  Chromium 打开 `file:///…/visualize.html`（窗口 1800×1010）并截图：canvas 有画面、中文标签清晰、
  面板文本完整；`Space` 会让画面**冻结**（间隔 1.2 秒的两张截图逐字节相同，而冻结前同样间隔的两张
  不同），`ArrowRight` 会换掉剧本、再按一次 `Space` 动画恢复。这一步**没有进 `gates`**——它需要一台
  有浏览器的机器和一个桌面会话，而 `npm run gates` 只依赖 `node`。`test:visualize` 证明的是另一件事：
  这个页面**能跑**（本机实测 >500 帧、>5000 笔绘制调用）且**不漂移于 `host/`**，不是"画得对"。
- **`lib/` 的新鲜度现在有门禁证明。** `check:libsync` 把仓库里的 `lib/` 与一次全新 `tsc` 编译
  逐字节对比（76 个文件）。
- **没有一次真实的判定器往返被证明。** `host/decider.ts` 的 `endpoint` 那条路在本 checkout 里
  从未连过第三方服务；`test:host` 全程跑在默认的 `deciderKind: 'baseline'` 上。
- **本仓库是被并行改写出来的，文档里每个数字都对应"最后一次检查那一刻"的树。** 写这份文档期间，
  `host/index.ts`、`host/runtime.ts`、三个测试脚本都是边读边出现的；`host/index.ts` 曾经有一处
  编译错误（`characters: text.length`）在写作过程中被修好，三处门禁失败与两条宿主缺陷也是如此。
  引用行号时请以当时的树为准。

---

## 七、物理化演示页：`docs/visualize.html`

`docs/visualize.html` 是一个**单文件页面**（约 64 KB）：没有构建步骤、没有依赖、没有任何外部请求
（全页只有一对内联的 `<style>` / `<script>`，没有 CDN、没有 `src=`、没有 `url()`）。它把插件的判定过程
演成一个二维物理场景——调用沿传送带流向闸口，闸口按决策点分级拦停，证据按 A/B/C 归属，天花板按
`mode` 与 `rules` 压低，`L4_human` 把决定抛回给人。直接双击打开即可（`file://` 就够）。

它和插件的关系是**抄写**，不是包含：页面里的纯函数与表都抄自 `host/`。

| 页面里抄过来的东西 | 对照的 `host/` 导出 |
| --- | --- |
| mode 帽 | `capForMode`（`host/config.ts:497`） |
| 固有天花板 + rules + `lockdown` | `configuredCeilingFor`（`host/config.ts:511`） |
| 计划级别 / 投递级别 | `planLevel`（`host/intervene.ts:70`） |
| 缺口 → 状态 | `statusFrom`（`host/gate.ts:678`） |
| 力度阶梯与排序 | `INTERVENTION_LEVELS`（`host/types.ts:33`）/ `LEVEL_RANK`（`:35`） |
| 缺口种类与分档 | `GAP_KINDS`（`host/types.ts:252`）/ `GAP_SEVERITY`（`:273`） |
| 14 个决策点 | `DECISION_POINTS`（`host/catalog.ts:21`） |
| 剧本 → 决策点 + 需要的身份 | `pointForCall`（`host/catalog.ts:307`）/ `bindingForCall`（`:301`） |

抄写会漂移，而**漂移的演示比没有演示更糟**：它会用一套早已不成立的口径去骗看它的人。所以每一处抄写
都被 `npm run test:visualize` 逐条钉在真实导出上（这道门禁具体在抓什么、以及它证明不了什么，见
`docs/GATES.md` 第四之二节）。

### 十个剧本与控件

| # | 剧本 | 走的绑定 |
| --- | --- | --- |
| ① | 队长开队并冻结基线 | `agent_teams_create` → `scope_freeze` |
| ② | 登记任务，契约不全 | `team_task_create` → `contract_health`（`contract-incomplete`） |
| ③ | 宣称完成，且有实测证据 | `agent_teams_update_task` → `completion_report`（条目录到 A/B，缺口为空） |
| ④ | 宣称完成，只有自述 | 同上（缺口 `no-evidence`：C 级全从筛缝漏下去） |
| ⑤ | 说改了，文件根本不存在 | `completion_report`（`skeleton` + `unreported` → blocker → 计划升到 L3） |
| ⑥ | 评审结论与证据对不上 | `review_verdict`（`claim-mismatch`） |
| ⑦ | 只是在正文里宣布完成 | `agent/assistant-stream` → `narrative_claim`（不经任何工具） |
| ⑧ | 未登记的团队工具 | `agent_teams_parallel_dispatch` → `unknown_team_tool`（前缀命中就按最保守过闸） |
| ⑨ | 没有基线就宣称完成 | `baseline-unfrozen`（"我不知道"只记附注，不拦停） |
| ⑩ | 只是看一眼状态 | `agent_teams_status` → `status_read`（未门禁，直接放过） |

右侧面板上的控件都是真的：**运行模式 `mode`**（关闭 / 只记账 / 只提醒 / 完整 / 只读）、**正文闸
`narrativeWatch`**（不管 / 记下 / 推回 / 拒绝）、**身份检查 `roleAwareness`**、**按决策点压低天花板
`rules`**（选决策点 + 选力度，加一条规则，画面上的天花板立刻压低）、**同屏呼入 `burst`**（同时在途的
调用条数上限 = `burst + 1`，用来演示"证据的归属在碎片自己身上，不在最后那份报告里"）。键盘上
`Space` 暂停/继续、`ArrowRight` 换下一个剧本。

画面底部的图例就是这套演示的诚实声明：**橙色 = 本次天花板**、**虚线圆 = 本来会说什么**、
**闸门 = 真的拦停**。这三样能分开画，是因为"计划级别"与"投递级别"本来就可能是两件事：把模式切到
「只记账」，虚线圆照样画出来，但**没有任何东西真的被拦下**。页面默认停在「完整」（`enforce`），
好让人一进来就看得见 `L3_deny` 与 `L4_human` 长什么样。

### 这个页面的证据等级

- **它不漂移，有门禁背书。** `test:visualize` 的 50 条断言里有一半在拿页面抄过去的表与函数对
  `host/` 的真实导出（`scripts/lib/bundle.mjs` 现 bundle 现 import），其中 `planLevel` 是逐样本对照
  （每个决策点 × 每个 mode × 每个 status × 每类缺口组合，本机实测 1000 组以上），不是抽查。
- **它能跑，有门禁背书。** 内联脚本被抽出来做 `node --check` + `vm.Script` 双重编译，再在 `node:vm`
  里用 canvas/document 桩真的跑起来：本机实测驱动 500 帧以上、canvas 上 5000 笔以上绘制调用、
  账本累计面板被写进内容、9 秒里至少一条调用交付完成；「同屏呼入」上限、rules 压低天花板、
  账本累计都被真的触发过。还有一条容易漏的：物理量逐条断言为有限值——`NaN` 不抛错，它只是
  安静地画出一片空白。
- **它不是"画得对"的证据。** 桩把 `fillRect` / `arc` / `fillText` 换成了计数，所以门禁证明的是
  "绘制调用发生了"，不是"你看到的这张图是对的"。真实浏览器里渲染过，但那是一次人工检查
  （见第六节末尾的交付边界），没有进 `gates`。

---

## 八、配置

默认姿态是**装了但不动**：`enabled: false`、`mode: 'dry-run'`。这是刻意的——`host/config.ts` 的注释写着 "a plugin that can stop team actions must not start stopping them the moment it is installed"，`scripts/run-contract-check.mjs` 还会再把这两条默认值断言一遍（断言 9）。

### mode 阶梯

| mode | 允许做什么 |
| --- | --- |
| `off` | 记账照做，投递为零（`capForMode` 把一切都压到 `L0_ledger`） |
| `dry-run`（默认） | 只记账：`planLevel()` 仍算出「本来会说什么」，账本记下**计划级别**，但**投递级别**被压到 L0 |
| `advisory` | 只提醒：可以附注、可以续跑，但 `L3_deny` / `L4_human` 被降成 `L1_note`，**绝不拦停** |
| `enforce` | 完整阶梯：附注、续跑、拦停、交人四档都能用 |
| `lockdown` | 只准只读：先拒绝任何扩大范围的动作，再把 `L1_note` 以上的天花板压回 `L1_note` |

`host/config.ts` 的 `capForMode()` 被注释标为「这里最重要的一个纯函数」，因为它保证了「演习」和「真事」看到**完全相同**的缺口，只在最后一步分岔。

### 安全边界

`advance` 这个判定只授权一件事：**在一个已经预先批准的范围之内继续**。

它**不**授权部署、不授权发布、不授权签署交易、不授权任何破坏性操作。这些动作无论缺口多干净、证据多充分、人给了多明确的"sole"授权，都不在 `advance` 的射程内——`advance` 的射程止于基线里那几条已经被冻结的范围声明。要越界，得由人通过 `jev_gate_authorize` 写下一个具名的、带理由的接受记录。

全部 22 个字段、类型、默认值和语义见 `docs/CONFIGURATION.md`；设计取舍见 `docs/DESIGN.md`；门禁能证明什么、不能证明什么见 `docs/GATES.md`。

---

## 九、文档反查源码时发现、并已修正的不一致

写文档时逐条核对过源码，以下是**互相矛盾**的地方。文档这一侧按当时的任务范围只做了记录；
随后由实现侧逐条修正。每条都写明修法与验证方式，留此备查。

1. **`package.json` 的 `description` 说「七个决策点」，`host/catalog.ts` 里是 14 个。**
   原文是「…在团队的**七个**决策点上分级拦停或交人。」而 `DECISION_POINTS` 实际有 14 项。
   这句描述是从旧版（只 gate 4 类调用）留下的。**已改为「十四个决策点」。**
2. **`host/baseline.ts:17` 指向一个不存在的工具名。** 那句文档注释写的是
   "The `jev_baseline` tool"，而实际注册的工具名是 `jev_gate_freeze`
   （`host/tools.ts:70`）。**已改为 `jev_gate_freeze`。** 四个工具的真名是：
   `jev_gate_freeze`（`:70`）、`jev_gate_check`（`:179`）、`jev_gate_status`（`:302`）、
   `jev_gate_authorize`（`:375`）。
3. **`scripts/bundle-run.mjs:11-12` 的注释已经过时。** 它写着
   "The entry does not exist yet (it is being written in parallel), so a clear failure is the
   expected outcome today"。**已改写**为：缺失或损坏的入口会在这里（`node scripts/bundle-run.mjs`）
   大声失败，不必为一个明显的错误先付一次完整构建。
4. **`scripts/run-lib-sync.mjs` 的临时镜像目录比 `lib/` 深一层。** 原注释声称把
   `--declarationDir` 一起镜像到临时目录就能让 sourcemap 与声明映射
   "contain the same relative paths as the real build"；但 `tsc` 把每个 `.map` 的 `sources`
   写成**相对该产物文件**的路径，镜像深一层就使每个 `.map` 多一层 `../`——`npm run build`
   刚刚成功、`lib/` 刚出炉，`check:libsync` 依然报 38 个 `.map` 逐字节不同。**已把临时目录改为
   与 `lib/` 同深度的 `.tmp-libsync/`**（并加进 `.gitignore`）；此后 `check:libsync` 报
   `76 file(s) compared` 全部相等。详见 `docs/GATES.md` 第七节第 5 条。
5. **`interveneAtPreFinish` 是一个没人读的旋钮。** 它在 `host/config.ts` 里被声明、有默认值
   `true`、出现在设置表单上、也被 `toRuntimeConfig()` 归一化——但对它的引用只有声明、表单与
   字典，**没有任何判定逻辑读它**。**已接线**：`host/index.ts:141`（`agent/assistant-stream`）
   与 `host/index.ts:250`（`agent/turn-stopping`）现在都以
   `if (!runtime.interveneAtPreFinish) return` 开头。两者的分工是：
   `narrativeWatch` 决定收工边界**做什么**（`off`/`note`/`steer`/`deny`），
   `interveneAtPreFinish` 决定**来不来**这个边界。见 `docs/CONFIGURATION.md` 第二节。
6. **`rulesJson` 在有基线时完全不起作用——第 6 项简陋点的实质被架空。**
   `host/intervene.ts` 的 `planLevel()` 只在 `insufficient` 分支里用 `ceilingFor`，
   正常路径用的是决策点的静态天花板，于是 `enabled:false` 也关不掉一个决策点。
   **已拆成 `configuredCeilingFor()`（固有天花板 + 规则 + `lockdown`）与 `ceilingFor()`
   （再叠 mode 帽）**：计划级别钳在前者、投递级别再叠 `capForMode`，因此规则生效而 dry-run
   仍能记下"本来会说什么"。见 `docs/CONFIGURATION.md` 第五节。
7. **验收条件证据归不了属，把实测失败误报成"未上报"。** `host/gate.ts` 递进去的 haystack 是
   `` `${item.requirement} ${spec}` ``，而 `attributeToItem` 只按 `haystack.includes(item.id)`
   归属——对从团队记录推导出的基线（id 是任务 id、requirement 是任务标题）这句话永远不成立。
   **已给 `EvidenceInput` 加上可选 `itemId`**：调用方已经知道归属时（遍历某条目自己的
   `acceptance` / `scope`）直接传 `item.id`；不知道时（自述类证据）仍走文本猜测，保守性没变。
8. **摘要被篡改的基线会被拿去做判定。** `host/store.ts` 原先只记一句 problem 就照常返回它，
   而 `host/baseline.ts` 自己的文档说这种不符应当是 `baseline-unfrozen`。**已改为拒绝**
   （记下原因、返回 `null`，让门禁走"没有可用基线"的既有路径）。

（以上第 6、7、8 条不是文档反查出来的，是 `test:host` 第一次真正跑起来之后才暴露的——
前五条是"工程没做完"，这三条是"**机制是假的**"。写作过程中还短暂存在过一条矛盾——
`host/index.ts` 里的 `characters: text.length` 引用了不存在的 `text`，`tsc` 报 `TS2304`；
它在文档定稿前已被并行改写的实现改掉：现在是
`characters: claims.reduce((sum, claim) => sum + claim.sentence.length, 0)`。引用它是因为这正是
"本仓库是活树"的一个例子：文档只能保证对**最后一次检查那一刻**的树成立。）

---

## 许可证

MIT，见 `LICENSE`。
