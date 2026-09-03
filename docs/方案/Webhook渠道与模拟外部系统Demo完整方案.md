# Webhook 渠道与模拟外部系统 Demo 完整方案

方案日期：2026-09-01。状态：待实施。

本文设计一个参考 Telegram Bot API 的 Webhook 渠道。用户只需填写 `Base URL + Token` 并点击“绑定并连接”，DSH 即主动连接外部系统；外部系统不需要知道 DSH 地址。本文同时定义一个放在 `src/webhookDemo` 的最小模拟外部系统，提供单页聊天界面，用于本地联调渠道收发消息。

## 1. 最终决策

Webhook 渠道只采用一套机制：

```text
Base URL + Token
        ↓
POST /v1/getMe 验证身份
        ↓
POST /v1/getUpdates 长轮询收消息
        ↓
TextHarnessBridge 处理消息
        ↓
POST /v1/sendMessage 发送回复
```

关键决定：

- DSH 始终是主动发起连接的一方，不开放入站 Webhook，不要求公网地址。
- 协议固定为 HTTPS/HTTP + JSON + Bearer Token，不使用 WebSocket、SSE 或回调 URL。
- 接收消息使用 Telegram 风格的 `getUpdates(offset, timeout, limit)` 长轮询。
- V1 只支持文本、私聊和群聊；共享命令、Session、Workspace、Agent Preset、上下文增强、权限和主动投递继续复用现有机制。
- 渠道代码复用现有 Token Bot 生命周期和 `TextHarnessBridge`，只新增外部协议适配层。
- Demo 使用 Node.js 内置 HTTP 服务、一个 HTML 文件和内存数据，不增加运行时依赖，也不考虑持久化、集群或可靠性。

虽然产品名称为“Webhook 渠道”，其技术模型实际是“可配置 Base URL 的 Bot API 长轮询渠道”。名称不影响协议边界。

## 2. 目标与范围

### 2.1 必须实现

1. 设置页可以填写 Base URL 和 Token，并点击“绑定并连接”。
2. 绑定时调用外部系统 `getMe`，确认 Token、协议版本和机器人身份。
3. 绑定成功后自动启动长轮询；Host 重启后自动恢复。
4. 外部消息能够进入现有 Harness 会话、命令和权限链路。
5. Harness 最终文本能够通过外部系统发送回原会话。
6. 私聊和群聊使用稳定的外部会话 ID。
7. 支持现有连接状态、重试连接、移除机器人、连接测试、工作区、Agent Preset、上下文增强和文字主动投递。
8. Token 只进入 `ctx.credentials`，配置、状态、错误和日志不得返回 Token。
9. 一个 DSH 可以绑定多个 Webhook Connector；同一 Connector 重绑新 Token 时保留原 bot 状态。
10. 提供一个能直接启动的模拟外部系统及 HTML 聊天页面。

### 2.2 V1 明确不做

- 不让外部系统 POST 到 DSH。
- 不实现 WebSocket、SSE、反向隧道或公共 Relay。
- 不支持图片、文件、语音、卡片、按钮、消息编辑、输入状态和 Reaction；图片与普通文件保留为后续协议扩展，不进入 V1 实现和 Demo。
- 不支持流式更新；只发送最终文字和现有明确错误提示。
- 不允许用户配置任意 API 路径或 JSON 映射模板。
- 不支持 OAuth、动态注册或自动创建外部机器人。
- 不实现 DSH 侧消息队列、离线补发或出站自动重试。
- 不为 Demo 实现数据库、磁盘持久化、幂等、限流、多租户、消息保留承诺或多消费者协调。
- 不重构所有渠道，也不建设新的通用 Connector 框架。

## 3. 用户体验

Webhook 设置页显示两个输入项：

```text
Base URL  https://connector.example.com/dsh/
Token     ••••••••••••••••••••

[绑定并连接]
```

点击后：

1. 浏览器通过现有 Connection RPC 把 `{ baseUrl, token }` 发送给 Host。
2. Host 严格校验 Base URL 和 Token。
3. Host 调用 `{baseUrl}/v1/getMe`。
4. 外部系统返回稳定机器人身份。
5. Host 保存非敏感配置，把 Token 写入凭据服务。
6. Runtime 启动 `getUpdates` 长轮询。
7. Harness 可达且首次 `getUpdates` 成功后，机器人状态显示“HTTP 长轮询运行正常”。

如果身份验证成功但长轮询暂时失败，机器人配置仍然保留，状态显示连接未就绪，并由现有 supervisor 自动重试。删除接入时停止长轮询、删除本地配置、Token、会话状态和 Workspace 绑定，不调用外部系统删除机器人。

## 4. 总体架构

```mermaid
flowchart LR
    U[外部用户] --> E[外部系统]
    D[DSH WebhookRuntime] -->|getMe / getUpdates| E
    E -->|Update JSON| D
    D --> N[normalizeWebhookUpdate]
    N --> B[WebhookHarnessBridge]
    B --> H[Harness]
    H --> B
    B --> C[WebhookBotClient]
    C -->|sendMessage| E
    E --> U
```

职责边界：

| 组件 | 职责 |
| --- | --- |
| 外部系统 | 鉴权、机器人身份、接收其业务消息、提供 Update、把 DSH 回复发回业务会话 |
| `WebhookApi` | Base URL、Bearer Token、HTTP 请求、响应校验和错误分类 |
| `WebhookRuntime` | Harness 启动、身份复核、长轮询、cursor、重连状态和资源停止 |
| `normalizeWebhookUpdate` | 外部 Update 转换成 `TextHarnessBridge.accept()` 所需语义 |
| `WebhookBotClient` | 将共享文字交付转换为 `sendMessage` 请求 |
| `WebhookHarnessBridge` | 只提供渠道 descriptor，业务处理复用 `TextHarnessBridge` |
| `WebhookController` | 复用 Token Bot 的绑定、状态、重连、删除和主动投递生命周期 |

## 5. 外部 Connector 协议 V1

### 5.1 公共约束

- 协议标识：`dsh-im-webhook-v1`。
- 所有接口使用 `POST` 和 `application/json; charset=utf-8`。
- 鉴权头为 `Authorization: Bearer <token>`。
- 成功响应统一为 `{ "ok": true, "result": ... }`。
- 失败响应统一为 `{ "ok": false, "error": { "code", "message", "retry_after"? } }`。
- Token 长度为 20～4096 个字符；Token 不进入 URL、响应或日志。
- `update_id` 和消息序号必须是 JavaScript safe integer。
- `chat.id`、`from.id` 和机器人 `id` 是 1～128 字符的稳定字符串，不允许空白、控制字符和 `|`。
- V1 文本最大 32 KiB，单次 Update 数量最大 100。
- DSH 请求使用 `redirect: "error"`，外部系统不能通过重定向更换目标地址。

### 5.2 Base URL 规则

用户填写的 Base URL：

- 生产环境只允许 `https:`。
- 本地调试允许 `http://localhost`、`http://127.0.0.1` 和 `http://[::1]`。
- 禁止 username、password、query 和 hash。
- 允许非根路径，例如 `https://example.com/connectors/dsh/`。
- 保存前统一补齐结尾 `/`。

接口通过 `new URL("v1/getMe", baseUrl)` 等方式拼接。因此：

```text
Base URL: https://example.com/connectors/dsh/
getMe:   https://example.com/connectors/dsh/v1/getMe
```

Base URL 是用户明确配置的受信 Connector 地址，因此 V1 不额外阻止内网地址；但任何入站消息都不能改变 Base URL。

### 5.3 `getMe`：验证绑定与取得身份

请求：

```http
POST /v1/getMe
Authorization: Bearer webhook-demo-token-123456
Content-Type: application/json; charset=utf-8

{}
```

成功响应：

```json
{
  "ok": true,
  "result": {
    "protocol_version": "dsh-im-webhook-v1",
    "id": "demo-bot",
    "name": "Webhook Demo Bot",
    "username": "webhook_demo",
    "is_bot": true
  }
}
```

要求：

- `id` 在同一个 Base URL 下长期稳定。
- Token 轮换后仍应返回相同 `id`。
- `name` 必填，`username` 可省略。
- `protocol_version` 必须精确匹配；V1 不做协议协商。
- `is_bot` 必须为 `true`。

DSH 内部使用 `规范化 Base URL + "|" + 外部 id` 作为 `platformId`，再复用现有 `deriveTokenBotIdentity()` 生成 `botId` 和 `tokenRef`。因此同一 Base URL、同一外部 id 重绑会更新原机器人；Base URL 改变视为新的 Connector。

### 5.4 `getUpdates`：长轮询收消息

请求：

```http
POST /v1/getUpdates
Authorization: Bearer webhook-demo-token-123456
Content-Type: application/json; charset=utf-8

{
  "offset": 123,
  "timeout": 25,
  "limit": 100
}
```

成功响应：

```json
{
  "ok": true,
  "result": [
    {
      "update_id": 123,
      "message": {
        "message_id": 456,
        "date": 1788200000,
        "chat": {
          "id": "demo-chat",
          "type": "private",
          "title": "Demo Chat"
        },
        "from": {
          "id": "demo-user",
          "name": "Demo User",
          "is_bot": false
        },
        "text": "你好",
        "addressed": true
      }
    }
  ]
}
```

参数语义：

| 字段 | 约束 | 语义 |
| --- | --- | --- |
| `offset` | safe integer，最小 0 | 只返回 `update_id >= offset` 的 Update；提交更大 offset 表示确认更早的 Update |
| `timeout` | 0～30，默认 25 | 没有消息时最多保持请求的秒数；有消息立即返回 |
| `limit` | 1～100，默认 100 | 单次最多返回的 Update 数量 |

消息约束：

- `chat.type` 只允许 `private` 或 `group`。
- 私聊总是视为 addressed；群聊只有 `addressed: true` 才进入 Harness。
- `from.is_bot: true` 的消息被 DSH 忽略，避免机器人循环。
- `text` 是 V1 唯一输入内容；空文本 Update 被忽略。
- Update 按 `update_id` 升序返回。
- 正常超时返回 `result: []`，不是错误。

生产外部系统应自行实现未确认消息保存和 offset 语义。Demo 只在内存中近似实现，不提供可靠性承诺。

### 5.5 `sendMessage`：接收 DSH 回复

请求：

```http
POST /v1/sendMessage
Authorization: Bearer webhook-demo-token-123456
Content-Type: application/json; charset=utf-8

{
  "delivery_id": "delivery-789",
  "chat_id": "demo-chat",
  "reply_to_message_id": 456,
  "text": "你好，我可以帮你处理任务。",
  "format": "markdown"
}
```

成功响应：

```json
{
  "ok": true,
  "result": {
    "message_id": 789
  }
}
```

约束：

- `delivery_id` 是 DSH 为本次交付生成的不透明 ID。
- `chat_id` 必须来自入站消息或已保存的主动投递目标。
- `reply_to_message_id` 可省略。
- `format` 只允许 `plain` 或 `markdown`。
- 外部系统不支持 Markdown 时可以按纯文本显示，但不能丢失文字。
- 成功必须返回稳定 `message_id`。
- DSH 对最终发送不自动重试；生产外部系统可以按 `delivery_id` 做幂等，Demo 不做。

### 5.6 错误和超时

建议错误响应：

```json
{
  "ok": false,
  "error": {
    "code": "invalid_token",
    "message": "Token is invalid"
  }
}
```

| HTTP 状态 | DSH 处理 |
| --- | --- |
| `400` | 明确协议错误；绑定失败或当前消息发送失败 |
| `401` / `403` | 无效 Token 或权限不足；连接失败 |
| `404` | 会话不存在；发送明确失败 |
| `409` | 可用于报告另一个活跃轮询者；Runtime 失败后重连 |
| `429` | 限流；读取 `retry_after`，由 supervisor 稍后重连 |
| `5xx` | Connector 暂时不可用；长轮询重连；发送结果标记不确定 |

默认超时：

- `getMe`：15 秒。
- `sendMessage`：15 秒。
- `getUpdates`：`timeout + 10` 秒，最大 40 秒。

网络错误、发送超时、无效 JSON和 `5xx` 如果发生在请求已经发出之后，映射为现有 unknown delivery 语义，不发送 fallback 副本，不自动重试。明确 `4xx` 映射为 failed。错误对象和日志只保留稳定 code、HTTP 状态和安全摘要，不包含 Token、Authorization Header 或完整响应体。

## 6. DSH 渠道设计

### 6.1 目录结构

```text
src/channels/webhook/
├── config-store.mjs
├── harness-client.mjs
├── state-store.mjs
├── webhook-api.mjs
├── webhook-bridge.mjs
├── webhook-controller.mjs
└── webhook-runtime.mjs

plugin-src/host/channels/webhook/
├── index.mjs
├── production.mjs
└── rpc.mjs

plugin-src/client/channels/webhook/
├── api.js
├── index.js
└── styles.js
```

目录沿用 Telegram 渠道结构，避免引入新的组织方式。

### 6.2 `WebhookApi`

`webhook-api.mjs` 负责：

- `normalizeWebhookBaseUrl(value)`。
- `inspectWebhookBinding({ baseUrl, token })`，内部调用 `getMe`。
- `WebhookApi.getMe()`。
- `WebhookApi.getUpdates({ offset, timeout, limit, signal })`。
- `WebhookApi.sendMessage({ deliveryId, chatId, replyToMessageId, text, format, signal })`。
- 统一 `{ ok, result }` 响应、超时、Abort、HTTP 状态和安全错误映射。

它不处理 Harness、Session、cursor、重连或 UI。

实现保持普通 `fetch` 注入点，测试使用 fake fetch。V1 不直接导入 Telegram 私有 HTTP transport，也不新建通用 Transport 框架；如果真实 Connector 后续出现长轮询占用连接问题，再独立提取共享 transport。

### 6.3 配置和身份

`WebhookConfigStore` 继承 `TokenBotConfigStore`，通过 extension 保存并严格校验：

```json
{
  "botId": "webhook_<24 hex>",
  "platformId": "https://connector.example.com/dsh/|remote-bot-id",
  "tokenRef": "DSH_WEBHOOK_BOT_TOKEN_<24 HEX>",
  "name": "CRM Assistant",
  "username": "crm_bot",
  "baseUrl": "https://connector.example.com/dsh/",
  "remoteBotId": "remote-bot-id",
  "createdAt": "...",
  "connectedAt": "..."
}
```

不保存 Token。`baseUrl` 是非敏感配置，但公共状态只显示协议和机器人身份，不必回传完整 Base URL；设置页如需展示，只显示 host 或脱敏后的地址。

### 6.4 对共享 Token Bot 的最小扩展

当前 `TokenBotController` 和共享 RPC 假定绑定 payload 只有 `{ token }`。为避免复制整套 Controller，增加两个可选扩展点，默认行为完全不变：

1. `TokenBotController` 可选 `inspectBinding(payload)`：
   - 默认仍提取 `payload.token` 并调用现有 `inspectToken(token)`。
   - Webhook 实现校验 `{ baseUrl, token }`，调用 `getMe`，返回 `{ token, platformId, name, username, configExtension }`。
   - Controller 后续保存凭据、原子写配置、启动 Runtime、回滚、状态、重连和删除逻辑保持原样。
2. `createTokenBotRpcHandler()` 可选 `validateBindCredentials(payload)`：
   - 默认仍只接受 `{ token }`。
   - Webhook 只接受 `{ baseUrl, token }`，未知字段拒绝。

这是本方案唯一需要修改的共享 Token Bot 绑定边界。不能把 Base URL 编码进 Token，也不能复制一份完整的 `TokenBotController` 或 RPC Handler。

共享 `createTokenProductionController()` 继续负责：

- ConfigStore 和 StateStore。
- HarnessClient。
- 每 Bot Workspace、Agent Preset 和上下文增强。
- 当前统一访问策略。
- Controller 和 Runtime 装配。
- supervisor 自动重连。
- Delivery adapter 注册。
- 删除状态和关闭资源。

### 6.5 `WebhookRuntime`

状态模型与 Telegram 保持一致：

```js
{
  startedAt: null,
  ready: false,
  connectionState: 'idle',
  harnessReachable: false,
  lastCheckedAt: null,
  lastConnectedAt: null,
  lastError: null,
  ...createTextBridgeStatus()
}
```

`start()`：

1. 调用 `stop()` 清理旧代 Runtime。
2. 设置 `connecting`。
3. `harness.ensureRunning()`。
4. 创建 `WebhookApi({ baseUrl: config.baseUrl, token })`。
5. 调用 `getMe`，再次确认外部身份与保存的 `platformId` 一致。
6. 创建 `WebhookBotClient` 和 `WebhookHarnessBridge`。
7. 从 `state.cursor()` 读取 offset；首次使用 `0`。
8. 立即执行一次 `getUpdates({ offset, timeout: 0, limit: 100 })`；处理返回结果并在成功后设置 `connected/ready`，不能让绑定操作等待 25 秒。
9. 启动使用 `timeout: 25` 的持续 poll task。

`poll()`：

1. 调用 `getUpdates({ offset: cursor, timeout: 25, limit: 100 })`。
2. 验证 Update 数组按 `update_id` 升序且没有无效字段。
3. 为本批消息捕获当前上下文增强快照。
4. 调用 `normalizeWebhookUpdate()`。
5. 对有效消息异步调用 `bridge.accept()`。
6. 每处理一个 Update，把 cursor 更新为 `update_id + 1` 并通过 `ConversationStateStore.setCursor()` 原子保存。
7. 空数组直接进入下一轮。

该确认时机与现有 Telegram Runtime 相同：Update 交给 Bridge 后推进 cursor，不等待一次 Harness 任务完成。V1 不额外建设 durable inbox。

`stop()`：

- Abort 当前请求。
- 清空 API、Bridge 和 poll task 引用。
- 最多等待 poll task 和 `bridge.waitForIdle()` 各 2 秒。
- 状态恢复为 `idle`。
- 重复调用必须幂等。

poll task 非 Abort 错误时设置 `failed`，由现有 supervisor 负责重启整个 Runtime，不在内部增加第二套退避循环。

### 6.6 消息标准化

`normalizeWebhookUpdate(update, { botId })` 只做 V1 所需转换：

```js
{
  messageId: String(update.update_id),
  senderId: String(message.from.id),
  senderIsBot: message.from.is_bot === true,
  kind: message.chat.type === 'group' ? 'group' : 'direct',
  conversationId: String(message.chat.id),
  content: message.text,
  plainText: true,
  addressed: message.chat.type === 'private' || message.addressed === true,
  contextSource: () => ({ senderName: message.from.name }),
  replyTarget: {
    chatId: String(message.chat.id),
    replyToMessageId: message.message_id
  },
  connectionTestTarget: {
    chatId: String(message.chat.id)
  }
}
```

不直接复用 `normalizeTelegramUpdate()`，因为它还包含 Telegram mention、topic、图片、文件和下载逻辑。Webhook normalizer 保持为一个小型纯函数，业务层仍复用 `TextHarnessBridge`。

### 6.7 Bridge 和 BotClient

`WebhookHarnessBridge` 仅设置 descriptor：

```js
{
  key: 'webhook',
  label: 'Webhook',
  connectionLabel: ' HTTP 长轮询'
}
```

不声明 Reaction。

`WebhookBotClient` 只实现：

- `sendText(target, text)`：按 plain 调用 `sendMessage`。
- `sendDelivery(target, block)`：传递 `plain/markdown` 格式并返回 `providerMessageIds`。

不实现 `openDeliveryStream`、`sendTyping`、`addReaction`、`sendImage` 或 `sendFile`。`TextHarnessBridge` 会使用现有非流式文字路径；遇到产物时沿用共享的明确失败提示，不静默丢失。

### 6.8 主动投递

Webhook Delivery Target 使用一个目标类型：

```json
{
  "targetId": "demo-chat",
  "kind": "chat",
  "route": {
    "chatId": "demo-chat"
  }
}
```

Runtime 校验 `kind === "chat"` 且 `route.chatId` 是合法外部 ID，然后调用 `bridge.sendProactiveText({ chatId }, text)`。目标候选从共享状态中的 `direct:<chatId>` 和 `group:<chatId>` conversation key 生成。

需要在现有 Delivery 支持表、路由校验、候选解析和客户端字段定义中加入 `webhook`。不新增主动投递历史、重试或幂等逻辑。

### 6.9 Host 和 Client 接入

Host：

- 新增 `/webhook` RPC channel。
- 使用共享 Token Bot endpoint 名称。
- 在 `plugin-src/host/index.mjs` 注册 Webhook channel，并注入现有 `deliveryService`。
- Webhook 启动失败不得阻止其他渠道。

Client：

- 复用 `createTokenChannelSettings()`。
- 自定义 `CredentialPanel`，内部继续使用现有 `CredentialBindingPanel`：
  - identity 字段显示为 `Base URL`。
  - secret 字段显示为 `Token`。
- `credentialPayload({ identity, secret })` 返回 `{ baseUrl: identity, token: secret }`。
- 复用机器人卡片、状态轮询、连接检查、移除、Workspace、Agent Preset、上下文增强和设置按钮。
- 新增最小 Webhook 图标和样式，不复制页面布局。

## 7. 模拟外部系统 Demo

### 7.1 目标

Demo 用于证明完整链路：

```text
HTML 页面输入消息
    ↓
Demo 写入内存 Update 队列
    ↓
DSH getUpdates 拉到消息
    ↓
Harness 生成回复
    ↓
DSH sendMessage
    ↓
Demo HTML 页面显示机器人回复
```

Demo 不模拟生产可靠性，只要便于本机启动、绑定和观察消息即可。

### 7.2 目录结构

代码全部放在用户指定目录：

```text
src/webhookDemo/
├── server.mjs
├── index.html
└── README.md
```

不增加前端构建、CSS 文件、客户端框架或数据库。

### 7.3 启动方式

建议增加 npm script：

```json
{
  "scripts": {
    "demo:webhook": "node src/webhookDemo/server.mjs"
  }
}
```

默认启动：

```text
Host:      127.0.0.1
Port:      8787
Base URL:  http://127.0.0.1:8787/
Token:     webhook-demo-token-123456
Chat URL:  http://127.0.0.1:8787/
```

允许通过环境变量覆盖：

- `WEBHOOK_DEMO_HOST`，默认 `127.0.0.1`。
- `WEBHOOK_DEMO_PORT`，默认 `8787`。
- `WEBHOOK_DEMO_TOKEN`，默认 `webhook-demo-token-123456`。

默认只监听 loopback，避免无意暴露 Demo Token。

### 7.4 `server.mjs`

仅使用 Node 内置模块：

- `node:http` 提供服务。
- `node:fs/promises` 读取 `index.html`。
- `node:url` 和 `node:path` 定位静态文件。
- `node:crypto` 生成 `delivery_id` 或消息 ID（如有需要）。

内存状态：

```js
{
  updates: [],
  transcript: [],
  waiters: Set,
  nextUpdateId: Math.max(Date.now(), previous + 1),
  nextMessageId: 1
}
```

Update ID 使用当前毫秒时间并保证进程内单调递增。这样 Demo 重启后生成的 ID 通常仍大于 DSH 已保存的 cursor，不需要为了调试增加磁盘持久化。

Demo 路由：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/` | 返回聊天页 |
| `GET` | `/demo/config` | 返回当前 Base URL、脱敏提示和 Demo Token，供本地页面展示 |
| `GET` | `/demo/messages?after=<seq>` | 页面轮询聊天记录 |
| `POST` | `/demo/messages` | 页面提交一条用户消息并生成 Update |
| `POST` | `/v1/getMe` | Connector 身份接口 |
| `POST` | `/v1/getUpdates` | 长轮询 Update |
| `POST` | `/v1/sendMessage` | 接收并记录 DSH 回复 |

服务端约束：

- API 请求体上限 64 KiB。
- `/v1/*` 必须验证 Bearer Token；`/demo/*` 只因默认 loopback 而不鉴权。
- `getUpdates` 最多保持 30 秒；请求关闭时移除 waiter。
- 页面提交固定使用：
  - `chat.id = "demo-chat"`
  - `chat.type = "private"`
  - `from.id = "demo-user"`
  - `from.name = "Demo User"`
- 新用户消息同时写入 transcript 和 updates，并立即唤醒等待中的 `getUpdates`。
- `sendMessage` 把机器人消息写入 transcript，返回递增 message ID。
- 当 DSH 提交更大 offset 时，Demo 可以删除更早 Update；进程退出时全部数据丢失。
- `SIGINT/SIGTERM` 时关闭 server，并用空数组结束所有 pending poll。

为了便于测试，`server.mjs` 导出 `createWebhookDemoServer(options)`；直接执行文件时才监听默认端口。测试可传入 `port: 0` 获取随机端口。

### 7.5 `index.html`

单个 HTML 文件内联少量 CSS 和 JavaScript，界面只包含：

- 标题“Webhook Demo Chat”。
- 当前 Base URL 和 Token，附复制提示。
- DSH 长轮询状态提示：根据最近一次 `getUpdates` 时间显示“DSH 已连接/等待连接”。
- 消息列表，区分“Demo User”和“DSH Bot”。
- 文本输入框和发送按钮。
- 清晰展示服务端错误。

浏览器行为：

1. 加载 `/demo/config`。
2. 每 500～1000 毫秒调用 `/demo/messages?after=<lastSeq>`。
3. 提交表单到 `/demo/messages`。
4. 使用 `textContent` 渲染消息，禁止把消息内容写入 `innerHTML`。
5. 页面卸载时不需要额外清理。

页面不直接调用 DSH，也不需要知道 DSH 地址。

### 7.6 `README.md`

只记录：

1. 启动命令。
2. 默认 Base URL 和 Token。
3. 在 DSH 设置页绑定的方法。
4. 打开聊天页并发送消息的步骤。
5. Demo 的内存数据和无可靠性限制。

## 8. 现有代码复用清单

| 现有组件 | 处理 |
| --- | --- |
| `TokenBotController` | 增加可选 binding hook 后复用生命周期、状态、重连、删除和主动投递 |
| `TokenBotConfigStore` | 通过 extension 保存 Base URL 和 remote bot id |
| `ConversationStateStore` | 原样复用 Session、seen message IDs 和 cursor |
| `TextHarnessBridge` | 原样复用消息队列、命令、Session、审批、问题、历史、Workspace、Preset、权限和最终回复 |
| `HarnessClient` | 通过薄 `WebhookHarnessClient` 设置日志/RPC 前缀 |
| `createTokenProductionController` | 原样复用生产装配；只传入 Webhook 定义 |
| `createTokenConnectionSupervisor` | 原样复用自动初始化和重连 |
| `createTokenChannelSettings` | 原样复用设置页；只提供双字段 CredentialPanel |
| `DeliveryService` | 原样复用目标管理和发送服务 |
| `createDeliveryAdapter` | 增加 Webhook route case |
| 共享上下文增强和访问策略 | 把 `webhook` 加入渠道集合后复用 |

不复用的 Telegram 专属部分：

- `normalizeTelegramUpdate()`。
- Telegram 图片、文件和 rich-message 转换。
- Telegram mention、topic、command menu 和 webhook conflict 检查。
- Telegram Token 格式和 API URL。
- Telegram 私有 Undici transport；V1 先用普通 fetch 注入点。

## 9. 预计文件改动

### 9.1 新增

| 文件 | 用途 |
| --- | --- |
| `src/channels/webhook/webhook-api.mjs` | Connector HTTP API 和绑定检查 |
| `src/channels/webhook/webhook-runtime.mjs` | 长轮询 Runtime、normalizer、BotClient |
| `src/channels/webhook/webhook-controller.mjs` | Token Bot controller 定义 |
| `src/channels/webhook/config-store.mjs` | Base URL 配置扩展和身份派生 |
| `src/channels/webhook/state-store.mjs` | `ConversationStateStore` 薄子类 |
| `src/channels/webhook/webhook-bridge.mjs` | descriptor + `TextHarnessBridge` 薄子类 |
| `src/channels/webhook/harness-client.mjs` | `HarnessClient` 薄子类 |
| `plugin-src/host/channels/webhook/*` | Host 装配和 RPC |
| `plugin-src/client/channels/webhook/*` | 设置页、API 和最小样式 |
| `src/webhookDemo/server.mjs` | 模拟 Connector 服务 |
| `src/webhookDemo/index.html` | 简单聊天页 |
| `src/webhookDemo/README.md` | Demo 使用说明 |
| `test/channels/webhook/*.test.mjs` | 渠道单元、生产装配、RPC 和 UI 测试 |
| `test/webhook-demo.test.mjs` | Demo 端到端 HTTP 测试 |

### 9.2 修改

| 文件/区域 | 改动 |
| --- | --- |
| `src/channels/shared/token-bot-controller.mjs` | 可选 `inspectBinding`，默认行为不变 |
| `plugin-src/host/channels/shared/rpc.mjs` | 可选 bind payload validator，默认行为不变 |
| `plugin-src/host/index.mjs` | 注册 Webhook Host 渠道 |
| `plugin-src/client/index.js` | 注册 Webhook 设置页、RPC 和图标 |
| `plugin-src/client/channel-logos.js` | Webhook 图标 |
| `plugin-src/host/delivery-adapter.mjs` | `webhook` 和 `{ chatId }` route |
| `plugin-src/host/delivery-suggestions.mjs` | Webhook 会话候选 |
| `plugin-src/client/delivery-settings.js` | Webhook 主动投递表单 |
| `src/channels/shared/context-enhancement.mjs` | 加入 `webhook` 渠道键 |
| 访问策略渠道集合及对应 UI/RPC 测试 | 加入 Webhook |
| `package.json` | 增加 `demo:webhook`；渠道描述从九个更新为十个 |
| `scripts/verify-package.mjs` | 校验 Webhook Host、Runtime 和 RPC marker |
| `README.md`、`README.en.md`、`CHANGELOG.md` | 渠道、绑定和 Demo 文档 |
| `lib/index.js`、`lib/client.js` | 由现有 build 生成 |
| 所有硬编码九渠道数组和测试 | 加入 `webhook`，保持原渠道基线不变 |

实施时先通过 `rg` 再次检索 `nine`、`九个/九种/九渠道` 和九渠道数组，避免遗漏包验证、Compact、History、Session 和 UI 测试中的渠道清单。

## 10. 测试方案

### 10.1 API 和安全

- 只接受合法 HTTPS 或 loopback HTTP Base URL。
- 拒绝 URL credentials、query、hash、无效协议和重定向。
- 所有请求使用 Bearer Token，错误和日志不泄漏 Token。
- `getMe` 拒绝错误协议版本、无效 bot id/name 和 `is_bot !== true`。
- 超时、Abort、无效 JSON、`4xx`、`429`、`5xx` 使用稳定错误语义。
- `sendMessage` 的 unknown delivery 不自动重试。

### 10.2 Controller、配置和 RPC

- `{ baseUrl, token }` 可以绑定并启动 Runtime。
- 其他 Token 渠道继续只接受 `{ token }`。
- 同 Base URL、同远端 id 重绑复用 botId；更换 Token 不丢 Session/Workspace。
- 不同 Base URL 即使返回相同远端 id，也产生不同 botId。
- 配置只包含 Base URL、remote id 和 tokenRef，不包含 Token。
- 配置写入失败恢复旧 Token；启动失败保留配置并显示可重试状态。
- 删除时停止 Runtime、删除 Token、配置、state 和 workspace。
- 公共 RPC 响应不返回 Base URL 中可能包含的敏感信息，更不返回 Token。

### 10.3 Runtime 和 Bridge

- 启动顺序为 Harness → getMe → 首次 getUpdates → connected。
- direct 消息进入 `TextHarnessBridge` 并通过 sendMessage 回复。
- 未 addressed 的 group 消息被拒绝且不回复。
- `from.is_bot`、重复 update 和无效 payload 被忽略。
- cursor 按 update 顺序持久化，重启后从保存位置继续。
- 空 poll 正常循环；poll 失败进入 failed，交给 supervisor 重连。
- stop 取消 poll、等待 Bridge、有界返回且幂等。
- plain 和 markdown 最终文本映射正确。
- 文件/图片请求走共享明确降级，不静默丢失。
- 连接测试在收到一条私聊后可以发送到记忆目标。
- 主动投递使用 `{ kind: "chat", route: { chatId } }`。

### 10.4 Host、Client 和回归

- Webhook 渠道失败不阻止其他渠道激活。
- 设置页显示 Base URL + Token，并提交精确 payload。
- 状态、重连、删除、Workspace、Preset、上下文增强、权限和 Delivery 设置复用正常。
- 所有既有渠道共享 Controller/RPC 测试保持通过。
- 构建 bundle 和发布包包含新增 Host、Client 和 Runtime。

### 10.5 Demo

使用随机端口启动真实 Demo server，验证：

1. 无 Token 调用 `/v1/getMe` 返回 `401`。
2. 正确 Token 返回 Demo bot identity。
3. `/demo/messages` 创建 Update，并立即释放等待中的 `getUpdates`。
4. offset 增长后旧 Update 不再返回。
5. `/v1/sendMessage` 把 DSH 消息写入浏览器 transcript。
6. `/demo/messages?after=` 只返回新增消息。
7. `/` 返回可用 HTML，消息使用文本渲染。
8. 关闭 server 时 pending poll 正常结束。

Demo 测试不覆盖持久化、幂等、多消费者、限流和跨进程恢复。

## 11. 实施顺序

### 阶段 1：协议和 API

1. 完成 Base URL 校验和 `WebhookApi`。
2. 锁定三个接口和错误契约。
3. 完成 API 单元测试。

### 阶段 2：共享绑定扩展和渠道核心

1. 给共享 Token Controller/RPC 增加两个可选 hook。
2. 先跑全部既有 Token 渠道测试，确认默认行为不变。
3. 新增 ConfigStore、Controller、StateStore、Bridge、BotClient 和 Runtime。
4. 完成 poll、cursor、消息收发和生命周期测试。

### 阶段 3：Host、Client 和主动投递

1. 接入 shared production 和 supervisor。
2. 注册 Host/RPC/Client 渠道。
3. 接入上下文增强、访问策略和 Delivery。
4. 更新渠道硬编码清单和 UI 测试。

### 阶段 4：Demo

1. 实现 `server.mjs` 和真实 HTTP 测试。
2. 实现单页 `index.html`。
3. 编写 Demo README 和 npm script。
4. 使用真实 DSH 完成一轮本机收发联调。

### 阶段 5：发布验证

1. 更新中英文 README、包描述、CHANGELOG 和 package verification。
2. 执行 `npm run check`。
3. `npm pack` 后在空临时目录安装并导入 Host/Client bundle。
4. 从发布包启动 Demo，完成一次 Base URL + Token 绑定和聊天闭环。

## 12. 验收标准

满足以下条件即可认为 V1 完成：

- 用户只填写 Base URL 和 Token 就能绑定，不需要 DSH 地址。
- 绑定会验证真实外部身份，Token 不进入配置、状态和日志。
- 外部系统通过长轮询向 DSH 提供文本消息。
- 私聊消息可以触发 Harness，并在同一个外部会话看到最终回复。
- 群聊 addressed 边界、机器人消息过滤和重复 Update 去重有效。
- Host 重启和短暂网络故障后可以从持久化 cursor 恢复轮询。
- 连接状态、自动重连、删除、连接测试、Workspace、Preset、上下文增强、权限和文字主动投递可用。
- 图片和文件等未支持能力产生明确提示，不静默丢失。
- Demo 一条命令启动，浏览器页面能够完成用户消息 → DSH → 机器人回复闭环。
- Demo 没有数据库、WebSocket、前端框架或新增第三方依赖。
- 既有渠道行为和测试没有退化，完整构建和包验证通过。

## 13. 后续能力触发条件

V1 上线后只有出现真实需求和证据时才增加：

- 外部 Connector 明确需要图片或文件时，在保持 `getMe/getUpdates/sendMessage` 不变的前提下，为 Update 增加可选 `message.attachments`，并增加基于受控 `file_id` 的 `downloadFile` 接口；不接受任意下载 URL 或把文件编码进 `getUpdates`。现有 `WebhookApi`、normalizer 和 `TextHarnessBridge` 分层能够承接该扩展，V1 不提前实现。
- 长轮询在真实代理环境出现连接竞争时，再提取共享私有 HTTP transport。
- 外部系统达到高并发且长轮询成为瓶颈时，再评估 WebSocket；不得与 V1 同时实施。
- 需要严格任务不丢失时，单独设计 durable inbox/outbox 和 Harness 幂等，不修改本协议的简单 cursor 基线。
- 需要多个 Connector 方言时，先由外部系统适配到本协议，不在 DSH 内引入任意 JSON 映射器。

在这些条件出现前，保持三个 API、文本消息和现有共享机制即可。
