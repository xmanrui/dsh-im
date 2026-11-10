# Telegram 过程展示挡位（极简 / 标准 / 全面）方案与记录

状态：**已实现，待真机截图验收**。实现日期：2026-11-10。fork 版本：`5.10.1-wings.2`
基线：`5.10.1-wings.1`（= v5.10.0 + 三套 Telegram 卡片），本次只动「一个回合显示多少」。

## 0. 一页结论

| 结论 | 证据 |
| --- | --- |
| 改版前 Telegram 出厂默认是**逐条新消息**（`thinkingTraces` 缺省 ON、节流 0、编号关），一轮聊天可能几十条消息，且全部计入每聊天 15 条/分钟预算 | `src/channels/telegram/telegram-runtime.mjs:1676`、`src/channels/shared/thinking-cadence.mjs:14`、`src/channels/shared/send-limit.mjs:14` |
| 现在默认是「标准」：**一轮一条占位消息原地改写**，结束时收成一行回执，答案单独一条 | `test/channels/telegram/presentation-levels.test.mjs` L2、L12 |
| 三挡位是**一个 enum 收口**：同时决定「开哪条流」和「哪类进度上屏」 | `src/channels/shared/text-harness-bridge.mjs`（`#presentationLevel`、`turnProgress`） |
| 聊天里可切换：`/display` 卡片三按钮，或 `/display 极简/标准/全面`；设置页也有下拉 | `src/channels/telegram/display-card.mjs`、`plugin-src/client/channels/telegram/thinking-traces.js` |
| 其他渠道（WhatsApp/Slack/Discord…）不传挡位时渲染**逐字节不变** | `test/channels/whatsapp/streaming.test.mjs`（7 例全绿，未改断言） |

## 1. 三挡位到底发什么

以「用户发一句话 → 模型调用 2 个工具 → 回答」为例：

| 挡位 | 过程 | 结束时 |
| --- | --- | --- |
| 极简 | 只有一条占位「正在处理…」，**不改写**（不暴露工具名与步数） | 删除占位 → 发送答案 |
| 标准 | 同一条占位原地改写：`⏳ 处理中 · 12 秒 · 2 步` + `🔧 bash → npm test`；模型开始写答案时换成 `✍️ 正在整理回复`；1.2 秒窗口内合并，10 秒心跳只更新秒数 | 占位**改成** `✅ 完成 · 12 秒 · 2 步` 回执 → 发送答案 |
| 全面 | 每条 💭 思考、每条 🔧 工具调用各自一条消息；工具结果**回写到同一行**：`🔧 bash → npm test · ✓ 0.8s`（失败 `· ⚠️ 失败 0.8s`，编号模式下保留帧号） | 发送答案（无回执） |

失败回合：三挡位都**不**留回执，占位删除后发错误消息——错误本身就是终态，上面再压一行「已中断」是噪音。

## 2. 事实与实现位置

| # | 断言 | 位置 |
| --- | --- | --- |
| F1 | 挡位归一化、旧布尔映射、输入别名、进度行合成器 | `src/channels/shared/presentation-level.mjs` |
| F2 | 桥里只有一个收口：`#presentationLevel` 决定开流与帧过滤 | `text-harness-bridge.mjs` `#process`（`level`、`turnProgress`、`pushProgress`） |
| F3 | 回执靠 `stream.supportsProgressSummary` + `progressSummary` 字段，只有声明支持的流才会收到 | `telegram-runtime.mjs` `TelegramDeliveryStream`、`openDeliveryStream` |
| F4 | 占位改回执失败（例如 not-modified / 429）时退化为删除，绝不留过期占位 | `telegram-runtime.mjs` `settlePlaceholder` |
| F5 | `/display` 只在声明支持的渠道出现（catalog `channels: ['telegram']`）；`/menu` 同样收进 catalog 并放在菜单第一位，从「隐藏命令」变成可发现入口 | `command-catalog.mjs`、`text-harness-bridge.mjs` `#supportsDisplayCommand` |
| F6 | 卡片命名空间 `d1|<nonce>|<level>`，TTL 30 分钟，首按认领；**每次按完换新 nonce 再重绘**，所以卡片可反复用，点当前项也不死 | `display-card.mjs` |
| F7 | 配置落盘 `presentationLevel`，未知值回落标准；写入挡位时删掉旧布尔 | `telegram/config-store.mjs`、`telegram-controller.mjs` |
| F10 | 全面挡位的工具结果用编辑同一条消息实现（`formatToolOutcome`），不额外发消息 | `telegram-runtime.mjs` `settleToolTrace` |
| F11 | 群聊里点/打共享本地命令（`/status`、`/menu`、`/display` 等）算「已点名」，不再被群触发规则静默丢弃；普通文字与未知 slash 仍按规则处理 | `telegram-runtime.mjs`（`isSharedLocalCommand`）、`command-permission.mjs` |
| F9 | 切换挡位**不重连**：配置落盘后把新挡位推给在跑的 runtime/bridge，下一回合即生效，不会 abort 其它聊天的在飞回合 | `telegram-controller.mjs`、`token-bot-controller.mjs`（`restart:false`）、`telegram-runtime.mjs#setPresentationLevel` |
| F8 | RPC `bot.presentation-level.set` + 设置页下拉 | `plugin-src/host/channels/shared/presentation-level-rpc.mjs`、`rpc.mjs`、`thinking-traces.js` |

## 3. 兼容与行为变更（明说）

1. **默认值变了**：未配置 `thinkingTraces` 的 bot 从「逐条」变为「标准」。这是本次要治的刷屏本身。
2. **`thinkingTraces` 变成别名**：`true`→全面、`false`→标准；保存挡位时删除该字段，避免两个开关打架（`thinking-traces.test.mjs` E1 已按新语义改写）。
3. **其他渠道零变化**：桥的挡位默认是 `null`（= 未接入），只有 Telegram 运行时会传值。

## 4. 验收与证据

红证（改版前会失败的断言，改版后通过）：

| 断言 | 改版前 | 改版后 |
| --- | --- | --- |
| 标准挡位占位行含「处理中 · N 秒 · N 步」 | 只有 `正在使用bash…` | `rich-message.test.mjs`、`presentation-levels.test.mjs` L2 通过 |
| 标准挡位结束时占位被改成回执 | 占位被删除 | `presentation-levels.test.mjs` L12 通过 |
| 极简挡位零改写 | 每步一条进度 | `presentation-levels.test.mjs` L1 通过 |
| `/display` 存在于 Telegram 菜单与 `/help` | 命令不存在 | `command-menu.test.mjs`、`command-help.test.mjs` 通过 |
| 三挡位的**真实运行时调用序列** | 只有一种行为 | `presentation-levels-runtime.test.mjs`（5 例）：极简 `send→delete→rich`、标准 `send→edit→edit(回执)→rich`、全面 `send→send→rich` |

命令（在 `~/Code_Project/dsh-im-build`）：

```bash
node --test test/*.test.mjs test/channels/*/*.test.mjs   # 5088 例：5087 通过、0 失败
npm run build && npm pack && node scripts/verify-package.mjs
```

产物：`xmanrui-dsh-im-5.10.1-wings.2.tgz`（517 文件，`Verified dsh-im package artifacts.`，sha256 `56ce0dd9…`），已复制到 `~/.dsh/local-packages/` 待装。

## 4.1 独立评审修掉的问题（2026-11-10）

第一版有 12 条独立评审意见，阻塞级的两条已修并补了回归测试：

| # | 问题 | 修法 | 回归断言 |
| --- | --- | --- | --- |
| P1 | `TelegramDisplayCard` 没接进生产 bridge，`/display` 只会走文本菜单（卡片是死代码） | `telegram-bridge.mjs` 构造器注入 | `presentation-levels.test.mjs` L15（真 runtime 必须发出带 `d1\|` 按钮的卡片） |
| P2 | `/display <挡位>` 保存会重启 runtime，确认消息随 abort 丢失，且打断其它聊天 | 保存走 `restart:false` + live runtime/bridge 推送 | L11（不重连、就地切换）、L7（确认消息） |
| P3 | 点「当前挡位」按钮 `settle(ACTIVE)` 抛 TypeError，卡片永久卡死 | 当前项不 settle，直接换 nonce 重绘 | L16 |
| P4 | 成功后用同一个 nonce 重绘，第二次点击变「已处理」 | 每次按完 `issue()` 新 nonce | L16 |
| P5 | 设置页下拉恒显示「标准」：客户端归一化漏了字段 | `token-api.js` 白名单加 `presentationLevel` | client-ui / bundle 用例 |
| P6 | 旧 `thinkingTraces` 字段实际没被清掉（config-store 的 `...previous` 合并又写回） | `TelegramConfigStore.save` 在写入挡位时删布尔 | E1、L11 |
| P8 | 标准与全面两套工具摘要（`{"command":"ls"}` vs `ls`） | 抽出共享 `summarizeToolArguments`，两处共用 | P5/P6、A1–A3 |
| P9 | 非 ASCII 截断可能切出孤立代理 | 按码点截断 | P5（emoji 用例） |
| P7 | 飞书面板用例被改成空循环（白跑） | 用 `commandsForChannel('slack')` 代表文本族并断言非空 | 飞书 slash 用例 |

## 5. 未完成（下一轮）

0. **已装到 wings-gpd**（2026-11-10 08:45 最新构建，`wings_gpd_dsh_bot` connected、`presentationLevel=standard`），用户可直接在 TG 里发 `/start`、`/display` 体验；tx-us1 与 Windows 仍是 wings.1。
1. **真机截图**：wings-gpd 的图形会话从 01:22 起一直锁屏（`loginctl` `LockedHint=yes`），没法用 computer-use 操作 Telegram 客户端；需要用户解锁（自动跑完整条验收流水线）或直接授权装到设备上。
2. ~~真实模型回合的三挡位渲染~~：已用本地假 LLM 在真宿主跑通（§6.1），含失败工具的分支。
3. ~~`/status` 增加「当前挡位」一行~~：已做（§6.2）。

### 4.2 第三轮评审（welcome/⏹/矩阵）修掉的问题

| # | 问题 | 修法 |
| --- | --- | --- |
| M1 | ⏹ 先 ack「已请求停止」再执行，`/stop` 的结果被丢弃：没任务在跑时读者被骗 | 执行后按 `result.stopped` 判定；没停成时把 `/stop` 的原话补发到聊天 |
| M2 | 欢迎卡不校验 `status`，TTL 与「被取代」失效 | 补 `ACTIVE` 校验 + `claim`/`releaseClaim`，与其它卡一致 |
| M3 | 取消（abort/失败）时占位保留，留下点不动的 ⏹ | `onCancel` 顺手删占位（token 已回收，按钮只会道歉） |
| M4 | L23 用例的 fixture 没绑会话，测不到 `control`（上轮 bug 复现不了） | 绑定会话 + stub `sessionExists`/`stopActiveTurn`/`ask`，断言 `control:{owner,key}` 真的传下去 |
| M5 | 矩阵断言只看「有没有 delete」，不看删的是哪条；顺序/次数都不校验 | mock 记 `messageId`；断言删除对象=占位、ack 在 delete 之前、停止只报一次；半行 JSON 跳过 |

顺带清理：`/start` 与 `isStartCommand` 去重、支持 `/start@botname`、删掉死条件、`full` 挡位不再白铸 token、欢迎卡只渲染一次、`run-host-e2e.sh` 先查端口占用。

### 4.3 第 3.5 轮复审（针对修复本身）

| # | 问题 | 修法 |
| --- | --- | --- |
| F1 | 欢迎卡退键盘用了 `editInteractionCard`（要求文本），真实客户端直接抛 TypeError，被 catch 吞掉 → 被取代的旧卡键盘永远清不掉 | 改用 `updateInteractionCard`（只改键盘），并在删除记录前取 id |
| F2 | 为支持 `/start@bot` 放开任意后缀 → 群里 `/start@别的bot` 会唤醒本 bot | 收回到只认裸 `/start`（本 bot 自己的 `@` 在进桥前已被剥离） |
| F3 | 后台任务停止的提示被 `!stopped` 条件吞掉 | `commandResult` 补 `background` 标记，桥按它决定是否补发 |
| F4 | 失败路径与 cancel 会删两次占位 | 加 `placeholderDeleted` 一次性守卫 |
| F9 | 欢迎卡里的「菜单」按钮打不开（没有文本 runner） | 卡片入口里 `/menu` 直接 present hub 卡 |
| F5/F6 | 矩阵只数 `Stopped`、欢迎卡 fake bot 没有清键盘 API，F1 漏网 | 矩阵补计数断言；W5 用例只在 `updateInteractionCard` 上断言 |

### 5.1 已知但不打算改的

- `/status` 卡片是**快照**：从它打开选择器改了挡位后，旧卡上的「显示挡位」一行仍是旧值（卡上有「刷新」按钮）。让它自动联动需要跨卡订阅，收益不抵复杂度。

## 6. 宿主级端到端实测（2026-11-10，无需 Telegram 账号）

做法：在隔离的 `DSH_HOME=/tmp/dsh-e2e` 里装本仓打出的 `5.10.1-wings.2`，用本地 CONNECT 代理 + 自签 CA 冒充 `api.telegram.org`（脚本 `/tmp/e2e/mock-telegram.mjs`），让真 `dsh web` 带着插件连上一个假 bot，脚本化推送两条更新：私聊 `/display`、按钮「极简」，再推一条**群里没 @ 的 `/help`**。

| 观察点 | 实测 |
| --- | --- |
| 连接与菜单 | `getMe` → `getWebhookInfo` → 两次 `setMyCommands`（私聊 24 条 / 群 19 条，**首项都是 `menu`**，含 `display`）→ `deleteMyCommands`（清默认 scope）→ `setChatMenuButton` |
| `/display` | 发出一条带 3 个按钮的消息：`◻️ Minimal` / `✓ Standard (current)` / `◻️ Full`，`callback_data` 形如 `d1|<nonce>|minimal` |
| 按钮按下 | `editMessageText` **原地重绘**：正文变 `Current: Minimal`，按钮变 `✓ Minimal (current)`，并换新 nonce；机器人在线状态不变（没有重连） |
| 群聊命令 | 群里发 `/help`（不带 @）→ 回了帮助卡（25 条命令、6 个分区按钮）——证明群命令不再被「仅 @ 时回复」吞掉 |
| 落盘 | `integrations/dsh-telegram/config.json` 出现 `presentationLevel: "minimal"`，旧的 `thinkingTraces` **已被删除** |
| 运行时状态 | management RPC `connection.status` 返回 `state: connected`、`presentationLevel: minimal`、`thinkingTraces: false` |

### 6.1 真实回合的三挡位（同一隔离实例 + 假 LLM）

用本地假 OpenAI-Completions 服务（`/tmp/e2e/mock-llm.mjs`：第一轮返回 `bash echo tier-check` 工具调用，第二轮返回最终答案）让真宿主跑出**真工具调用**，再在 Telegram 侧记录插件发的每条消息：

| 挡位 | 实测序列（Bot API 调用） |
| --- | --- |
| 极简 | `sendMessage Processing…` → `deleteMessage` → `sendRichMessage 答案` |
| 标准 | `sendMessage Processing…` → `editMessageText ⏳ Working · 1s · 1 steps / 🔧 bash → echo tier-check` → `editMessageText ✅ Done · 1s · 1 steps` → `sendRichMessage 答案` |
| 全面 | `sendMessage 🔧 bash → echo tier-check` → `editMessageText … · ✓ 0.3s` → `sendRichMessage 答案` |

这一轮实测抓出并修掉两个只有真宿主才会暴露的问题：

1. **标准挡位的过程行会被冲掉**：`status`（"正在整理结果…"）与 canonical 答案文本也会走通用进度路径，把紧凑行覆盖成一句状态、甚至把答案预演到占位里（等于答案出现两次）。现在 `standard` 只接受 tool / tool-result / text(→写回复) 三类，其余一律忽略。
2. **全面挡位的工具行永远停在「进行中」**：Telegram 走 `progressMode:'all'`，tracker 的 `live` 永远为假，所以生产里**根本不会出现 `tool-result` 帧**——工具结果只以 `status + toolName(+error)` 下发。现在两种形态都能结算该行：带 callId 按 id 归属，没给 id 才按 FIFO 兜底；**给了 id 但查不到就什么也不做**（否则会误结算别人还在跑的行）。
3. **失败的工具行曾被渲染成 ✓**（独立评审发现）：status 帧其实带着 `error`，早先却硬编码 `ok:true`。现在按 `error` 判定，并把这个字段（连同 callId）补进投影帧；`standard` 的收尾回执遇到失败步数会变成 `⚠️ 完成 · 12 秒 · 5 步 · 1 步失败`，不再一律 ✅。真宿主实测：`🔧 bash → false · ⚠️ failed 0.0s` / `⚠️ Done · 1s · 1 steps · 1 failed`。

### 6.1.1 `/start` 欢迎卡（真宿主，2026-11-10）

Telegram 新用户点 Start 会发 `/start`；以前这条会被当普通文本丢给模型（模型去解释一串 `/start`）。现在：

| 观察点 | 实测 |
| --- | --- |
| `/start` | 发欢迎卡：「已连接 DeepSeek Harness…当前过程显示：标准」+ 三个按钮 `🏠 Menu` / `🎛 Display` / `❓ Help` |
| 按下「Display」 | 直接打开三挡位选择器，回调 ack「Opened.」 |
| 副作用 | `/start` 不再进入模型回合（用例断言 `ask` 调用数为 0） |

### 6.1.2 ⏹ 停止按钮（真宿主，2026-11-10）

极简/标准挡位的占位消息底部带一个 `⏹ 停止` 按钮（回调 `st|<token>`，单回合一次性、只认发起者）：

| 观察点 | 实测 |
| --- | --- |
| 占位 | `sendMessage Processing… hasKeyboard=true`，按钮 `⏹ Stop` |
| 按下 | 回调 ack「Stop requested.」；带 `control:{owner,key}` 调 `/stop`，宿主取消该回合，`sleep 40` 立即结束 |
| 收尾 | 占位消息被删除（连按钮一起消失），随后一条「Stopped.」；**不会**多出一条重复提示 |
| 已修的坑 | 早先按钮走 `#runMenuEntry('/stop')`，没带 `control`，宿主不知道要取消哪个回合 → 按钮只 ack、任务照跑 40 秒；现在直接带 `control` 调 `runControlCommand` |
| 边界 | token 与「是谁发起的这一回合」绑定：群里其他人按只会收到「只有发起这个任务的人可以停止它」；过期 token 回「需要停止请发送 /stop」 |

已知取舍：全面挡位没有占位消息，所以没有按钮（那一档的用户直接发 `/stop`）；被停止的回合回执沿用「完成/失败」措辞而不是「已停止」。

### 6.1.3 回归矩阵（一条命令，6 例）

`skills/dsh-plugin-development/scripts/check-matrix.sh` 在宿主级一次跑完：

| 用例 | 结果 |
| --- | --- |
| `turn / minimal` | PASS：占位（带 ⏹）→ 删除 → 答案，无进度编辑 |
| `turn / standard` | PASS：占位 → `⏳ Working` → `✅ Done`（清键盘）→ 答案 |
| `turn / full` | PASS：`🔧` 行 → `· ✓ 0.0s` → 答案 |
| `stop / minimal` | PASS：ack → 占位（连按钮）删除 → 「Stopped.」 |
| `start / standard` | PASS：欢迎卡 + 三入口 |
| `status / standard` | PASS：状态卡（含挡位）→ 按下 → 选择器 + ack |

### 6.2 /status 卡片与选择器入口（真宿主）

同一隔离环境里脚本化「先 `/status`、再按下卡片上的显示挡位按钮」：

| 观察点 | 实测 |
| --- | --- |
| 状态卡正文 | 末尾多一行 `Display: Standard`（中文宿主下为「显示挡位：标准」） |
| 状态卡按钮 | 8 个按钮里含 `🎛 Display`（`t1|<nonce>|d`） |
| 按下 | 直接发出三挡位选择器卡（`Current: Standard` + 三个按钮），**不是**回「无法打开」 |
| 同一构建再跑一个真回合 | 标准挡位序列不变：占位 → `⏳ Working · 1s · 1 steps / 🔧 bash → …` → `✅ Done · 1s · 1 steps` → 答案 |

复现要点（踩过的坑）：假 token 必须是 `数字:35 字符`，否则连接在 `runtime.prepare` 阶段就失败；`getUpdates({offset:-1})` 是游标探测，不能回放脚本更新；`pnpm` 会按路径缓存 tarball，换包后要删 `node_modules/@xmanrui` 再 `dsh plugin install`，否则装到的还是旧构建（这坑让群命令实测一开始“失败”）。
