# 构建门禁：它们断言什么、能证明什么、以及目前的真实状态

这份文档的对象是 `package.json` 的 `gates` 链：

```
npm run typecheck
  && npm run test:logic
  && npm run test:host
  && npm run test:client
  && npm run test:visualize
  && npm run check:contract
  && npm run check:secrets
  && npm run build
  && npm run check:libsync
```

一条 `&&` 链，所以**第一个失败就终止**。

## 一、逐条形态

| 步骤 | 载体 | 形态 |
| --- | --- | --- |
| `typecheck` | `tsc -p tsconfig.json --noEmit` | 不产出文件；`tsconfig.json` 开了 `strict` / `noUncheckedIndexedAccess` / `noImplicitReturns` |
| `test:logic` | `scripts/run-logic-tests.mjs` | 把 `host/` 里的**纯逻辑**逐条钉在真实源码上 |
| `test:host` | `scripts/run-host-tests.mjs` | 依赖宿主 Service 的一层 |
| `test:client` | `scripts/run-client-tests.mjs` | 用 `node:vm` 造最小浏览器宿主，执行 `client/index.js`，断言求值出来的导出 |
| `test:render` | `scripts/run-render-tests.mjs` | 把配置面板挂载成真实元素树并驱动它：控件初值、改动→保存→回读、密钥全流程、降级态 |
| `test:visualize` | `scripts/run-visualize-tests.mjs` | 抽 `docs/visualize.html` 的内联脚本，在 `node:vm` 里用 canvas/document 桩跑起来，并把页面抄过去的表与函数逐条对 `host/` 的真实导出 |
| `check:contract` | `scripts/run-contract-check.mjs` | 跨文件/跨半边的一致性断言 |
| `check:secrets` | `scripts/run-secret-scan.mjs` | 凭据形状扫描 + `process.env` 结构性规则 |
| `build` | `tsc -p tsconfig.json` | `host/` → `lib/`（`lib/types/` 放声明） |
| `check:libsync` | `scripts/run-lib-sync.mjs` | 仓库里的 `lib/` 与一次全新编译逐字节对比 |

所有脚本共用 `scripts/lib/bundle.mjs`：它用 **esbuild**（已在 `devDependencies`）把 TypeScript
入口打成单个可运行文件再 `import()`。这条设计的目的是让门禁只依赖 `node`，不需要全局的
`tsx` / `ts-node`。它还有两个 Windows 相关的细节：`importBundle()` 必须走 `pathToFileURL()`，
因为裸的 `F:\...` 会被 ESM 解析器当成 URL scheme（`ERR_UNSUPPORTED_ESM_URL_SCHEME`）；
`fail()` 刻意**不抛异常**，只写 stderr 并置 `process.exitCode = 1`，好让一个脚本一次报出多条
互相独立的断言。

---

## 二、`scripts/run-contract-check.mjs`：漂移门禁

存在理由写在脚本开头：旧版发布的缺陷**不是逻辑 bug，是漂移**——各部分单独看都对，
只是彼此不一致。

它打包并**真正执行** `host/catalog.ts`、`host/config.ts`、`host/types.ts`（产物落在
`.tmp/contract/*.mjs`），再把结果与 `package.json`、`cordis.patch.yml`、浏览器半边对照。
浏览器半边**不是** import 进来的，而是当文本读进来、在隔离的 `node:vm` 里求值，
import 被换成 `Proxy` 桩（模块级解构与 `class extends` 都能活下来）——因为它真要 import
需要 DOM 和客户端运行时。

它有 **10 个** `check`/`checkAsync` 调用（计数器报的是 "9 contract assertions passed"，
两者数量不同）：

| # | 断言 | 它防的是什么 |
| --- | --- | --- |
| 1 | `catalogIssues()` 返回空数组 | 目录自相矛盾（重复绑定、指向不存在的点、声明了工具却没绑定、member 工具被标成 captain-only、flavor 与清单打架） |
| 2 | `DecisionPointId` 联合与 `DECISION_POINTS` 的键**集合相等**，且每个键等于自身的 `.id` | 类型层与运行时目录分家 |
| 3 | 每个决策点 `LEVEL_RANK[ceiling] >= LEVEL_RANK[floor]` | 天花板低于地板这种不可能的组合 |
| 4 | `cordis.patch.yml` **恰好一行**，其 `id` 与 `name` 等于包名，且**不带 `config`** | 安装即生效——"installing a plugin that can stop team actions must not start stopping them" |
| 5 | `exports` 的键集合等于 `['.','./client','./cordis.patch.yml','./package.json']`；`dsh.bundle.patch === './cordis.patch.yml'`；`dsh.client.platform === 'web'` | 入口声明被改坏 |
| 6 | 每个 `files` 条目与每个 `./` 开头的导出目标都存在 | 发布了不存在的文件 |
| 7 | 客户端 `FIELDS` 与宿主 `VOLATILE_FIELDS` **同序逐项**相等 | 面板少一个字段（改不了）或多一个（宿主必拒） |
| 8 | `DECIDER_KINDS` 的每一项都在 `IMPLEMENTED_DECIDERS` 里 | 又出现一个"声明了 llm 却没实现" |
| 9 | `DEFAULT_CONFIG.enabled === false` 且 `=== 'dry-run'` | 默认姿态被悄悄改成会拦人 |
| 10 | 客户端 `DECISION_POINTS` 的 id 集合与每点 `ceiling` 与 `host/catalog.ts` 一致 | 参照表与真实目录漂移 |

**它明确放弃了一部分覆盖面**，而且这个放弃是可见的：断言 6 对 `lib` / `lib/…` 只打印一行
`NOTE ... build output absent (checked by run-lib-sync.mjs after the build step)`，不判失败。
原因是 `gates` 链把 `check:contract` 排在 `build` **之前**，而 `lib/` 又是 `.gitignore`
忽略的编译产物——"声明存在性"和"构建新鲜度"是两件事，前者在这里只能延后，
后者归 `run-lib-sync.mjs` 管。

**它证明不了的事**：它证明各半边的**声明**一致，证明不了任何一侧的行为正确。这就是
`test:*` 三个脚本存在的理由。

---

## 三、`scripts/run-logic-tests.mjs`：逻辑门禁

存在理由写在开头：「一个判断错了的门禁比没有门禁更糟」。所以它把 `host/` 里**可判定**的
逻辑逐条钉在真实源码上——数量、集合、边界、映射、默认姿态——让"悄悄把门禁的判断改坏"在
`npm run test:logic` 就变红，而不是在用户面前才暴露。

自述覆盖范围（脚本头部的原文列表）：catalog 图完整性、未知工具保守兜底、`update_task`
判别、身份要求、干预阶梯（floor 不越 ceiling）、severity/label 映射、正文声明识别、
`NarrativeWatch` 缓冲、契约/恢复/修订缺口、证据谓词、配置面与默认姿态。

**它证明不了的事**：它只覆盖纯函数与可判定的数据关系。任何需要真实宿主 Service
（session、agent、tools、credentials）的行为都不在这里。

---

## 四、`scripts/run-client-tests.mjs`：浏览器半边的桩测试

`client/index.js` 不是可 import 的 ESM：它只调用
`window.__ModuleLoader__.load({ id, factory(require) {...} })`。所以这个脚本用 `node:vm`
造一个最小的宿主（`window` / `document` / `console`），把文件当脚本求值，截获传给 `load`
的记录，再用 stub `require` 调 `factory` 拿到真正的导出，然后逐条断言。

最重要的一组断言是"跨半镜像"：客户端声明的 volatile 字段顺序与决策点 ceiling 必须与
`host/` 完全一致——一边改了另一边没改，必须在这里变红。（这组断言与
`run-contract-check.mjs` 的断言 7 / 10 有意重叠：契约门禁管**声明的形状**，
这个脚本管**求值出来的导出**。）

**它证明不了的事**：它用桩替掉了 slot / locale / configForms / credentials 域，所以它本身
**不是**渲染测试。配置面板的真实渲染由 `scripts/run-render-tests.mjs` 负责（见第四之三节）。
它当前的实测结果是 `OK run-client-tests: 67 assertions passed`；写作期间它曾
因为客户端在缺失表单时不降级而失败（见第七节第 3 条），这正好说明这一层不是空转。

---

## 四之三、`scripts/run-render-tests.mjs`：配置面板的真实渲染门禁

`test:client` 证明的是**文本一致**；这一关证明的是**控件真的能被驱动**。差别不是形式上的——
下面几类缺陷在文本比对下一律看不见，而它们都会让用户在真机上遇到"面板坏了"：

- `jsx(Switch, {...})` 的参数顺序写反（成了 `jsx({...}, Switch)`）；
- `fieldRow` 里 `props.control` 漏传、`props.hint` 拼错键；
- 保存按钮永远 `disabled`（`state.dirty` 从没被算出来）；
- 密钥框在引用名为空时反而可写（密钥会存到一个不存在的名字下）；
- `SettingsFormModel` 的 stage → plan → save → 回读链路断在某一环。

这一关真的把 `client/index.js` 挂载起来：`apply(ctx)` 走完四个 effect，槽位注册出组件，
然后按宿主约定把 `inject()` 的返回值接成 props（`hooks.jevGate` → `useJevGate(selector)`，
`view` / `t` 由宿主给），求值出元素树，从树上找到控件并**调用它们的 `onChange` / `onClick`**——
不是绕过控件直接调 actions。断言分七组：挂载协议（字典注册 / `whileServed` / 槽位记录 / 四个
effect / `form === null` 时不建卡）、`summary` 视图、完整结构（3 个分区标题、23 个 label 的顺序、
6 个下拉框的选项集合、5 个开关的 `aria-checked`、4 个数字字段的 `inputMode`、密钥框的
`type=password`、14 条决策点参照表、保存按钮初始禁用）、改动→保存→回读（含 `unset`）、
无效数字挡住保存、文本 `trim`、宿主拒收后的 `saveFailed` 与 `discard`、密钥全流程
（含"改引用名 + 填密钥"必须写到新名字下）、`unavailable` / `readOnly` 两个降级态、语言切换。

**原语是逐行忠实的桩，不是真实包。** 宿主 asar 里真实实现的行号注在每个桩上方
（`Switch` :3394、`SettingsForm` :6918、`SettingsValueField` :6973、`SettingsSecretField` :7052、
`settingsNumberField` :7110、`settingsTextField` :7131、`SettingsFormModel` :7151-7377）。原因是
`@deepseek-ai/dsh-client-ui-primitives` 的 bundle 顶层 import 了 react / react-dom / shiki / katex /
simple-icons / micromark 系等 15+ 外部包，还带 30+ 个 CSS module——把它拉进 `gates` 就等于让门禁
依赖浏览器工具链，与「门禁只依赖 `node` 和本包已装依赖」这条底线冲突。

**所以它证明不了的事**：CSS 观感、焦点顺序、真实浏览器对 `aria-*` 的播报。真机安装验证才管这些，
本轮明确不在范围内。当前实测：`OK run-render-tests: 129 条断言全通过`。
它抓到过一条真缺陷——`inject()` 只把 `form.actions()` 原样交出去，改凭据引用名时不重新读凭据状态，
于是**徽章会对一个已经配了密钥的引用名谎报"还没有密钥"**（见第七之二节第 8 条）。

---

## 四之二、`scripts/run-visualize-tests.mjs`：演示页门禁

`docs/visualize.html` 把插件的裁决逻辑**重抄**了一遍：决策点表、缺口表、mode 帽、rules 天花板、
`planLevel`、`statusFrom`、剧本到绑定的映射。抄写就会漂移，而**漂移的演示比没有演示更糟**——
它会用一套早已不成立的口径去骗看它的人。这道门禁做四件事：

1. **证明它真的能跑。** 先断言页面里只有一个 `<script>` 块，把内联脚本抽出来做 `node --check` 与
   `vm.Script` 双重编译，再在 `node:vm` 里用 canvas/document 桩把它**跑起来并驱动帧**。本机实测：
   引擎驱动 500 帧以上、canvas 上 5000 笔以上绘制调用、账本累计面板确实被写进内容、9 秒里至少有一条
   调用交付完成。桩会检查页面索取的每一个 id 都存在（页面改了 HTML 却忘了改脚本，在这里变红）。
2. **证明它不漂移。** 页面抄过去的纯函数与表逐条对照 `host/` 的**真实导出**：
   `capForMode`、`configuredCeilingFor`、`planLevel`、`statusFrom`、`INTERVENTION_LEVELS`、
   `LEVEL_RANK`、`GAP_KINDS` / `GAP_SEVERITY`、`DECISION_POINTS`。基准一律用
   `scripts/lib/bundle.mjs` 现 bundle 现 import——不是复刻，是这个包真正会加载的代码。
   其中 `planLevel` 是**逐样本对照**（每个决策点 × 每个 mode × 每个 status × 每类缺口组合，
   本机实测 1000 组以上），不是抽查。
3. **证明面板上的控件不是摆设。** 「同屏呼入」必须真的限制在途条数（`burst=2` → 上限 3、
   `burst=4` → 恰好填满 5 条、`burst=0` → 峰值恒为 1、在途满了 `maybeSpawn()` 必须拒绝）；
   rules 必须真的压低天花板（加一条 `completion_report → L1_note` 的规则后 `configuredCeilingFor`
   从 `L4_human` 变成 `L1_note`，删掉又回到 `L4_human`）；账本累计面板必须有数字。
4. **证明每条剧本都走真实绑定。** `catalog.pointForCall(tool, args)` 必须落在剧本自己声明的决策点上，
   `bindingForCall(...).requires` 必须与剧本的身份相符；只有带工具调用的剧本才谈得上绑定，
   正文剧本（`tool` 为空）必须落在 `narrative_claim`。另外还断言**插件自己的工具不在剧本里**——
   把 `jev_gate_*` 画成"被闸口拦下的团队动作"会让整个演示失真。

它还有一条不在上面四条里的检查：**物理量必须是有限值**。`NaN` 不会抛错，它会静默地画出一片空白，
所以坐标/时间/半径/速度都逐条断言 `Number.isFinite`，并断言证据碎片不会无限堆积。

**它证明不了的事**：桩把 `fillRect` / `arc` / `fillText` 这些绘制原语换成了计数，所以它证明的是
"绘制调用发生了"，**不是"画出来的东西是对的"**。真实浏览器里的渲染是一次人工检查（见 `README.md`
第六节末尾），它需要一台有浏览器的机器和一个桌面会话，因此没有进 `gates`。

---

## 五、`scripts/run-secret-scan.mjs`：密钥门禁

两个职责：

**1. 真实的凭据形状扫描。** 扫描范围 `SCAN_DIRS = ['host','client','scripts']`、
`SCAN_FILES = ['package.json','cordis.patch.yml','README.md']`；跳过 `node_modules`、`.git`、
`.tmp`；对**包根目录**下名为 `lib` 的目录跳过——注释解释了为什么只跳根目录：
"a directory *named* `lib` is not [tsc output]：`scripts/lib/` holds real source that must be
scanned"。五个检测器：

| 检测器 | 形状 |
| --- | --- |
| `sk-prefixed-key` | `\bsk-[A-Za-z0-9_-]{16,}` |
| `bearer-token` | `Bearer` 后跟长 token |
| `aws-access-key-id` | `\bAKIA[0-9A-Z]{16}\b` |
| `api-key-assignment` | 形如 `apiKey = "…"` 的赋值 |
| `opaque-base64url-run` | 40+ 字符的 base64url 串，再由 `classifyBase64Run` 排除：十六进制摘要的形状、不同字符数 `<= 8`、Shannon 熵低于 **3.90 bits/char** |

**2. 一条结构性规则。** 在 `host/` 或 `client/` 里出现 `process.env` **读取**即**硬失败**。
理由：环境变量对每个子进程都可见，且无法按会话撤销。注释里的提及不算失败，只报一行
`exempt [process.env mentioned in a comment, not a read]`；判断由 `commentMask()` 这个状态机
完成（它跟踪字符串与模板，所以字符串里的 `//` 不会被误当成注释）。

两个诚信设计：

- **`ALLOWLIST` 刻意为空。** 注释：每个条目都是"一个真实密钥可以通过的洞"。门禁每次都会打印
  `allowlist: N entries, M exemption(s) considered`，并把每条例外按原因分组列出——
  例外是**可见的**，不是悄悄放过的。
- **门禁自测。** `buildSyntheticSamples()` 在运行时用 `randomBytes(36).toString('base64url')`
  **现造**每个检测器对应的样本，并要求它们既能在直接调用时命中、也能穿过整条扫描管线。
  理由：文件里写一个固定的测试密钥，恰好就是这个门禁要抓的东西。

**它证明不了的事**：它抓形状与结构性违规，不抓"这段逻辑泄密了"。一个没有明显形状的密钥
（例如一段短口令）它抓不到；`ALLOWLIST` 为空只是把这条风险摆在明面上。

---

## 六、`scripts/run-lib-sync.mjs`：`lib/` 新鲜度门禁

`lib/` 是 `tsc` 的产物、被 `.gitignore` 忽略，但它是**真正被发布的东西**。旧版发布过一份
`lib/`，它与 `host/` 已经漂移，于是"跑起来的代码不是仓库里的代码"。这个门禁把 `host/`
重新编译到丢弃目录，再与仓库里的 `lib/` **逐字节**对比；比较的扩展名是
`EMITTED = ['.js','.d.ts','.js.map','.d.ts.map']`。

失败信息是分级的、可读的：

- `lib/ does not exist — the build must run first (tsc emits lib/); refusing to report
  freshness for a directory that is not there`
- typescript 不在 → "run npm install"
- `tsc exited N; freshness cannot be certified while the sources do not compile`
- 逐文件 `lib/<path> is missing (tsc emits it)` / `is stale: tsc no longer emits it` /
  `differs from a fresh build`
- 收尾汇总 `lib is stale — N missing, N stale-extra, N differing of N emitted file(s)`

成功时打印 `lib/ matches a fresh tsc build byte-for-byte (N file(s) compared)`。
丢弃目录在 `finally` 里总是被清掉。

---

## 七、目前的真实状态（实测）

以下是逐一执行、记录退出码得到的，**不是**预期值。这一组数字对应**最后一次检查那一刻**的树。

| 步骤 | 退出码 | 原始输出 |
| --- | --- | --- |
| `typecheck` | 0 | 无输出 |
| `test:logic` | 0 | `OK run-logic-tests: 239 assertions passed` |
| `test:host` | 0 | `OK run-host-tests: 153 assertions passed` |
| `test:client` | 0 | `OK run-client-tests: 67 assertions passed` |
| `test:visualize` | 0 | `OK run-visualize-tests: 50 assertions passed` |
| `test:render` | 0 | `OK run-render-tests: 129 条断言全通过（配置面板真实渲染：结构、保存、密钥、降级态）` |
| `check:contract` | 0 | `OK run-contract-check: 9 contract assertions passed` |
| `check:secrets` | 0 | `OK run-secret-scan: 33 file(s) scanned, 0 findings, 0 process.env reads, 146 exemption(s)` |
| `build` | 0 | 无输出（产出 `lib/`） |
| `check:libsync` | 0 | `OK run-lib-sync: lib/ matches a fresh tsc build byte-for-byte (76 file(s) compared)` |

**`npm run gates` 整体跑过一次，退出码 0。** 下面七条都不是"现在还红着"，而是这份文档写作期间
**真的抓到过并已修好**的缺陷——留档的理由是它们恰好证明这些门禁在抓真东西，而不是走过场：

| # | 抓到什么 | 谁抓到的 | 现在的状态 |
| --- | --- | --- | --- |
| 1 | `host/index.ts` 里 `characters: text.length` 引用不存在的变量 | `typecheck` / `build` / `check:libsync` | 已修好（源码） |
| 2 | `test:host` 找不到脚本 | `npm run gates` 第 3 步 | 已补上 `scripts/run-host-tests.mjs` |
| 3 | 表单缺失时 client 半边抛错而不是降级 | `test:client` | 已修好（源码） |
| 4 | `check:contract` 的解析器不认 bundle 的 `insert:` 形状 | `check:contract` | 已修好（门禁） |
| 5 | `check:libsync` 的镜像目录比 `lib/` 深一层，导致每个 `.map` 必然不等 | `check:libsync` | 已修好（门禁） |
| 6 | **`rulesJson` 在有基线时完全不起作用**——第 6 项简陋点的实质被架空 | `test:host` | 已修好（源码） |
| 7 | **验收条件证据因为 `requirement` 里没有自己的 id 而归不了属**，判否的验收条件被误报成"未上报" | `test:host` | 已修好（源码） |
| 8 | **改凭据引用名时不重新读凭据状态**，导致"已配密钥"的徽章对已有密钥的引用名谎报"还没有密钥" | `test:render` | 已修好（源码） |

第 6、7 条是这份文档交付之后、host 测试第一次真正跑起来才暴露的，它们比前面五条更值得读：
前五条是"工程没做完"，后两条是"**机制是假的**"——配置面板改不动任何东西，证据归属在真实数据上
永远不会命中。所以它们各自单列在下面（第六、七小节），并附上修法。另外 `test:host` 还提出一条
判断题：摘要被篡改的基线此前只留痕、仍被拿去做判定，现在改为拒绝（同样单列）。

### 1. `typecheck` / `build` / `check:libsync`——曾经的真实源码缺陷（现已修好，留档）

**状态：已修好，这条现在不再失败。** 写作期间它曾让三步挂在同一处：

```
host/index.ts(284,25): error TS2304: Cannot find name 'text'.
```

那一行是 `host/index.ts` 收工闸口里写审计事件的 `characters: text.length`，但作用域里
根本没有 `text`（该作用域里只有 `claims`）。它的后果分两层：

- **编译期**：`tsc` 直接失败，于是 `typecheck`、`build`、以及依赖编译的 `check:libsync`
  全部失败——`npm run gates` 因此连第一步都过不去。
- **运行期**（即使绕过编译）：那句话在 `try` 块内，抛错会被 `failSafe('收工闸口', …)` 接住，
  于是**表现成一条 warning 而不是崩溃**——`agent.steer()` 已经发出去了，但
  `store.appendEvent('narrative', …)` 这条审计事件**永远写不进去**。
  这正是本仓库最爱强调的那类缺陷：门禁看起来在工作，但它自己的账少了一页。

修改前这是**源码缺陷**，需要改 `host/index.ts`；本文档只记录，不修改源码。现在那一行是
`characters: claims.reduce((sum, claim) => sum + claim.sentence.length, 0)`，
`typecheck` 与 `build` 都已通过。

### 2. `test:host`——脚本不存在（现已补上）

`package.json` 声明了 `test:host: node scripts/run-host-tests.mjs`，但 `scripts/` 下没有这个文件。
这是纯粹的缺口，不是发现。现在该脚本存在（约 1416 行，153 条断言），它用
`scripts/lib/bundle.mjs` 的 `bundleHost` 把 `host/**` 真打成可执行文件再 `import`，
所以它跑的是**真代码**而不是复刻的逻辑。它自己的摘要分十四区：Gate+Ledger 端到端、advisory 与
enforce 的差别、dry-run 下全部 14 个决策点、决策点天花板、`high → hold` 的力度、冻结基线的权威性、
坏基线文件、持久化往返与 `schemaVersion` 拒绝、`LedgerStoreHub` 的工作区隔离、`RuntimeHub`、
角色缺口、未知团队工具照样过闸、验收条件绝不执行命令、以及 `appendEvent` 不走去抖而快照去抖。

### 3. `test:client`——曾经抓到的两个真实缺陷（现已修好，留档）

**状态：已修好；现在是 `OK run-client-tests: 67 assertions passed`。** 当时这次失败是
**有信息量**的：客户端测试跑到了真实代码，并报出

```
FAIL run-client-tests: configForms.get() 返回 null 时 apply 抛错（缺失的表单必须降级而不是崩溃）：
  Cannot read properties of null (reading 'subscribe')
```

在更早一次运行（`client/index.js:829` 还没有 `ctx.configForms` 兜底之前）它还直接崩在：

```
TypeError: Cannot read properties of undefined (reading 'bind')
    at Module.apply (client/index.js:829:28)
```

即 `client/index.js:829` 的 `const t = ctx.locale.bind(NS)`（这个 `t` 在函数里根本没被用到）
没有做 `ctx.locale` 的存在性检查；`ctx.configForms.get(ENTRY_NS)` 返回 `null` 时，
`JevGateForm` 也会在 `null` 上调 `subscribe`。测试的意图很明确：**缺失的表单必须降级，
不能崩**——当时代码没有做到。这两条是客户端半边的真实缺陷，后来被并行改写的实现修好
（本文档只记录，不修改源码）。

### 4. `check:contract`——`cordis.patch.yml` 的行数（现已修好：改的是门禁）

门禁报 `found 2`，而文件里只有一个 `insert:` 键、下面挂一行：

```yaml
- insert:
    - id: dsh-jev-gate
      name: dsh-jev-gate
```

`run-contract-check.mjs` 自带的 `parsePatchEntries`（一个专门写的扁平 YAML 读取器，
理由是"为了检查一个**不能**新增依赖的文件而引入解析器依赖，是自我拆台"）把这个文件数成了 2 行：
它把**每一行以 `- ` 开头的行**都当成一条 row，于是外层的 `- insert:` 与内层缩进的 `- id: …`
一起被数进去。

**裁定：`cordis.patch.yml` 是对的，门禁是错的。** 依据是权威文档
`dsh-plugin-guide/guide/plugin-dev-guide.md` 里 bundle 的最小结构逐字写着
`├── cordis.patch.yml   # - insert: [{ id, name: 'dsh-hello-plugin' }]`，即 bundle 补丁的顶层
形状就是 `insert:`（bundle 只**追加**条目，不覆写别人的配置）。修法是给解析器加上 wrapper 识别：
遇到 `insert:` / `replace:` 这一层，块状形式就跳过 wrapper 让嵌套的 `- ` 行按顶层 row 读，
流状形式（`- insert: [{ id: …, name: … }]`）则用一对新增的小助手 `splitFlow` / `readFlowRows`
把内联的 `{…}` 逐对读出来。修好之后 `check:contract` 报
`OK run-contract-check: 9 contract assertions passed (catalog, decision points, bundle row, manifest, paths, FIELDS, deciders, defaults, client table)`。

### 5. `check:libsync`——门禁自身的缺陷（现已修好：改的是门禁）

这一条最干净：`npm run build` **刚刚成功**、`lib/` 是刚出炉的产物，紧接着 `check:libsync`
依然报 `.map` 不一致。也就是说，它否定的不是被比较的产物，而是它自己的对比方式。
之前一次运行报的是同一件事的汇总形态：

```
FAIL run-lib-sync: lib is stale — 0 missing, 0 stale-extra, 36 differing of 72 emitted file(s)
```

失败清单里点名的**全是 `.map`**。根因已实测确认，是门禁自己的力量缺陷：

- `lib/ledger.js.map` 里的 `sources` 是 `["../host/ledger.ts"]`；
- 用同样的 `tsconfig.json` 但按门禁的方式覆盖输出目录
  （`--outDir .tmp/probe --declarationDir .tmp/probe/types`）重新编译后，
  同一文件的 `sources` 变成 `["../../host/ledger.ts"]`。

原因：`run-lib-sync.mjs` 把镜像编译产到 `.tmp/libsync/`，**比 `lib/` 深一层**，
于是相对路径的 `..` 层数不同，**每一个 `.map` 文件都必然逐字节不等**。
`scripts/run-lib-sync.mjs:77-80` 的注释声称同时镜像 `--declarationDir` 就能让"源码映射与
声明映射含有与真实构建相同的相对路径"，实测**该断言不成立**——那不是它做到的事，深度才是。

**修法：把镜像编译到与 `lib/` 同深度的 `.tmp-libsync/`**（并在 `.gitignore` 里加上它），
同时把那句不成立的注释改写成"为什么必须同深度"。修好之后报
`OK run-lib-sync: lib/ matches a fresh tsc build byte-for-byte (76 file(s) compared)`。

这一点与第 1 条无关：编译已经通过，它照样失败。

---

## 七之二、host 测试第一次跑起来之后暴露的两条真缺陷

这一节是本文档最该读的部分。前五条是"工程没做完"，下面两条是**机制本身是假的**：
两条都不会让任何门禁变红（typecheck 通过、契约检查通过、客户端契约镜像也通过），
只有真正执行宿主代码的 `test:host` 才会碰到它们。

### 6. `rulesJson` 在有基线时完全不起作用（已修好）

第 6 项简陋点（配置面板只能改扁平字段、规则改不了）的实质，是**"规则真的能改行为"**。
`host/config.ts` 里有一个 `ceilingFor(pointId, config)`，它依次应用：决策点的固有天花板 →
逐条规则（`enabled:false` 压到 L0、显式 `ceiling` 取更低者）→ `lockdown` 封顶 → `capForMode`。

问题是 `host/intervene.ts` 的 `planLevel()` 里，`ceilingFor` **只在 `insufficient` 那一个分支**
被用到；正常路径（有基线、有缺口、真的要判）用的是**决策点的静态静态天花板**：

```ts
const plannedClamped = clampLevel(planned, point.floor, point.ceiling)   // ← 旧代码
```

实测（这就是断言里的数字）：同一份配置

```
mode: 'enforce', rulesJson: '[{"pointId":"completion_report","enabled":false}]'
```

`ceilingFor('completion_report', cfg)` 老老实实返回 `L0_ledger`，可
`planLevel({pointId:'completion_report', status:'halt', gaps:[blocker]})` 依然交付 `L3_deny`。
**即：基线一旦冻结，规则既关不掉也压不低任何决策点。** 一个"能配但配了没用"的旋钮，
比没有这个旋钮更坏——它会让使用者以为自己关掉了某个闸口。

修法是把两个概念拆开（这正是原本就该有的结构）：

- `configuredCeilingFor(pointId, config)` = 固有天花板 + 规则 + `lockdown`，**不套 mode 帽**；
- `ceilingFor(pointId, config)` = `capForMode(configuredCeilingFor(…))`，签名与语义不变；
- `planLevel()` 的**计划级别**钳在 `configuredCeilingFor` 上，**投递级别**再叠 `capForMode`。

最后一条是关键：如果连计划级别也钳在 mode 帽上，dry-run 里 `planned` 会永远变成 `L0_ledger`，
而"账本记下本来会说什么"正是 dry-run 存在的全部理由。修好之后这两条同时成立（已实测）：
`enforce + enabled:false → delivered = L0_ledger`，而 `dry-run + blocker → planned = L3_deny,
delivered = L0_ledger`。

### 7. 验收条件证据归不了属（已修好）

`host/gate.ts` 逐条遍历 `baseline.items`、逐条执行 `item.acceptance` 里的谓词，把结果记成证据。
但记录归属用的是**文本猜测**：`host/baseline.ts` 的

```ts
export function attributeToItem(haystack: string, items: readonly BaselineItem[]): string | null {
  const matches = items.filter((item) => haystack.includes(item.id))
  return matches.length === 1 ? (matches[0]?.id ?? null) : null
}
```

而 `gate.ts` 递进去的 haystack 是 `` `${item.requirement} ${spec}` ``。于是**只有条目的
`requirement` 文本里恰好含自己的 id 时**，这条证据才会被归属。对从团队记录推导出来的基线，
id 是任务 id、requirement 是任务标题——**真实数据里这句话永远不成立**。

后果不是少记一条证据，而是**判反**。实测（fixture 的 requirement 不含 id）：

- 四行状态变成 `["skeleton","unreported","unreported","unreported"]`，`contradicted=1, selfOnly=0`；
- `exists reports/accept.md` 明明 `checked:true, passed:false`（文件不存在），
  却因为记录 `itemId = null` 而拿不到 `counterfactual-failed`（blocker）缺口，
  该行停在 `unreported`（high）。

也就是说：**一个验收条件明明实测失败了，账本却报"这一条没有上报"。** 覆盖率永远上不去，
而真正的失败被稀释成"没说清楚"。

修法：调用方**已经知道**这条证据属于哪个条目时，就不该再让它去猜。`EvidenceInput` 增加一个
可选 `itemId`，`makeEvidence()` 优先用它；`host/gate.ts` 的 `observe()` 多接一个可选参数，
遍历 `item.acceptance` 与 `item.scope` 时把 `item.id` 直接传进去。保守性没有被放宽——两处反证都
保留：①不传 `itemId` 时（自述类证据）仍然走文本猜测，requirement 不含 id 就依然是 `null`；
②`attributeToItem` 的"唯一命中"规则没动，`'t-impl t-accept'` 这种同时命中两个 id 的 haystack
仍然返回 `null` 而不是猜一个。

### 判断题：摘要被篡改的基线（已改为拒绝）

`host/store.ts` 的 `loadBaseline()` 遇到文件摘要与内容不符时，原先只往 `problems` 里记一句
`基线摘要不匹配…`，**然后照样把这份基线返回**。而 `host/baseline.ts` 自己的文档写着这种不符
"is not a crash; it is `baseline-unfrozen`——账本不能再声称它是拿一份冻结范围在判定"。
两者矛盾：拿一份被偷偷改过的基线去做判定，等于让之后每一个裁决都建立在虚构的范围上。

改法是拒绝：记下原因，返回 `null`。于是门禁按既有路径处理"没有可用基线"——要么从团队记录
重新推导，要么报 `baseline-unfrozen`（blocker）。文件本身留在盘上不动，让人能看到发生了什么。
`test:host` 里原本把旧行为钉成了期望（3 条断言），已改为钉新行为，并**同时**断言
"未被改动的基线仍然读得出来"，避免把正常路径一起拒掉。

### 8. 改凭据引用名时不重新读凭据状态（已修好）

`JevGateForm` 的 `readCredential()` 是异步的：它问宿主"这个名字底下有没有密钥"，然后把结果
存进 `this.credential`，面板上的徽章（`这个引用名下还没有密钥。` / `已经配了密钥。`）就照着它画。
它**只在两种时机被调用**：`scope.subscribe(...)` 的通知（宿主侧另一次写入）和
`credentials/reference-updated` 事件（别的页面改了同名凭据）。

于是漏了一条最常见的时机：**用户在面板里把引用名从 `A` 改成 `B`**。这只是一次草稿编辑，
宿主没有写入任何东西，所以 scope 不发布，`reference-updated` 也不会响（凭据没变）——
`this.credential.ref` 停在 `''`，`configured` 停在 `false`。结果：把一个**明明已经配了密钥**的
引用名填进来，徽章仍然说"还没有密钥"。用户会以为刚才没存上，于是再输一遍。

`inject()` 原本只是把 `form.actions()` 原样交出去，宿主拿不到任何"字段被编辑了"的信号。改法是
在 `inject()` 里包一层 `edit` / `resetField`：字段是 `deciderCredentialRef` 时顺手调一次
`this.readCredential()`。`readCredential()` 本身已经带 `if (ref !== this.credential.ref)` 的短路，
所以同一个名字反复编辑不会重复打扰宿主。

`test:render` 的断言是：填入引用名后**恰好一次** `credentials.describe`、无关引用名的
`reference-updated` **不**触发回读。

---

## 八、门禁整体证明不了什么

把这些放在一起，能证明的边界很清楚：

1. **没有一行真实的宿主集成被证明。** `scripts/run-host-tests.mjs` 现在存在，会真的执行
   `host/**` 的代码（打包后 `import`，不是复刻），它能证明的是：冻结基线之后 `Gate.evaluate`
   会算出什么、`LedgerStore`/`RuntimeHub` 的分区与隔离、角色缺口、未知团队工具照样过闸。
   但它**证明了宿主接线层的存在性，没有证明接对了**：它注入的宿主 Service 是一个
   **访问任何属性就抛错**的 `Proxy`，而 `agent/assistant-stream`、`agent/turn-stopping`、
   `ctx.effect(...)` 的注册与回滚这些真正发生在 DSH 运行时内部的行为，没有任何门禁能在这里覆盖。
   所以"这个门禁在真实宿主里真的会拦下一次调用"仍然**没有被证明**。
2. **没有一次真实浏览器渲染被证明。** `test:render`（第四之三节）把配置面板挂载成了真实元素树
   并驱动了它，但它用的是**逐行忠实的原语桩**——真实包顶层 import 了 15+ 个浏览器生态的外部包，
   拉进 `gates` 就等于让门禁依赖浏览器工具链。所以 CSS 观感、焦点顺序、真实浏览器对 `aria-*`
   的播报都还没有门禁背书。演示页 `docs/visualize.html` 同样只在 `node:vm` 的 canvas 桩上跑；
   它在真实浏览器里被渲染过，但那是一次人工检查，不是门禁，而且门禁能证明的也只是"绘制调用
   发生了"，不是"画得对"。
3. **没有一次真实的判定器往返被证明。** `host/decider.ts` 自陈 `endpoint` 那条路
   "has not been exercised against a live third-party service in this checkout"。
4. **`lib/` 的新鲜度现在被证明了。** `check:libsync` 修好镜像目录深度之后报的
   `76 file(s) compared` 是逐字节对比，所以"仓库里的 `lib/` 与一次全新 `tsc` 编译一致"
   这句话现在有门禁背书，而不是"它刚被编出来"。
5. **没有一次真实安装被证明。** 见第九节：本插件没有装进任何 profile。

## 九、安装（本文档不声称已执行）

本插件**没有**被装进任何 profile。要装，读者可以自己在 profile 里做：

```bash
npm ci
npm run gates
npm run build
```

**`npm run gates` 现在跑得绿**（见第七节，九步全 0，退出码 0）。要装之前先按顺序跑这几条命令，
看到的应当是同样一组 `OK`；如果哪一步变红，第七节逐条写了每道门禁在抓什么，可以对着读。

另外要留意的是**它证明不了什么**：`test:host` 注入的宿主 Service 是一个访问即抛错的 `Proxy`，
所以它证明的是宿主代码本身的行为，不是"在真实 DSH 运行时里接对了"。详见第八节。

然后按该 profile 自己的方式引用这个包（例如在桌面应用的 **Plugins → Add plugin** 里填包名），
并注意 `cordis.patch.yml` 刻意不带 `config`——装上之后它仍然是 `enabled: false` +
`mode: 'dry-run'`，需要显式打开。装上之后面板出现在设置页的 `plugins.row.config` 槽位，
注册键是 `dsh-jev-gate#dsh-jev-gate`；这一步在本机**没有做过**，面板也没有被渲染过。
