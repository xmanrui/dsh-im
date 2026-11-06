# Telegram 审批按钮卡方案（批次1）

状态：**已实施 + 独立评审问题已修复（待集成）** ｜ 分支：`feat/tg-approval-card` ｜ 基于：`main` = 上游 `27bd7a2`
提交：`5f5c07a`（功能）→ `ff6466e`（评审修复）→ `243306d`（i18n 去重）→ 本方案文档
日期：2026-10-22（评审修复同日）｜ 对应路线图批次 1（按 Lead 协调，路线图/调研文档不在本分支引入，状态由 Lead 集成时统一更新）

交付三件事：

1. `src/channels/shared/action-card.mjs` —— 通用「一对话一活动卡」地基（nonce 仓库 + 首按认领 + 陈旧复核 + 统一终态文案 + ≤64B 回调命名空间）；
2. `telegram-api.editMessageText` 透传 `reply_markup`（一次调用同改正文+键盘）；
3. Telegram 审批按钮卡：`[✅ 批准一次] [❌ 拒绝]`，点击先 ack、actor 校验、幂等、原地终态、过期收键盘，**卡片失败/无卡能力时保留今天的纯文字「批准 / 拒绝」路径**。

---

## 0. 一页结论

| 结论 | 依据 |
| --- | --- |
| 审批从「手打批准/拒绝」变成「点按钮」，且原消息原地变终态、键盘清空 | 本文 §3、§5；`test/channels/telegram/approval-card.test.mjs` 14 条全绿 |
| 只有发起审批的用户能操作；陌生人点击只收 toast，不会消耗发起人的按钮 | 测试 `a press by someone else only receives a toast ...` |
| 重复/并发点击只提交一次；已处理/过期卡再点只 toast + 清死键盘 | 测试 `two presses of one card...`、`a press on a resolved card...`、`an approval timeout...` |
| 卡片发送失败、编辑失败、无键盘能力渠道：**全部保留文字审批**，文字提示字节级不变 | 测试 `a refused card send falls back to the byte-identical text approval`、`a channel without keyboard support...`、`a failed card edit still delivers the terminal text receipt` |
| `editMessageText` 现在可一次改正文+键盘；`callback_data ≤64B` 仍在 API 层强制 | `telegram-api.mjs:394-412`；本文 §1 事实核对 F4/F6 |
| 未动飞书/QQ/企微既有实现，也未动流式/发送预算区域 | `git diff --stat` 仅 5 个生产文件 + 2 个新文件（同类目 channels 之外的共享桥只加可选钩子，默认 null） |

---

## 1. 事实核对（闸门 1）

> 规则：每条关于框架/宿主/Telegram 行为的断言都有可复现命令 + 实测输出。日期 2026-10-22，Bot API 版本以官方页 `Recent changes` 为准（当前 **10.3，2026-08-24**）。
>
> **可信度分级**：`[官方文档]` = 已抓取官方 Bot API 页面核对；`[本地实测]` = 本仓代码/单测可复现；
> `[真机待验证]` = 官方文档如此声明，但本任务禁止调用生产 Telegram bot，需 Lead 在 E2E 阶段真机复核。
> 凡标 `[真机待验证]` 的断言**不要**在集成验收里当成已验证。

### F1 `editMessageText` 支持 `reply_markup`（F5/路线图） `[官方文档][真机已验证]`

```bash
curl -s https://core.telegram.org/bots/api > /tmp/tg-bot-api.html
python3 - <<'PY'
import re
html=open('/tmp/tg-bot-api.html',encoding='utf-8').read()
sec=re.search(r'<h4><a class="anchor" name="editmessagetext".*?(?=<h4>)', html, re.S).group(0)
print(re.findall(r'<td>([a-z_]+)</td>', sec))
PY
```

实测输出：

```
['business_connection_id', 'chat_id', 'message_id', 'inline_message_id', 'text',
 'parse_mode', 'entities', 'link_preview_options', 'rich_message', 'reply_markup']
```

结论：官方参数表为 `reply_markup | InlineKeyboardMarkup | Optional`，即一次调用可同改正文+键盘。**真机已验证**（2026-10-22，Telegram Desktop 7.3.1 / KDE Wayland / 独立测试 bot）：点按钮后卡片终态更新在一次调用里同时改正文与清键盘；`probe-telegram-limits.mjs --live` 也记录该组合被接受。

### F2 `callback_data` 预算为 1-64 字节 `[官方文档][本地实测][真机已验证]`

```bash
python3 - <<'PY'
import re
html=open('/tmp/tg-bot-api.html',encoding='utf-8').read()
i=html.find('callback_data')
print(re.sub(r'\s+',' ',re.sub(r'<[^>]+>',' ',html[i-100:i+700])))
PY
```

实测输出（节选）：

```
callback_data String Optional . Data to be sent in a callback query to the bot when
the button is pressed, 1-64 bytes
```

### F3 `answerCallbackQuery` 的职责：停止客户端进度条 `[官方文档][真机待验证]`

```bash
python3 - <<'PY'
import re
html=open('/tmp/tg-bot-api.html',encoding='utf-8').read()
sec=re.search(r'<h4><a class="anchor" name="answercallbackquery".*?(?=<h4>)', html, re.S).group(0)
print(re.sub(r'\s+',' ',re.sub(r'<[^>]+>',' ',sec))[:430])
PY
```

实测输出（节选）：

```
answerCallbackQuery Use this method to send answers to callback queries sent from
inline keyboards. The answer will be displayed to the user as a notification at the
top of the chat screen or as an alert.
```

这就是「点击必须先 ack」的依据（原文见官方 answerCallbackQuery 段落；不 ack 客户端一直转圈）。

### F4 本仓 `editMessageText` 原封装不透传 `reply_markup` `[本地实测]`

修复前 `src/channels/telegram/telegram-api.mjs`：`editMessageText` 的 payload 只有
`chat_id / message_id / text（或 rich_message）/ link_preview_options`（路线图 F4）。红灯证据：
`_notes/tg-approval/evidence.md` §C `editMessageText ... reply_markup` 的断言 diff。

修复后复现命令：

```bash
cd /home/wings/Code_Project/_worktrees/dsh-im/approval
node --input-type=module <<'EOF'
import { TelegramApi } from './src/channels/telegram/telegram-api.mjs';
import { telegramApprovalMarkup } from './src/channels/telegram/approval-card.mjs';
const calls=[];
const api=new TelegramApi({token:'123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456',
  fetchImpl: async (url, init) => { calls.push({method:url.pathname.split('/').at(-1), payload:JSON.parse(init.body)});
    return new Response(JSON.stringify({ok:true,result:{message_id:700}}),{status:200,headers:{'content-type':'application/json'}}); }});
const markup=telegramApprovalMarkup('abcd1234EFGH');
await api.editMessageText({chatId:42,messageId:700,text:'审批',replyMarkup:markup});
await api.editMessageText({chatId:42,messageId:700,text:'审批（已处理）'});
console.log(JSON.stringify(calls[0]));
console.log('plain has reply_markup:', 'reply_markup' in calls[1].payload);
EOF
```

实测输出：

```
{"method":"editMessageText","payload":{"chat_id":42,"message_id":700,"text":"审批","link_preview_options":{"is_disabled":true},"reply_markup":{"inline_keyboard":[[{"text":"✅ 批准一次","callback_data":"ap1|abcd1234EFGH|a"},{"text":"❌ 拒绝","callback_data":"ap1|abcd1234EFGH|d"}]]}}}
plain has reply_markup: false
```

### F5 64B 预算在 API 层强制（F6/路线图） `[本地实测]`

上一条同一命令继续：

```
oversized-callback-data: Telegram callback_data must be at most 64 bytes
```

（第 65 字节在 `#call` 之前抛 `TypeError`，见 `telegram-api.mjs:83-87` 与单测
`Telegram API refuses an oversized or malformed keyboard before dispatch`。）

### F6 富文本 + 按钮：路线图 F7 的平台前提已过时，本批次改为产品不变量 `[官方文档]`

路线图 F7 写「`sendRichMessage` 不支持 `reply_markup`」。当前官方（Bot API 10.3）
`sendRichMessage` 参数表**已包含** `reply_markup`：

```bash
python3 - <<'PY'
import re
html=open('/tmp/tg-bot-api.html',encoding='utf-8').read()
for name in ['sendrichmessage']:
    sec=re.search(rf'<h4><a class="anchor" name="{name}".*?(?=<h4>)', html, re.S).group(0)
    print(re.findall(r'<td>([a-z_]+)</td>', sec))
PY
```

实测输出：

```
['business_connection_id', 'chat_id', 'message_thread_id', 'direct_messages_topic_id',
 'ephemeral_message_parameters', 'rich_message', 'disable_notification', 'protect_content',
 'allow_paid_broadcast', 'message_effect_id', 'suggested_post_parameters',
 'reply_parameters', 'reply_markup']
```

结论：**平台本身已允许**富文本+按钮；但「富文本答案不带按钮」仍是本仓的产品不变量
（卡片统一走普通文本，避免答案与操作按钮混在一起）。因此 `telegram-api.editMessageText`
主动拒绝 `richMessage + replyMarkup` 组合（`telegram-api.mjs:399-405`），单测：

```
A rich Telegram answer never carries an inline keyboard; use regular text for cards
```

### F7 共享审批队列已有 `render` / `onResolved` 接缝 `[本地实测]`

```bash
grep -n "const render = typeof context?.render\|pending.render?.(pending, pending.send)\|onResolved?.(text, outcome)" \
  src/channels/shared/harness-approval.mjs
```

实测输出（修复后行号）：

```
343:    const render = typeof context?.render === 'function' ? context.render : null;
620:      await pending.onResolved?.(text, outcome);
```

`onResolved` 的第二个参数 `outcome` 是本批次新增（向后兼容；飞书只用第一个参数），
用于把卡片终态文案映射成「✅ 已批准（仅本次）/❌ 已拒绝/⏰ 已过期」。

### F8 文字审批提示字节（不变量基线） `[本地实测]`

```bash
node --input-type=module -e "
import {harnessApprovalText} from './src/channels/shared/harness-approval.mjs';
const p={type:'approval/requested',sessionId:'session-one',approvalId:'approval-secret-id',toolName:'bash',callId:'call-secret-id',reason:'测试 IM 审批链路'};
const t={callId:'call-secret-id',name:'bash',arguments:JSON.stringify({command:\"printf 'approval-test\\\\n'\"})};
console.log(JSON.stringify(harnessApprovalText(p,{toolCall:t,requiresMention:true})));
"
```

实测输出（与改动前逐字一致，测试里以字面量钉死）：

```
"DeepSeek Harness 需要你的审批：\n\n工具：bash\n操作参数：\n{\n  \"command\": \"printf 'approval-test\\\\n'\"\n}\n原因：测试 IM 审批链路\n\n请精准回复「批准」或「拒绝」（也支持：同意 / 不同意 / yes / no）。\n\n群聊中请 @机器人 后发送审批决定。"
```

### F9 「message is not modified」按成功处理 `[本地实测][真机待验证]`

Telegram 对「内容与键盘都没变」的编辑返回 HTTP 400 + `Bad Request: message is not modified...`。
官方方法页没有单列这个错误串，因此本项按 **单测 + 真实错误串** 核对：
`test/channels/telegram/approval-card.test.mjs` 的
`the card edit treats message is not modified as success` 用假 API 返回该 400 响应，
断言 `client.editInteractionCard()` 返回 `{ unchanged: true }` 而不是抛错。

> **真机待验证**：错误串来自 Telegram 平台行为，单测用假 API 复现；真机重复编辑行为由 Lead 在 E2E 阶段复核。

---

## 2. 验收标准（闸门 2）

判定命令统一在 worktree 根目录执行：

```bash
cd /home/wings/Code_Project/_worktrees/dsh-im/approval
node --test test/channels/shared/action-card.test.mjs
node --test test/channels/shared/harness-approval.test.mjs
node --test test/channels/telegram/approval-card.test.mjs
npm run build
npm test          # Lead 集成时统一跑；本分支也已跑（见 §5）
```

| # | 标准 | 判定命令 | 期望 | 实测 |
| --- | --- | --- | --- | --- |
| A1 | 审批收到卡片而非文字；点「批准一次」后共享队列收到 `allowed-once`，原消息变「✅ 已批准（仅本次）」且键盘清空 | `node --test test/channels/telegram/approval-card.test.mjs` | `approving on the card ...` 绿 | ✅ 见 §5 |
| A2 | 非发起人点审批按钮不生效，只收到 toast | 同上 | `a press by someone else ...` 绿 | ✅ |
| A8 | 点击后 ack 先行、重复点击只执行一次、过期卡清键盘 | 同上 | `two presses ...`、`a press on a resolved card ...`、`an approval timeout ...` 绿 | ✅ |
| A9 | 文字路径保留：卡发送失败/无卡能力时，提示与今天**字节相同** | 同上 | `refused card send falls back to the byte-identical text approval`、`a channel without keyboard support ...` 绿 | ✅ |
| A10 | `callback_data ≤64B`，命名空间可解析、外来 payload 一律拒绝 | `node --test test/channels/shared/action-card.test.mjs test/channels/telegram/approval-card.test.mjs` | 两条命名空间测试 + 卡按钮断言绿 | ✅ 例：`ap1|abcd1234EFGH|a` = 18 bytes |
| A11 | `editMessageText` 传/不传 `replyMarkup` 的 payload 都正确；富文本+按钮被拒 | `node --test test/channels/telegram/approval-card.test.mjs` | `editMessageText forwards ...` 绿 | ✅ |
| A12 | 编辑失败时仍发文字终态（决定不丢） | 同上 | `a failed card edit still delivers ...` 绿 | ✅ |
| A13 | `message is not modified` 视为成功 | 同上 | `the card edit treats ...` 绿 | ✅ |
| A14 | 超时自动拒绝 + 卡标「⏰ 已过期」+ 键盘清空 | 同上 | `an approval timeout ...` 绿 | ✅ |
| A15 | 既有飞书/QQ/企微审批行为不变 | `node --test test/channels/shared/text-harness-bridge.test.mjs test/channels/feishu/bridge.test.mjs test/channels/qq/bridge.test.mjs test/channels/wecom/bridge.test.mjs` | 全绿（本分支 scoped 已含 shared bridge；飞书/QQ/企微不在 scoped，Lead 全量跑） | 见 §5 全量 |
| A16 | 构建产物可复现 | `npm run build` | exit 0，`lib/index.js` 更新 | ✅ |

---

## 3. 设计

### 3.1 分层

```
HarnessApprovalQueue（shared/harness-approval.mjs，已有）
  ├─ context.render(pending, send)   ← 本批次：Telegram 提供
  └─ pending.onResolved(text, outcome) ← 本批次：新增 outcome 参数（兼容旧调用）

TextHarnessBridge（shared/text-harness-bridge.mjs）
  ├─ 构造参数 approvalCard（默认 null = 各渠道行为不变）
  ├─ #handleInteraction(approval) 组 context：{ render, onResolved, send }
  └─ acceptCallback() 先问 approvalCard.handlePress()，未命中再走问题卡

TelegramHarnessBridge（telegram/telegram-bridge.mjs）
  └─ 默认 new TelegramApprovalCard(...)（可用 approvalCard: null 关闭）

TelegramApprovalCard（telegram/approval-card.mjs）
  ├─ render：发卡（正文 = 现有审批文本去「请回复」行；键盘 = 两个按钮）
  ├─ onResolved：原地 editMessageText（终态文案 + 空键盘）
  └─ handlePress：ack → actor → 首按认领 → 共享队列提交；陈旧则 toast + 清键盘

ActionCardRegistry / createCallbackNamespace（shared/action-card.mjs）
  └─ nonce 仓库（TTL/容量/一对话一活动卡）、首按认领、统一状态文案、≤64B 命名空间
```

### 3.2 回调格式

```
ap1|<nonce>|a     批准一次（allowed-once）
ap1|<nonce>|d     拒绝（rejected）
```

- 版本化前缀 `ap1`：未来 `ap2` 或旧 `a1` 都不会被误认；
- nonce：12 个 base64url 字符（9 随机字节），示例长度 18 字节，远低于 64B；
- 只带 nonce + 决策，**不带 approvalId/UUID/路径**（I2）；approvalId 在服务端 nonce 仓库里。

### 3.3 按下按钮的顺序（安全边界）

```
acceptCallback(callback)
 → parseTelegramApprovalCallback(data)          // 非本命名空间返回 false
 → registry.get(nonce) → 若卡片有效但 actor 不符：toast「只有发起当前任务的用户…」并返回
 → registry.claim(nonce)（同步，先于任何 await）  // 首按胜出
     ├─ 非 active → toast 对应状态（已处理/已过期/已被取代/正在提交）
     └─ active → await answerCallbackQuery()      // 先 ack，停掉转圈
        → queue.submitByApprovalId(approvalId, outcome, { actor })  // 共享队列复核
        → 成功：队列 onResolved → 原地改卡 + 清键盘 + 记为 resolved
        → 失败/不存在：settle(stale) + 清键盘 + toast 提示
```

actor 在 claim **之前**校验：陌生人点击不会消耗发起人的唯一一次决定机会。
首按认领是同步内存操作，ack 的往返窗口里第二次点击只会看到 `claimed`。

### 3.4 卡片终态

| outcome | 卡片正文追加 | 键盘 |
| --- | --- | --- |
| `allowed-once` | `✅ 已批准（仅本次）` | `inline_keyboard: []` |
| `rejected` | `❌ 已拒绝` | 同上 |
| `expired` | `⏰ 已过期` | 同上 |
| `unavailable` | `⛔ 已失效` | 同上 |
| `resolved`（其他端已处理） | 共享队列的终态文本 | 同上 |

- 卡片正文保留工具/参数/原因，终态只是尾部追加；
- 成功终态**只出现一次**：`onResolved` 返回 `true` 表示「卡片已送达终态」，
  共享队列据此跳过随后那条「已批准，仅对本次操作有效。」文本（即使 `pending.send`
  已被 owner 的临时文字回复换掉）；编辑失败返回 `false`，队列照发文字终态保底；
  send 包装器的文本去重保留为第二道保险；
- 编辑报 `message is not modified` 视为成功（客户端已显示同一终态），同样返回 `true`；
- 按钮/终态/toast 全部经过 `t()`：中文是 identity，en 下有英文（见 §3.4.2）。

#### 3.4.1 交互卡与共享队列的契约（评审修复 #2）

| 契约 | 实现 | 为什么 |
| --- | --- | --- |
| 卡片送达后由 renderer 置 `pending.interactiveCard = true` | `approval-card.render` 成功发卡后设置 | 卡片已承担「怎么决定」的引导，文字提示不该和按钮打架 |
| 卡片活动时普通文字不再回「请精准回复…」 | `HarnessApprovalQueue.claimReply` 看到 `interactiveCard` 就不发 prompt | 评审复现：owner 发任意文字会收到与按钮矛盾的提示 |
| `onResolved` 返回 `true` = 终态已由卡片送达 | `#notifyResolved` 收到 `true` 就跳过 `send(text)` | 评审复现：owner 先发文字会换掉 `pending.send`，导致卡片终态之外又发一条重复终态 |
| `onResolved` 返回 `false`/`undefined` = 仍由队列发文字 | 编辑失败、卡片 absent、其他渠道（飞书/QQ/…）都返回 undefined | 不改变任何非 Telegram 渠道与文字降级路径 |

#### 3.4.2 文案与 i18n（评审 #3）

按钮（`✅ 批准一次` / `❌ 拒绝`）、终态标签（`✅ 已批准（仅本次）` / `❌ 已拒绝` /
`⏰ 已过期` / `⛔ 已失效`）、死卡 toast 全部走 `t()`；英文条目在
`src/channels/shared/i18n-en/telegram.mjs`。测试 `approval card labels follow the host language`
在 en 下断言按钮、终态、toast 都是英文。其他语言沿用仓内既有回退（未翻译 → 中文）。

#### 3.4.3 超长正文（评审 #3）

`sendInteractionCard` 是一条消息、不能拆分；Telegram `sendMessage` 上限 4096 字符。
正文超过 `TELEGRAM_APPROVAL_CARD_MAX_CHARS`（4096）时**直接走文字路径**（现有
`sendText` 会拆分同一文本），避免每次都先收一个 400 再降级。实测：4500 参数夹具下
`cardAttempts = 0`、文字提示字节不变、文字「批准」仍可完成审批。

### 3.5 降级矩阵（不变量 I4：绝不丢审批）

| 场景 | 行为 |
| --- | --- |
| bot 无 `sendInteractionCard/editInteractionCard`（如旧测试桩/无卡渠道） | `createContext` 返回 `{}`，队列完全走原文字路径 |
| 卡片发送失败 | 撤销 nonce，`send(pending.text)` 发**逐字一致**的旧提示，文字回复「批准/拒绝」照常可用 |
| 卡片发送成功但编辑失败 | 终态文字照发（不吞），死键盘 best-effort 清理 |
| 编辑 `message is not modified` | 视为成功，不重复发文字 |
| 超时 | 共享队列自动拒绝 → 卡变「⏰ 已过期」清键盘；若编辑失败，超时文字照发 |
| 非发起人点击 | 只 toast，不 claim、不提交、不改卡 |
| 同对话又来新审批 | registry 里旧 nonce 标 `superseded`，旧键盘点击只 toast |
| 正文 > 4096 字符 | 跳过卡片直接发文字（文字发送层拆分），不再产生注定 400 的卡片请求 |
| 卡片活动时 owner 发普通文字 | 不回复任何「请精准回复…」；按钮仍可点，终态只在卡上出现一次 |
| 卡片活动时 owner 直接打「批准/拒绝」 | 决策照常提交，卡被原地改成终态，不再额外发终态文字 |
| 终态卡片编辑失败 | 先尝试用归一后的数字 message id 清死键盘；终态文字照发 |

### 3.6 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/channels/shared/action-card.mjs`（新） | 命名空间 / nonce / 注册表 / 状态文案 |
| `src/channels/telegram/approval-card.mjs`（新） | Telegram 审批卡渲染 + 点击处理 |
| `src/channels/shared/harness-approval.mjs` | `harnessApprovalText({hasButtons})`；`onResolved(text, outcome)` |
| `src/channels/shared/text-harness-bridge.mjs` | 可选 `approvalCard` / `approvalTimeoutMs` 钩子（默认 null，其他渠道零变化） |
| `src/channels/telegram/telegram-api.mjs` | `editMessageText` 透传 `reply_markup`；富文本+键盘断言（F7 不变量） |
| `src/channels/telegram/telegram-runtime.mjs` | `TelegramBotClient.editInteractionCard`（含 not-modified 与两步降级）；`updateInteractionCard` 容忍 not-modified |
| `src/channels/telegram/telegram-bridge.mjs` | 默认装配 `TelegramApprovalCard` |
| `src/channels/shared/i18n-en/telegram.mjs` | 审批卡英文文案（评审 #3） |
| `lib/index.js` | 构建产物（host bundle） |

---

## 4. 不变量（闸门 4）

| # | 不变量 | 判定方式 | 实测/依据 |
| --- | --- | --- | --- |
| I1 | 文字批准/拒绝路径**字节级不变**（提示、审批提交结果）；有卡时终态回执由卡片承载、不再重复发聊天消息（评审要求），无卡/卡片失败时文字终态照发 | 测试 | `harness-approval.test.mjs` 的 `a card presentation ...` 用字面量钉死旧提示；`approval-card.test.mjs` 的 fallback 用例断言 `sent[0] === PLAIN_APPROVAL_PROMPT`；`typing 批准 ... keeps a single terminal receipt` 断言有卡时无重复终态文字 |
| I2 | `callback_data ≤64B` | 测试 | 生成器断言（最宽 token 组合 ≤64）；API 层 64B 抛错单测；实卡 `ap1\|abcd1234EFGH\|a` = 18B |
| I3 | 非发起人不能处理 | 测试 | `a press by someone else only receives a toast and leaves the card for its owner` |
| I4 | 重复点只执行一次 | 测试 | `two presses of one card submit the decision exactly once`（ack 延迟 30ms 并发双按） |
| I5 | 富文本答案不带按钮（F7 产品不变量） | 测试 + 人工核对 | `telegram-api` 拒绝 `richMessage+replyMarkup` 单测；F7 事实更正见 §1 F6 |
| I6 | 发送/编辑失败仍保留文字路径，绝不丢审批 | 测试 | 两条 fallback 用例 + `a failed card edit still delivers the terminal text receipt` |
| I7 | 飞书/QQ/企微实现零改动 | 人工核对 | `git diff --stat` 不含这些渠道文件；shared bridge 钩子默认 `null` |
| I8 | 不碰流式/发送预算区域（上游 PR #412/#423/#425/#426） | 人工核对 | `git diff --name-only` 不含 `telegram-runtime` 的流式/发送预算段（改动集中在 `TelegramBotClient` 卡片方法与 `normalizeTelegramCallback` 之外） |
| I9 | 卡片活动时普通文字不收到与按钮矛盾的「请精准回复…」 | 测试 | `ordinary text while a card is live ...` + harness 单测 `an interactive presentation suppresses ...` |
| I10 | 卡片文案随宿主语言（en 有英文，其他语言回退中文） | 测试 | `approval card labels follow the host language` |

> `git diff --name-only` 实际清单见 §5。
> I8 人工核对补充：`telegram-runtime.mjs` 的 diff 只有两处（模块级 `isMessageNotModified` 辅助函数 +
> `TelegramBotClient` 的 `updateInteractionCard/editInteractionCard`），未触碰流式渲染、`sendBudget`、
> `editable-message-stream` 等区域。

---

## 5. 验证证据（闸门 5）

### 5.1 验红（修复前失败）

完整记录：`/home/wings/Code_Project/_notes/tg-approval/evidence.md`、原始日志
`/home/wings/Code_Project/_notes/tg-approval/red-initial.log`。

- 红色命令：`node --test test/channels/shared/action-card.test.mjs test/channels/telegram/approval-card.test.mjs test/channels/shared/harness-approval.test.mjs`
- 红色结果：`tests 61 / pass 38 / fail 23`（exit=1）
- 失败样例（含测试名与断言行）：
  - `✖ approving on the card submits allowed-once ...` → 卡未接线，`eventually()` 超时（`approval-card.test.mjs:83`）
  - `✖ editMessageText forwards an optional keyboard ...` → payload 缺 `reply_markup`（`approval-card.test.mjs:517`）
  - `✖ the card edit treats message is not modified as success` → `client.editInteractionCard is not a function`（`:592`）
  - `✖ a resolved approval reports the outcome next to its receipt text` → `onResolved` 收到 `undefined` 而非 `allowed-once`（`harness-approval.test.mjs:1293`）

### 5.2 绿色（修复后）

| 命令 | 结果 |
| --- | --- |
| `node --test test/channels/shared/action-card.test.mjs` | `tests 9 / pass 9 / fail 0` |
| `node --test test/channels/shared/harness-approval.test.mjs` | 首轮 `38/38` → 评审修复后 `40/40`（新增 2 条契约测试） |
| `node --test test/channels/telegram/approval-card.test.mjs` | 首轮 `14/14` → 评审修复后 `19/19`（新增 5 条回归测试） |
| scoped 回归（上述 3 个 + `text-harness-bridge` + `interaction-card` + `telegram.test` + `i18n.test`） | 首轮 `206/206` → 评审修复后 `223/223` |
| `npm run build` | exit 0（`Wrote lib/client.js`、`Wrote lib/index.js`） |
| 全量 `npm test` | 见下方「全量验证记录」 |

全量验证记录（本分支独立跑，与并行队友共享 2 核 CPU）：

```bash
cd /home/wings/Code_Project/_worktrees/dsh-im/approval
npm test > /tmp/tg-approval-full-test.log 2>&1; echo "exit=$?"
```

实测输出（2026-10-22，分支 `feat/tg-approval-card`）：

```
ℹ tests 4431
ℹ suites 3
ℹ pass 4431
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 184720.243591
exit=0
```

原始日志已归档：`/home/wings/Code_Project/_notes/tg-approval/full-test.log`（scoped 绿跑：`scoped-final.log`；构建：`build.log`）。

### 5.5 评审修复后的验证（提交 `ff6466e` + `243306d`）

独立评审提出的 3 类问题，全部先写失败测试再修：

```bash
node --test test/channels/telegram/approval-card.test.mjs \
  test/channels/shared/harness-approval.test.mjs
# 修复前：exit=1，tests 59 / pass 52 / fail 7
# 修复后：exit=0，tests 59 / pass 59 / fail 0
```

红色明细（测试名 + 断言行，原始日志 `_notes/tg-approval/red-review-fixes.log`）：

| 测试名 | 修复前失败 |
| --- | --- |
| a failed terminal card edit still clears the dead keyboard (normalised message id) | `condition was not met before timeout` @ `approval-card.test.mjs:84`（终态 edit 失败后 `updateInteractionCard` 调用数 0） |
| ordinary text while a card is live neither asks for typing nor duplicates the receipt | `the button card must not answer ordinary text with the type-the-decision prompt` @ `approval-card.test.mjs:638` |
| typing 批准 and then pressing the card keeps a single terminal receipt | `the card is the terminal receipt; no duplicate chat message` @ `approval-card.test.mjs:666` |
| an oversized approval body keeps the plain-text flow instead of a doomed card | `condition was not met before timeout` @ `approval-card.test.mjs:84`（4500 字符仍先发卡片） |
| approval card labels follow the host language | `Expected values to be strictly deep-equal` @ `approval-card.test.mjs:707` |
| a presentation that delivered the receipt suppresses the duplicate terminal text | `no second terminal text after an interactive receipt` @ `harness-approval.test.mjs:1309` |
| an interactive presentation suppresses the type-a-reply prompt for ordinary text | `a button card must not ask the user to type the decision` @ `harness-approval.test.mjs:1332` |

修复后 scoped 回归（加跑 `i18n.test.mjs`）：`tests 223 / pass 223 / fail 0`（日志 `_notes/tg-approval/scoped-review-fixes.log`）。

全量 `npm test`（修复后，本分支独立跑）：`tests 4438 / pass 4438 / fail 0`，exit=0，
duration ≈ 178.6s。原始日志 `_notes/tg-approval/full-test-review-fixes.log`。

> 期间发现并修掉一个自测遗漏：新增英文词典键与既有 `feishu.mjs/shared-c.mjs` 重复，
> 被 `i18n.test.mjs` 的「no duplicate keys」用例拦下（首轮全量 4437/4438）；
> 复用既有条目后复跑 `4438/4438` 全绿（提交 `243306d`）。

### 5.3 构建产物说明

- `lib/index.js`（host bundle）已随 `src` 变更重建并提交，包含审批卡代码（minified 后中文以 `\uXXXX` 形式存在）。
- `lib/client.js`：worktree 的 `node_modules` 是软链，`npm run build` 会把模块注释路径写成
  `../../../dsh-im/node_modules/...`（与主检出构建产物仅有注释路径差异）。本分支已把
  `lib/client.js` 还原为 `HEAD`（host src 变更不影响 client bundle），避免提交路径噪音。
  集成时建议在主检出重跑 `npm run build`，产物即与仓库惯例一致。

### 5.4 变更清单

功能提交：`5f5c07a feat(telegram): 审批按钮卡 + 共享 action-card 卡片地基`

```
 lib/index.js                                   | 690 +++++++++++++------------
 src/channels/shared/action-card.mjs            | 311 +++++++++++
 src/channels/shared/harness-approval.mjs       |  12 +-
 src/channels/shared/text-harness-bridge.mjs    |  58 ++-
 src/channels/telegram/approval-card.mjs        | 310 +++++++++++
 src/channels/telegram/telegram-api.mjs         |  11 +-
 src/channels/telegram/telegram-bridge.mjs      |   7 +
 src/channels/telegram/telegram-runtime.mjs     |  67 ++-
 test/channels/shared/action-card.test.mjs      | 185 +++++++
 test/channels/shared/harness-approval.test.mjs |  42 ++
 test/channels/telegram/approval-card.test.mjs  | 607 ++++++++++++++++++++++
 11 files changed, 1945 insertions(+), 355 deletions(-)
```

评审修复提交：`ff6466e fix(telegram): 修复审批卡三处真机可见缺陷`

```
 lib/index.js                                   | 482 ++++++++++++-------------
 src/channels/shared/harness-approval.mjs       |  15 +-
 src/channels/shared/i18n-en/telegram.mjs       |  19 +
 src/channels/telegram/approval-card.mjs        |  39 +-
 test/channels/shared/harness-approval.test.mjs |  40 ++
 test/channels/telegram/approval-card.test.mjs  | 118 +++++-
 6 files changed, 460 insertions(+), 253 deletions(-)
```

- 未改飞书/QQ/企微/钉钉等渠道实现文件；
- 未改包依赖 / `package.json` / `package-lock.json`；
- 未改流式、发送预算、`editable-message-stream` 区域。

---

## 6. 风险、未做、需 Lead 拍板

| 项 | 说明 |
| --- | --- |
| 真机未验证 | 本任务禁止调用生产 Telegram bot；A1 的「真机点按钮」由 Lead E2E 阶段补（日志/截图）。单测使用假 Bot API 断言 payload 与状态机。 |
| 按钮布局 | 两个按钮放同一行（`[✅ 批准一次] [❌ 拒绝]`）。若真机小屏显示拥挤，可改两行——只是 `telegramApprovalMarkup` 一处改动 + 快照断言。 |
| 「本会话总是允许」 | 本批次只做「批准一次/拒绝」，不加第三个按钮（Harness 当前只消费 `allowed-once`）。 |
| 卡片正文长度 | `harnessApprovalText` 的 6000 字符参数上限不变；正文 >4096 字符时**跳过卡片直接走文字路径**（发卡不能拆分，注定 400；文字发送层会拆分），评审后已实现并有回归测试。 |
| i18n | 审批卡按钮/终态/toast 已接 `t()` 并补 en 字典；其他语言沿用仓内「未翻译即中文」的回退，未新增翻译。 |
| 审批卡出现前的旧文字提示 | 旧消息没有按钮，文字「批准/拒绝」路径仍然有效；两种入口共享同一队列，不会双提交。 |
| 路线图文档 | 按 Lead 协调，本分支**不引入、不修改**路线图与两份调研文档（避免与 `/ws` 分支 add/add 冲突）；批次 1 状态由 Lead 集成时统一更新。本方案文档是本功能独有留痕。 |
| 需拍板 | ① 真机 E2E 由谁执行（建议 Lead）；② 集成后是否在主检体重跑 `npm run build` 覆盖 `lib/`（推荐，可消除 worktree 软链导致的注释路径差异）；③ 按钮布局（同一行 vs 两行）是否等真机截图后再定。 |

---

## 7. 已知问题与评审修复记录

独立评审结论「可合并」，3 类真机可见缺陷已在 `ff6466e` 修复、i18n 去重跟进在 `243306d`（不改写已有提交）：

| # | 级别 | 问题 | 根因 | 修复 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | blocking | 终态卡片编辑失败时死键盘永远不清 | `#retireKeyboard` 用 `Number.isSafeInteger(card.messageId)`，而卡 id 来自 `providerMessageIds` 是 **string**，守卫恒 false | 先 `Number(providerMessageId)` 归一，再校验 `updateInteractionCard`；补回归测试 | ✅ 已修复/已验红 |
| 2 | blocking | owner 审批挂起时发文字 → 终端重复、普通文字收到「请精准回复…」 | `claimReply` 会把 `pending.send` 换成普通回复的 send；卡片终态后队列仍发文字；非决策文字固定回 prompt | `interactiveCard` 标记（render 成功置位）让队列跳过 prompt；`onResolved` 返回 `true` 时队列跳过 `send(text)`；补 2 条集成 + 2 条队列契约测试 | ✅ 已修复/已验红 |
| 3a | non-blocking | 正文 >4096 时先发卡片收 400 再降级 | 卡片发送不拆分 | 超过 4096 直接走文字路径 | ✅ 已修复/已验红 |
| 3b | non-blocking | 按钮/终态/toast 硬编码中文 | 未接 i18n | 全部走 `t()`，补 10 条新英文条目（3 条复用既有） + en 测试；新增键曾与 `feishu.mjs/shared-c.mjs` 重复，被 `i18n.test.mjs` 拦下后去重（`243306d`） | ✅ 已修复/已验红 |

### 仍待真机/集成验证

- A1「真机点按钮」、`editMessageText(reply_markup)` 组合、`message is not modified` 真机行为：
  官方文档支持，但本任务禁止调用生产 bot，标 `[真机待验证]`，由 Lead E2E 阶段补。
- 集成时建议在主检出重跑 `npm run build` 覆盖 `lib/`（worktree 软链会导致 `lib/client.js`
  的注释路径差异，功能提交已还原该文件）。

## 8. 真机验证（2026-10-22）

环境：`wings-gpd`（CachyOS / KDE Plasma 6.8 Wayland）+ Telegram Desktop 7.3.1 flatpak，
独立 `DSH_HOME` 的 `dsh web` 实例 + 临时测试 bot（验证后删除），审批策略 `policy=ask`。

| 用例 | 结果 |
| --- | --- |
| 审批卡出现：工具/参数/原因 + `✅ 批准一次` `❌ 拒绝`，无「请精准回复」文本 | ✅ |
| 点「批准一次」：卡原地「✅ 已批准（仅本次）」+ 清键盘，agent 继续执行并回报 | ✅ |
| 点「拒绝」：卡原地「❌ 已拒绝」+ 清键盘，agent 收到 denied 并按拒绝继续 | ✅ |
| 审批挂起时先发普通文字再点按钮：不再收到「请精准回复」，终态只出现一次 | ✅（评审修复 #2 真机复核） |
| 平台事实：`editMessageText`+`reply_markup` 一次调用接受；`callback_data` 64B 接受 / 65B 拒绝 | ✅（`probe --live`） |

截图与完整记录保存在验证机器 `_notes/tg-e2e/`，未提交进仓库；测试 bot 与独立实例验证后已删除。
