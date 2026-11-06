# Telegram 工作区切换卡片与 `/ws` 命令合并方案

状态：**实施完成，待真实 Telegram 重启验收**。基线：`27bd7a2`（2026-10-21，上游 main）。
实施分支：`feat/tg-workspace-picker`（首个提交 `f2408c0`）。整理/实施日期：2026-10-21～22。

目标：把 Telegram 的 `/ws` 与 `/wsl` 合并成一条命令——不带参数时发一张**可点击的工作区切换卡片**，
点按钮即切换、原地更新当前项；带参数时保持原来的直接切换。其他文本渠道在能力不足时**明确降级**为现有文字列表。

---

## 闸门 1：事实核对

每条断言都附可复现命令与实测输出（cwd = 仓库根）。

| # | 断言 | 命令 | 实测输出 |
| --- | --- | --- | --- |
| F1 | 当前 `/ws`、`/workspace` 不带参数只返回用法，不列工作区 | `node --input-type=module -e "import {runWorkspaceCommand} from './src/channels/shared/workspace-command.mjs'; console.log((await runWorkspaceCommand('/ws',{currentWorkspace:()=>'/tmp',async listWorkspaces(){return []}})).message)"` | `用法：/workspace 工作区序号或绝对路径` |
| F2 | 当前 `/wsl`、`/workspacelist` 不带参数返回纯文字列表（含「切换用法」提示） | 同上把命令换成 `/wsl` | `当前 Harness Host 上存在的工作区（2）：…切换用法：/workspace 工作区序号或绝对路径…` |
| F3 | Telegram 原生命令菜单同时暴露 `workspace` 与 `workspacelist`，共 23 项 | `node --input-type=module -e "import {SHARED_COMMAND_CATALOG} from './src/channels/shared/command-catalog.mjs'; import {commandsForChannel} from './src/channels/shared/command-catalog.mjs'; console.log(commandsForChannel('telegram').map(c=>c.name).join(','))"` | `new,compact,clear,history,workspace,conv,workspacelist,sessionlist,session,models,reasoninglist,reasoning,model,presetlist,preset,stop,steer,batch,send,cancel,status,version,help` |
| F4 | 菜单项按 `menuVisible !== false` 过滤，因此 `menuVisible:false` 可把 `workspacelist` 从原生菜单隐藏而保留命令 | 见 `src/channels/telegram/telegram-runtime.mjs:23-33`（`commandMenuEntries` 的 `.filter((item) => item.menuVisible !== false)`） | 读码确认 |
| F5 | Telegram 已有内联键盘基础设施：`sendInteractionCard` / `updateInteractionCard`（`editMessageReplyMarkup`）/ `answerInteractionCallback`（`answerCallbackQuery`），提问卡已用 `q|nonce|qIndex|optIndex` 回调 | `grep -n "sendInteractionCard\|updateInteractionCard\|answerInteractionCallback" src/channels/telegram/telegram-runtime.mjs src/channels/shared/text-harness-bridge.mjs` | `telegram-runtime.mjs:608/626/635`、`text-harness-bridge.mjs:1984/2005/1763` |
| F6 | 飞书已有「工作区列表卡 + 按钮切换」实现，按钮回调 `workspace:<绝对路径>` | `grep -n "workspaceListCard\|action.startsWith('workspace:')" src/channels/feishu/feishu-cards.mjs src/channels/feishu/bridge.mjs` | `feishu-cards.mjs:783`、`bridge.mjs:2942` |
| F7 | 工作区显示名规则（title 优先、重名补路径、超长省略）已存在于飞书卡片：`workspaceLabels()` | `sed -n '80,150p' src/channels/feishu/feishu-cards.mjs` | 函数 `workspaceLabels(paths, titles)`，上限 22 码点 |
| F8 | 工作区快照支持同时取回路径与 title：`workspacePathSnapshot(harness,{includeTitles:true})` | `sed -n '108,134p' src/channels/shared/workspace-command.mjs` | `listWorkspaceEntries` 存在时带 `titles` |
| F9 | Telegram `callback_data` 上限 64 字节，绝对路径不可直接塞进按钮 | Telegram Bot API `InlineKeyboardButton.callback_data` 说明（https://core.telegram.org/bots/api#inlinekeyboardbutton） | 官方文档；现有提问卡注释 `telegram-bridge.mjs:15-22` 也写明预算 |
| F10 | 每条中文 `t()` 字面量必须有英文词条，否则 `i18n.test.mjs` 变红 | `grep -n "every literal t() key" test/channels/shared/i18n.test.mjs` | 测试名「every literal t() key in src/channels has an English dictionary entry」 |
| F11 | 卡片点击回调统一进 `acceptCallback`，目前只处理提问卡 pending 状态；新回调命名空间可在此前置分流 | `sed -n '1795,1868p' src/channels/shared/text-harness-bridge.mjs` | `acceptCallback` 先校验消息元数据，再进 `#pendingInteractions` |
| F12 | 文本命令路径无参数时只调用 `runWorkspaceCommand` 后逐条 `sendText`，卡片能力需在同处分流 | `sed -n '1116,1126p' src/channels/shared/text-harness-bridge.mjs` | `for (const reply of workspaceCommand.messages ?? [workspaceCommand.message]) sendText` |
| F13 | 渠道构造器已按 `interactionCard` 模式注入渠道专属呈现适配器 | `sed -n '231,253p' src/channels/shared/text-harness-bridge.mjs`、`src/channels/telegram/telegram-bridge.mjs:96-106` | `interactionCard = null` 参数 + `TelegramHarnessBridge` 传入 `TELEGRAM_INTERACTION_CARD` |
| F14 | 命令权限由 `evaluateAccessPolicy(... isCommand:true)` 判定，文本入口在 `accept()` 已执行；回调入口尚无该闸门 | `sed -n '300,330p' src/channels/shared/text-harness-bridge.mjs`、`src/channels/shared/access-policy.mjs:192-208` | 回调路径需补 `isCommand:true` 校验（本方案新增） |

## 闸门 2：验收标准

判定列的命令为空即该条不成立。全部命令在仓库根执行。

| # | 标准 | 判定命令 | 期望输出 |
| --- | --- | --- | --- |
| A1 | `/ws` 无参数在 Telegram 发出一张内联键盘卡片，而不是文字列表 | `node --test test/channels/telegram/workspace-card.test.mjs`（用例 `text /ws sends one inline-keyboard card`） | 通过；`cards.length === 1`，`inline_keyboard` 行数 = 工作区数 |
| A2 | `/workspace`、`/wsl`、`/workspaces`、`/workspacelist` 无参数都打到同一张卡片逻辑 | 同上（用例 `every listing alias sends the same card`） | 通过；四次调用的按钮 `callback_data` 前缀均为 `w|` |
| A3 | 按钮回调数据 ≤64 字节且能解析出 nonce+序号 | 同上（用例 `callback payload fits the 64-byte budget`） | 每个 `callback_data` UTF-8 字节数 ≤ 64 |
| A4 | 点击按钮切换到对应工作区，并原地更新当前项标记 | 同上（用例 `a press switches the workspace and re-marks the pressed card`） | `harness.switchWorkspace` 收到该路径；`updateInteractionCard` 被调用且新 keyboard 中该按钮带 `✓` |
| A5 | 点击后面向用户的 toast 为「工作区已切换为：…」 | 同上 | `notices` 最后一条匹配 |
| A6 | 重复点击/在切换进行中再点时只切一次，并提示稍候 | 同上（用例 `a second press while switching does not switch twice`） | `switchWorkspace` 调用 1 次；toast 提示稍候 |
| A7 | 过期/伪造 nonce 不切换、不报错，回一条过期提示 | 同上（用例 `a stale card cannot switch anything`） | `switchWorkspace` 0 次；toast 匹配「已过期」 |
| A8 | 别的对话的卡片按不动 | 同上（用例 `a card from another conversation is rejected`） | `switchWorkspace` 0 次 |
| A9 | 无命令权限的用户点击不切换，回权限提示 | 同上（用例 `a press without command permission switches nothing`） | 0 次切换；toast 为现有权限拒绝文案 |
| A10 | 卡片发送失败时降级为原来的文字列表（不丢信息） | 同上（用例 `card delivery failure falls back to the text list`） | `sent` 含「当前 Harness Host 上存在的工作区」；不抛错 |
| A11 | 工作区超过按钮上限时降级为文字列表 | 同上（用例 `too many workspaces falls back to text`） | 无卡片；`sent` 为文字列表 |
| A12 | `/ws 2` 与 `/ws <绝对路径>` 行为不变（直接切换 + 文字回执） | `node --test test/workspace.test.mjs` | 通过 |
| A13 | 共享列出命令返回 `listing` 供渠道渲染，文字输出不变 | `node --test test/workspace.test.mjs`（新增用例） | 通过 |
| A14 | Telegram 原生菜单只剩一个工作区入口，`/wsl` 等仍可用 | `node --test test/channels/telegram/command-menu.test.mjs` | 菜单含 `workspace`，不含 `workspacelist`/`workspaces`/`wsl` |
| A15 | 飞书命令面板同步收敛：面板不再列出三个别名 | `node --test test/channels/feishu/slash-command-registry.test.mjs` | 通过 |
| A16 | 飞书 `/ws` 无参数也打开工作区卡（与 `/wsl` 一致） | `node --test test/channels/feishu/bridge.test.mjs` | 通过（新增用例） |
| A17 | 英文界面下新增文案全部有词条 | `node --test test/channels/shared/i18n.test.mjs` | 通过 |
| A18 | 全量检查（构建 + 全测试 + 打包校验）绿 | `npm run check` | exit 0 |
| A19 | 干净环境复现：删 `node_modules`/`lib` 后 `npm ci && npm run check` 绿 | 见「验证记录」 | 待填 |
| A20 | 真实 Telegram 机器人收到卡片并可点击切换（手工/脚本） | 见「验证记录」 | 待填 |
| A21 | 同一对话发第二张卡时，旧卡键盘被立即收起（旧 ✓ 不会再被按） | `node --test test/channels/telegram/workspace-card.test.mjs`（用例 `a newer picker retires the previous card in the same conversation`） | 通过；首卡 `editMessageReplyMarkup` 收到空键盘 |
| A22 | 点击「当前工作区」是幂等回执，不调用切换 | 同上（用例 `pressing the workspace that is already current is an idempotent receipt`） | `switchWorkspace` 0 次；toast 含「已经在工作区」 |
| A23 | 卡片路径与文字命令的切换失败文案出自同一 helper | 同上（用例 `a switch failure reuses the typed command failure text`） | toast 与 `workspaceSwitchFailureText(error)` 完全相等 |
| A24 | 可识别的过期卡在 toast 之外就地清掉键盘 | 同上（过期分支断言 `updateInteractionCard` 空键盘） | 通过 |

**已知不做**：

- 不做 `/conv`（对话专属工作区）的卡片化，仍为文字命令。
- 不做卡片分页；超过 20 个工作区降级为文字列表（手机端按钮扫描成本高于翻页价值）。
- 不改其他渠道（QQ/企微/微信/Slack/Discord/WhatsApp/Matrix）的呈现：它们拿到的仍是同一份文字列表，只是 `/ws` 无参数从「用法」变成「列表」，属于纯增益。
- 不向上游 `xmanrui/dsh-im` 发 PR（等用户确认）。

## 闸门 4：不变量（必须保持不变）

| # | 不变量 | 守护方式 |
| --- | --- | --- |
| I1 | `/ws N`、`/ws <绝对路径>`、`/conv`、`/sessionlist`、`/session` 的行为与文案不变 | `test/workspace.test.mjs`、`test/conversation-*-workspace*.test.mjs` 回归 |
| I2 | 文字列表内容（数量、顺序、当前标记、切换提示）字节级不变 | `test/workspace.test.mjs` 现有断言 |
| I3 | 不支持卡片的渠道仍按原顺序收到同一组文字消息 | `test/workspace.test.mjs` + bridge 降级用例 |
| I4 | 提问卡回调（`q|…`）不被新命名空间影响 | `test/channels/telegram/interaction-card.test.mjs` 回归 |
| I5 | 卡片回调数据 ≤64 字节 | A3 用例 |
| I6 | 命令权限语义不变，回调路径与文本路径同一判定函数 | A9 用例 + 代码审查 |
| I7 | 中文/英文界面无新增未翻译字面量 | A17 |

## 方案

### 命令语义合并

| 输入 | 现在 | 之后 |
| --- | --- | --- |
| `/ws` / `/workspace` | 只回用法 | 发可点击卡片；无卡片渠道回文字列表 |
| `/ws 2` / `/ws /abs/path` | 直接切换 + 文字回执 | 不变 |
| `/wsl` / `/workspaces` / `/workspacelist` | 文字列表 | 与 `/ws` 相同的卡片；仍是别名、仍可用 |
| Telegram 菜单 | `workspace` + `workspacelist` 两项 | 只留 `workspace`（`/ws` 别名仍可输入） |
| 飞书面板 | 同时列 `workspace`、`workspacelist`、`workspaces`、`wsl` | 去掉后三项 |

### 数据流

```text
用户输入 /ws
  └─ TextHarnessBridge #process
       └─ runWorkspaceCommand(text, harness, conversationKey)
            ├─ 无参数 → { handled, message, messages, listing:{current, paths, titles} }
            └─ 有参数 → 切换（不变）
       ├─ listing 且渠道有 workspaceCard 适配器 → 生成 nonce，缓存 listing
       │    → bot.sendInteractionCard(target, adapter.render(listing, {nonce}))
       └─ 失败/无适配器 → 逐条 sendText（原路径）

用户点按钮
  └─ Telegram callback_query → acceptCallback(callback)
       ├─ adapter.parse(data) → { nonce, index }
       ├─ 命令权限闸门 evaluateAccessPolicy(..., isCommand:true)
       ├─ 查 nonce 缓存；校验对话 key、序号、是否切换中
       ├─ harness.switchWorkspace(paths[index])
       └─ bot.updateInteractionCard(pressedMessage, adapter.render(updated))
          + bot.answerInteractionCallback(callbackQueryId, '工作区已切换为：…')
```

### 接口契约

1. `workspace-command.mjs`
   - `commandResult(message, messages, extra = {})` → 允许附加 `listing`。
   - 工作区列表（无参数）返回 `listing: { current, paths, titles }`；`titles` 来自
     `workspacePathSnapshot(harness, { includeTitles: true })`，取不到时为 `{}`。
   - 有参数与其它会话命令的返回结构不变。
2. `text-harness-bridge.mjs`
   - 构造参数新增 `workspaceCard = null`（渠道适配器，形状：`{ render(listing,{nonce}), parse(data) }`）。
   - 新增私有状态 `#workspaceCards: Map<nonce,{listing,key,target,createdAt,submitting}>`，
     容量 50、TTL 1 小时，插入时惰性清理。
   - `acceptCallback` 在进入提问卡 pending 逻辑**之前**分流行 workspace 回调；布局见数据流。
3. `telegram-bridge.mjs`
   - 导出 `TELEGRAM_WORKSPACE_CARD` 与 `parseTelegramWorkspaceCallback(data)`。
   - 回调载荷：`w|<nonce>|<index>`，nonce 为 12 字符 base64url；按钮上限 20。
4. `shared/workspace-labels.mjs`
   - 从 `feishu-cards.mjs` 提取 `workspaceLabels()`，飞书与 Telegram 共用同一套显示名规则（title 优先、重名补父目录、22 码点省略）。

### 明确降级

| 场景 | 行为 |
| --- | --- |
| 渠道 bot 没有 `sendInteractionCard` | 原文字列表（与现在一致） |
| 卡片发送抛错 | 记录警告后回退文字列表；不重试卡片 |
| 工作区数 > 20 | 直接文字列表 + 「用 /ws 序号切换」提示 |
| 卡片 nonce 过期/未知 | toast「这个列表已过期，请重新发送 /ws。」，不切换 |
| 切换进行中再次点击 | toast「正在切换工作区，请稍候。」，不重复切换 |
| 切换失败 | toast「暂时无法切换工作区，请稍后重试。」，卡片保持原样（可再点） |

### 闸门 3 补充：上游调研与采纳

上游调研见 [docs/research/tg-ux-upstream-brief.md](../research/tg-ux-upstream-brief.md)（openclaw / hermes-agent / Memoh 三仓，144 条 file:line 引用）。
本轮采纳：

| 建议 | 本方案落点 |
| --- | --- |
| R2 卡片与文字命令共用切换/错误 helper | `workspaceSwitchFailureText()`，文字路径与卡片路径共用（A23） |
| R3 过期卡清键盘而非只 toast | 已知 nonce 过期时 `updateInteractionCard(空键盘)` + toast（A24） |
| R4 同对话只留一张活跃卡 | `#workspaceCardKeys` + 发送即收起上一张（A21） |
| R5 回调命名空间版本化 | `w1|<nonce>|<index>` |
| R8 幂等以实时 current 为准 | 点击前读 `harness.currentWorkspace()`（A22） |

未采纳及原因：

- R1「press 时按实时列表重判 index」：本方案的按钮身份是**发送时快照里的路径**，不是「实时列表的第 N 个」，
  重排不会错切；工作区被删除时由 `switchWorkspace` 的失败分支兜底（A23 同一文案）。
- R7「成功回执标注本对话生效」：`/workspace` 切换的是 **bot 级默认工作区**，会影响该机器人的其他对话，
  标注「本对话生效」反而误导。
- R9 分页：见「已知不做」——超过 20 个工作区降级文字列表。

## 测试计划（先红后绿）

1. 新增 `test/channels/telegram/workspace-card.test.mjs`：A1–A11、A21–A24。
2. 扩展 `test/workspace.test.mjs`：A12、A13。
3. 更新 `test/channels/telegram/command-menu.test.mjs`、`test/channels/feishu/slash-command-registry.test.mjs`：A14、A15。
4. 扩展 `test/channels/feishu/bridge.test.mjs`：A16。
5. 新增中文文案的英文词条：A17。
6. `npm run check`：A18。

验红留痕：先提交/运行上述新用例，记录失败输出（含测试名与断言行），再实施。

## 验证记录

> 全部证据文件在 `/home/wings/Code_Project/_notes/`（本机工作日志，不进仓库）。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 验红（实现前跑新测试） | ✅ | 新测试首次运行即红：`SyntaxError: The requested module '../../../src/channels/telegram/telegram-bridge.mjs' does not provide an export named 'TELEGRAM_WORKSPACE_CARD'`（13 个新用例全部无法执行） |
| 变异验证（故意弄坏一处，证明测试会红） | ✅ 3/3 | 见 `_notes/mutation-evidence.log`：M1 去掉当前项 ✓ → `current workspace is marked / actual: '1. wings'`；M2 删掉双击守卫 → `only the first press switches / actual: 2`；M3 把 workspacelist 放回菜单 → 菜单深比较失败 |
| `npm run check`（构建 + 4421 测试 + 打包校验） | ✅ | `_notes/check-2.log`：`ℹ tests 4421 / pass 4421 / fail 0`、`EXIT_0` |
| GitHub Actions（Node 24 ubuntu + Windows 回归） | ✅ | fork PR #1 的验证分支 run `39627534098`：两个 job 全 success（`Test, build, and verify package`、`Workspace and QR regression tests (Windows)`） |
| 干净环境（删 `node_modules`/`lib` 后 `npm ci && npm run check`） | ✅ | 在临时副本（无 `node_modules`/`lib`/`.git`）重装依赖后跑完整 check：`ℹ tests 4421 / pass 4421 / fail 0`、`EXIT_0`、`Verified dsh-im package artifacts.`（`_notes/clean-check.log`） |
| 宿主加载（隔离 `DSH_HOME` 启动真实 dsh web） | ✅ | `_notes/host-e2e.sh`：把 profile 里的 `@xmanrui/dsh-im` 指向本地仓库后，`dsh web` 在 5011 端口正常启动（`HOST_E2E_OK`）；再给 `lib/index.js` 临时追加启动打点重跑，日志出现 `[dsh-im-local-marker] loaded from local working tree`，且无 boot error → 真实 Host 加载的确实是本地构建。打点已还原（`sha256` 与提交一致） |
| 真实 Telegram 机器人收到卡片并可点击切换 | ✅ | 2026-10-22 在 `wings-gpd`（KDE Wayland + Telegram Desktop 7.3.1）+ 独立 `DSH_HOME` 实例 + 临时测试 bot 上真机验证：单工作区卡、多工作区卡点击原地切换、切换后 `/status` 反映新路径（测试 bot 验证后已删除） |

### 真机验证（2026-10-22）

环境：`wings-gpd`（CachyOS / KDE Plasma 6.8 Wayland）+ Telegram Desktop 7.3.1 flatpak；
独立 `DSH_HOME` 的 `dsh web` 实例 + 临时测试 bot（验证后删除），用 computer-use-linux 驱动真实点击。

| 用例 | 结果 |
| --- | --- |
| 单工作区 `/ws` | 卡片「选择要切换的工作区（共 1 个）：」+「✓ 1. im」按钮 ✅ |
| 多工作区 `/ws` | 3 个工作区 3 行按钮；点「2. dsh-im」后卡片原地把 ✓ 移到第 2 项 ✅ |
| 切换真实生效 | 随后 `/status` 显示「工作区：/home/wings/Code_Project/dsh-im」✅ |
| 旧卡键盘 | 同对话发新卡后旧卡 nonce 失效（进程重启前的内存态）；进程重启后旧卡键盘不再收（本实现为内存态 nonce 存储的已知限制，与文字路径一致） |
