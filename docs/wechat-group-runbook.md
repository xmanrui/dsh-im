# 微信群接入运行手册（DSH-IM 5.8.0 本地 UIA 桥）

## 结论先说清楚

在**微信 4.1.15.56** 上，本桥可以把**已配置的群**接到 DSH，并能把回复发回该群；但有三个微信自身的限制，代码不会假装绕过：

| 能力 | 状态 | 原因 |
|---|---|---|
| 群消息正文读取 | ✅ 可用（观察模式） | 气泡控件有正文 |
| 向群发送 | ✅ 可用（显式开关） | 输入框 + Enter 可用 |
| 识别“谁发的” | ❌ 不可得 | 群气泡 `kids=0`，无 sender 控件 |
| 区分“自己/别人” | ❌ 不可得 | 同上，无 is_self |
| 真实 @ 触发 | ❌ 不可得 | 真实 @ 渲染为 `@[___]` 占位 |
| 自动回复触发 | ❌ 默认关闭 | 未验证身份不得 addressed |

所以：**能收发，但“谁在说话”无法证明**。适配器把这类消息标记为 `uia-unverified:row`，并**永不**把它判为 `addressed`，因此不会自动执行命令、不会冒充某个成员。

## 使用前必须置顶目标群（硬性）

实测：群一旦滚出左侧会话列表，**按标题既选不到、也搜不回来**（搜索框存在，但输入后列表不变）。因此：

1. 在微信里把目标群**置顶**（右键会话 → 置顶），让它常驻会话列表。
2. 否则适配器会报 `duplicate_group_title`（视觉上表现为“找不到目标群”），群桥保持离线，不会误发到别的群。

这是微信客户端侧的约束，插件不会绕过它去猜测群。

## 群识别方法（实测）

- 群：标题栏子控件类名 `mmui::ChatTitleBarChatRoomView`，标题形如 `群名(175)`（175 是成员数）。
- 私聊：`mmui::ChatTitleBarChatSingleView`。
- 会话项：`AutomationId = session_item_<精确标题>`；`Name` 含多行摘要，**不能**当标题。

## 两个开关（默认均关闭）

开关有两种等价写法：**账号级配置文件**（推荐，改完下一次启动群桥即生效，不需要重启宿主）或**进程环境变量**（需要重启宿主）。

| 配置文件键（`group-chats.json` 根级） | 环境变量 | 作用 | 关闭时行为 |
|---|---|---|---|
| `"allowUnverifiedRead": true` | `DSH_WECHAT_GROUP_ALLOW_UNVERIFIED=1` | 允许读取群消息正文（身份标记为未验证） | `read_messages` 抛 `message_layout_unverified`，群保持离线 |
| `"allowSend": true` | `DSH_WECHAT_GROUP_ALLOW_SEND=1` | 允许向已配置群发送 | `send_text` 返回 `send_disabled`，绝不写群 |

插件把配置里的两个键翻译成适配器的环境变量再 spawn，宿主自身环境不被改写；两者同时存在时任一为真即可。

只读排障永远安全：`py -3.12 -B scripts/wechat_group_uia.py --probe`（不选群、不输入、不发送）。

### 无障碍标志（微信 4.x 的硬前提）

微信 4.x 的 `mmui::*` 无障碍控件树**只在微信进程启动那一刻系统「屏幕阅读器」标志已置位时才构建**；事后打开读屏、广播 `WM_SETTINGCHANGE`、重启微信以外的任何操作都补不回来。标志未置位时，主窗口在 UIA 里只剩一个空的 `MMUIRenderSubWindowHW` 面板，`mmui::MainWindow` 根本不存在。

置位（一次性，命令行即可，不需要读屏软件常驻）：

```bash
# 置位并回读；不需要装读屏软件，也不需要它常驻
py -3.12 -B scripts/enable_wechat_uia_flag.py
# 只查不改：加 --check；想恢复默认：加 --disable
```

顺序必须是**先置标志、再启动微信**。若微信已在运行，只能先退出再启动（会掉一次登录态，需要扫码）。

### 群桥起不来时的错误码

| 适配器错误码 | 含义 | 处置 |
|---|---|---|
| `wechat_logged_out` | 微信停在登录/扫码页 | 扫码登录后再启动群桥 |
| `main_window_missing` | 没有微信主窗口 | 确认微信已启动且窗口未被最小化到托盘 |
| `message_layout_unverified` | 未开 `allowUnverifiedRead` | 在 `group-chats.json` 里置 `"allowUnverifiedRead": true` |
| `send_disabled` | 未开 `allowSend` | 在 `group-chats.json` 里置 `"allowSend": true` |
| `duplicate_group_title` | 目标群标题不在可见会话列表里（或重名） | 在微信里把目标群**置顶** |

## 账号级群配置

路径：`integrations/dsh-weixin/accounts/<botId>/group-chats.json`

```json
{
  "version": 1,
  "pollIntervalMs": 750,
  "groups": [
    {
      "id": "uia_<stable-random-id>",
      "title": "精确群名（与 session_item_ 一致）",
      "commandPrefix": "/dsh",
      "mentionMode": "command",
      "allowSelf": false
    }
  ]
}
```

没有此文件时**不会启动 Python 进程**，私聊 iLink 行为完全不变。

## 实测证据（2026-10-31）

- 真实群 `零食快递洗鞋打扫外卖代写`（175 人）：
  - 观察模式启动成功，基线建立、两次轮询 0 新事件（群内确实无新消息）
  - 打开发送开关后发送 `DSH probe2 ...` → `ok=true`，下一次轮询**捕获到该消息**为 1 条新事件，`sender=uia-unverified:row`、`addressed=false`
- 已验证的失败假设（勿重复尝试）：气泡左右对齐（整行同 x/w）、`TextPattern`/`ValuePattern`/`LegacyIAccessible`（本机均 AttributeError）

## 已知风险

1. **无法区分自己与他人**：若群成员恰好手工发了与机器人完全相同的一句，观察侧无法分辨。
2. **不能自动回复**：任何基于“被 @/被点名”的自动触发都不可靠，故一律不触发。
3. **UIA 依赖前台已登录窗口**：微信未登录、窗口被最小化到异常状态时需要先人工恢复（`--probe` 会明确报 `main_window_missing`）。
4. **滚出可视区的历史消息不可回溯**：只读当前可见气泡。

## 安全设计要点（已实现，有测试）

- 单会话锁：选群、读、写、恢复串行；提交前复核标题。
- 选群用 `SetFocus()+Click()`（`SelectionItemPattern.Select()` 在本机返回 True 但不切群，已弃用）。
- 恢复原聊天；恢复失败判 `restore_failed`，不当作成功。
- 发送幂等：`request_id` 预约后先落盘状态，`unknown` 永不盲重试。
- 未验证身份一律 `addressed=false`，不得执行命令、不得走 owner 豁免。

## 回滚

```bash
# 恢复官方 5.8.0 包
cp -a "C:/Users/37533/.dsh/plugin-backups/dsh-im-5.8.0-pre-wechat-groups/dsh-im" \
      "C:/Users/37533/.dsh/profiles/desktop/node_modules/@xmanrui/dsh-im"
# 然后重启 DSH Desktop
```

或直接删除账号级 `group-chats.json`（群桥不再启动，私聊不受影响）。
