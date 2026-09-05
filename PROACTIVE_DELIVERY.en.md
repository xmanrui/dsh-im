# Proactive Delivery Guide

[简体中文](PROACTIVE_DELIVERY.md) · **English**

Proactive delivery lets an application send a text message through a bot connected to DSH-IM without waiting for a new user message. The caller stores only a stable `botId + targetId` pair—never a Harness `sessionId`, chat reference, message ID, or temporary webhook.

All nine built-in channels support proactive delivery: Weixin, Feishu, DingTalk, WeCom, QQ, Slack, Telegram, Discord, and WhatsApp.

## Quick start

1. Open **Settings → IM Bot** and find the bot that should send the message.
2. Select the gear icon in the bot card's upper-right corner.
3. Copy the **Bot ID** under **Call identifiers**.
4. Select **New target**, then choose a known conversation or select **Enter manually (advanced)** and enter the platform-native ID.
5. Review or enter the **Target ID**, target type, and native platform ID.
6. Select **Test**. After the target receives `DSH-IM 主动投递测试成功。`, select **Save target**.
7. Select **Copy call parameters** on the saved target and store the resulting `{ botId, targetId }` in the calling application.
8. Send messages through HTTP POST, same-Host `ctx.dshIm.send()`, or the Connection RPC `message.send` endpoint.

## Configure a delivery target

### 1. Get the Bot ID

`botId` is the real call identifier of the currently connected bot. Copy it from the settings page and treat it as an opaque string. Do not infer the channel from its prefix, and do not substitute the bot name, a platform App ID, or a masked ID from a card.

Targets belong to this bot record. Removing a bot also removes its delivery targets. After connecting it again, copy its `botId` again and recreate the required targets.

### 2. Create a target

After selecting **New target**, the page opens a **Choose from conversations** dropdown:

- Suggestions come from conversation mappings already persisted for this bot. They are neither a platform address book nor a complete, strictly time-ordered recent-chat list.
- A suggestion contains only the target type and native platform ID required for delivery. It does not contain a Harness `sessionId`, message text, message ID, conversation name, or last-active time.
- A target already configured in the dropdown is marked **Added** and disabled.
- When the dropdown is empty, send the bot a message on that platform and select **Refresh**. If it still does not appear, use **Enter manually (advanced)**.

Choosing a conversation only pre-fills a draft. It does not save anything automatically.

### 3. Understand Target ID

`targetId` is the stable alias you define for callers. It is not a platform user, group, or channel ID.

- It must be unique only within one bot. Different bots may use the same `targetId`.
- It may contain uppercase and lowercase letters, numbers, dots, underscores, colons, `@`, or hyphens, with a length of 1–128 characters.
- New targets default to `tgt_` plus 16 random hexadecimal characters, such as `tgt_7f3a91c8d2e64b10`.
- You may change it before the first save—for example, to `daily-report` or `release-alerts`.
- After saving, `targetId` is read-only. You may still edit the name, target type, and native route while callers keep using the same `botId + targetId` pair.

### 4. Test, save, and copy

The **Test** button appears in conversation-filled drafts, manually entered drafts, and edit forms:

- It is enabled only while the bot is online and every native ID required by the current target type is present.
- It tests the target type and native ID currently shown in the form. It does not create, update, or save the target first.
- Changing a tested native ID clears the old success result; test the new value again.
- The **Test** button on a saved target row tests that target's currently saved route.
- A successful test means the platform accepted the send request or its SDK returned success. It does not mean the message was read.

After saving, **Copy call parameters** copies JSON in this shape:

```json
{
  "botId": "bot_9577c8572d454122a4ef7fb4d8420a91",
  "targetId": "release-alerts"
}
```

### Configuration example: a Feishu alert group

Assume the Feishu bot has already received a message in the alert group:

1. Open that bot's settings page and copy its **Bot ID**.
2. Select **New target**, then choose the alert group from the dropdown.
3. Change the generated **Target ID** to `release-alerts` and set the display name to `Release alerts`.
4. Confirm that the target type is **Group** and the group Chat ID is filled in.
5. Select **Test** and confirm the test message in the Feishu group.
6. Select **Save target**, then **Copy call parameters**.

If the group Chat ID is edited later, callers can continue using the same `botId + release-alerts` pair.

## Two-way sync for direct-message Sessions

A saved direct-message target has an opt-in **Two-way Session sync** switch. When enabled:

1. User text submitted from DSH Web/CLI to the DM's current Session is sent to the DM with a `[来自 DSH]` prefix.
2. After that turn completes successfully, the final assistant text merged in step order is sent once more with a `[DSH 助手]` prefix.
3. Ordinary IM prompts and `/steer` continue through the existing reply path. They are neither duplicated nor forwarded to another target.

The setting stores the private conversation target, never a `sessionId`, so it follows `/session` changes automatically. After `/new` or a workspace change, its status becomes **Waiting for this DM to establish a new Session** and recovers as soon as that DM creates one; the switch does not need to be toggled again.

Enabling requires one uniquely known DM that already has a current Session for this bot. Groups, Slack Threads, Telegram Topics, Discord server channels, and targets that cannot be confirmed as DMs are unavailable. A channel with an explicit remote `harnessBaseUrl` is also unsupported. The first version mirrors current-Host text only—no images, files, cards, tool progress, approvals, or history. Changing the target type or native route disables sync; renaming the target does not.

## Native fields for all nine channels

Choose a known conversation whenever possible. Obtain and enter a platform-native ID manually only when the target is missing from the suggestions.

| Channel | Target type | Required field | Example or note |
| --- | --- | --- | --- |
| Weixin | `user` | Weixin user ID (`toUserId`) | Enter the user ID that should receive messages |
| Feishu | `user` | Open ID (`openId`) | For example, `ou_xxx` |
| Feishu | `group` | Group Chat ID (`chatId`) | For example, `oc_xxx` |
| DingTalk | `user` | User ID (`userId`) | Enter the DingTalk user ID |
| DingTalk | `group` | Group Open Conversation ID (`openConversationId`) | Proactive delivery never uses a temporary `sessionWebhook` |
| WeCom | `user` | User ID (route field: `chatId`) | Enter the user ID for a direct message |
| WeCom | `group` | Group Chat ID (`chatId`) | Enter the group's `chatid` |
| QQ | `user` | User Open ID (`userOpenId`) | The platform's `user_openid` |
| QQ | `group` | Group Open ID (`groupOpenId`) | The platform's `group_openid` |
| Slack | `conversation` | Channel ID (`channelId`) | For example, `C0123456789` |
| Slack | `thread` | Channel ID + thread timestamp (`channelId`, `threadTs`) | For example, `1712345678.123456` |
| Telegram | `chat` | Chat ID (`chatId`) | A decimal string, such as `-1001234567890` |
| Telegram | `topic` | Chat ID + Topic ID (`chatId`, `messageThreadId`) | Topic ID must be a positive integer |
| Discord | `channel` | Channel ID (`channelId`) | DMs, channels, and Threads all use a messageable Channel ID |
| WhatsApp | `user` | User JID (`jid`) | For example, `8613800000000@s.whatsapp.net` |
| WhatsApp | `group` | Group JID (`jid`) | For example, `1234567890-123456@g.us` |

Native ID strings must be nonempty and have no leading or trailing whitespace. A target accepts only the fields required by the selected channel and type; extra fields are rejected.

## Send through HTTP POST

An ordinary external application can call the Host's proactive-delivery endpoint directly:

```bash
curl --request POST \
  http://127.0.0.1:3080/api/dsh-im/delivery/messages \
  --header 'Content-Type: application/json' \
  --data '{
    "botId": "bot_9577c8572d454122a4ef7fb4d8420a91",
    "targetId": "release-alerts",
    "text": "The build has completed."
  }'
```

A successful request returns:

```json
{ "sent": true }
```

The body accepts exactly `botId`, `targetId`, and `text`, with a maximum total JSON size of 1 MiB. Do not add a native platform route, `sessionId`, `chatRef`, temporary webhook, or `idempotencyKey`.

The fixed endpoint is `POST /api/dsh-im/delivery/messages`. It reuses the current DSH Host WebServer and does not open another port. Port `3080` is the default for the Web profile; use the address printed by the running Host when it differs.

The HTTP endpoint currently has no authentication and does not provide CORS. Use it only on the local machine or a trusted network; never expose it directly to the public internet.

## Send from a plugin in the same Host

A consumer plugin can declare the `dshIm` injection and call the shared service directly without going through Connection RPC.

This minimal example sends one message when the plugin loads:

```js
export const inject = ['dshIm'];

export async function apply(ctx) {
  const result = await ctx.dshIm.send(
    'bot_9577c8572d454122a4ef7fb4d8420a91',
    'release-alerts',
    'The build has completed.',
  );

  if (result.sent !== true) {
    throw new Error('Proactive delivery did not return success');
  }
}
```

In a real plugin, call `ctx.dshIm.send()` from your existing scheduled job, build callback, or business-event handler. Its optional fourth argument currently supports an abort signal:

```js
await ctx.dshIm.send(botId, targetId, text, { signal });
```

A same-Host plugin may also list the saved targets for one bot:

```js
const targets = await ctx.dshIm.listTargets(botId);
// [{ targetId, name?, kind, route }, ...]
```

Companion plugins can discover configured bots through the same Host service:

```js
const bots = await ctx.dshIm.listBots();
// [{ botId, channel }, ...]
```
The result contains stable public metadata only; it never includes credentials, platform routes, or target data.

On failure, the Promise rejects with an Error whose `code` is one of the public error codes below.

## Send through Connection RPC

Connection RPC is for a caller that already holds a `connection` client for the current DSH Host. The settings page also uses it to manage targets. Ordinary external applications should prefer the HTTP POST endpoint above.

First unwrap the RPC success and error envelopes:

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

Then send text with the copied `botId + targetId` pair:

```js
const result = await callDelivery(connection, 'message.send', {
  botId: 'bot_9577c8572d454122a4ef7fb4d8420a91',
  targetId: 'release-alerts',
  text: 'The build has completed.',
});

// result: { sent: true }
```

`message.send` accepts exactly `{ botId, targetId, text }`. Do not add a native route, `sessionId`, `chatRef`, temporary webhook, or `idempotencyKey`.

### Example: deliver a daily report

```js
async function sendDailyReport(connection, summary) {
  try {
    await callDelivery(connection, 'message.send', {
      botId: 'bot_9577c8572d454122a4ef7fb4d8420a91',
      targetId: 'daily-report',
      text: `Daily operations summary\n\n${summary}`,
    });
  } catch (error) {
    if (error.code === 'bot-not-connected') {
      // Let the application decide whether to retry after reconnection.
      return { delivered: false, reason: 'offline' };
    }
    throw error;
  }
  return { delivered: true };
}
```

## Management RPC reference

The settings page manages targets through the same Connection RPC channel. Most callers need only `message.send`; use the other endpoints only when the caller must manage targets itself.

Every response is either `{ ok: true, value }` or `{ ok: false, error: { code, message, details } }`.

| Endpoint | Payload | Successful `value` |
| --- | --- | --- |
| `message.send` | `{ botId, targetId, text }` | `{ sent: true }` |
| `target.list` | `{ botId }` | `{ botId, channel, targets }` |
| `target.suggestion.list` | `{ botId }` | `{ botId, channel, suggestions }` |
| `target.create` | `{ botId, target: { targetId, name?, kind, route } }` | The complete created target |
| `target.update` | `{ botId, targetId, target: { name?, kind, route } }` | The complete updated target |
| `target.delete` | `{ botId, targetId }` | `{ deleted: true }` |
| `target.session-sync.set` | `{ botId, targetId, enabled }` | `{ enabled, state }`; manages DM sync from the local settings UI |
| `target.test` | `{ botId, targetId }` | `{ sent: true }` |
| `target.test` | `{ botId, target: { kind, route } }` | `{ sent: true }`; tests a draft without saving it |

Payloads are validated with exact fields. The inner `target` in `target.update` must not contain `targetId`; a draft test must not contain `targetId` or `name`. Every target returned by `target.list` includes read-only `sessionSync: { enabled, state }`, where `state` is `off`, `active`, `waiting`, or `unavailable`; the internal private-conversation key is never returned to the client.

## Error handling

An HTTP failure returns `{ "error": { "code", "message", "details" } }`. Same-Host and RPC calls use the same error codes without an HTTP status.

| Error code | HTTP status | Meaning and suggested action |
| --- | --- | --- |
| `bad-request` | 400 | Invalid request shape, ID format, JSON, or text; check field names and remove extra fields |
| `unknown-bot` | 404 | The current Host does not own this `botId`; copy it again from bot settings |
| `unknown-target` | 404 | The bot has no such `targetId`; check the copied pair or whether the target was deleted |
| `target-conflict` | 409 | The same bot already has this `targetId`; choose another alias |
| `invalid-target` | 422 | The target type or native ID violates this channel's rules; select the correct type and verify the ID |
| `bot-not-connected` | 503 | The bot is offline; let the caller decide whether to retry after reconnection |
| `target-rejected` | 422 | The platform explicitly rejected the target or the bot lacks permission; check platform permissions and the target ID |
| `delivery-failed` | 502 | A network, platform, or other safely redacted delivery failure; check bot state and Host logs |
| `session-sync-unavailable` | — | The target is not a confirmed current-Host DM, has no current Session, or uses a remote Harness; create it from a known DM and establish a Session first |
| `cancelled` | 408 | The call was cancelled; stop or start a new call as required by the application |

The HTTP protocol layer may also return `method-not-allowed` (405), `unsupported-media-type` (415), or `payload-too-large` (413).

## Delivery semantics and limits

- Proactive delivery currently accepts nonempty text only. This API does not send images, files, cards, or rich content.
- The maximum HTTP JSON request body is 1 MiB.
- `{ sent: true }` means the platform accepted the send request or its SDK returned success. It does not guarantee final delivery or a read receipt.
- DSH-IM stores no proactive-delivery history, generates no `deliveryHandle` or `idempotencyKey`, and performs no automatic retry.
- Retrying after a caller timeout can create duplicate messages. When business idempotency matters, the caller must store its own event ID and processing result.
- Normal delivery uses only a saved `botId + targetId`. Keep the native route in target configuration instead of sending it with every message.
- One call sends to one target. Notify multiple targets with separate calls and handle each result separately.
- Targets remain editable while a bot is offline, but testing and delivery require a connected bot.
- WeChat proactive sends, connection tests, and deferred task results use the latest `context_token` received from the corresponding user by that bot. Context is stored only in the Host account state and restored after restart; it is never included in delivery targets or returned to callers. Rebinding with a different login credential clears it. After upgrading, an inbound user message is needed to populate the cache.
- iLink server rules still govern whether WeChat accepts a send. Healthy long polling does not guarantee proactive delivery. If `ret=-2 prepare failed` persists, avoid repeated heartbeat messages as a renewal strategy; ask the recipient to send a message before retrying. This error alone does not establish login expiry, context expiry, or exhausted quota.

- Failed WeChat proactive sends remain visible in the account’s latest message error, with sanitized diagnostics including the provider code and whether context was included. Healthy polling does not clear this error; a successful outbound send does. HTTP/RPC still return the existing `delivery-failed` error, with no automatic retry or disconnection of healthy long polling.

## HTTP and RPC reachability

The HTTP endpoint is registered only when the current Host provides a WebServer, and it uses that server's existing listen address and port. A Web profile normally defaults to `127.0.0.1:3080`, which is reachable only from the same machine. To call it from another machine, bind the WebServer to a reachable address in that profile's `cordis.patch.yml`, then restart the Host. For example:

```yaml
- id: webserver
  config:
    host: '0.0.0.0'
```

This also expands network reachability for the other pages and routes on that WebServer. Because the proactive-delivery HTTP endpoint currently has no authentication, use it only with a trusted LAN, firewall, or reverse proxy, and never expose it directly to the public internet.

Connection RPC accepts loopback callers by default. If a Web profile is deliberately served on a trusted LAN, it can reuse the existing Host authority in that profile's `cordis.patch.yml`:

```yaml
- id: xmanrui-dsh-im
  config:
    rpcAuthority: trusted-host
```

`trusted-host` is only a Host/Origin reachability boundary, not user authentication. Callers that can reach that trusted-network authority can also access bot-management endpoints. Enable it only on a trusted network.

## Troubleshooting

### The target conversation is missing from the dropdown

Send that bot a message on the platform, return to settings, and refresh. Suggestions are not a complete platform conversation directory. Use **Enter manually (advanced)** if the target still does not appear.

### The Test button is disabled

Make sure the bot is online and every native ID required by the current target type is present. A Slack Thread and a Telegram Topic both require two fields.

### Can Target ID be changed after saving?

No. You can edit its name, type, and native route without changing call parameters. If the alias itself must change, create a new target, migrate callers, and then delete the old target.

### Why not use sessionId?

A `sessionId` identifies a Harness Session. It is not a uniform, stable message address across the nine platforms. Proactive delivery uses the stable bot and saved-target pair instead.

### The test succeeded, but the recipient cannot see the message

A successful test proves only that the platform accepted the send. Check bot permissions, platform restrictions, target accuracy, and client-side filtering or archive settings.
