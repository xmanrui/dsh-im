# 主动投递使用指南

**简体中文** · [English](PROACTIVE_DELIVERY.en.md)

主动投递让应用在没有用户新消息的情况下，通过已经接入 DSH-IM 的机器人发送文字消息。调用方只需保存一组稳定的 `botId + targetId`，不需要保存 Harness `sessionId`、聊天引用、消息 ID 或临时 Webhook。

九个内置渠道均支持主动投递：微信、飞书、钉钉、企业微信、QQ、Slack、Telegram、Discord 和 WhatsApp。

## 快速开始

1. 打开「设置 → IM机器人」，找到需要发消息的机器人。
2. 点击机器人卡片右上角的齿轮图标。
3. 在「调用标识」中复制 `Bot ID`。
4. 点击「新建目标」，从已聊会话中选择，或点击「手动填写（高级）」填写平台原生 ID。
5. 填写或确认 `Target ID`、目标类型和平台原生 ID。
6. 点击「测试」。目标收到 `DSH-IM 主动投递测试成功。` 后，再点击「保存目标」。
7. 在已保存目标上点击「复制调用参数」，得到可供应用保存的 `{ botId, targetId }`。
8. 使用 HTTP POST、同 Host 的 `ctx.dshIm.send()` 或 Connection RPC 的 `message.send` 发送消息。

## 配置投递目标

### 1. 获取 Bot ID

`botId` 是当前已接入机器人的真实调用标识。请从设置页复制并将它视为不透明字符串，不要根据前缀推断渠道，也不要使用机器人名称、平台 App ID 或卡片中的脱敏 ID 代替。

目标配置跟随当前机器人保存。移除机器人时，它的投递目标也会被清理；重新接入后应重新复制 `botId` 并配置目标。

### 2. 新建目标

点击「新建目标」后，默认显示「从已聊过的会话选择」下拉框：

- 候选来自该机器人已经持久化的会话映射，不是平台通讯录，也不是严格按时间排序的完整最近会话列表。
- 候选只包含投递所需的目标类型和平台原生 ID，不包含 Harness `sessionId`、消息正文、消息 ID、会话名称或最后活跃时间。
- 已配置的相同目标会显示「已添加」并禁用。
- 没有候选时，先在对应平台与机器人聊一条消息，再点击「刷新」。仍未出现时可使用「手动填写（高级）」。

选择候选只会预填表单，不会自动保存。

### 3. 理解 Target ID

`targetId` 是你为调用方定义的稳定别名，不是平台用户 ID、群 ID 或频道 ID。

- 它只需在同一个机器人下唯一；不同机器人可以使用相同的 `targetId`。
- 可使用大小写字母、数字、点、下划线、冒号、`@` 或连字符，长度为 1–128 个字符。
- 新建时页面默认生成 `tgt_` 加 16 位十六进制随机串，例如 `tgt_7f3a91c8d2e64b10`。
- 首次保存前可以修改，例如改成 `daily-report` 或 `release-alerts`。
- 保存后 `targetId` 不可修改，但名称、目标类型和平台原生路由可以修改；调用方仍使用原来的 `botId + targetId`。

### 4. 测试、保存和复制

从会话新建、手动新建和编辑目标时，表单底部都会显示「测试」按钮：

- 机器人在线且当前目标所需的平台 ID 已填写完整时，测试按钮才可用。
- 测试使用当前表单中的目标类型和平台 ID，不会先创建、更新或保存目标。
- 修改测试过的平台 ID 后，旧的成功提示会清除，需要重新测试。
- 已保存目标列表中的「测试」按钮测试该目标当前保存的路由。
- 测试成功表示平台发送接口已接受请求或 SDK 成功返回，不代表消息已经被阅读。

保存后点击「复制调用参数」，页面会复制如下 JSON：

```json
{
  "botId": "bot_9577c8572d454122a4ef7fb4d8420a91",
  "targetId": "release-alerts"
}
```

### 配置示例：飞书告警群

假设飞书机器人已经在告警群中收到过消息：

1. 打开该机器人的设置页并复制 `Bot ID`。
2. 点击「新建目标」，在下拉框中选择告警群。
3. 将自动生成的 `Target ID` 改为 `release-alerts`，显示名称填为「发布告警群」。
4. 确认目标类型为「群聊」，群 Chat ID 已自动填入。
5. 点击「测试」，到飞书群中确认测试消息。
6. 点击「保存目标」，再点击「复制调用参数」。

以后即使编辑并更换群 Chat ID，调用方仍可继续使用同一组 `botId + release-alerts`。

## 私聊会话双向同步

已保存的私聊目标可以在目标行开启「会话双向同步」，默认关闭。开启后：

1. DSH Web／CLI 向该私聊当前绑定的 Session 提交的用户文字，会以 `[来自 DSH]` 开头发送到私聊。
2. 该 Turn 成功完成后，按 step 合并的最终助手文字会以 `[DSH 助手]` 开头再发送一次。
3. IM 用户自己的普通提问和 `/steer` 仍走原回复链，不会被同步逻辑重复发送或转发给其他目标。

开关只保存私聊目标，不保存 `sessionId`，因此会自动跟随 `/session` 切换。执行 `/new` 或切换工作区后，状态暂时显示「等待该私聊建立新会话」；该私聊下一次建立 Session 后自动恢复，无需重新开关。

开启要求目标来自该机器人已经聊过、已有当前 Session 的唯一私聊。群聊、Slack Thread、Telegram Topic、Discord 服务器频道和其他无法确认是私聊的目标显示为不可用。显式配置了远程 `harnessBaseUrl` 的渠道也不支持；首版仅同步当前 Host 的文字，不同步图片、文件、卡片、工具过程、审批或历史消息。修改目标类型或平台路由会自动关闭同步，改名不会。

## 九渠道手动填写字段

优先从已聊会话中选择。只有目标未出现在候选中时，才需要手动取得以下平台原生 ID。

| 渠道 | 目标类型 | 需要填写的字段 | 示例或说明 |
| --- | --- | --- | --- |
| 微信 | `user` | 微信用户 ID（`toUserId`） | 填写接收消息的微信用户 ID |
| 飞书 | `user` | Open ID（`openId`） | 例如 `ou_xxx` |
| 飞书 | `group` | 群 Chat ID（`chatId`） | 例如 `oc_xxx` |
| 钉钉 | `user` | 用户 ID（`userId`） | 填写钉钉用户 ID |
| 钉钉 | `group` | 群 Open Conversation ID（`openConversationId`） | 主动投递不使用临时 `sessionWebhook` |
| 企业微信 | `user` | 用户 ID（路由字段为 `chatId`） | 私聊填写用户 ID |
| 企业微信 | `group` | 群 Chat ID（`chatId`） | 群聊填写群 `chatid` |
| QQ | `user` | 用户 Open ID（`userOpenId`） | 平台提供的 `user_openid` |
| QQ | `group` | 群 Open ID（`groupOpenId`） | 平台提供的 `group_openid` |
| Slack | `conversation` | Channel ID（`channelId`） | 例如 `C0123456789` |
| Slack | `thread` | Channel ID + Thread 时间戳（`channelId`, `threadTs`） | 例如 `1712345678.123456` |
| Telegram | `chat` | Chat ID（`chatId`） | 十进制字符串，例如 `-1001234567890` |
| Telegram | `topic` | Chat ID + Topic ID（`chatId`, `messageThreadId`） | Topic ID 必须是正整数 |
| Discord | `channel` | Channel ID（`channelId`） | 私信、频道和 Thread 都使用可发消息的 Channel ID |
| WhatsApp | `user` | 用户 JID（`jid`） | 例如 `8613800000000@s.whatsapp.net` |
| WhatsApp | `group` | 群 JID（`jid`） | 例如 `1234567890-123456@g.us` |

平台 ID 字符串不能为空或带首尾空格。一个目标只接受所选渠道和类型要求的字段，额外字段会被拒绝。

## 通过 HTTP POST 发送

普通外部应用可以直接调用 Host 的主动投递接口：

```bash
curl --request POST \
  http://127.0.0.1:3080/api/dsh-im/delivery/messages \
  --header 'Content-Type: application/json' \
  --data '{
    "botId": "bot_9577c8572d454122a4ef7fb4d8420a91",
    "targetId": "release-alerts",
    "text": "构建已经完成。"
  }'
```

成功返回：

```json
{ "sent": true }
```

请求体严格只接受 `botId`、`targetId` 和 `text`，JSON 总大小不能超过 1 MiB。不要附加平台原生路由、`sessionId`、`chatRef`、临时 Webhook 或 `idempotencyKey`。

接口路径固定为 `POST /api/dsh-im/delivery/messages`，复用当前 DSH Host 的 WebServer，不会另开端口。示例中的 `3080` 是 Web profile 的默认端口；实际地址以 Host 启动时显示的地址为准。

当前 HTTP 接口不包含鉴权，也不提供 CORS。只应在本机或可信网络中使用，不要直接暴露到公网。

## 在同一 Host 的插件中发送

消费插件声明 `dshIm` 注入后，可以直接调用共享服务，不经过 Connection RPC。

下面是一个最小示例；插件加载时会发送一次消息：

```js
export const inject = ['dshIm'];

export async function apply(ctx) {
  const result = await ctx.dshIm.send(
    'bot_9577c8572d454122a4ef7fb4d8420a91',
    'release-alerts',
    '构建已经完成。',
  );

  if (result.sent !== true) {
    throw new Error('主动投递没有返回成功结果');
  }
}
```

实际使用时，把 `ctx.dshIm.send()` 放进你的定时任务、构建回调或业务事件处理函数中。可选的第四个参数当前支持取消信号：

```js
await ctx.dshIm.send(botId, targetId, text, { signal });
```

同 Host 插件也可以列出某个机器人的已保存目标：

```js
const targets = await ctx.dshIm.listTargets(botId);
// [{ targetId, name?, kind, route }, ...]
```

同 Host 插件可以通过同一个服务发现已配置机器人：

```js
const bots = await ctx.dshIm.listBots();
// [{ botId, channel }, ...]
```
返回值只包含稳定的公开元数据，不包含凭据、平台路由或目标内容。

调用失败时 Promise 会拒绝，`error.code` 使用本文后面的公共错误码。

## 通过 Connection RPC 发送

Connection RPC 适合已经持有当前 DSH Host `connection` 客户端的调用方，也是设置页管理目标所使用的接口。普通外部应用优先使用上面的 HTTP POST。

先封装 RPC 成功与错误包络：

```js
const DELIVERY_CHANNEL = '/dsh-im-delivery';

async function callDelivery(connection, endpoint, payload, signal) {
  const result = await connection.rpc.call(
    DELIVERY_CHANNEL,
    endpoint,
    payload,
    signal,
  );

  if (result?.ok !== true) {
    const error = new Error(result?.error?.message || 'delivery-failed');
    error.code = result?.error?.code || 'delivery-failed';
    throw error;
  }
  return result.value;
}
```

然后使用已复制的 `botId + targetId` 发送文字：

```js
const result = await callDelivery(connection, 'message.send', {
  botId: 'bot_9577c8572d454122a4ef7fb4d8420a91',
  targetId: 'release-alerts',
  text: '构建已经完成。',
});

// result: { sent: true }
```

`message.send` 只接受 `{ botId, targetId, text }`。不要附加平台路由、`sessionId`、`chatRef`、临时 Webhook 或 `idempotencyKey`。

### 示例：投递每日报告

```js
async function sendDailyReport(connection, summary) {
  try {
    await callDelivery(connection, 'message.send', {
      botId: 'bot_9577c8572d454122a4ef7fb4d8420a91',
      targetId: 'daily-report',
      text: `今日运行摘要\n\n${summary}`,
    });
  } catch (error) {
    if (error.code === 'bot-not-connected') {
      // 等待机器人恢复连接后，由业务决定是否重试。
      return { delivered: false, reason: 'offline' };
    }
    throw error;
  }
  return { delivered: true };
}
```

## 管理 RPC 参考

设置页使用同一个 Connection RPC 通道管理目标。普通调用方通常只需要 `message.send`；需要自行管理目标时再使用其他端点。

所有响应均为 `{ ok: true, value }` 或 `{ ok: false, error: { code, message, details } }`。

| 端点 | Payload | 成功时的 `value` |
| --- | --- | --- |
| `message.send` | `{ botId, targetId, text }` | `{ sent: true }` |
| `target.list` | `{ botId }` | `{ botId, channel, targets }` |
| `target.suggestion.list` | `{ botId }` | `{ botId, channel, suggestions }` |
| `target.create` | `{ botId, target: { targetId, name?, kind, route } }` | 已创建的完整目标 |
| `target.update` | `{ botId, targetId, target: { name?, kind, route } }` | 更新后的完整目标 |
| `target.delete` | `{ botId, targetId }` | `{ deleted: true }` |
| `target.session-sync.set` | `{ botId, targetId, enabled }` | `{ enabled, state }`；仅供本机设置页管理私聊同步 |
| `target.test` | `{ botId, targetId }` | `{ sent: true }` |
| `target.test` | `{ botId, target: { kind, route } }` | `{ sent: true }`；测试草稿，不保存 |

接口严格校验字段。`target.update` 的内部 `target` 不能包含 `targetId`；草稿测试不能包含 `targetId` 或 `name`。`target.list` 返回的每个目标带只读 `sessionSync: { enabled, state }`，其中 `state` 为 `off`、`active`、`waiting` 或 `unavailable`；内部私聊键不会返回客户端。

## 错误处理

HTTP 失败响应格式为 `{ "error": { "code", "message", "details" } }`。同 Host 和 RPC 使用相同错误码，但没有 HTTP 状态码。

| 错误码 | HTTP 状态 | 含义与处理建议 |
| --- | --- | --- |
| `bad-request` | 400 | 请求结构、ID 格式、JSON 或文字无效；检查字段名并移除额外字段 |
| `unknown-bot` | 404 | `botId` 不属于当前 Host；重新从机器人设置页复制 |
| `unknown-target` | 404 | 该机器人下不存在 `targetId`；检查是否复制错误或目标已被删除 |
| `target-conflict` | 409 | 同一机器人下已经存在相同 `targetId`；更换别名 |
| `invalid-target` | 422 | 目标类型或平台原生 ID 不符合当前渠道规则；重新选择类型并核对 ID |
| `bot-not-connected` | 503 | 机器人当前离线；恢复连接后由调用方决定是否重试 |
| `target-rejected` | 422 | 平台明确拒绝目标或机器人缺少发送权限；检查平台权限和目标 ID |
| `delivery-failed` | 502 | 网络、平台或其他无法安全细分的发送失败；检查连接状态和 Host 日志 |
| `session-sync-unavailable` | — | 目标不是可确认的当前 Host 私聊，尚无当前 Session，或渠道使用远程 Harness；先从已聊私聊创建目标并建立 Session |
| `cancelled` | 408 | 调用被取消；按业务需要结束或重新发起 |

HTTP 协议层还可能返回 `method-not-allowed`（405）、`unsupported-media-type`（415）或 `payload-too-large`（413）。

## 投递语义与限制

- 当前主动投递只发送非空文字，不支持在该接口中发送图片、文件、卡片或富文本。
- HTTP JSON 请求体上限为 1 MiB。
- `{ sent: true }` 表示平台发送接口接受请求或 SDK 成功返回，不承诺最终送达或已读。
- DSH-IM 不保存主动投递历史，不生成 `deliveryHandle` 或 `idempotencyKey`，也不自动重试。
- 调用方超时后重试可能产生重复消息；需要业务幂等时，由调用方保存自己的业务事件 ID 和处理结果。
- 正式发送只使用已保存的 `botId + targetId`。平台原生路由保存在目标配置中，不应随每次消息发送。
- 一个调用只发送到一个目标。需要通知多个目标时，应分别调用并分别处理结果。
- 机器人离线时仍可编辑目标，但不能测试或主动发送。
- 微信主动投递、连接测试和延迟任务结果会使用该机器人最近收到的对应用户 `context_token`。上下文仅保存在 Host 的账号状态中，重启后恢复，不放进投递目标或返回给调用方；重新绑定并更换登录凭据后清理。升级后需要收到一次用户消息才能建立缓存。
- 微信是否接受发送仍受 iLink 服务端规则约束。长轮询在线不保证主动发送可用；若持续出现 `ret=-2 prepare failed`，不要通过反复发送心跳尝试续期。可让目标用户发一条消息后重试；这不是登录凭据失效的确定证据，也不能仅凭此错误确定上下文过期或额度耗尽。

- 微信主动发送失败会保留在账号的最近消息错误中，包含平台错误码和是否携带上下文等脱敏诊断；健康轮询不会清除此错误，后续成功投递会清除。HTTP/RPC 仍返回既有的 `delivery-failed`，不会自动重试或断开正常的长轮询连接。

## HTTP 与 RPC 可达范围

HTTP 接口只在当前 Host 提供 WebServer 时注册，并使用同一个监听地址和端口。默认 Web profile 地址通常是 `127.0.0.1:3080`，只能由本机访问。若要从其他机器调用，需要在对应 profile 的 `cordis.patch.yml` 中把 WebServer 绑定到可达地址并重启 Host，例如：

```yaml
- id: webserver
  config:
    host: '0.0.0.0'
```

这会同时扩大该 WebServer 上其他页面和路由的网络可达范围。当前主动投递 HTTP 接口没有鉴权，因此只能配合可信局域网、防火墙或反向代理使用，不能直接暴露到公网。

Connection RPC 默认只允许当前 Host 的回环调用。若 Web profile 明确运行在受信任局域网，可在该 profile 的 `cordis.patch.yml` 中复用现有 Host authority：

```yaml
- id: xmanrui-dsh-im
  config:
    rpcAuthority: trusted-host
```

`trusted-host` 只是 Host／Origin 可达性边界，不是用户认证。启用后，能访问该受信网络 authority 的调用方也能访问机器人管理接口；只应在可信网络中使用。

## 常见问题

### 下拉框找不到目标会话

先在对应平台向该机器人发送一条消息，再返回设置页刷新。候选不是平台的完整会话目录；仍然找不到时使用「手动填写（高级）」。

### 测试按钮不可点击

确认机器人在线，并填写当前目标类型要求的全部平台原生 ID。Slack Thread 和 Telegram Topic 都需要两个字段。

### 保存后能否修改 Target ID

不能。你可以编辑名称、类型和平台路由而保持调用参数不变；若必须更换 `targetId`，请新建目标并让调用方切换后再删除旧目标。

### 为什么不用 sessionId

`sessionId` 标识 Harness 会话，不是九个平台统一、稳定的消息投递地址。主动投递只使用机器人和已保存目标的稳定组合。

### 测试成功但对方没有看到消息

测试成功只证明平台接口接受发送。请继续检查机器人权限、平台限制、目标是否正确，以及客户端侧的消息过滤或归档设置。
