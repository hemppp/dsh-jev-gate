# 配置参考

全部可调项都在 `host/config.ts` 声明。那里没有硬编码的可调参数：每个阈值、路径、模式和策略
都在 `DEFAULT_CONFIG` 里给出默认值，并在运行时由 `toRuntimeConfig()` 归一化后交给门禁。
`DEFAULT_CONFIG` 是**默认值**，不是写死的值。

## 一、默认姿态：装了但不动

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `false` | 插件不介入任何调用 |
| `mode` | `'dry-run'` | 即使被启用，也只记账 |

这是刻意的。`host/config.ts` 的注释：

> a plugin that can stop team actions must not start stopping them the moment it is installed

同一件事在另外两处被再钉一遍：

- `cordis.patch.yml` 只插入一行、**刻意不带 `config`**，让默认值生效；
- `scripts/run-contract-check.mjs` 的第 9 条断言直接检查
  `DEFAULT_CONFIG.enabled === false` 与 `DEFAULT_CONFIG.mode === 'dry-run'`。

要启用，请在**你自己的** profile 的 `cordis.patch.yml` 里按 id 覆盖，或者在插件页的设置面板上改。

## 二、22 个可配置字段

所有字段都是 `.volatile()`（22/22）。`VOLATILE_FIELDS` 的声明顺序就是设置表单的渲染顺序，
`scripts/run-contract-check.mjs` 会要求 `client/index.js` 的 `FIELDS` 与之**逐项同序**。

### 门禁行为

| 字段 | 类型 | 默认 | 范围 / 取值 | 它改变什么 |
| --- | --- | --- | --- | --- |
| `enabled` | boolean | `false` | — | 是否让门禁介入。关掉时门禁完全不参与调用 |
| `mode` | enum | `'dry-run'` | `off` / `dry-run` / `advisory` / `enforce` / `lockdown` | 决定**允许投递到哪一级**（见第三节） |
| `onUnavailable` | enum | `'ask'` | `allow` / `ask` / `deny` | 外部判定器不可达时的姿态：`allow` 退回本地基线、`ask` 交给人、`deny` 直接拦停 |
| `minConfidence` | number | `0.6` | `0` – `1` | 外部意见至少要有多少置信度才会被采纳 |
| `maxGapsPerIntervention` | number | `3` | `1` – `50`，步长 1 | 一次干预最多逐条列几个缺口；被截掉的数量会在消息尾部说明 |
| `stateDir` | string | `'.dsh-jev-gate'` | 必须是工作区内的相对路径 | 账本、审计日志、冻结基线所在目录。绝对路径或含 `..` 会被拒绝并回落到默认值（附带中文说明） |
| `persistEnabled` | boolean | `true` | — | 是否把状态写盘；关掉后一切只活在内存里 |
| `debounceMs` | number | `500` | `0` – `60000`，步长 1 | 账本落盘的防抖窗口（毫秒） |
| `interveneAtStateTransition` | boolean | `true` | — | 是否在「会改变团队状态」的调用发生的那一刻设闸 |
| `interveneAtPreFinish` | boolean | `true` | — | 是否在「一个回合即将停下」的那一刻设闸。`host/index.ts:141` 与 `:250` 的两个监听器（`agent/assistant-stream` 与 `agent/turn-stopping`）都以 `if (!runtime.interveneAtPreFinish) return` 开头；关掉它，正文缓冲与收工判定就都不发生。与 `narrativeWatch` 的分工是：这里决定**来不来**收工边界，`narrativeWatch` 决定来了**做什么**。见 README 第九节第 5 条 |
| `roleAwareness` | enum | `'enforce'` | `off` / `observe` / `enforce` | 是否确定调用方的团队身份，以及是否据此判定。`off` 让 `roleGaps()` 直接空转 |
| `narrativeWatch` | enum | `'steer'` | `off` / `note` / `steer` / `deny` | 对「只在正文里宣布完成/通过」的反应强度 |
| `requireBaseline` | boolean | `true` | — | 没有冻结基线时，是否拒绝受闸动作 |

### 判定器（decider）

| 字段 | 类型 | 默认 | 范围 / 取值 | 它改变什么 |
| --- | --- | --- | --- | --- |
| `deciderKind` | enum | `'baseline'` | `baseline` / `llm` / `endpoint` | 谁来当第二意见。`baseline` 是本地确定性判定、不联网；`llm` 走宿主模型服务；`endpoint` 指向一个通用 HTTP 判定器 |
| `deciderProvider` | string | `''` | — | 仅 `llm`：provider 覆盖；留空则跟随会话自己的路由 |
| `deciderModel` | string | `''` | — | `llm` / `endpoint`：模型 id；留空则各自取自己的默认值 |
| `deciderBaseUrl` | string | `''` | — | 仅 `endpoint`：基地址；留空回落到文档化的默认值 |
| `deciderEndpointPath` | string | `'/v1/systemone'` | — | 仅 `endpoint`：追加到基地址后的路径 |
| `deciderCredentialRef` | string | `''` | 凭据**名字**（`.role('credential-ref')`） | 仅 `endpoint`：要用的凭据引用名。值本身不在配置里（见第四节） |
| `deciderAuthority` | enum | `'advisory'` | `advisory` / `sole` | `advisory`：外部意见只能收紧或升级给人。`sole`：判定器**可以**清除一个缺口并让流程继续——等于把通过/不通过的裁决权交出去 |
| `deciderMaxQuestions` | number | `8` | `1` – `32`，步长 1 | 一次咨询最多问几个问题（一问一缺口） |

### 规则覆盖

| 字段 | 类型 | 默认 | 它改变什么 |
| --- | --- | --- | --- |
| `rulesJson` | string | `''` | 一个 JSON 数组，按决策点覆盖力度（见第五节） |

## 三、`mode` 阶梯

`host/config.ts` 的 `capForMode(level, mode)` 是这套阶梯的唯一定义处，被注释标为「这里最重要的
一个纯函数」。

| mode | `capForMode` 的结果 | 实际后果 |
| --- | --- | --- |
| `off` | 一切 → `L0_ledger` | 记账照做，投递为零 |
| `dry-run`（默认） | 一切 → `L0_ledger` | 与 `off` 一样不投递，但它是**受支持的默认姿态**：账本里仍记录「本来会说什么」 |
| `advisory` | `L3_deny` / `L4_human` → `L1_note` | 可以附注、可以续跑；**绝不拦停**（`allowsBlocking('advisory')` 为假） |
| `enforce` | 原样通过 | 附注、续跑、拦停、交人四档全部可用 |
| `lockdown` | 先拒绝扩大范围的动作，再把 `L1_note` 以上的天花板压回 `L1_note` | 只准只读 |

两个相关的纯函数给出更细的边界：

- `allowsDelivery(mode)`：`advisory` / `enforce` / `lockdown` 为真。
- `allowsBlocking(mode)`：只有 `enforce` / `lockdown` 为真。`host/intervene.ts` 的
  `blockingAllowed(config)` 用它作守卫，保证 `ask` 不可能在 `advisory` 下冒出来。

**`lockdown` 与 `dry-run` 收紧的方式不同**：`dry-run` 压掉投递（靠 `capForMode`），
`lockdown` 保留完整阶梯，但更早一步拒绝任何扩大范围的动作，并把天花板压到 `L1_note`。

## 四、凭据接缝

`deciderCredentialRef` 存的是**引用名**，不是密钥。规则的落点是：

- 值存放在**宿主的凭据服务**里，按请求解析；浏览器半边保存时调用
  `ctx.remote.credentials.set(<deciderCredentialRef>, <值>)`，读回来只拿
  `{ configured, writable? }`——**明文永远不会回到任何页面**。
- 值**永远不写进** `cordis.yml` / profile 配置。
- 值**永远不从环境变量读**。这不是约定，是结构性强制：`scripts/run-secret-scan.mjs` 把
  `host/` 与 `client/` 里出现 `process.env` **读取**判为硬失败。理由：环境变量对每个子进程
  可见，且无法按会话撤销。

`toRuntimeConfig()` 对这条接缝做了校验：`deciderKind: 'endpoint'` 要求
`deciderCredentialRef` 匹配 `/^[A-Za-z_][A-Za-z0-9_]*$/`，否则给出中文 `deciderProblem`
（并把它说成凭据的**名字**，不是值）。

### 四之二、配置面板里的「一次填写」

上面五个字段都要**分别**填写，但人脑子里的地址和路由都是一整串：`https://…/v1/…`、
`openai/gpt-5`。配置面板（`client/index.js`）因此在「外部裁决器」一节多给两行**只属于面板
自己**的输入，把它们拆进设置字段：

| 面板输入 | 拆成 | 规则 |
| --- | --- | --- |
| 接口地址 | `deciderBaseUrl` + `deciderEndpointPath` | 协议头可省（补 `https://`）；URL 里带的 `user:password` **被丢掉**（否则密钥会写进设置文件）；查询串跟着路径走 |
| 模型路由 | `deciderProvider` + `deciderModel` | 按首个 `/` 切开；没有斜杠就只有模型、没有提供方覆盖 |
| —（自动） | `deciderCredentialRef` | 由 `deciderBaseUrl` 的 hostname 派生：`api.example.com` → `API_EXAMPLE_COM`；首字符非字母时加 `GATE_` 前缀。同一 profile 里两个网关因此不会互相覆盖密钥 |

要点（都是代码里钉死的，`scripts/run-render-tests.mjs` 第 14 节逐条断言）：

- **这两行不是设置字段。** 宿主没有 `endpointUrl` / `modelRoute` 这两个路径；把它们塞进
  `SPECS` 会让 `SettingsFormModel.stage()` 抛 `plugin card has no field`。
  `scripts/run-contract-check.mjs` 断言它们不在 `FIELDS` 里。
- **可见可改，派生不覆盖手输。** 规则是**归属**不是过期：面板可以填没人管的字段，用户一旦
  自己改过某格，那格就归用户，之后再怎么动上面的输入都不覆盖它，直到按「恢复默认」把它交还
  派生。
- **重置面板输入会把两格放回原样**，而不是回到「空白的默认值」——否则按一次重置就把用户
  已经配好的网关抹掉了。
- 面板输入在**保存前**会被清掉，之后由已存的两半重新拼出来，所以别的页面改了设置，这里跟着
  变。
- `client/index.js` 里有一份 `DEFAULT_DECIDER_BASE_URL` 拷贝（用于显示空基地址会解析成什么、
  以及用户什么都没填时派生引用名）；它与 `host/decider.ts` 的 `DEFAULT_BASE_URL` 由契约门禁
  钉在一起。

## 五、`rulesJson`：按决策点覆盖力度

因为宿主把字段名当作**单段路径**（`path: [field]`），数组无法作为一个字段进来，所以规则以
一个 JSON 字符串存在。`host/config.ts` 的 `parseRuleOverrides()` 负责解析，它**永不抛错**：

| 输入 | 结果 |
| --- | --- |
| `''` | `{ rules: [], error: null }` |
| 非法 JSON | `rulesJson 不是合法 JSON：<message>` |
| 不是数组 | `rulesJson 必须是一个数组。` |
| 条目不是对象，或 `pointId` 不认识 | `rulesJson[i].pointId 不是已知决策点：<value>` |
| `ceiling` 不认识 | `rulesJson[i].ceiling 不是已知力度：<value>` |

每条规则的形状（`RuleOverride`）：

```json
{ "pointId": "review_verdict", "enabled": false, "ceiling": "L2_continue" }
```

- `pointId`：必须是 `host/catalog.ts` 里 14 个决策点之一。
- `enabled`：可选布尔值，`false` 把该点的天花板钉到 `L0_ledger`（等于关掉这个点）。
- `ceiling`：可选，注释写着 "Most force this decision point may ever reach."。

**覆盖只能降低力度。** `ceilingFor(pointId, config)` 从决策点自带的 `ceiling` 起步，只接受
**更低**的 `ceiling`，没有任何一条路径能把它抬高。设置面板在 `rulesJson` 输入框下方渲染一张
只读的决策点参照表（`client/index.js` 的 `DECISION_POINTS`），否则用户无从知道有哪些 `pointId`
可写；那张表由 `scripts/run-contract-check.mjs` 与 `host/catalog.ts` 逐项比对，漂移即构建失败。

**这条覆盖现在真的会生效。** 原先 `host/intervene.ts` 的 `planLevel()` 只在 `insufficient`
分支里用 `ceilingFor`，正常路径（有基线、有缺口、真的要判）用的是决策点的**静态**天花板，
于是规则"能配，但配了没用"——`enabled:false` 也关不掉一个决策点。现在两个概念拆开了：

- `configuredCeilingFor(pointId, config)`：固有天花板 + 逐条规则 + `lockdown` 封顶，**不套 mode 帽**；
- `ceilingFor(pointId, config)`：`capForMode(configuredCeilingFor(…))`，签名与语义不变；
- `planLevel()`：**计划级别**钳在 `configuredCeilingFor` 上，**投递级别**再叠 `capForMode`。

最后一层是刻意保留的：如果连计划级别也钳在 mode 帽上，dry-run 里 `planned` 会永远变成
`L0_ledger`，而"账本记下本来会说什么"正是 dry-run 存在的理由。这条缺陷与它的修法写在
`docs/GATES.md` 第七之二节。

## 六、为什么 22 个字段全是 `.volatile()`

只有 `.volatile()` 字段会出现在宿主渲染的设置表单上。这里 22/22 全开是刻意的：

> leaving a knob off the form is how the previous version ended up with rules nobody could edit

代价有两个，都已知且被接受：

1. volatile 字段以「携带 `.get()` 的稳定引用」而非裸值的形式抵达 `apply()`；
   `toRuntimeConfig()` 负责拆包，`currentValue(value, fallback)` 是**唯一**允许这个怪癖
   外泄的地方。
2. 只支持顶层字段，所以判定器相关设置是一个扁平分组，规则只能走 `rulesJson` 字符串。

## 七、归一化：`toRuntimeConfig()`

`toRuntimeConfig(partial)` 是纯函数（逻辑测试可以不搭宿主就断言它），它保证返回的
`RuntimeConfig` **每个字段都在**且都在范围内：

| 情况 | 处理 |
| --- | --- |
| 未知的 `deciderKind` | 回落到 `baseline`，并把原因写进 `deciderProblem` |
| `deciderKind: 'endpoint'` 但 `deciderCredentialRef` 不合法 | 写进 `deciderProblem`（点名凭据的名字） |
| `deciderKind: 'llm'` 且 `rulesJson` 解析失败 | 解析错误浮出为 `deciderProblem` |
| 数字越界 | 夹到范围内并取整 |
| `stateDir` 是绝对路径或含 `..` | 拒绝，回落到默认值并附中文说明 |
| `narrativeWatch` 之外的一切布尔/枚举 | 取 `DEFAULT_CONFIG` 的对应用值 |

`RuntimeConfig` 在 `Config` 之上补了四个**运行时**字段（它们不是配置项，不在表单上）：

| 字段 | 含义 |
| --- | --- |
| `unimplementedDecider` | 声明了但没实现的判定器（当前为 `null`：三种都已实现） |
| `deciderProblem` | 配置写不成可用的判定器时的非空诊断 |
| `rules` | 解析后的 `RuleOverride[]` |
| `rulesError` | `rulesJson` 的解析诊断 |

`host/runtime.ts` 的 `RuntimeHub` 把归一化后的配置按**工作区**分区使用：每个工作区根目录各有
一份 `Ledger` + `LedgerStore` + `Gate`。这不是性能优化——两个项目共用一个 `stateDir` 会让在
A 项目冻结的验收条件去判定 B 项目的完成报告。
