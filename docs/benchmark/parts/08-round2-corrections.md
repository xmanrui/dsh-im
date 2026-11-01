# 分卷 08 — 第二轮更正与新增（2026-11-02 · 轮2）

> 主报告 `2026-11-01-dsh-im-benchmark.md` §8 是本卷的摘要版；两处内容同源。
> 本卷不改写第 1–7 章的历史读数，只做两件事：登记本轮落地的改造，以及把
> 正文里已被复算证伪的数字**就地更正并留痕**。

权威件最危险的失败不是写错，而是「代码演进了而文档没说」。本轮 §1/§2/§5 有
四处正是这种状态：人读两边各自都像真的，只有把两个来源放一起比才会现形
（已做成判据，见 §4）。

## 1. 本轮落地的四项改造（按优先级高→低）

| 序 | ID | 改造 | 提交 | 完成判据（可复跑） | 负向对照 |
| --- | --- | --- | --- | --- | --- |
| 1 | M5 | 语音/媒体链路去平台依赖 | `ac397eea` | `node --test test/channels/feishu/voice.test.mjs` → 13 pass / **0 skip**；telegram voice.test.mjs → 18 pass / 0 skip；全量 skipped **8 → 2** | 喂不存在的输入让替身退非 0 ⇒ 管线必须 reject（实测 `stub exit 1`）；把 `.sh` 交给生产默认 runner ⇒ `EFTYPE`；假 ffmpeg 路径 ⇒ `ENOENT`。三条各证一类断言有牙，跑完即删副本 |
| 2 | M3 | 渠道热路径吞吐/延迟基准 | `bc27b224` | `npm run benchmark` → `BENCHMARK_OK suites=6 corpus=400 seed=20261102`；`node --test test/benchmark-floor.test.mjs` → 9 pass | 下限表与 suite 清单必须**恰好**配对（加项忘配下限、删项留下限均判红）；`NaN / -1 / 0 / -Infinity` 判红；缺 suite 判 `missing-suite`；逐轮 checksum 非零 |
| 3 | M4 | 覆盖率入 CI | `62f89f45` | `npm run coverage` → `COVERAGE_OK lines=89.97%`（阈值 85%；functions 83.89%、branches 81.14%、471 文件） | `--min-lines 95` → `COVERAGE_BELOW_FLOOR` **exit=1**；空 lcov → exit=1（缺数据不得当满分）；85% 时 exit=0。三条 exit 码直测，不经管道（管道会把退出码换成 tail 的） |
| 4 | H4.1 | 治理/覆盖率/基准各自成 CI job | `66f8078c` | `node --test test/ci-workflow.test.mjs` → 5 pass；PyYAML 解析出 5 个 job 且 benchmark 带 `continue-on-error: true` | 每条 `uses` 必须是 40 位提交 SHA ⇒ 换成浮标签即判红。本轮真踩：我凭记忆写的 upload-artifact SHA 是编的，`gh api .../git/refs/tags/v4` 实查为 `ea165f8d…`（v4.6.2）才修正 |

## 2. 本轮新增的两条建议（来自上游复现，不重复既有 ID）

| ID | 建议 | 依据（本轮实测） | 完成标准 |
| --- | --- | --- | --- |
| **N1** | 给 `plugin-src/host/channel-registry.mjs` 的注册条目加 `capabilities` 字段 | matterbridge 复现证明「光有注册表不够」：上游把能力放在**第二张表** `bridgemap.UserTypingSupport`，与实现脱钩 ⇒ 穷举 20 个协议目录，`EventUserTyping` 出现在 discord / harmony / slack，注册表只登记 discord(`bdiscord.go:11`) 与 slack(`bslack.go:12`)，**harmony 的 typing 代码不可达**（`gateway/bridgemap/bharmony.go` 全文只有一行 `FullMap["harmony"]`；消费点 `gateway/handlers.go:197` 查不到就不发）。本仓注册表 62 行同样不含能力位 | 能力位从注册条目读；`channel-capability-matrix.mjs --check` 改为对账「注册条目 ⇄ matrix 实测」，不一致判红 |
| **N2** | 把投递能力声明从 1 个渠道扩到 14 个 | `grep -rln describeDeliveryAccount src/ plugin-src/` → 只有 `src/channels/feishu/multi-bot-controller.mjs` 与 `plugin-src/host/delivery-adapter.mjs` 两处，即 **1/14**；而 `plugin-src/host/delivery-service.mjs:579,583` 是**硬读** `account.capabilities`（不含 `proactive-text-checked` 直接拒发）。机制存在，覆盖面没有 | 14 个渠道各有 `describeDeliveryAccount`，且 `npm run check` 里有一条对账判据 |

## 3. 报告自身被证伪并更正的四处（留痕）

| # | 旧读数（本轮前） | 复算值 | 根因 |
| --- | --- | --- | --- |
| 1 | 语音 3/14、卡片 3/14、流式 6/14 | **2/14、2/14、4/14** | 分卷 02 写在 matcher 收窄（`017e3ae`/`0ef3a36`）**之前**，收窄时未回改分卷。总格数 56 两边一致，所以只看总数发现不了 |
| 2 | `nonebot/message.py` 15,911 B 是「消息段模型」 | 该文件 15,911 B / 578 行是**事件总线**（`event_preprocessor`、`check_and_run_matcher`；`class MessageSegment` 命中 0 次）。段模型在 `nonebot/internal/adapter/message.py`（12,695 B / 434 行，第 25 行 `class MessageSegment`、第 101 行 `class Message`） | 只按目录名与文件大小推断，没打开文件 |
| 3 | `gateway.go` 19,673 B、`bridge.go` 3,030 B | **20,347 B / 674 行**、**3,165 B / 135 行** | 旧值取自更早的一次快照；本轮改用本地全量 clone 直接 `wc` |
| 4 | LangBot `ARCHITECTURE.md` 在 `docs/` 下、5 语言 README | 在**仓库根**（31,138 B 这个数本身是对的）；README 实为 **6** 语言（README / CN / ES / FR / JP / KO，各 10.7–13.1 KB） | 路径凭印象写；语言数按「常见五语」估 |

**方法论更正（一并适用于全仓文档）**：按字节数估行数不可用。实测 steam.go 2,189 B 估 48 行、实为 95 行；mattermost.go 4,839 B 估 107 行、实为 194 行。凡行数量级一律 `wc -l` 实测。

## 4. 判据升级：让第 3 节那类漂移无法再次发生

`scripts/verify-benchmark-report.mjs` 新增**判据二**：报告里形如 `| 语音 | N/M |` 的
行首主张，必须等于 `collectChannelMatrix()` 的实测值，否则报
`BENCHMARK_REPORT_MATRIX_MISMATCH` 并退出 1。

实施顺序刻意是「**先让判据报红，再改文档**」。第一次跑的输出（原文）：

```
BENCHMARK_REPORT_MATRIX_MISMATCH: 语音: report=3/14 matrix=2/14 | 流式/编辑: report=6/14 matrix=4/14 | 卡片/按钮: report=3/14 matrix=2/14
```

判据只认「行首第一格就是能力名」的行：正文里顺带出现的 `3/14` 不该被当成主张，
否则任何一处巧合都会误伤。少写一条能力不判红（不要求报告逐项列全），写错一条必判红。

## 5. §5.8 共同盲区的闭合情况（本轮）

| 原登记盲区 | 本轮状态 | 证据位置 |
| --- | --- | --- |
| ① 未 clone 运行任何上游项目 | **部分闭合**：matterbridge 全量 clone（`D:/tmp/bench2/matterbridge`，HEAD `c4157a4`，6,598 文件）+ 284 行 JS 复现（`node --test` 12 pass / 0 fail）。NoneBot2 **未能 clone**：本机 GitHub 443 被代理阻断（实录 `Failed to connect to github.com:443 over proxy 127.0.0.1`；tarball 亦 HTTP 415），按退路降级为 `gh api contents` 逐文件取 master 原文 + 125 行纯 JS 复现（10 pass / 0 fail） | `_research/bench2/repro-matterbridge-gateway-thin-api/`、`repro-nonebot-message-segment/`（均在 gitignored 目录，不入库） |
| ② 未做跨框架同一条消息的行为对照 | **部分闭合**：同一份意图段 `[quote,text,image,voice,bold]` 喂给 weixin / feishu / telegram 三个适配器替身，得到三种调用序列（weixin 手写引用块 + 图片两跳 `send_file` + 语音降为 ASR 文本 + bold 丢弃留痕），且投递函数体内**零渠道分支** | `node _research/bench2/repro-nonebot-message-segment/demo.mjs` |
| ③ 未建吞吐基准 | **闭合** | M3（`bc27b224`，见第 1 节） |
| §5.5「matterbridge 是否有能力声明」 | **闭合，且结论是缺陷**：有，但放在第二张表且与实现脱钩 ⇒ harmony 漏登记（见第 2 节 N1） | `grep -rn UserTypingSupport gateway/bridgemap/*.go` → 仅 discord/slack + 定义行 |
| §5.4「上游如何做去重与回声抑制」 | **闭合**：不是一处 dedup，而是三种互不重叠机制 —— 路由层自回声门（`gateway/gateway.go:441-450`，目标通道==来源通道就不回发）、平台重推去重（`bridge/rocketchat/handlers.go:65-69`）、桥身份标记（`bridge/mattermost/helpers.go:136/164` 写 `Props[matterbridge_<uuid>]`、`:176/:224` 读取并跳过） | 笔记 `_research/bench2/matterbridge-gateway-thin-api.md` §4.1 |

## 6. 本轮仍未闭环（如实登记，不冒充完成）

| 项 | 状态 | 卡点 |
| --- | --- | --- |
| Koishi 五节笔记落盘 | ⏳ 在办（第二轮已重派子代理，目标 `_research/bench2/koishi-adapter-di.md`） | 首轮子代理读完了但没写文件；另本机 GitHub 443 被代理阻断，真实 cordis 运行时实验能否跑起待实测 |
| LangBot 五节笔记落盘 | ⏳ 在办（分类脚本 `classify.mjs` 37,996 B 与 `outputs/domain-mapping.md` 17,847 B 已在盘，缺的只是笔记本体） | 同上 |
| M2 `shared/` 二级分层 | ⛔ 未动 | 拆目录与本轮语音/基准改动落在同一批文件上（写面重叠），按「同文件先串后派」推迟 |
| H4.2 上游 issue 提交 | ⛔ 未做 | 四条候选缺陷的**源码事实**均已独立复核（第 7 节），但 nonebot 两条的触发证据只到「按源码求值顺序推导 + 标准库复刻」，**未端到端跑过真实 bot.send()**；本机 443 不通也无法验证。按「证据不足不冒充完成」留待可联网机器坐实 |
| M3.2 基准的 Infinity 边界 | ⛔ 未修 | `evaluateFloors` 对 `opsPerSecond = Infinity` 判绿（分母为 0 的坏读数）。本轮刻意不改：改判定会让刚写回的下限标定与 CI 首次读数失去可比性。已钉成测试 `known edge…recorded on purpose` |
| 分支覆盖阈值 | ⛔ 未设 | M4 只给行覆盖率设 85%；分支 81.14% 暂无阈值，避免一拍就红 |

## 7. 独立复核成立的上游缺陷清单（本仓未提交 issue）

| # | 上游 | 缺陷 | 我本人的复算证据 |
| --- | --- | --- | --- |
| 1 | `42wim/matterbridge` | harmony 实现了 `EventUserTyping` 但未登记进 `UserTypingSupport` ⇒ 该分支不可达 | `grep -rln EventUserTyping bridge/` → config / discord / harmony / slack；`grep -rn UserTypingSupport gateway/bridgemap/*.go` → 仅 `bdiscord.go:11`、`bslack.go:12`、`bridgemap.go:9`（定义）；消费点 `gateway/handlers.go:197`；`gateway/bridgemap/bharmony.go` 全文只有 `FullMap["harmony"]` 一行注册。修法一行 |
| 2 | `42wim/matterbridge` | README 把 Gitter / Twitch 列为 **Natively supported**，代码里既无 `bridge/gitter`、`bridge/twitch` 目录也无 FullMap 键；`bridge/config/config.go:225` 还留着 `Gitter map[string]Protocol` 死字段 | `ls -d bridge/gitter bridge/twitch` → No such file；`grep -rn Gitter --include=*.go`（排除 vendor）→ 仅 config.go:225 与一处测试；`grep -rn Twitch --include=*.go`（排除 vendor）→ 0 命中；README.md:13/22/92/107/159/167 仍在列 |
| 3 | `nonebot/adapter-telegram` | 多文件分支用 `file.data.pop("file")` **就地**删键 ⇒ 同一 Message 二次 send 抛 `KeyError`；单文件分支用 `.get("file")` ⇒ 不抛异常而静默发出 `photo=None`（更难发现） | 取 master 原文逐行确认 `pop` 与 `.get` 两形态并存；该文件全文 `deepcopy` / `copy()` **0 次**，无任何防就地修改的保护 |
| 4 | `nonebot/adapter-feishu` | `message.py:161-163` 的 `to_post()` 把 `image` **就地**改名 `img`，而 `:612` 单段序列化分支直接返回 `self[0].type` ⇒ 先多段再单段会发出 `msg_type=img`（飞书无此 msg_type，真实调用必 400） | 原文确认 `:162 if self.type == "image": :163 self.type = "img"` 与 `:612-615` 的 `return self[0].type, json.dumps(self[0].data…)` 分支形态 |

证据等级统一为 [一手-上游源码]（`gh api` 取 master 原文 / 本地全量 clone）。#3/#4 的**端到端触发**未取证（见第 6 节），故未提 issue；#1/#2 的源码事实本身已足够复核。

本轮**没有**修改任何上游项目文件，没有向任何仓库提 issue/PR 或推送。
