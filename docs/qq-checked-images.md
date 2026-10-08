# Checked QQ group images / QQ 群图片 checked 契约

This is an opt-in extension of the existing exclusive group-mention consumer. It uses the pinned official QQ SDK 1.0.4. It does not enable ordinary messages, proactive delivery, Echo, generic files or voice. Native media permissions still depend on the QQ application.

这是现有独占群 @ 消费者的可选图片扩展，使用固定的官方 QQ SDK 1.0.4。它不启用普通消息、主动投递、Echo、通用文件或语音；实际媒体权限仍由 QQ 应用决定。

## Public contract / 公开契约

`describeBot` advertises `source-file-checked`, `source-image-checked`, `reply-file-checked`, `reply-image-fence-checked` and `reply-file-receipt-checked`. Pass `sourceImages:true` to `consumeInbound` to receive supported mention images. The shared file service is restricted to image bytes for QQ in this slice.

`describeBot` 声明以上能力；`consumeInbound` 必须显式传入 `sourceImages:true` 才接收支持的群 @ 图片。本切片的 QQ 共用文件接口只接受图片字节。

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
