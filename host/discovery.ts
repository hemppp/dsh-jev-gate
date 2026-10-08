/**
 * 模型发现器：把「填一个 API 地址 + 密钥」变成「从下拉里挑一个模型」。
 *
 * ## 为什么需要它
 *
 * 本插件的判定器最终要两个东西：一个能 POST 问题的**端点**，和一个**模型 id**。
 * 宿主把这两个拆成了四个设置字段（`deciderProvider` / `deciderModel` /
 * `deciderBaseUrl` / `deciderEndpointPath`），因为运行时确实分别要用它们。但让
 * 人配一次 API 就手敲四个值，其中两个还是同一条地址的左右两半，是把内部结构
 * 漏给了使用者。
 *
 * 面板把它们折回一个输入框，靠的正是这里：设置页只收 `deciderBaseUrl` 这一个
 * 地址（端点路径用本模块的默认值），模型则由这个发现器从地址里问出来。
 *
 * ## 为什么注册在 `enabled` 早退之前
 *
 * 发现器不是干预行为，它只回答「这个地址上有哪些模型」。`enabled: false` 的
 * 部署（插件在场但不干预）依然要能在设置页里填好接口——**否则那张设置卡片对
 * 刚装上、还没开用的用户是空的**，而那正是他第一次来这张卡片的时刻。
 *
 * ## 为什么接口形状跟宿主一致
 *
 * 宿主 `dsh-llm` 的 `registerModelDiscovery(settingsNs, discover)` 收的就是这个
 * 形状，`settingsNs` 是本插件的配置命名空间；浏览器的 `llm.discoverModels` 会
 * 带着草稿地址和一次性密钥穿过 `/api/llm/discoverModels` 调回来。浏览器因此
 * 既不必自己发请求（CORS），也不必经手常驻凭据——密钥从表单到出网只在这一次
 * 调用里存在。
 */

/** 一个可被采用的模型候选。形状取自宿主 `dsh-llm` 的发现契约。 */
export interface DiscoveredModel {
  readonly id: string
  readonly name: string
  /** 附注容量：端点给了才有，界面可以据此提示，判定不用。 */
  readonly contextWindow?: number
  readonly maxTokens?: number
}

/** 浏览器问「这个地址上有哪些模型」时给出的草稿。 */
export interface DiscoveryRequest {
  /** OpenAI 兼容的基地址，如 `https://gateway.example/openai/v1`。 */
  readonly baseURL?: string
  /** 本次调用专用的一次性密钥，不落盘。 */
  readonly apiKey?: string
}

/**
 * 端点回复超过这个字节数就拒绝。
 *
 * 上限卡在**实际读到的字节**上，而不是服务端声明的 `content-length`：地址是
 * 人自己敲进去的，先看声明可以把一个诚实的大网关挡在门外，后累加才管得住一个
 * 少报长度或流式输出的端点。模型列表被截断后无法解析，所以这里拒绝而不是截断。
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** 列模型的路由：OpenAI 兼容网关一律是 `{基地址}/models`。 */
const MODELS_PATH = '/models'

/**
 * 收尾多余斜杠后拼出列模型的地址。
 *
 * 基地址按**前缀**处理而不是交给 `URL` 去 resolve，这样
 * `https://gateway.example/openai/v1` 这种带部署路径的地址会保住它自己的段，
 * 不会在解析时被根路径吃掉。
 */
export function modelsUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}${MODELS_PATH}`
}

/**
 * 读一个键；非空字符串以外的一切都当作「没给」。
 *
 * 端点是外部输入，这里不接受「有值但不是字符串」的解释——那只会把一个畸形回复
 * 变成后面某个 URL 拼接里的怪异字符。
 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 读一个正整数字段；缺失或不可用时返回 `undefined`。
 *
 * 容量元数据是给界面看的附注，不是判定的输入，所以一个坏值只该让这行少一个
 * 数字，而不该让整个列表失败。
 */
function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** 发现失败时抛出。`reason` 面向人，`code` 面向界面。 */
export class DiscoveryError extends Error {
  constructor(
    message: string,
    readonly code: DiscoveryFailure,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'DiscoveryError'
  }
}

export type DiscoveryFailure =
  | 'EMPTY_BASE_URL'
  | 'BAD_BASE_URL'
  | 'BAD_API_KEY'
  | 'UNREACHABLE'
  | 'REFUSED'
  | 'ABORTED'
  | 'NOT_JSON'
  | 'TOO_LARGE'
  | 'NOT_A_LISTING'

/**
 * 从一个模型列表回复里读出候选。
 *
 * 标准 `data` 数组优先；某些兼容网关额外给一个 `models` 对象，用属性名当模型
 * id（嵌套的 `id` 只在属性名为空时兜底——网关可能把规范模型名塞在那里，而
 * 请求侧认的是别名）。两种形态都在时以 `data` 为准。
 *
 * 缺 id 的行被跳过而不是让整次询问失败：一条畸形数据不该让人拿不到一个本来
 * 可用地址上的其余模型。名字缺失时回落到 id，好让每一行都有可读的名字。
 */
export function readListing(body: unknown): DiscoveredModel[] {
  if (body === null || typeof body !== 'object') {
    throw new DiscoveryError(
      "这个地址的模型列表既不是 \"data\" 数组也不是 \"models\" 对象；请手填模型 id",
      'NOT_A_LISTING',
    )
  }
  const listing = body as { data?: unknown; models?: unknown }

  /** 已知的容量字段名，按「最可能是哪个」的顺序试。 */
  const contextKeys = ['contextWindow', 'context_window', 'context_length', 'max_input_tokens'] as const
  const outputKeys = ['maxOutputTokens', 'max_output_tokens', 'maxTokens', 'max_tokens'] as const

  const rows: Array<{ key?: string; raw: Record<string, unknown> }> = []
  if (Array.isArray(listing.data)) {
    for (const raw of listing.data) {
      if (raw !== null && typeof raw === 'object') rows.push({ raw: raw as Record<string, unknown> })
    }
  } else {
    const models = listing.models
    if (models === null || typeof models !== 'object' || Array.isArray(models)) {
      throw new DiscoveryError(
        "这个地址的模型列表既不是 \"data\" 数组也不是 \"models\" 对象；请手填模型 id",
        'NOT_A_LISTING',
      )
    }
    for (const [key, raw] of Object.entries(models as Record<string, unknown>)) {
      // 只收对象值：标量属性多半是目录元数据，不是模型记录。
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        rows.push({ key, raw: raw as Record<string, unknown> })
      }
    }
  }

  const models: DiscoveredModel[] = []
  for (const { key, raw } of rows) {
    const id = text(key) ?? text(raw.id)
    if (id === undefined) continue
    const name = text(raw.name) ?? text(raw.display_name) ?? text(raw.displayName) ?? id
    const contextWindow = capacity(...contextKeys.map((name_) => raw[name_]))
    const maxTokens = capacity(...outputKeys.map((name_) => raw[name_]))
    models.push({
      id,
      name,
      // 容量是附注，不参与判定，所以有值才带。
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    })
  }
  return models
}

/** 发请求用的极小接口，便于测试注入。 */
export type DiscoveryFetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  text(): Promise<string>
}>

/**
 * 读回复正文，超出上限就拒绝。
 *
 * 先看声明的长度，让一个诚实的服务端在传输任何东西之前就被转身走开；真正兜底
 * 的是累加出来的总量，因为少报长度（或流式输出）的服务端在开头什么也没说。
 */
async function readBounded(
  response: { headers: { get(name: string): string | null }; text(): Promise<string> },
  url: string,
): Promise<string> {
  const oversized = (): DiscoveryError =>
    new DiscoveryError(`${url} 的回复超过了 ${MAX_RESPONSE_BYTES} 字节上限`, 'TOO_LARGE')
  const declared = Number(response.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw oversized()
  const body = await response.text()
  // 服务端少报长度时，只有真正读到的字节数说话。
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) throw oversized()
  return body
}

/**
 * 问一个 OpenAI 兼容端点：它开放哪些模型。
 *
 * 密钥只在这一句里被放进请求头，不写任何存储，也不进日志；错误信息里也不带它。
 * @param request - 草稿地址与一次性密钥。
 * @param signal - 浏览器取消这次询问。
 * @param fetchImpl - 发请求；测试注入，生产用全局 `fetch`。
 * @returns 候选列表，按端点给的顺序。
 */
export async function discoverModels(
  request: DiscoveryRequest,
  signal: AbortSignal | undefined,
  fetchImpl: DiscoveryFetch,
): Promise<DiscoveredModel[]> {
  const baseURL = text(request.baseURL)
  if (baseURL === undefined) {
    throw new DiscoveryError('请先填写 API 地址', 'EMPTY_BASE_URL')
  }
  let url: string
  try {
    url = modelsUrl(baseURL)
    // 只校验、不解析出协议以外的信息：`new URL` 成功才说明这是一个可请求的地址。
    new URL(url)
  } catch (cause) {
    throw new DiscoveryError(`API 地址 '${baseURL}' 不是可请求的 URL`, 'BAD_BASE_URL', { cause })
  }

  const apiKey = text(request.apiKey)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`

  let response: Awaited<ReturnType<DiscoveryFetch>>
  try {
    response = await fetchImpl(url, signal === undefined ? { headers } : { headers, signal })
  } catch (cause) {
    if (signal?.aborted === true) {
      throw new DiscoveryError('列模型已被取消', 'ABORTED', { cause })
    }
    // 只报地址，不报原因细节：这里的失败原因常常包含 URL 与网络细节，而这条
    // 信息会一路显示在设置页上。
    throw new DiscoveryError(`无法访问 ${url}：请检查地址、网络或密钥`, 'UNREACHABLE', { cause })
  }

  if (!response.ok) {
    const authHint = response.status === 401 || response.status === 403 ? '；请检查密钥' : ''
    throw new DiscoveryError(`${url} 返回 ${response.status}${authHint}`, 'REFUSED')
  }

  let body: string
  try {
    body = await readBounded(response, url)
  } catch (cause) {
    if (signal?.aborted === true) {
      throw new DiscoveryError('列模型已被取消', 'ABORTED', { cause })
    }
    throw cause
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (cause) {
    throw new DiscoveryError(`${url} 没有返回 JSON`, 'NOT_JSON', { cause })
  }
  return readListing(parsed)
}