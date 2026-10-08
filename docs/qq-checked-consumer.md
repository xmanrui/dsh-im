# Checked QQ group text consumer

An official QQ application can opt into exclusive group-mention text intake through the same-Host public `dshIm` Service. Existing standalone behavior remains the default until `consumeInbound` explicitly persists `external-consumer` mode.

`describeBot` authenticates the native robot identity with `GET /users/@me` and fingerprints its ID together with the configured AppID. Live group application responses can omit the example's `bot` flag; an explicit non-robot or malformed flag is refused. Credentials and SDK state remain Provider-owned.

Qualified accounts advertise `exclusive-text-consumer`, `reply-text-checked`, `reply-context-checked`, `reply-receipt-checked` and `reply-fence-checked`. The Service's optional `replyContextVersion`, `replyReceiptVersion` and `replyFenceVersion` are each 1; consumers must still inspect the account's capabilities.

`consumeInbound(botId, { expectedFingerprint, onEvent, signal })` takes one exclusive lease and delivers text-only `GROUP_AT_MESSAGE_CREATE` with application-scoped group/member OpenIDs and native message identity. It awaits consumer admission, but does not claim a durable QQ acknowledgement or server resume cursor. Private messages, ordinary traffic, attachments and compound payloads stay outside this consumer. Losing the lease or restarting does not restore standalone processing.

`qualifyReplyChecked(botId, route, options)` checks process-local proof of the exact message/group/actor. It refuses threads, missing sources, a changed account, an expired five-minute passive window and an exhausted five-attempt local budget. The native platform independently enforces its limits. Proof is bounded to 2,000 sources and disappears on restart; canonical history belongs to the consumer.

`replyChecked(botId, route, text, { expectedFingerprint, signal, receipt: true, beforeSend })` prepares the official SDK token and then rechecks source, lease, current account, cancellation and the trusted synchronous `beforeSend` fence immediately before public `apiClient.request` dispatch. No asynchronous step intervenes between that fence and dispatch. Return `{ sent: true, receipt: { version: 1, messageId, conversationId } }` only for a valid native response; calls without receipt opt-in retain `{ sent: true, messageId }`.

Expiry, reply limit, rate limit and permission refusals stay typed. Unclassified failures, interruption after dispatch or an invalid response retain `reply-result-unknown`; there is no automatic retry or proactive fallback. Native IDs prove platform acceptance, not Human delivery or reading. The account does not advertise checked proactive sending, media or group history.

The pinned official SDK is `@tencent-connect/qqbot-nodejs@1.0.4`. Its public Logger lifecycle messages clear receiver readiness on close/reconnect/exhaustion, because it has no public disconnect event. Only current-runtime READY/RESUMED restores readiness. Logs omit gateway URLs and raw response bodies. Actual-SDK regressions cover token-stage revocation, native disconnect/resume, account-query failure/recovery and omitted optional flags; public-Service regressions cover cancellation and definite refusals.

Sources: [robot details](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/users_me.get.html), [group replies](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html), [group mention events](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html), [ordinary group events](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html).
