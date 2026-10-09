# Checked first group posts

The same-Host public `dshIm` Service keeps `contractVersion: 1` and optionally advertises `reachableConversationVersion: 1` and `postFenceVersion: 1`. In this upstream contribution, connected Feishu/Lark accounts declare `reachable-conversations-checked`. Other accounts retain their existing APIs; this change does not advertise group discovery for QQ, Discord or Slack.

`listReachableConversations(botId, { expectedFingerprint, signal, cursor? })` returns `{ version: 1, conversations: [{ id, kind: 'group', name }], hasMore, cursor? }`. Each page contains at most 100 groups and the opaque cursor is at most 2048 characters. Discovery checks current native membership and speaking permission. Restricted speaking lists require the verified Bot's open ID and are bounded to ten pages of 100 entries; unqualified, cyclic or incomplete lists do not authorize sending.

`postConversationChecked(botId, conversationId, text, { expectedFingerprint, signal, beforeSend })` does not require a saved target. The mandatory synchronous `beforeSend` callback must return `true`. Current membership and speaking permission are rechecked before the callback and native message create. The result is `{ sent: true, receipt: { version: 1, messageId, conversationId } }` with the exact requested destination. A preflight failure is `send-preflight-unavailable`; permission refusal is `send-permission-denied`. A missing or unqualified receipt after dispatch is `send-result-unknown`, with no automatic retry.

The consumer owns local authorization, blocks, quotas, durable conversation entries and its Outbox. Registration replacement, disposal and cancellation fence unstarted effects. A native acceptance receipt remains valid when disposal occurs after the effect.

`sendChecked` for saved targets also accepts an optional synchronous `beforeSend` callback. When provided it must return `true`; callers that omit it retain existing behavior. The callback is checked again at the final Feishu native create boundary.

Platform references: [member group list](https://open.feishu.cn/document/server-docs/group/chat/list), [speaking permission](https://open.feishu.cn/document/server-docs/group/chat/get-3), [native send](https://open.feishu.cn/document/server-docs/im-v1/message/create). Missing platform scopes fail closed. Maintained-fork native QA and this modern upstream contribution have different revisions and DSH compatibility; one does not qualify the other.
