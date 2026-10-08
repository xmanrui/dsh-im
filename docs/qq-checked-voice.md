# Checked QQ incoming voice / QQ 受检语音入站

The exclusive consumer can opt into `sourceVoiceTranscripts` and, independently, `sourceVoiceAudio`. These options pass through the production factory. A current native group @ message can carry one voice attachment directly or in one explicitly associated type-103 native quote. The same envelope, reference and current-application checks used for files apply; neighbouring messages and recursive quotes are not sources.

Only the native attachment's nonempty `asr_refer_text` establishes `voice.transcript: platform`. Missing or empty ASR produces `unavailable`; a caption remains a user instruction. Optional SDK fields do not establish real application availability. No cloud ASR credentials, ordinary-message reception or outgoing voice are introduced.

Original bytes remain private until the checked file operation acquires them. `audio/unknown` describes an unverified original codec, not a promise of playback. Acquisition validates the exact descriptor, current source/application/consumer, HTTPS platform host, declared and actual size (1 MiB), cancellation and a 15-second download budget. The original URL and optional platform WAV URL never enter the public event. This slice does not fetch the optional platform WAV representation.

The consumer can reply as the same application using the current mention's existing text reply fence, five-minute window and native receipt. Unknown dispatch results remain unknown and are not retried automatically. Bounded diagnostics record only voice count and whether native ASR/WAV fields are present.

Public production-factory regressions cover opt-in, native ASR provenance, unavailable state, explicit quote association, original bytes, descriptor mismatch and consumer revocation. Fixture ASR and synthetic bytes do not qualify real speech understanding. The maintained RC1 branch qualified one real explicitly quoted native-ASR/SILK request on 2026-10-08: canonical admission, model answer, own-app original-group text (Human confirmed 24), unchanged original download and actual Client keyboard playback through a 6.4-second derived WAV. This does not qualify the modern upstream Host, other applications/codecs or absent ASR. See [consumer PR #1201](https://github.com/BotHarness/DeepSeekBot/pull/1201).

---

独占消费者可显式开启 `sourceVoiceTranscripts`，并独立协商 `sourceVoiceAudio`；生产工厂会传递这两项能力。当前原生群 @ 消息可直接携带一个语音附件，或通过单个 type-103 原生引用块明确关联语音。沿用文件路径的原始信封、引用索引及当前应用校验，不从相邻消息或递归引用猜测来源。

只有原生附件中非空的 `asr_refer_text` 能标记为平台转写；缺少或空转写标记为 unavailable，说明文字仍属于用户指令。SDK 可选字段不证明当前应用实际提供该能力。本片不新增云 ASR 凭证、普通群消息接收或语音输出。

原音仅通过受检文件操作按需获取。`audio/unknown` 表示原始编码尚未确认，不承诺可播放。获取时校验精确附件描述、当前来源／应用／消费者、HTTPS 平台域名、声明及实际大小（1 MiB）、取消和 15 秒下载预算。原音和可选平台 WAV 的私有地址不进入公开事件，本片不获取可选平台 WAV 副本。

沿用当前 @ 消息的原群文字回复检查、五分钟窗口及原生回执；结果未知时不自动重试。诊断只记录语音数量和原生转写／WAV 字段是否存在。生产工厂公开回归已覆盖协商、来源、空转写、显式引用、原音、描述冲突及消费者撤销；样例转写和合成字节不证明真实语音理解，维护版 RC1 分支已于 2026-10-08 验收一个实际引用的原生转写／SILK 请求：canonical 接收、模型答复、本应用原群文字（Human 确认 24）、原件下载不变及实际 Client 键盘播放独立 6.4 秒 WAV；这不代表现代上游 Host、其他应用／编码或无转写情况。参见 [消费方 PR #1201](https://github.com/BotHarness/DeepSeekBot/pull/1201)。

A voice quote may omit redundant instruction text; exact current native envelope/reference checks and the single voice attachment still apply. Files retain their existing nonempty instruction requirement.

语音引用可以省略重复的说明文字；当前原生信封／引用检查及单一语音附件要求不变，文件仍保留原有非空说明要求。
