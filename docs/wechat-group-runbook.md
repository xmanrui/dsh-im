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

### 树与窗口不等价：微信 4.x 实测纠正（2026-11-01 晚）

只读取证（`_audit/weixin-close-window-setting.md`，DLL `2b3677c3`）：微信 4.2.0.12 里
3.x 的「设置→通用→关闭主面板时→最小化到通知栏」**已被整体删除**——配置层明文
grep 零命中、44 个 db 里 42 个是 SQLCipher、MMKV 配置带 CRC 加密、命令行也没有
`--minimized/--tray`。DLL 里写死的是 `quitOnLastWindowClosed` +
`MainWindowWillClose → 退出`。所以在本版本：

- **X 关闭面板 ≠ 进程退出**（实测：5 个 Weixin 进程仍在、壳窗口可见）。销毁的是
  `mmui::MainWindow` 及其无障碍子树，群桥随即读不到也发不出。
- **最小化同样会毁树**（实测：18:27 树在、`main: true`、10 个会话；我对面板做过
  `SW_SHOWMINNOACTIVE` 之后，窗口仍可见非图标化，UIA 全桌面 0 个 mmui 控件）。
  ⇒ 早前写的「最小化 = 树保留」是错的，已撤回。**结论：既不要 X 关也不要最小化，
  让面板保持展开**，这是群桥唯一的可用形态。
- **窗口可见 ≠ 树存在**（实测：截图上面板开着，UIA 只有 2 个 PaneControl；
  `WM_GETOBJECT` 对 6 个句柄全部返回 0，即该实例根本没注册无障碍 provider）。
  重播 `SPI_SETSCREENREADER` 也救不回（flag 前后都 true，树仍 0 节点）。
- **唯一实测有效的恢复动作**：重启微信客户端并走完一次登录流程（本机账号已记住，
  登录窗显示「当前登录用户大肥鱼」+「登录」按钮，无需扫码）。实测状态序列：
  `需在手机上完成登录 → 正在进入 → MAIN`，随后 `session_list` 10 项、目标群在列。
  注意该按钮的 UIA `Invoke()` 会**返回 true 而什么都不做**（同 `select_chat` 的撒谎
  行为），必须用真实点击。
关于「不抢屏也能发送」，实测把可选通路一条条排除：

- Enter 走的是全局键盘注入，而键盘一次只属于一个窗口；`SetFocus` 在最小化窗口上
  **返回 false 且不激活**（自有窗口实验 `operator_kept_focus=true`），所以隐藏态
  根本拿不到键盘。
- 定向 `PostMessage`(WM_CHAR / WM_KEYDOWN) 投给**未聚焦**的标准 EDIT 也不生效
  （`delivered_without_focus=false`，且已带消息泵，排除假阴性）。
- ⇒ 真正不需键盘的通路只剩 InvokePattern 触发微信自己的「发送」控件
  （`send_by_invoke`，现为 `press_enter` 首选）。它是否被本 build 接受，需在树存在时
  活体复验（`--probe` 的 `send_candidates` 字段就是为此准备的只读探针）。

因此**桥绝不主动最小化**：`autoMinimize` 保留为根级开关（默认 false），但按上面的实测
它会让群桥失去树，属于「无人值守机专用、且明知会断桥」的选项，日常必须保持关闭。
本机 `group-chats.json` 已实测把它写回 `false`。



已闭环的部分：宿主已于 17:29 重启装上新 JS（`autoMinimize` 键已实测被校验器接受，
写入 false 无 `invalid-group-config`）；`poll_failed` 洪水已变成每次一条真实错误码 +
慢梯退避（生产实测 30s → 2m → 10m，日志 15 分钟仅 4 行）。

仍待活体复验（诚实边界，别当已通）：

1. **焦点守卫的真机形态**：守卫按「进程归属」判定（`GetFocusedControl().ProcessId`
   与微信主窗口 pid 相同）。该 API 本机可用性与语义已实测（前台 Chrome 的
   `OmniboxViewViews` EditControl 报 `hwnd=0` + 可用 pid，与 mmui 子控件同形），
   但 **mmui 真机上焦点被报成什么仍未活体复验**，因为树在复验前就没了。
2. **`send_by_invoke` 是否被本 build 接受**：同样待复验；`--probe` 现在会输出
   `send_candidates`，树一恢复就能一次读出，不必再猜。
3. 守卫按 #37 保守：证明不了键盘在微信内就拒发（宁可少发一条，也不把回车注入
   操作者正在用的程序）。这是「不控屏」优先于「必发出去」的有意取舍。

错误码现在区分四种「没有主窗口」：`wechat_logged_out`（扫码/点登录）、
`wechat_accessibility_unavailable`（面板可见但树没了 → 只能重启微信）、
`wechat_panel_closed`（壳窗被推到屏外/托盘尺寸 → 重开面板，别最小化）、
`main_window_missing`（没开微信）。
### 群桥起不来时的错误码

| 适配器错误码 | 含义 | 处置 |
|---|---|---|
| `wechat_logged_out` | 微信停在登录/扫码页 | 扫码登录后再启动群桥 |
| `main_window_missing` | 微信进程没在跑 | 启动微信并登录 |
| `wechat_panel_closed` | 面板被 X 关闭：进程还在但 mmui 树已销毁 | 重开面板；**不要最小化**（实测同样毁树） |
| `wechat_accessibility_unavailable` | 面板可见但整个无障碍树不存在（provider 未注册） | 重启微信并走完一次登录 |
| `message_layout_unverified` | 未开 `allowUnverifiedRead` | 在 `group-chats.json` 里置 `"allowUnverifiedRead": true` |
| `send_disabled` | 未开 `allowSend` | 在 `group-chats.json` 里置 `"allowSend": true` |
| `duplicate_group_title` | 目标群标题不在可见会话列表里（或重名） | 在微信里把目标群**置顶** |
| `window_minimised` | 微信被最小化，UIA 点击不生效 | 手动还原微信；或显式允许桥接管 |
| `control_missing` | 缺少 `session_list` / `chat_*` 控件 | 确认微信已登录且窗口正常 |
| `target_title_mismatch` | 选群后标题校验不一致 | 通常是窗口未还原或目标群未置顶 |

### 为什么桥不会自己把你的窗口拉回来

还原窗口会把屏幕从正在用电脑的人手里抢走，所以插件**默认不做**：遇到最小化的微信时它抛 `window_minimised` 并保持离线，而不是抢占焦点。确有需要（例如无人值守机）才在账号配置里显式打开：

```json
{"allowWindowRestore": true}
```

对应适配器环境变量 `DSH_WECHAT_GROUP_ALLOW_WINDOW_RESTORE=1`；默认关闭，测试里有一条断言专门守着它不被隐式打开。

## 账号级群配置

路径：`integrations/dsh-weixin/accounts/<botId>/group-chats.json`

```json
{
  "version": 1,
  "pollIntervalMs": 750,
  // 读/发/抢屏三个开关默认全关，按需逐项打开：
  "allowUnverifiedRead": true,
  "allowSend": true,
  "allowWindowRestore": false,
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
