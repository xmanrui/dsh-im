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
4. Scheduled tasks (`schedule`, `deliveryMode: host`) also sync their final assistant text after successful completion in the bound Session. Internal reminder framing is not echoed as a `[来自 DSH]` message.

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

The body accepts the required `botId`, `targetId`, and `text` fields, plus optional `format` (`plain` or `markdown`, default `plain`), with a maximum total JSON size of 1 MiB. Do not add a native platform route, `sessionId`, `chatRef`, temporary webhook, or `idempotencyKey`.

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

In a real plugin, call `ctx.dshIm.send()` from your existing scheduled job, build callback, or business-event handler. Its optional fourth argument supports an abort signal and a text format:

```js
await ctx.dshIm.send(botId, targetId, text, { signal }); // Keep existing default behavior
await ctx.dshIm.send(botId, targetId, '# Daily report\n\n**Checks complete**', {
  signal,
  format: 'markdown',
});
```

`format` accepts only `plain` and `markdown`, defaulting to `plain`. Markdown formatting is currently implemented for Feishu/Lark: both direct and group destinations receive a native Markdown card without starting a Session or a stream. Other channels retain their existing delivery behavior; Markdown rendering is not guaranteed there. HTTP and `message.send` RPC accept the same optional `format` field in their payloads.

The original Markdown, including whitespace, is preserved without silent truncation or automatic splitting; platform message-size and Markdown-syntax limits still apply. Rejection, timeout, and cancellation use the existing error handling, with no automatic plain-text resend that could duplicate delivery. Older dsh-im Host APIs may ignore this option; both the consumer and dsh-im must load the updated code.

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

`message.send` accepts `{ botId, targetId, text, format? }`; `format` must be `plain` or `markdown`. Do not add a native route, `sessionId`, `chatRef`, temporary webhook, or `idempotencyKey`.

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

## Checked proactive sending for companion plugins

The same-Host `dshIm` Service exposes `contractVersion: 1`, `describeBot(botId)` and `sendChecked(botId, targetId, text, options)`. The initial authenticated-account implementation supports Feishu/Lark; other channels explicitly report `capability-unavailable` until they implement the contract. Existing `send`, HTTP and management RPC behavior remains unchanged.

`describeBot` returns `{version: 1, botId, channel, account: {fingerprint, name?}, connected, capabilities}`. The `proactive-text-checked` capability is not a user grant. Feishu/Lark resolves credentials through the credentials service and verifies the current platform Bot Open ID. Its lowercase SHA-256 fingerprint is derived from UTF-8 `JSON.stringify({provider:'feishu', domain, appId, botOpenId})` in that field order. It never returns credentials or tokens and rejects a principal different from the configured verified bot. Discovery is asynchronous during Host startup; refresh after channel initialization.

Options require `expectedFingerprint` and `expectedTargetDigest` and optionally accept `signal` and `format`. Derive the target digest from lowercase SHA-256 of UTF-8 `JSON.stringify({kind, route})`, with route keys sorted by ascending JavaScript string code-unit order. Names and aliases do not affect this digest. The service checks the currently saved target, freezes its normalized route, revalidates the authenticated account inside the account transition and sends that frozen route. Editing an alias during verification cannot redirect the request. Removing or changing a target before lookup rejects the request; after a request starts, changes cannot undo its external effect.

`account-unverified`, `account-changed`, `target-changed` and `capability-unavailable` are pre-send refusals; credential lookup and platform authentication failures also return `account-unverified`. `{sent:true}` still means platform acceptance, not delivery/read. SDK cancellation after start, timeout and other ambiguous outcomes are not proof that nothing was sent. The caller owns durable authorization, intent/attempt records and reconciliation and must not blindly retry. Provider Registration disposal or controller closure rejects checked sends whose SDK request has not started, including disposal during the final account verification; it cannot unsend an already started SDK request.

## Exclusive Feishu/Lark text intake (same Host)

Applications with their own durable message store can use `ctx.dshIm` (`inboundVersion: 1`) instead of the standalone DSH Session bridge. This is an opt-in Feishu/Lark capability; other channels and accounts that have never opted in retain their existing behavior.

```js
const account = await ctx.dshIm.describeBot(botId);
const dispose = await ctx.dshIm.consumeInbound(botId, {
  expectedFingerprint: account.account.fingerprint,
  signal: lifecycleSignal,
  async onEvent(event, { signal }) {
    // Authorize the conversation, deduplicate by provider event/message ID,
    // and commit into the application's canonical store before acknowledging.
    await application.acceptDurably(event, { signal });
    return { accepted: true };
  },
});
// Later, use the same verified account and the exact event.reply route:
await ctx.dshIm.replyChecked(botId, event.reply, 'Acknowledged', {
  expectedFingerprint: account.account.fingerprint,
  signal: lifecycleSignal,
});
// Release with the application's Registration/Fiber lifecycle:
dispose();
```

Check the account's `exclusive-text-consumer` and `reply-text-checked` capabilities before enabling reception. Only one consumer may own an account; conflicts fail with `consumer-conflict`. The Host-only callback is not exposed through browser RPC or HTTP.

A version-1 event contains `channel`, `botId`, authenticated `fingerprint`, `eventId`, `messageId`, `actor: {kind: 'user', id}`, `conversation: {kind: 'group' | 'dm', id}`, `mentions: [{id, key}]`, `mentionedAccount`, ISO `at`, original `text`, and `reply: {messageId, conversationId, actorId, threadId?, rootId?, parentId?}`. These are platform-native IDs; optional server names are display-only; avatars and attachments are outside this slice. Bounded history is described below. Applications decide which conversations/messages to accept and when to wake an agent.

The mode is saved per account as `consumerMode: 'external-consumer'`. In that mode the native Session bridge, card callbacks and slash commands do not run. Releasing the consumer, losing its Registration, or restarting the Host does not restore standalone processing; intake fails closed until a consumer registers again. Returning to standalone requires an explicit configuration change and reconnect. A consumer must cooperate with cancellation while committing; releasing a consumer cannot undo an application commit already completed.

Checked replies re-read the original message and compare sender, conversation, thread, root and parent IDs before sending. A topic reply uses Lark's original-topic reply operation; it never falls back to the group mainline. Missing/changed sources fail with `stale-route`. An SDK failure after attempting the reply returns `reply-result-unknown`: inspect the external conversation before retrying. Provider redelivery has no resume cursor and may have gaps; this contract does not promise exactly-once transport, message-read receipts, or cross-account replies. Keep deduplication and durable delivery intents in the application.

## Bounded Feishu/Lark context reads (same Host)

An active exclusive consumer may call the optional `dshIm.historyChecked(botId, source.reply, query, {expectedFingerprint, signal})`. Check `history-text-checked`, and also `thread-history-text-checked` for a thread. Query is `{scope: 'group' | 'nearby' | 'thread', limit: 1..20, cursor?: string}`. There is no browser/HTTP history endpoint. The verified account and live consumer lease are required; standalone accounts cannot read through this contract.

Each call re-fetches the source and compares its author, chat, thread, root and parent IDs before listing. `group` lists the source chat; `nearby` uses a bounded five-minute-before/after chat time window, not a native around-message API; `thread` lists the native thread. The response is `{version:1, scope, events, omitted, hasMore, nextCursor?, window?, coverage:'provider-visible-human-text'}`. At most `limit` provider records are inspected; unsupported, deleted, application-sent or invalid text is counted as omitted. Pagination is explicit, one page per call. The caller binds its continuation to the same source/query. History-derived events use `history:<messageId>` as event ID; deduplicate with the native message ID alongside received events.

Only visible Human text is returned, with the same normalized event shape. Optional platform `sender_name` and mention `name` are display labels, never identity or authorization; missing names remain absent. No directory lookup or Human token fallback is performed. A read does not admit ordinary messages to an Inbox, wake an agent, reply, mark a message read, or synchronize withdrawal. The companion application owns those decisions and canonical persistence.

Missing Bot permissions return `history-permission-denied`; missing/changed source IDs return `stale-route`; an anchor without a thread returns `thread-unavailable`; provider failures or malformed pagination return `history-unavailable`. Unrelated chat/thread records fail with `untrusted-source`. Caller cancellation, consumer release, Host close and Provider replacement discard in-flight results. The consumer must retain its lifetime until the read completes. This capability is neither a complete transcript guarantee nor provider-wide search.

```js
const page = await ctx.dshIm.historyChecked(botId, event.reply,
  { scope: 'thread', limit: 10 },
  { expectedFingerprint: account.account.fingerprint, signal: lifecycleSignal });
// Persist/reconcile only after application authorization. Do not turn reads into intake.
```

## QQ native group notification observations (BotHarness #1154)

The official SDK's raw-event hook reports `GROUP_MSG_RECEIVE` and `GROUP_MSG_REJECT` as bounded developer diagnostics. Each connection records at most 64 observations with its local Bot identity, a SHA-256 group digest, local observation time and enabled/disabled hint. Group/member OpenIDs, raw event contents and credentials are omitted; malformed events and callbacks from stopped or replaced connections are ignored. These events do not enter a Source/Inbox, change capabilities or permission, trigger a send, retry a retained result or prove current proactive eligibility. An actual source-free API acceptance receipt and group-side confirmation are still required. The hook does not recover switches changed before this connection started.

First-party reference: [QQ event subscription and group notification events](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html).


Enabling QQ receive-all changes the message carrier to GROUP_MESSAGE_CREATE. The checked text consumer preserves only server-marked self mentions (mentions[].is_you === true); this does not enable ordinary-message participation. Public connection diagnostics expose bounded mention count and a self-mention boolean without identities or content.
