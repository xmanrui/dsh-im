# QQ native reply observations

In `external-consumer` mode, QQ Host logs can record sanitized candidates for a
native bot group callback before the existing Human mention filter discards it.
This does not enable ordinary-message intake, change Intents, create attention,
or advertise `own-text-echo`.

The structured `qq.native-reply.observation` record contains the authenticated
account fingerprint, hashes of the native group and message IDs, event type,
bot flag, whether the sender matches the authenticated bot ID, and whether an
actual checked-send HTTP receipt has the same app-local group and message ID.
It contains no message text, raw identifiers, access tokens or credentials.

Receipts alone produce no observation. A candidate may arrive before its HTTP
response; a later matching receipt produces a second, correlated observation.
Duplicate callbacks do not repeat the observation. State is process-local,
limited to 128 entries with a five-minute lifetime, and discarded with the
owning runtime. Logs are limited to 64 records per minute; the next emitted
record includes the number suppressed. A failed diagnostic sink cannot fail a
message or a send.

`receiptMatched` is diagnostic correlation, not Provider Echo delivery. Before
enabling Echo, qualify actual platform callback delivery, identity and ID
relationships with each real app. Synthetic tests prove the observation and
filtering code only. Missing logs do not prove the platform will never deliver
self messages: the account's permission, connection lifetime, expiration and
rate limit must also be considered. Keep any receive-all permission change
separate and explicitly authorized.

## 中文

QQ 的 `external-consumer` 模式会在现有 Human @ 消息过滤之前，观察已经实际到达的
机器人群消息候选，并输出脱敏的 `qq.native-reply.observation` Host 日志。它不会开启
普通消息接收、改变 Intents、创建注意力或声明 `own-text-echo`。

日志仅包含已认证账号指纹、原生群和消息 ID 的哈希、事件类型、机器人标志、发送者
是否匹配认证 Bot ID，以及是否与实际 checked-send HTTP 回执的本应用群／消息 ID
匹配。正文、原始标识、令牌和凭证均不进入日志。单独的 HTTP 回执不会产生观察记录。
先于回执到达的原生候选可以在回执到达后补记关联；重复回调不重复记录。

状态只在当前运行时保存，最多 128 项、五分钟过期，随运行时释放。日志每分钟最多
64 条，下一条会记录此前被限流的数量；日志出口失败不影响接收或发送。
`receiptMatched` 仍只是诊断关联，不能替代 Provider Echo 交付资格。必须用每个真实
应用核验平台投递、身份和 ID 关系后再启用能力；合成测试只能证明分流代码。没有日志
也不能证明平台永远不投递自身消息。接收所有消息的权限变更需要独立、明确授权。
