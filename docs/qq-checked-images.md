# Checked QQ group images / QQ 群图片 checked 契约

This is an opt-in extension of the existing exclusive group-mention consumer. It uses the pinned official QQ SDK 1.0.4. It does not enable ordinary messages, proactive delivery, Echo or voice. Generic files have a separate explicit extension below. Native media permissions still depend on the QQ application.

这是现有独占群 @ 消费者的可选图片扩展，使用固定的官方 QQ SDK 1.0.4。它不启用普通消息、主动投递、Echo 或语音；通用文件须单独显式启用，见下文。实际媒体权限仍由 QQ 应用决定。

## Public contract / 公开契约

`describeBot` advertises `source-file-checked`, `source-image-checked`, `reply-file-checked`, `reply-image-fence-checked` and `reply-file-receipt-checked`. Pass `sourceImages:true` to `consumeInbound` to receive supported mention images. Image opt-in alone does not admit generic files.

`describeBot` 声明以上能力；`consumeInbound` 必须显式传入 `sourceImages:true` 才接收支持的群 @ 图片。仅开启图片不会接收通用文件。

- A Source Attachment contains an opaque selector and original message association. Download URLs and upload tickets stay private. Caption and attachment-array order are preserved separately; a caption-first display does not prove native interleaving. Quoted `msgElements` and mixed unsupported media are refused.
- Source proof is bounded to 2,000 process-local messages. Reading checks the same application, group, descriptor and active consumer before acquisition and after it completes. HTTPS platform hosts, no redirects, 15 seconds and 25 MiB bound download; bytes must match the original supported PNG/JPEG/GIF/WebP type and supplied size. The reply window does not restrict historical image acquisition. Restart loses unfetched private tickets; already acquired canonical attachments remain owned by the consuming application.
- Image replies validate bytes and MIME, upload with `srvSendMsg:false`, reverify the account and reply source, prepare the token, then check cancellation and the caller's synchronous `beforeSend` immediately before one native media POST. Text and images share the same five-attempt source budget and five-minute reply window. Upload waiting is bounded to 120 seconds; the SDK cannot cancel the underlying upload, but a cancelled request never proceeds to the final POST.
- A successful checked result is `{sent:true,receipt:{version:1,messageId,conversationId}}`. The message ID comes from the final native message response, never from the upload. Missing responses or cancellation after dispatch remain unknown; there is no automatic resend or file fallback. Capability negotiation keeps legacy file providers compatible.

- Source Attachment 仅包含不透明选择器及原消息关联；下载 URL、上传票据留在 Provider 内部。正文与附件数组顺序分别保留，正文先行展示不代表平台原生混排位置；引用 `msgElements` 和不支持的混合媒体会被拒绝。
- 原消息证明最多保存 2,000 条进程内记录，获取前后检查同一应用、群、附件描述和活跃消费者。下载仅限平台 HTTPS 域名、禁止重定向，限时 15 秒、上限 25 MiB；字节须匹配原始 PNG/JPEG/GIF/WebP 类型及已提供的大小。回复窗口不限制历史图片读取；重启后未获取的私有票据失效，已取得的 canonical 附件继续由消费应用持有。
- 图片回复验证字节和 MIME，以 `srvSendMsg:false` 上传，再检查账号、来源及回复资格；预取 token 后，紧贴一次原生媒体 POST 检查取消和同步 `beforeSend`。图片与文字共享五次尝试和五分钟窗口。等待上传最多 120 秒；SDK 无法取消底层上传，但取消后不会继续最终 POST。
- checked 成功结果包含最终原生消息的 ID 和原群，不将上传 ID 冒充回执。发送后缺失响应或取消保持 unknown，不自动重发，也不降级文件发送。新增回执通过能力协商保留旧 Provider 兼容性。

Automated regression is not real QQ/model qualification. Integration acceptance must independently verify the native image, the canonical preview, the actual image-capable model/tool input and the public saved receipt.

自动回归不等于 QQ／模型实机验收；验收需独立检查原生图片、canonical 预览、支持图片的模型／工具实际输入及公开持久化回执。

## Generic-file extension / 通用文件扩展

Issue #331 adds `source-generic-file-checked` and `reply-file-fence-checked`. Only an explicit `sourceFiles:true` consumer receives a native `content_type:file` attachment on its trusted group mention. The native category maps to opaque `application/octet-stream`, not a claimed MIME. An explicit native type-103 file quote is also a candidate: one raw quote block must carry the actual file attachment, its index must agree with the normalized reference and every supplied raw reference, and its application/group/author/message envelope must agree with the current mention. Adjacent messages, cache lookups, quoted images and ambiguous quote blocks do not establish association. Mixed direct images/files require both opt-ins. The existing private HTTPS host restrictions, descriptor checks, current account/consumer fences, no redirects, timeout and 25 MiB limit apply; only image payloads require image signatures.

Generic results validate a safe filename, bounded independent bytes and a non-image/audio/video MIME. Upload uses `fileType:4` and `srvSendMsg:false`, then the same account/source/consumer and caller fence immediately before one original-group POST. The final native response supplies the receipt; unknown is never retried. The current SDK exposes file methods while older official media documentation says type 4 is unavailable. Actual application permission, native payload and download host require real QQ acceptance; automated tests do not qualify them.

#331 增加 `source-generic-file-checked` 与 `reply-file-fence-checked`；消费者仅显式传入 `sourceFiles:true` 时才接收可信群 @ 消息携带的 `content_type:file` 附件。原生分类映射为不透明的 `application/octet-stream`，不声称提供 MIME。也提供显式原生 type-103 文件引用候选路径：仅一个原始引用块，实际携带文件附件，块索引与 SDK 引用以及已提供的全部原始引用一致，且原始群、作者、消息身份与当前 @ 一致。相邻消息、缓存查找、引用图片及含糊的引用块不能建立关联；同条直接图片与文件须同时开启两项能力。复用现有私有 HTTPS 域名限制、描述符、当前账号／消费者检查、禁止重定向、超时及 25 MiB 上限；仅图片检查图片签名。

Quoted attachments belong to the current mention Source and its reply `msg_id`; the reference index only qualifies the private selector. They do not create or reconstruct a historical Source. The current consumer's account, lease and file opt-in still govern acquisition. The Controller's latest inbound shape is bounded process evidence (type/count/index agreement/refusal code), never attachment URLs, contents or a second history. A scalar `message_type:103` is metadata, not structural nesting. On 2026-10-08 the maintained DSH RC1 fork at `6d24d1f` passed real quoted-CSV acquisition, independent-copy model reading, a distinct original-group result file with native receipt, and Human download/content confirmation. That acceptance qualifies one authorized application on the maintained runtime; it does not qualify every application, direct-file carriers or the modern upstream Host runtime. See the [official SDK quote path](https://github.com/tencent-connect/qqbot-nodejs/blob/main/src/middleware/quote-ref.ts).

引用附件属于当前 @ Source，回复仍使用当前消息 `msg_id`；引用索引仅用于限定私有选择器，不创建或重建历史 Source。读取仍受当前账号、消费者及文件开关约束。Controller 仅保留最近一次入站形状作为有界进程证据（类型、计数、索引一致性、拒绝码），不包含附件 URL、内容，也不是第二份历史。标量 `message_type:103` 是元数据，不是递归嵌套。2026-10-08，固定在 `6d24d1f` 的 DSH RC1 维护版 fork 已通过真实引用 CSV 获取、独立副本模型读取、原群独立结果文件和原生回执，以及 Human 下载及内容确认。验收限定于维护版运行时上的一个已授权应用，不代表所有应用、直接文件载荷或现代上游 Host 运行时均已通过。

普通文件结果验证安全文件名、有界独立字节及非图片／音频／视频 MIME，以 `fileType:4`、`srvSendMsg:false` 上传，再在最终单次原群 POST 前重查账号／来源／消费者及调用者授权。回执取自最终原生消息响应，unknown 不重试。新 SDK 提供文件方法，而旧版官方文档仍写类型 4 未开放；应用权限、实际载荷和下载域名须经真实 QQ 验收，自动回归不证明资格。
