# 群里直接 @ 就能调用 —— 触发链现状分析与改造点

目标（老大原话）：「群里直接艾特就可以调用大肥鱼」。当前桥只认字面量前缀 `/dsh`。
本文件是改动前的逐函数、逐行记录（2026-11-01 工作树，分支 feat/wechat-groups），
改动落点全部列在最后，保证 surgical、不扩面。

## 1. 入站全链路（adapter parse -> addressed 判定 -> JS runtime -> 回复）

### 1.1 文本行读取（身份不可得的源头）

`scripts/wechat_group_uia.py`

| 行 | 函数 | 事实 |
|---|---|---|
| 161 | `UNVERIFIED_SENDER_PREFIX = "uia-unverified:"` | 未验身份行的前缀常量 |
| 164-167 | `unverified_sender()` | 判定一行是否无身份 |
| 170-205 | `read_visible_rows_as_messages()` | 只取 `mmui::ChatTextItemView` 的 `name` 作文本；第 199 行把 sender 写成 `UNVERIFIED_SENDER_PREFIX + "row"`，第 201 行 `is_self=False`。微信 4.2.0.12 的无障碍树里没有任何逐消息作者/自我标志子控件（实测），所以群里每一行都是「有正文、无身份、is_self 恒 False」。 |
| 1526-1528 | `UiaBackend._allow_unverified()` | 读行需要环境开关 `DSH_WECHAT_GROUP_ALLOW_UNVERIFIED=1`；缺省 fail-closed |
| 1509-1524 | `UiaBackend.read_messages()` | 真后端把 UIA 行喂给上面的解析函数，是唯一的正文来源 |

真实入口链：`read_messages()` -> `WechatGroupAdapter._read_target()`（335-356）-> `_observe()`。

### 1.2 触发解析（今天只有前缀）

| 行 | 函数 | 现状 |
|---|---|---|
| 112-126 | `parse_trigger(text, command_prefix) -> (bool, str)` | docstring 明写 never infer mentions from @ text。空前缀一律不触发（115-117）；`/dsh` 必须成词，`/dsh正文` 不算（121-125）；返回剥掉触发词之后的正文 |
| 72-81 | `GroupConfig` | 字段 `id / title / trigger_names / command_prefix / allow_self / allow_unverified_trigger`。没有 mention_mode。`trigger_names` 在 JS 配置校验里根本不认识（见 1.5），实际是空壳 |

### 1.3 addressed 判定（两条并行路径，改一处不够）

| 行 | 位置 | 判定式 |
|---|---|---|
| 412-420 | `WechatGroupAdapter._observe()` —— 轮询生产路径 | `parsed, text = parse_trigger(item.text, group.command_prefix)`（412）；`addressed = parsed and text and (not unverified_sender(...) or group.allow_unverified_trigger)`（415-418）；`parsed and not text` 直接 continue（419-420，裸命令词不入库）；随后拼 v1 事件（421-442）并 `validate_message_event`（443） |
| 208-245 | `build_message_event()` —— 单测/工具路径 | 第 217 行 `trusted = (not unverified_sender) or allow_unverified_trigger`；219-223 用 `parse_trigger` 决定 `addressed`。必须与 `_observe` 同一口径，否则判据在两条路上分叉 |
| 248-282 | `validate_message_event()` | v1 精确字段集（251-258）、`from_user_id` 只允许 `uia-name:<name>` 或 `uia-unverified:row`（271-275）、`item_list` 必须等于剥完触发词的正文（280-282） |
| 446-452 / 454-458 | `poll()` / `drain_events()` | 逐群 `_observe`，事件交 `JsonlProtocol.poll_frames()`（700-720）写 stdout |

### 1.4 出站回复腿（自触发风险的现场）

| 行 | 位置 | 作用 |
|---|---|---|
| 398-404（JS） | `weixin-bridge.mjs` `WeixinHarnessBridge.accept()` | `if (!conversation?.addressed) return` —— addressed 是唯一入场券；过了才排队、跑 Harness、生成回复 |
| 1357（JS） | `#send(replyTarget, text, ...)` | 回复目标就是群本身（同一个 chat） |
| 216-236（JS） | `wechat-group-runtime.mjs` `sendText()` | 走 UIA 传输 |
| 478-567（py） | `WechatGroupAdapter.send_text()` | 真发消息 |
| 535-538（py） | 回声读回 | 未验身份行只能靠文本全等证明这条是我发的（535 的分支正是这个原因） |
| 373-386（py） | `_consume_bridge_echo()` | 第 374 行 `if not item.is_self: return False` —— 实测 is_self 恒 False，所以这道闸在未验身份行上是空的；403 行调用它 |
| 408-409（py） | `is_self and not group.allow_self` | 同样对未验行无效 |

结论：@ 一旦成为触发词，机器人自己回的一句话里带 @ 就是真回路。改造必须先把回声闸对未验行
生效（文本全等 + 已 attempted + echo_pending），这不是可选优化。

### 1.5 JS 侧配置与二次判据

| 行 | 文件 | 内容 |
|---|---|---|
| 6-9 | `wechat-group-config.mjs` | `ROOT_KEYS`：version/pollIntervalMs/groups/allowUnverifiedRead/allowSend/allowWindowRestore/autoMinimize |
| 14 | 同上 | `GROUP_KEYS = id,title,commandPrefix,mentionMode,allowSelf,allowUnverifiedTrigger`。注意 `triggerNames` 不在册，写了就 unknown key 硬拒 |
| 31-35 | 同上 `exactKeys()` | 未知键一律抛 `invalid-group-config` |
| 60-66 | 同上 | `commandPrefix` 必填且必须匹配正则 `^\/[^\s]+$`（必须是单个 `/` 起头的词） |
| 67-69 | 同上 | `mentionMode` 必填且唯一合法值 `command`；缺省也拒 |
| 70-77 | 同上 | `allowSelf` / `allowUnverifiedTrigger` 严格布尔（字符串 false 拒） |
| 79-87 | 同上 | 归一化输出（mentionMode 硬编码回 command） |
| 758-789（py） | `load_config()` | 读 triggerNames/commandPrefix/allowSelf/allowUnverifiedTrigger；完全不读 mentionMode，即 JS 认识的键在 Python 侧不生效（本次要补） |
| 307-322（py） | `_validate_groups()` | 只校 id/title/重复/`command_prefix` 类型/`allow_self` 类型 |
| 311-342（JS） | `wechat-group-runtime.mjs` `#validEvent()` | 事件准入。321-324 未验身份只允许 `allowUnverifiedTrigger === true` 的群；325 `addressed !== true` 直接拒；334-340 用 `raw_text` 重新证明前缀触发（防伪造/防陈旧事件）：`candidate.startsWith(group.commandPrefix)`（335）+ 前缀必须成词（338）+ 剥完正文必须等于 `event.text`（340） |
| 344-374（JS） | `#onMessage()` | 不过 `#validEvent` 就 `messagesRejected += 1` 并写一行原因 |

## 2. 硬事实与它逼出来的折中

1. 发送者身份不可得（1.1）：每一行都是 `uia-unverified:row`、`is_self=False`。
   「谁在说话」永远需要操作员逐群显式认可，即 `allowUnverifiedTrigger`。这一点不因 @ 改造而放松。
2. @ 渲染成正文字面量 `@[___]`（实测见 `tests/python/test_wechat_group_observed.py:23`，
   `docs/wechat-group-runbook.md:13` 记「真实 @ 触发 不可得，真实 @ 渲染为 `@[___]` 占位」）。
   早先「@ 不可用」的结论把两件事混成一件：被 @ 的姓名不可解，但
   `@[` 与 `]` 之间的占位符只有从 @ 列表里选人才会产生，是可用信号。
   手打的 `@大肥鱼`（无 `[...]` 包裹）不是真 @，必须继续不触发。
3. 占位符里的名字被抹平（`___`）=> 无法证明 @ 的是大肥鱼而不是小李。
   折中（明写，不糊）：masked 占位符只在该群显式 `allowUnverifiedTrigger=true` 时才计入触发；
   若哪天无障碍树给出可读名字（`@[大肥鱼]`），代码走另一条严格分支 —— 名字必须命中
   `trigger_names` 才算 @ 机器人，命不中就不触发，此时不再依赖「不可得身份」的 opt-in。
4. mention 模式与 opt-in 必须成对：在实测版本上，mention 模式若不开 `allowUnverifiedTrigger`
   永远不会触发（发送者不可验 + 被 @ 者被抹平）。所以校验器拒绝「mention 模式但没开 opt-in」
   的配置，而不是默默收下让操作员以为配好了。
5. 自触发：见 1.4。未验行下 `is_self` 是空的，只有「与我方 attempted outbound 文本全等」能证明那是自己。

## 3. 改造落点（本文件之外唯一改动清单）

| 文件 | 改什么 |
|---|---|
| `scripts/wechat_group_uia.py` | `MENTION_MODES`/`MENTION_TOKEN_RE` 常量；`GroupConfig.mention_mode`；`split_mention_tokens()`；`parse_trigger()` 增加 mode/trigger_names/masked opt-in 三个带默认值的尾参（旧调用零改动）；`_observe()` 与 `build_message_event()` 同口径；`_consume_bridge_echo()` 对未验行按文本全等生效；`_validate_groups()` 与 `load_config()` 严格校 mention_mode；`health()["mention_routing"]` 报真值而不是恒 False |
| `tests/python/test_wechat_group_uia.py` | 新增 `MentionTriggerTests` / `LoadConfigMentionModeTests`（正负对照 + 自触发对照） |
| `src/channels/weixin/wechat-group-config.mjs` | `MENTION_MODES` 枚举、mentionMode 合法值集合校验、mention 模式必须 `allowUnverifiedTrigger=true` 的交叉闸；未知键/未知值仍 fail-closed |
| `src/channels/weixin/wechat-group-runtime.mjs` | `#validEvent()` 的二次判据改为按 mention_mode 复用与 adapter 相同的剥词规则（command 模式行为逐字不变） |
| `test/channels/weixin/wechat-group-config.test.mjs` | 新模式合法、交叉闸、未知值仍拒 |
| `test/channels/weixin/wechat-group-runtime.test.mjs` | masked @ 事件入站、正文不含占位符、command 模式下 @ 形态仍拒、伪造正文仍拒 |
| `lib/index.js` | 只由 `npm run build` 生成，不手改 |

## 4. 操作员要写的配置形状

```json
{
  "version": 1,
  "pollIntervalMs": 750,
  "allowUnverifiedRead": true,
  "allowSend": true,
  "groups": [{
    "id": "uia_group_one",
    "title": "精确群名",
    "commandPrefix": "/dsh",
    "mentionMode": "mention-or-command",
    "allowSelf": false,
    "allowUnverifiedTrigger": true
  }]
}
```

`mentionMode` 三值：`command`（今天的行为，也是缺省）/ `mention`（只认 @）/
`mention-or-command`（@ 或 `/dsh` 都认，向后兼容）。非 `command` 必须同时写
`allowUnverifiedTrigger: true`，否则配置直接被拒（见 2.4）。
