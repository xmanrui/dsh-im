# DSH-IM rv5.8.0 个人微信群接入设计

## 决策

在保留腾讯 iLink 私聊链路的前提下，为现有 `weixin` 账号增加一个**免费、原生 Windows UI Automation（UIA）群桥**。桥只附着用户已经打开并登录的 `mmui::MainWindow`，不启动微信、不打开新窗口、不调用 `ShowWindow/SetWindowPos/SwitchToThisWindow`，不依赖 wxauto Plus。

本决策由当前目标与全自动自决规则直接授权，不回抛选择。质量优先顺序是：真实当前版本可运行 > 不串群/不重复 > 私聊零回归 > 配置与部署可回滚。

## 已核实现状

- 官方基线：`v5.8.0` / `e84df7034ab82de9844d142aff36b7c8f377c9ea`。
- 当前微信：`D:/wechat2/Weixin/Weixin.exe` / `4.1.15.56`。
- 现有 UIA 控件：`session_list`、`chat_message_list`、`chat_input_field` 可读。
- iLink 私聊桥只生成 `p2p:` 会话，权限和上下文均固定 `direct`，客户端也声明 `groupSupported:false`。
- 可导入的 wxauto 是 `3.9.11.17`，要求旧窗口类 `WeChatMainWndForPC`，不匹配；免费 wxauto4 官方适配上限为微信 `4.1.8.107`，低于本机版本；v4 监听 API 属 Plus。

## 方案比较

| 路径 | 可观测质量判据 | 结论 |
| --- | --- | --- |
| 继续用 iLink 猜群字段 | 真群事件可解析、群回发有回执 | 否决：无群 payload/文档/测试，且当前产品声明不支持 |
| wxauto v4 Plus | 多群监听 API 完整 | 否决：监听属 Plus，不作为默认交付依赖 |
| 免费 wxauto / 旧 wxauto | 当前微信 4.1.15 可附着、可读、可发 | 否决：免费 v4 适配上限 4.1.8；现有 3.9 找旧窗口类且有窗口副作用 |
| 企业微信机器人 | 官方协议稳定 | 否决：不是个人微信群，改变平台前提 |
| **原生 UIA 群桥** | 当前窗口直接读写，所有步骤可在本机复核 | **采用** |

## 总体数据流

```text
指定微信群（现有微信主窗口）
  → Python UIA 适配器（校验群名、读取新消息、提取成员/正文）
  → 版本化 JSONL 事件（uia-wechat-group/v1）
  → Node 群运行时的子进程边界（超时、重启、去重、fail-closed）
  → WeixinHarnessBridge（group 权限、group 上下文、group:<chatId> 会话）
  → DSH Agent
  → Node sendText(chatId, text)
  → Python UIA（再次校验目标群、发送、回读恰好一次）
```

iLink 的私聊消息仍走原 `weixin-api.mjs`，不经过 UIA。群桥与 iLink API 不相互伪装，也不猜测 iLink 群协议。

## 模块边界

| 模块 | 责任 | 明确不负责 |
| --- | --- | --- |
| `scripts/wechat_group_uia.py` | 当前窗口读取、精确选群、文本发送与发送后回读 | DSH 会话、模型、权限决策 |
| `src/channels/weixin/wechat-group-config.mjs` | 读取并验证账号级 `group-chats.json` | 修改既有 iLink `config.json` |
| `src/channels/weixin/wechat-group-process.mjs` | 隐藏子进程、JSONL 协议、请求超时、停止与健康检查 | UIA 控件解析 |
| `src/channels/weixin/wechat-group-runtime.mjs` | 向账号现有 HarnessBridge 投递群事件并提供 UIA sendText | 不新建 HarnessBridge、不新建 deferred 协调器 |
| `src/channels/weixin/weixin-bridge.mjs` | 把版本化群事件映射为 group 权限/上下文/会话/回复目标 | 解析 UIA 或 iLink 原始私有群字段 |
| `weixin-runtime.mjs` + Host production | 每账号只保留一个 HarnessBridge 和一个 deferred 协调器，按群 ID 选择 iLink/UIA 发送；可选地启停群事件源 | 不再为群另建恢复实例 |
| Python/Node 测试 | 纯函数、协议、群隔离、负向对照、真实 UI 验收脚本 | 以 mock 冒充真群 E2E |

## 账号级群配置

文件：`integrations/dsh-weixin/accounts/<botId>/group-chats.json`。与 iLink 凭据配置分离，账号保存/重绑不会悄悄改写它。

```json
{
  "version": 1,
  "pollIntervalMs": 750,
  "groups": [
    {
      "id": "uia_<stable-random-id>",
      "title": "精确群名",
      "commandPrefix": "/dsh",
      "mentionMode": "command",
      "allowSelf": false
    }
  ]
}
```

- `id` 是本地稳定 ID；`title` 是 UIA 选群用精确标题，二者不得混用。重名群配置 fail-closed，因为 UI 无法可靠区分。
- 未配置此文件时，不创建 Python 进程，现有私聊行为完全不变。
- `allowSelf` 默认 `false`。即使允许自己发言，桥发出的文本仍按发送记录抑制，防止回声循环。
- 群访问继续使用现有 `accessPolicies.group`，默认 allowlist。授权键必须包含 `chatId` 与显示名，A 群的 Alice 不得授权 B 群同名者；组内同名或身份不明 fail-closed，不能授予命令权限。UIA 事件不得注入 iLink `ownerUserId`，本地群消息不得走 owner privileged bypass。

## 版本化群事件

Python 只发送满足 schema 的事件；Node 对缺字段、错误类型、未知版本、空群/成员 ID、非目标群事件一律拒绝。

必需字段：

```json
{
  "source": "uia-wechat-group/v1",
  "message_type": 1,
  "message_id": "account+chat_id+前驱链/occurrence 推导的 ID",
  "bridge_outbound_id": null,
  "conversation_type": "group",
  "conversation_id": "uia_<stable-random-id>",
  "conversation_title": "精确群名",
  "from_user_id": "uia-name:<chatId>:<成员显示名>",
  "identity_verified": false,
  "sender_name": "成员显示名",
  "reply_target": "uia_<stable-random-id>",
  "addressed": true,
  "text": "去掉触发前缀后的正文",
  "raw_text": "原始正文",
  "sent_at": 0,
  "is_self": false,
  "item_list": [{"type": 1, "text_item": {"text": "去掉触发前缀后的正文"}}]
}
```

实际 JSON 中 `sent_at` 为毫秒时间戳，`item_list` 与 `text` 保持一致。桥自身产生的回显以 `bridge_outbound_id` 和 `message_type=2` 双重抑制，且必须在 access/Harness 之前；`allowSelf=true` 也绝不放行桥自己的回声。UIA 本地群消息与 iLink 私聊分别走独立来源，不猜测 iLink 群协议。

## 触发、权限与会话

- 群默认只在 `/dsh <正文>` 时视为 `addressed`；空前缀或去触发后空正文不进入 Harness。`mentionMode=command` 是当前唯一允许的模式。普通 `@昵称` 文本只能作为 text hint，不能证明真实提及，因此不得触发特权动作；只有取得可区分的真实 @ 元数据并通过正负对照后，才可另开 mention 路由。
- `direct` 继续 `p2p:<senderId>`；`group` 使用 `group:<chatId>`。同群成员共享会话，不同群隔离。
- `senderId` 永远指实际成员；`replyTarget` 永远指群 ID。回复、typing、deferred delivery、引用上下文、错误提示不得把成员当群目标。
- `conversationType=group` 传入访问策略和上下文增强。客户端开启微信 group 设置，不再强制清零。
- 每账号只有一个 HarnessBridge 和一个 deferred 协调器。UIA 只提供事件源与发送传输，恢复记录 `entry.id` 作为稳定 outbound 幂等键；群事件只允许已配置群 ID。
- 群交互必须额外校验 `message.from_user_id === pending.actor`：成员 B 不得替成员 A 回答或推进问题/approval；非 actor 不得消费该交互。
- 未 @/无命令前缀的消息不触发模型；访问拒绝不得误发到成员私聊。

## UIA 安全规则

1. 只操作当前已登录主窗口；找不到窗口、控件或精确群名时 fail-closed。
2. 所有选群、读取、写入、提交、恢复都在同一个 UIA 会话锁内串行，轮询与 outbound 不得交错。读消息或发消息前都验证规范化完整标题等于目标群且绑定目标 `chat_id`；提交 Enter 前再次读取当前聊天标题、输入框所属聊天和输入文本。任何一步不符都不得提交；若输入框仍含本次注入的精确文本则仅清除这段自有文本，绝不清除用户草稿。
3. 启动时只建立可见消息基线，不回放历史；进程重启后先重建基线，避免历史整批重发。
4. UIA RuntimeId 不是持久消息 ID。轮询使用“可见消息序列的最长重叠 + 持久尾部游标”输出新后缀；相同成员连续发相同文字必须由序列位置区分。启动/重启先恢复游标并建立基线，不承诺跨虚拟化/重启的数学意义 exactly-once。
5. 发送前保存当前聊天与输入状态；操作完成只有在当前聊天仍受本次操作控制时才恢复原聊天，若用户已主动切群则记录 restore_skipped_user_changed 而不抢回。发送后回读目标群，确认正文恰好出现一次且输入框已清空；未回读成功不算已发送。
6. UIA 无法提供平台唯一成员 ID 时，不捏造。显示名仅作本地标识，不能声称跨群或跨账号唯一。
7. 必须有负控覆盖：标题校验后用户切群、轮询与 outbound 交错、恢复时用户再次切群。回读只是事后证据，不能替代提交前的所有权复核。

## 子进程与故障边界

- Node 使用 `windowsHide:true` 启动 `py -3.12 -B`；不弹控制台、不启动微信。
- JSONL 每行一个事件/响应；请求带 ID，健康检查、发送、停止均有超时。`request_id` 同时是 outbound 幂等键：正常回复使用原消息/投递 ID，deferred 恢复使用持久 `entry.id`（分块追加块序号），先 reserve 再发送，重复提交不得产生第二个气泡；结果不确定为 `unknown`，先对账，禁止盲重试。日志不记录完整聊天正文，必要时只保留长度和去重 ID 前缀。
- 子进程崩溃不得反复重放历史；先报告 unhealthy，再按有界退避重建基线。连续失败保持群桥离线，私聊继续。
- 关闭时先停止接收，再完成已接受消息，最后终止子进程；不得留下 Python 作业。

## 测试与验收

### 自动化

- Python 纯测试：触发解析、自己/他人、重复正文、同名群拒绝、历史基线、schema 拒绝、错误群不发送、回读缺失判失败。
- Node 纯/集成测试：direct 不回归；group access；同群共享/异群隔离；未 addressed 不入 Harness；回复/延迟回复到群；进程超时与关闭。
- 负向对照：旧官方代码必须让新增群测试失败；删除群 ID 校验、群权限或发送后回读断言时，对应测试必须变红。
- 构建：`npm run build`、`npm test`、`node scripts/verify-package.mjs`。测试环境使用已验证的独立 esbuild 副本，原仓既有飞书代理红项单独归因，不混入本改动。

### 真实微信

首选专用测试群 + 第二已授权账号：第二账号发唯一 token，断言群/成员/正文正确且只产生一次 ACK；非目标群或非授权发送者不产生 ACK。

若当前没有第二账号，允许用当前账号的受控自发 token 做**补充**验证：必须同时证明桥发回声被抑制、目标群回读恰好一次、原聊天恢复。该结果只证明当前账号下的真实 UI 链，不能冒充第二账号安全边界验收。

## 独立审查最终硬门

以下状态机是进入真实 UI 发送和部署前的必要条件，不允许以“多数路径可用”替代：

1. **错群提交**：所有 UIA 操作共用一把会话锁；真实同名列表项直接离线。选中后、写入后、Enter 前均重新绑定 chat_id、完整标题和输入框所属聊天。任何变化都不提交；用户再次切群时不强行恢复。双同名项、校验后切群、poll/send 交错、恢复时再切群均须零气泡。
2. **live-tail 入站**：只有能证明处于最新消息尾部才 ingest。历史滚动、零/不足重叠、群锚变化、虚拟列表换窗一律 baseline-only 或停读。message_id 由 account+chat_id+持久前驱/occurrence 推导，禁止纯文本或 RuntimeId。无 inbound ACK 时只承诺宁可丢、不重放。
3. **outbound journal**：每账号持久 `reserved → sending → succeeded/unknown`，request_id 绑定 chat_id+text hash+chunk_index。deferred 由持久 entry.id 派生；同 ID 不同 payload 硬拒绝；unknown 永不自动重发。回读只认发送前 self-bubble 序列的新后缀，不能数全列表相同文本。Enter 后、回读前/后、send_result 前崩溃均有负控。
4. **单恢复**：每账号只有一个 deferred 协调器。direct/group 同时有 pending 时，direct 仅 iLink、group 仅 UIA，request_id 跨恢复稳定，不能生成第二个恢复实例。
5. **群 actor**：A 发起的 question/approval 只能由 A 回答和推进。B 回答不得 resolve、不得误标为 A 的答案，也不得误消费消息。
6. **全路径 route**：命令、busy、notice、错误、interaction、quote、deferred 都使用 replyTarget=群 ID；群 isDirect=false，私聊 batch 不对群开放。malformed/duplicate config 只把群边界标为 unhealthy，不得拖死 iLink 或要求 Python 才能使用私聊。
7. **统一负控**：双群双成员故障矩阵覆盖历史虚拟化滚动/重启、标题校验后切群、B 替 A 回答、气泡出现后 send_result 前崩溃、direct+group deferred 同时恢复。分别删除最终标题校验、持久 journal、actor 检查、transport 过滤，对应测试必须逐项变红。

凡不能唯一证明来源群/目标群、实际 actor、live-tail 新后缀、request_id+payload 完成记录的状态，一律不读、不答、不发送、不重试；宁可明确 loss/unknown，也不猜。

## 部署与回滚

- 提交明确文件清单后，使用 Desktop 受管入口 `resources/app/lib/desktop-cli.js plugin --profile desktop add --save-exact <source>`，不用被 Electron 拒绝的普通 CLI。
- `package.json` 与 `scripts/verify-package.mjs` 必须同时列入 Python 适配器、依赖 pin 和全部 Node 群模块；先用 `npm pack --dry-run` 验证 tarball 未缺件。
- 部署前保存官方 `v5.8.0` 包和新增配置备份；构建产物与 profile 中实际包做哈希对账，并直接检查 profile 内的 Python/Node 文件存在。用 `py -3.12 -B -c` 在隔离环境导入并断言 `uiautomation.__version__ == "2.0.29"`。
- Host 如仍加载旧模块，先查受管热重载能力；只有证据表明必须重启时才按既有重启门执行，并读回加载版本与真实群链。
- 回滚：停用/移出账号级群配置并恢复官方包；既有 iLink `config.json`、`workspaces.json` 和私聊 `p2p:` 会话保持不变。

## 当前资源边界

已确认一个已登录微信账号和可读主窗口；尚未确认第二已授权测试账号及专用测试群。该资源缺口不得被 fake E2E 掩盖。实现与真实当前账号验证可以继续；第二账号边界若仍无资源，需单独登记为未闭环证据项。
