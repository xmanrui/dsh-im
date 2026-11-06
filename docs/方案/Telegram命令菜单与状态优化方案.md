# Telegram 命令菜单与 /status 优化方案（批次 0）

- 状态：**已实施**（worktree `feat/tg-menu-polish`，基于 main `27bd7a2`；未 push、未合并）。
- 关联：Telegram 交互体验路线图（Lead 统一维护，**本分支不提交**）的批次 0 / P0-5 / 技术地基第 4 条 / A7·A9；调研 `command-ux-audit.md`（主检出只读）的 B16、B08、D11；任务板 task-7。
- 本分支只新增功能独有的文档；路线图与调研文档仍由 Lead 在规划分支统一提交，避免与 `/ws` PR 的同名文件冲突。
- 实施提交：`64a6ded`（首轮实现 + 测试 + lib），评审修复提交（`git log` 顶部，分支 +2）；路线图状态由 Lead 收尾统一更新。
- 环境：Node 26.12.0、`node --test`（测试直接 import `src/`，lib 为发布产物）。

## 0. 一页结论

| 项 | 结果 |
| --- | --- |
| 原生命令菜单 | main 基线实际是 **31 项 / 8 个别名**（文档写的 27 项 / 5 个来自另一分支，见 F2）。现在别名全部离开原生菜单（仍可输入、仍在 `/help`），菜单变成私聊 **23 项** / 群聊 **19 项** |
| 分 scope 注册 | 私聊 `{type:'all_private_chats'}` 含全部命令；群聊 `{type:'all_group_chats'}` 排除 `history/batch/send/cancel`（privateOnly）；每次同步**先成功写入两个 scope，最后才 `deleteMyCommands()` 清默认 scope**（空目录则三个 scope 都删）——scoped 写失败时旧菜单保留，不会整片消失 |
| `/status` | 一行变一条消息 5–6 行：连接、工作区、绑定会话、当前模型、Agent Preset、运行中任务（有才显示）；单字段失败独立降级，命令不失败；中英文都有翻译 |
| 平台事实 | 新增 `scripts/probe-telegram-limits.mjs`：默认零网络输出官方事实 + 仓内约束 + 实测计划；`--live` 才用环境变量里的探测 token/chat 实测 callback_data/按钮数/编辑带键盘/429，并删除临时消息 |
| 明确不做 | 进度消息节流/流式发送预算（上游 #423/#425/#426 正在改同一片代码）、审批按钮卡（另一并行队友）、`/stop` 按钮；均见 §7 |
| 验证 | scoped 测试 65/65 + `telegram.test` 44/44 全绿；全量 `npm test` **4430/4430 通过**；`npm run build`、`node scripts/verify-package.mjs`、验收脚本 `--check-scopes` 离线自检均成功（证据见 §6 与 `_notes/tg-menu/evidence.md`） |

## 1. 事实核对（闸门 1）

每条断言都配可复现命令与实测输出。完整记录：`/home/wings/Code_Project/_notes/tg-menu/evidence.md`。

| # | 断言 | 可复现命令 | 实测输出 |
| --- | --- | --- | --- |
| F1 | main 基线的原生菜单是 31 项，含 8 个别名；privateOnly 是 4 条 | `node --input-type=module -e "import {telegramCommandMenu} from './src/channels/telegram/telegram-runtime.mjs'; ..."`（完整脚本见 evidence F1） | `catalog commands: 23` / `menu entries: 31` / `visible aliases (8): ws,conversation,thread,workspaces,wsl,sessions,reasonings,presets` / `privateOnly: history,batch,send,cancel` |
| F2 | 调研/路线图写的「27 项 / 5 个别名」来自规划分支 `8ebef5c`，不是 main | `git diff 27bd7a2 8ebef5c -- src/channels/shared/command-catalog.mjs`（在只读主检出执行） | 规划分支把 `workspace` 的别名 `ws` 和整条 `workspacelist` 设为 `menuVisible:false`，于是 22 主名 + 5 别名 = 27；main 没有这两处隐藏，所以是 23 + 8 = 31 |
| F3 | `setMyCommands`/`deleteMyCommands` 已支持 `scope` 与 `languageCode`，payload 透传 | `sed -n '416,435p' src/channels/telegram/telegram-api.mjs` | `...(scope ? { scope } : {})` / `...(cleanString(languageCode) ? { language_code: cleanString(languageCode) } : {})` |
| F4 | 修复前启动只写「默认 scope」，没有分 scope | `git show 27bd7a2:src/channels/telegram/telegram-runtime.mjs \| rg -n "#sendCommandMenu" -A 5` | `api.setMyCommands({ commands, signal })`（无 scope） |
| F5 | Telegram 命令按 scope 解析：更具体的 scope 覆盖 default | 官方文档 <https://core.telegram.org/bots/api#setmycommands>、<https://core.telegram.org/bots/api#botcommandscope> | 官方原文：*"The commands set for the default scope are used if no commands with a narrower scope are specified for the user."* 因此旧版本写在 default 的列表必须清掉/覆盖，见 §3.1 策略 |
| F6 | `callback_data` 1–64 字节，仓内有本地强制 | `rg -n "CALLBACK_DATA_MAX_BYTES" src/channels/telegram/telegram-api.mjs` | `58:const CALLBACK_DATA_MAX_BYTES = 64;`，83–87 行按 `Buffer.byteLength` 校验并抛错 |
| F7 | `privateOnly` 只是菜单元数据，真正的私聊限制在 handler 里（所以菜单分 scope 不改变权限） | `sed -n '118,122p' src/channels/shared/history-command.mjs`；`sed -n '386,394p' src/channels/shared/text-harness-bridge.mjs`；`rg -n "batchInputGroupUnsupportedMessage" src/channels/shared/batch-input.mjs` | `if (!isDirect) return commandResult(t('请在与机器人的私聊中使用 /history。'));`；群聊批量输入回 `批量输入模式仅支持私聊…` |
| F8 | 修复前 `/status` 只有一行 | `git show 27bd7a2:src/channels/shared/text-harness-bridge.mjs \| rg -n "command === '/status'" -A 3` | `await ensureRunning(...)` 后 `sendText(t('{label}机器人与 DeepSeek Harness 连接正常。'))` |
| F9 | 平台数值（按钮上限/编辑频率/ack 时限）官方未公布或未真机验证 | `node scripts/probe-telegram-limits.mjs` | 离线输出见 `_notes/tg-menu/probe-offline.txt`：官方只公布 `callback_data` 64B、`setMyCommands` ≤100 条、`retry_after` 语义等；按钮数量上限未公布；`answerCallbackQuery` 只有「客户端转圈直到 ack」的说明，无秒数 |
| F10 | 上游 PR 状态（改动同区域，先协调） | `gh pr list --repo xmanrui/dsh-im --limit 30 --json number,title,state` | `#423 OPEN feat(telegram): respect Telegram's per-chat send budget`、`#425 OPEN …pace and number thinking-trace frames`、`#426 OPEN …number the progress placeholder too`；`#412 MERGED …deliver the final answer as its own message` |

### 平台事实（真机数值待 Lead 在 E2E 回填）

| 事实 | 来源 | 当前状态 |
| --- | --- | --- |
| `callback_data` 1–64 字节（UTF-8） | 官方 + F6 本地强制 | 已按 64B 设计；`probe --live` 会实测 64/65 ASCII 与 63/66 UTF-8 字节 |
| inline_keyboard 按钮数量上限 | 官方未公布 | **未实测**；`probe --live` 从 8 试到 200，记录首次拒绝位置 |
| 按钮文字长度上限 | 官方未公布 | **未实测**（客户端截断行为需真机看） |
| `editMessageText` 能否同时带 `reply_markup` | 官方参数表支持 | `probe --live` 实测；成功则批次 1 可一次原地更新正文 + 键盘 |
| 429 / `retry_after` | 官方 `ResponseParameters` | `probe --live` 连续编辑 30 次尝试触发；未触发只说明窗口内没到阈值，不代表无限制 |
| `answerCallbackQuery` 时限 | 官方未公布秒数 | **未实测**（需要真人按键；机器人无法合成 callback_query） |
| `setMyCommands` ≤100 条/名字/描述规则 | 官方 + F6/`validateTelegramCommands` | 本地已强制；不放进 live 探测以免改写 bot 的正式菜单 |

`probe-telegram-limits.mjs` 的安全约束：token 只从 `TELEGRAM_PROBE_TOKEN` 读、只接受合法 bot token 形状、从不打印（输出里统一 `[redacted]`）；`TELEGRAM_PROBE_CHAT_ID` 必填；只操作探测 chat 里自己创建的临时消息并在 `finally` 里删除；不加 `--live` 时零网络请求。

### 真机回填（2026-10-22，独立测试 bot）

`probe-telegram-limits.mjs --live` 实测（Telegram Desktop 7.3.1 / KDE Wayland / 独立 `DSH_HOME` 实例）：

| 探测项 | 实测 |
| --- | --- |
| default / all_private_chats / all_group_chats 命令数 | **0 / 23 / 19**（本分支基线；与 `/ws` 分支合并后为 22 / 18，scope 语义相同） |
| callback_data 64B / 65B ASCII | 接受 / 400 `BUTTON_DATA_INVALID` |
| callback_data 63B / 66B UTF-8（21/22 个汉字） | 接受 / 400 `BUTTON_DATA_INVALID` |
| inline_keyboard 按钮数 8/20/40/60/100/200 | 全部接受（200 以内未触限） |
| `editMessageText` 同时传 `reply_markup` | 接受（一次调用更新正文 + 键盘） |
| 连续 30 次编辑 | 窗口内未触发 429（阈值未到，不代表无上限） |
| `answerCallbackQuery` 时限 | 仍未实测（机器人无法合成按键） |

真机端到端（同一集成构建）：Telegram 客户端「菜单」按钮展示私聊主名列表（无 8 个别名）、
`/status` 一条消息 5–6 行且随工作区切换更新；Bot API 三 scope 计数与上表一致。
截图与完整记录保存在验证机器 `_notes/tg-e2e/`，未提交进仓库。


## 2. 验收标准（闸门 2）与实测

| # | 标准 | 判定命令 | 期望 | 实测 |
| --- | --- | --- | --- | --- |
| A1 | 原生菜单不再出现 8 个别名 | `node --test test/channels/telegram/command-menu.test.mjs` | 用例 `hidden alias /<alias> still parses but is absent from the native menu` 全绿 | ✅ |
| A2 | 私聊菜单 23 项、群聊 19 项；群聊排除 4 条 privateOnly；两份列表 id 顺序固定 | `node --test test/channels/telegram/command-menu-scopes.test.mjs` | 全绿（含完整 id 列表断言） | ✅ |
| A3 | 注册顺序：先写私聊/群聊，再删默认 scope；scoped 写失败不清 default；空目录三个 scope 都删 | `node --test test/channels/telegram/command-menu-sync.test.mjs` | 用例断言 `setMyCommands(private)`→`setMyCommands(group)`→`deleteMyCommands` 的 payload 与 scope 结构；`a failing scoped write keeps the legacy default menu…` 断言 delete 次数 0 | ✅ |
| A4 | 语言切换只刷新文本、不重设菜单按钮；连接期间切换会在连接完成后补发 | 同上 | `a live interface language switch…` / `a language switch during connection…` 全绿 | ✅ |
| A5 | `/status` 一条消息含连接/工作区/绑定会话/当前模型/Agent Preset；运行中任务仅在运行时有该行 | `node --test test/channels/shared/status-command.test.mjs` | 4 个用例（全字段 / 未绑定 / 单字段失败降级 / 英文）全绿 | ✅ |
| A6 | 字段读取失败不影响其他字段，也不让命令失败 | 同上用例 `a failing status field degrades independently…` | 只剩连接/工作区/绑定会话三行 | ✅ |
| A7 | `/help` 文本字节级不变（别名仍在帮助里，共 30 行） | `node --test test/channels/shared/command-help.test.mjs test/channels/shared/i18n.test.mjs` | 对 `fixtures/command-help.json` 的 zh/en 快照完全相等 | ✅ |
| A8 | 除 `/status` 外的文字回执不变 | 全量 `npm test`；`git diff --stat` 只含允许的文件 | 全绿；失败时按字节断言定位 | ✅ |
| A9 | 构建成功且 lib/ 与源码一致 | `npm run build` | 退出码 0，`lib/` 有 diff 并随实现一起提交 | ✅ |
| A10 | 平台探测脚本可离线运行、不读 token、不联网 | `node scripts/probe-telegram-limits.mjs`；`node scripts/probe-telegram-limits.mjs --live`（无 env） | 离线退出 0 且无请求；无 env 时拒绝并退出非 0，不打印 token | ✅ |

## 3. 设计

### 3.1 原生命令菜单（核心）

**数据面（`src/channels/shared/command-catalog.mjs`）**：继续用现有 `menuVisible:false` 机制，把 8 个别名改成 `{ name, menuVisible:false }`：`ws`、`conversation`、`thread`、`workspaces`、`wsl`、`sessions`、`reasonings`、`presets`。别名仍留在 catalog 的 `aliases` 里，所以 `commandHelpLines()`（`/help`）与 handler 解析完全不受影响。选择在 catalog 表达而不是在 Telegram runtime 里过滤，是因为 catalog 是唯一事实源；飞书/企微/QQ 的消费方读的是同一份 `aliases`/`help`，行为不变。

**菜单面（`src/channels/telegram/telegram-runtime.mjs:23-91`）**：

- `commandMenuEntries()` 在扁平化时给每条命令带上 `privateOnly`（别名继承所属命令的值）。
- `telegramCommandMenu()` 保持原有公开形状（`[{command,description}]`，全量），供 `/help` 相关测试和现存消费方使用。
- 新增 `TELEGRAM_COMMAND_MENU_SCOPES = { private: {type:'all_private_chats'}, group: {type:'all_group_chats'} }`。
- 新增 `telegramCommandMenuScopes()`：返回 `[ {scope, commands}, {scope, commands} ]`；私聊 = 全量，群聊 = 去掉 `privateOnly`；两份都独立跑 `validateTelegramCommands`（≤100、名字/描述规则、无重名）。

**注册时序（`telegram-runtime.mjs`）**：

```
setMyCommands(commands, all_private_chats)   // 先成功写入两个 scoped 列表
setMyCommands(commands, all_group_chats)
deleteMyCommands()                           // 最后才清 default scope 的旧菜单
```

**默认 scope 旧命令的清理策略（明确）**：采用「显式 scope 覆盖 + 最后清空 default」，不保留 default 列表。

1. 先分别写入 `{type:'all_private_chats'}` 与 `{type:'all_group_chats'}` 两个显式 scope；
2. 两个 scoped 列表都成功之后，才调用 `deleteMyCommands()`（不带 scope 即 default scope）清掉旧版本留下的整份菜单；
3. 命令目录为空时，三个 scope 都调用 `deleteMyCommands({scope})`（scoped 在前、default 最后）；
4. 任何一步失败即中止后续步骤并保留原警告路径；**scoped 写失败时 default 旧菜单原样保留**，下个普通菜单仍可用，不会出现「菜单整片消失到下次重连」；
5. 若第一个 scoped 写成功、第二个失败，同样停在 delete 之前——旧 default 菜单继续生效，等下次连接/语言切换时重试。

可复现验证：

```bash
# 1) 单测直接断言调用顺序与 payload（fake API 记录 calls）
node --test --test-name-pattern "registers private and group menus" \
  test/channels/telegram/command-menu-sync.test.mjs
# 期望：setMyCommands(commands, all_private_chats)
#       → setMyCommands(commands, all_group_chats) → deleteMyCommands({})
# 另有用例 a failing scoped write keeps the legacy default menu… 断言 set 失败时
# deleteMyCommands 调用次数为 0

# 1b) 验收脚本的离线自检（不需要 Harness/token）
node scripts/verify-interface-language.mjs --check-scopes
# 期望：打印 default/private/group 三个 scope 后 "Offline self-check passed"


# 2) 真机只读核对（不需要改任何东西；用探测 bot 或 E2E 环境的 token）
TELEGRAM_PROBE_TOKEN=... TELEGRAM_PROBE_CHAT_ID=... \
  node scripts/probe-telegram-limits.mjs --live --json
# 输出里的 commandScopes 段：default 应为 0 条，all_private_chats / all_group_chats
# 分别是当前版本的私聊/群聊条目数（本分支为 23 / 19，规划分支合并后预期 22 / 18）

# 3) 纯手工：直接查 Telegram
#    getMyCommands（不传 scope）→ 空
#    getMyCommands {"scope":{"type":"all_private_chats"}} → 23 条
#    getMyCommands {"scope":{"type":"all_group_chats"}}  → 19 条
```

- 为什么先清 default：官方解析顺序是「更具体的 scope 覆盖 default」，旧版本的 default 列表在升级后既不会被两个 scope 覆盖掉存储，又会在任何未来新增 scope/降级场景里重新露出来；清掉是最小惊讶的选择。
- 空 catalog：三个 scope 都 `deleteMyCommands`（原行为是删 default）。
- 失败语义：任一步失败即中止后续 scope，由 `#start()`/`refreshCommandMenu()` 原有的 catch 打一条 `command menu setup failed` / `command menu refresh failed` 警告；bot 仍然 ready，命令照常处理（有测试）。
- 不带 `languageCode`：一次注册覆盖所有客户端语言，文案跟随 Host 语言在连接/语言切换时重发；menu button 仍由连接流程设置（`setChatMenuButton` 不进刷新路径）。
- 幂等：已连接时重复 `start()` 不重复发；语言切换时 `refreshCommandMenu()` 重发 3 个调用。

**不改权限**：菜单只是展示层。`history/batch/send/cancel` 的私聊限制仍在 handler（F7），群聊把菜单项藏掉不改变任何判定。

### 3.2 `/status` 文本

新增 `src/channels/shared/status-command.mjs`（`runStatusCommand`），`text-harness-bridge.mjs:1114-1123` 的 `/status` 分支改为调用它。格式（中文实测见 `_notes/tg-menu/status-sample.txt`）：

```
Telegram机器人与 DeepSeek Harness 连接正常。
工作区：/home/wings/Code_Project/dsh-im
绑定会话：abcdef12-345…
当前模型：deepseek-official/deepseek-v4-pro
Agent Preset（预设）：跟随 Host 默认
运行中任务：有（发送 /stop 可停止）      ← 仅在该会话确实在跑时出现
```

- 连接状态 = 第一行（沿用原句，失败仍走原错误路径）；`ensureRunning` 成功后才继续读其余字段。
- 工作区：优先 `currentConversationWorkspace(key)`（对话专属覆盖或 bot 默认），没有再退回 `currentWorkspace()`。
- 绑定会话：`state.sessionFor(key)`；长 ID 截前 12 位 + `…`，未绑定写清「发送消息后自动创建」。
- 当前模型：绑定会话的 `session.models().current`，格式 `provider/model`；未绑定时给占位说明而不是空行。
- Agent Preset（预设）：`harness.agentPresetSettings()`；显式值显示 `label（id）`，未设置显示「跟随 Host 默认」（与 `/preset` 文案一致）。标签同时写中文产品词与英文名，保证中英文都能读懂。
- 运行中任务：绑定会话的 `session.isRunning()` 为真才出现；`/stop` 能否停止仍由各卡片的 actor 判定，文案只做提示。
- 降级策略：除连接检查外每个字段独立 `try/catch`，读不到就省略该行；一条 `/status` 最多一次 `ensureRunning` + 一次预设读取 + 一次会话模型读取 + 一次运行状态读取，且后三者并行。可选读取使用**3 秒上限**的 `AbortSignal`（`STATUS_FIELD_TIMEOUT_MS`），Host 卡住时 `/status` 仍按「连接 + 工作区 + 绑定会话」降级返回，不会跟着卡 30 秒。
- 影响面：`TextHarnessBridge` 被 telegram/slack/discord/whatsapp/matrix/imessage/email 七个文字渠道共用，所以这些渠道的 `/status` 一起变好；缺少 workspace/preset/session API 的渠道（iMessage/Email 这类最小 harness）会自动降级成「连接 + 绑定会话 + 模型占位」三行，有专门测试。飞书/钉钉/企微/QQ 有自己的 `/status` 实现，本轮未动。

## 4. 不变量（闸门 4）

| # | 不变量 | 类别 | 证据 |
| --- | --- | --- | --- |
| I1 | 除 `/status` 外所有命令的文字回执字节级不变 | 测试 | `/help` 由 `test/channels/shared/command-help.test.mjs` 对 `fixtures/command-help.json`（zh/en）逐字节断言，全绿；其余回执由全量 `npm test` 覆盖 |
| I2 | 8 个别名仍可输入 | 测试 | `command-menu.test.mjs`：每个别名 `isWorkspaceCommand/isModelCommand/isPresetCommand` 为真 |
| I3 | 菜单展示差异不影响权限判定 | 测试 + 人工核对 | 群聊菜单去掉 4 条命令；handler 判定未改（F7、`command-menu-sync` 只断言 API payload）；`npm test` 全绿 |
| I4 | `callback_data` 仍 ≤64B | 测试 | `command-menu.test.mjs` 的 TelegramApi 用例 + `validateTelegramCommands` 边界用例；本轮未新增任何 callback 数据 |
| I5 | 私聊/群聊菜单 id 列表顺序稳定、可复现 | 测试 | `command-menu-scopes.test.mjs` 钉死两份列表 |
| I6 | 默认 scope 的旧菜单不会被重新写入 | 测试 | `command-menu-sync.test.mjs` 断言每次同步最后一步是 `deleteMyCommands({})`，且空目录三个 scope 都删 |
| I7 | scoped 写失败时不清 default scope，旧菜单继续可用 | 测试 | `command-menu-sync.test.mjs` 用例「a failing scoped write keeps the legacy default menu…」：第二次 `setMyCommands` 打桩失败后 delete 调用数为 0、bot 仍 ready、`/help` 仍可用 |

## 5. 明确不做（本轮）

1. **进度消息节流 / 流式发送预算**：上游 `#423`（per-chat send budget）、`#425`（thinking frame 节奏）、`#426`（占位符编号）OPEN，`#412`（最终答案独立消息）已 MERGED；与本轮不改同一片代码，等上游落地后协调（F10）。
2. **审批按钮卡**：另一并行队友（`feat/tg-approval-card`）负责；本轮不碰 `harness-approval.mjs`、审批 render 回调。
3. **`/stop` 按钮**：依赖进度消息 id 管理与批次 1 的 action-card 地基，且与上游流式改动同区域，推迟。
4. 卡片化（`/menu` hub、`/status` 卡、`/help` 分区卡、选择卡）属于路线图批次 1–3，不在批次 0。
5. `/watch*`、`/archived`、`/permission*` 等能力补齐不在本轮（B17，需要跨渠道存储/新命令）。

## 6. 验证与证据（闸门 5）

- 验红：首轮修复前 4 个测试文件 `tests 23 / pass 8 / fail 15`，另有 2 个文件因新导出不存在在 import 阶段失败；失败原文（测试名 + 断言行）在 `_notes/tg-menu/evidence.md`「闸门3 验红」与 `red.log`。独立评审修复轮的验红（旧顺序、旧验收脚本、/status 无短超时）在 evidence.md「验红：评审修复轮」与 `red-review.log`。
- 验绿：评审修复后菜单/status/验收脚本自检/help/i18n 合计 **65/65**；`telegram.test.mjs` 44/44；全量 4430/4430（记录在 evidence.md「独立评审修复轮」节）。
- 全量：首轮 `npm test` 4422/4422；评审修复轮 **4430 tests / 4430 pass / 0 fail / 0 cancelled**，用时约 185s；完整日志 `_notes/tg-menu/full-test.log` 与 `full-test-review-fix.log`。`npm run build`、`node scripts/verify-package.mjs`、`node scripts/verify-interface-language.mjs --check-scopes` 均成功。
- 可复现：菜单计数、/status 样张、probe 离线输出都存在 `_notes/tg-menu/`（`evidence.md`、`red.log`、`full-test.log`、`status-sample.txt`、`probe-offline.txt`）。
- 构建说明：worktree 的 `node_modules` 是指向主检出的软链，esbuild 会把 `lib/client.js` 的依赖注释路径解析成真实路径；已归一化回 `node_modules/...`（client 无代码改动，`git diff lib/client.js` 为空）。`lib/index.js` 为正常压缩产物。
- 真机：`probe-telegram-limits.mjs --live` 的数值（含只读 `getMyCommands` 三 scope 条目数）与 Telegram 客户端菜单截图由 Lead 在 E2E 阶段回填本节；路线图状态由 Lead 统一更新。

## 7. 风险、回滚与合并注意

| 风险 | 应对 |
| --- | --- |
| 与 `feat/tg-workspace-picker`（8ebef5c）在 `command-catalog.mjs` 上冲突：那边已把 `ws` 隐藏、`workspacelist` 整条隐藏，并把 `/workspace` 合并成列表+切换 | 合并后预期：主名 22 条（`workspace` 保留、`workspacelist` 隐藏）、群聊 18 条；冲突时保留本分支的 8 个别名 `menuVisible:false` + 那边的 workspace 文案/隐藏。不要用任一整边覆盖 |
| Telegram 客户端菜单缓存，真机上可能延迟显示新列表 | 注册成功即 API 接受；验收时以 `getMyCommands(scope)` 或客户端刷新（重进聊天）为准，probe/文档已注明「客户端缓存」 |
| 多一次/两次 API 调用（每次同步 3 个调用） | 只在连接与语言切换时发生；失败已隔离不影响 ready，测试覆盖 |
| `/status` 在 5 个共享文字渠道同时变长 | 一条消息 5–6 行、字段独立降级；如需只改 Telegram，应加 descriptor 开关（本轮未加，见 §8 决策点） |
| 探测脚本误用生产 bot | 必须显式 `--live` + 环境变量；token 不打印、临时消息清理；不调用 `setMyCommands/deleteMyCommands` |

回滚：实现是独立提交，`git revert` 即可；菜单注册失败已有降级路径，不会阻塞 bot。

## 8. 需要拍板 / 已知取舍

1. **`/status` 的渠道范围**：实现放在共享 `TextHarnessBridge`，所以 telegram/slack/discord/whatsapp/matrix 五个文字渠道一起生效（飞书等用自己的实现，不变）。如果只想 Telegram 生效，需要加 descriptor 级开关——默认按「共享层一起变好」处理。
2. **菜单是否再隐藏 `workspacelist`**：main 基线上 `/workspace` 只切换、`/workspacelist` 才列列表，两者不重复；规划分支已把两者合并后隐藏 `workspacelist`。本分支只隐藏别名，`workspacelist` 保留在菜单；合并规划分支后自然变成 22 主名。
3. **`/status` 里是否显示会话标题**：当前只显示短 ID（省一次列表 RPC，保证一条消息轻量）；如需要「标题 + 短 ID」，批次 1 的 status 卡再做（路线图 P1-8）。

## 9. 独立评审修复（第二轮，blocking）

| # | 评审问题 | 修法 | 验证 |
| --- | --- | --- | --- |
| 1 | `scripts/verify-interface-language.mjs` 仍用无 scope 的 `getMyCommands` 等待菜单 → 新实现清了 default scope 后必然 15s 超时；finally 还会把旧默认菜单写回 default | 抽出 `scripts/telegram-menu-scopes.mjs`：保存/轮询/恢复 **三个 scope**（default/private/group）；等待读 `all_private_chats`，并断言 default 为空、群聊菜单不含 4 条私聊命令；恢复时 scoped 先、default 最后。新增 `--check-scopes` 离线自检（不需要 Harness/token）。 | `test/telegram-menu-scopes.test.mjs` 6 项全绿 + `node scripts/verify-interface-language.mjs --check-scopes` 通过；静态断言禁止验收脚本再出现「只等默认 scope」的写法 |
| 2 | 同步顺序「先删 default 再写 scope」，scoped 写失败只 warn → 菜单整片消失到下次重连 | 改为**先写 private+group，最后删 default**；scoped 任一步失败即中止，default 旧菜单原样保留 | `command-menu-sync.test.mjs` 新增「a failing scoped write keeps the legacy default menu…」（第二次 setMyCommands 打桩失败，断言 delete 次数 0、bot ready、`/help` 仍回复）；既有顺序断言全部更新 |
| 3（非阻塞，已做） | `/status` 的 models RPC 30s 超时，Host 卡住时跟着卡 | 可选字段读取加 `STATUS_FIELD_TIMEOUT_MS = 3000` 的 `AbortSignal`，超时按字段降级 | `status-command.test.mjs` 新增「a stuck Host cannot hold /status open…」（20ms 上限 + 永不返回的假 RPC，断言连接行仍到达） |
| 4（非阻塞，已做） | iMessage/Email 也继承 TextHarnessBridge | 明确影响面为 7 个文字渠道，并加最小 harness 渠道测试 | `status-command.test.mjs` 新增「text channels without workspace or preset APIs (iMessage/Email) still answer /status」 |
| 5（非阻塞，已做） | probe 的「工作区卡上限 20」只在 /ws 分支存在 | 改写为「只存在于 /ws 分支；合并后成立」，与 main 基线一致 | `node scripts/probe-telegram-limits.mjs` 离线输出核对 |

## 9. 复现清单

```bash
cd /home/wings/Code_Project/_worktrees/dsh-im/menu
node --test test/channels/telegram/command-menu.test.mjs \
  test/channels/telegram/command-menu-scopes.test.mjs \
  test/channels/telegram/command-menu-sync.test.mjs \
  test/channels/shared/status-command.test.mjs
node --test test/channels/shared/command-help.test.mjs test/channels/shared/i18n.test.mjs
npm run build
node scripts/probe-telegram-limits.mjs            # 离线，零网络
# 真机（Lead E2E）：
# TELEGRAM_PROBE_TOKEN=<探测 bot token> TELEGRAM_PROBE_CHAT_ID=<测试 chat id> \
#   node scripts/probe-telegram-limits.mjs --live --json
```
