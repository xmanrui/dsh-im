# 微信群接入运行手册（DSH-IM 5.8.0 本地 UIA 桥）

## 结论先说清楚

在**微信 4.1.15.56** 上首次验证，本机现在跑的是**微信 4.2.0.12**（本手册 2026-11-01 的全部实测都取自这台 4.2.0.12）。在任一版本上，本桥都可以把**已配置的群**接到 DSH，并能把回复发回该群；但下面这些微信自身的限制，代码不会假装绕过：

| 能力 | 状态 | 原因 |
|---|---|---|
| 群消息正文读取 | ✅ 可用（观察模式） | 气泡控件有正文 |
| 向群发送 | ✅ 可用（显式开关） | ValuePattern 写输入框 + `press_enter()` 四条通路（首选 Invoke 微信自己的「发送」控件，见 4fe8b1d 一节） |
| 识别“谁发的” | ❌ 不可得 | 群气泡 `kids=0`，无 sender 控件 |
| 区分“自己/别人” | ❌ 不可得 | 同上，无 is_self |
| 真实 @ 的**名字** | ❌ 不可得 | 真实 @ 在无障碍文本里渲染成 `@[___]`，名字被抹成 `___`（`MASKED_MENTION_NAME`） |
| 真实 @ 触发（只证明“有人被 @ 了”） | ⚠️ 需逐群显式打开 | `mentionMode: mention` / `mention-or-command`，命中靠 `@[...]` 这个形状（`MENTION_TOKEN_RE`） |
| 自动回复触发 | ❌ 默认关闭 | `mentionMode` 默认 `command`；未验证身份的行只有本群置了 `allowUnverifiedTrigger: true` 才可能 addressed |

所以：**能收发，但“谁在说话”无法证明**。适配器把这类消息标记为 `uia-unverified:row`；默认（`mentionMode: "command"`）它**永不**把未验证身份的行判为 `addressed`，因此不会自动执行命令、也不会冒充某个成员。只有该群自己在配置里写 `"allowUnverifiedTrigger": true`，一条命令前缀命中（或 mention 模式下的 `@[...]` 命中）才可以让它 addressed——那仍然只证明“这句话是冲着群桥来的”，不证明说话的是谁，被抹名的 `@[___]` 也只有在同一 opt-in 下才被承认。这条规则在适配器 `build_message_event` / `_observe` 与运行时 `stripMentionTokens` / `#validEvent` 两侧必须一致：运行时是从 `raw_text` 重新推导触发条件的，规则一旦分叉就会要么拒掉真 @、要么收下伪造的 @。

## 使用前必须置顶目标群（硬性）

实测：群一旦滚出左侧会话列表，**按标题既选不到、也搜不回来**（搜索框存在，但输入后列表不变）。因此：

1. 在微信里把目标群**置顶**（右键会话 → 置顶），让它常驻会话列表。
2. 否则适配器会报 `duplicate_group_title`（视觉上表现为“找不到目标群”），群桥保持离线，不会误发到别的群。**例外**：整条会话列表都不存在时（操作员折叠了侧栏），报的是 `sidebar_collapsed`，不是 `duplicate_group_title`，见下面「会话列表被折叠时」。

这是微信客户端侧的约束，插件不会绕过它去猜测群。

## 群识别方法（实测）

- 群：标题栏子控件类名 `mmui::ChatTitleBarChatRoomView`，标题形如 `群名(175)`（175 是成员数）。
- 私聊：`mmui::ChatTitleBarChatSingleView`。
- 会话项：`AutomationId = session_item_<精确标题>`；`Name` 含多行摘要，**不能**当标题。

## 开关（根级四个布尔，默认全部关闭）

每个开关都有两种等价写法：**账号级配置文件**（推荐，改完下一次启动群桥即生效，不需要重启宿主）或
**进程环境变量**（需要重启宿主）。下表是读/发两条硬闸；另外两个（还原窗口、自动最小化）在表后说明。

| 配置文件键（`group-chats.json` 根级） | 环境变量 | 作用 | 关闭时行为 |
|---|---|---|---|
| `"allowUnverifiedRead": true` | `DSH_WECHAT_GROUP_ALLOW_UNVERIFIED=1` | 允许读取群消息正文（身份标记为未验证） | `read_messages` 抛 `message_layout_unverified`，群保持离线 |
| `"allowSend": true` | `DSH_WECHAT_GROUP_ALLOW_SEND=1` | 允许向已配置群发送 | `send_text` 返回 `send_disabled`，绝不写群 |

插件把配置里的键翻译成适配器的环境变量再 spawn（`wechat-group-process.mjs`），宿主自身环境不被改写。
子进程环境先取宿主环境的副本，然后**先把四个 `DSH_WECHAT_GROUP_*` 开关名删掉**，再只按配置注入：
`PYTHONHOME`/`PYTHONPATH`/`PYTHONSTARTUP`/`PYTHONEXECUTABLE` 也一并显式删除（宿主自带的嵌入式解释器路径
传下去会让子进程在第一条语句前就死掉，表现为无信息的过程退出并让桥无限重试）。
为什么是"先删再注入"而不是"按条件追加"：配置必须能**关掉**一个开关，而不只能打开它。旧写法只追加，于是
宿主环境里残留的 `DSH_WECHAT_GROUP_ALLOW_WINDOW_RESTORE=1`（shell profile、HKCU\Environment、启动器包装
都可能是来源）会越过 `group-chats.json` 里的 `allowWindowRestore: false` 把抢屏通路点亮——老大以为自己已被
文件保护，实际没有。四个开关的对应关系：`allowUnverifiedRead` → `DSH_WECHAT_GROUP_ALLOW_UNVERIFIED=1`、
`allowSend` → `DSH_WECHAT_GROUP_ALLOW_SEND=1`、`allowWindowRestore` → `DSH_WECHAT_GROUP_ALLOW_WINDOW_RESTORE=1`、
`autoMinimize` → `DSH_WECHAT_GROUP_AUTO_MINIMIZE=1`（该开关现已是无操作，见下文撤回）。
配置里为 false 的开关一律不注入。

只读排障永远安全：`py -3.12 -B scripts/wechat_group_uia.py --probe`（不选群、不输入、不发送）。

### 无障碍标志（微信 4.x 的硬前提）

微信 4.x 的 `mmui::*` 无障碍控件树**只在微信进程启动那一刻系统「屏幕阅读器」标志已置位时才构建**；事后打开读屏、广播 `WM_SETTINGCHANGE`、重启微信以外的任何操作都补不回来。标志未置位时，主窗口在 UIA 里只剩一个空的 `MMUIRenderSubWindowHW` 面板，`mmui::MainWindow` 根本不存在。

置位（一次性，命令行即可，不需要读屏软件常驻）：

```bash
# 置位并回读；不需要装读屏软件，也不需要它常驻
py -3.12 -B scripts/enable_wechat_uia_flag.py
# 只查不改：加 --check；想恢复默认：加 --disable
```

顺序必须是**先置标志、再启动微信**；`enable_wechat_uia_flag.py` 管的是 `SPI_SETSCREENREADER` 这一半。

**2026-11-01 22:56 实测的第二半（c857cfb）：Qt 还按 `QT_ACCESSIBILITY` 决定要不要挂无障碍 provider。**
本机 `HKCU\Environment` 里当时**没有** `QT_ACCESSIBILITY`，这就是「今天群桥大部分时间是死的」的完整根因：
从任务栏图标拉起的每个实例都是**零 automation id**，只有启动时环境里带着 `QT_ACCESSIBILITY=1` 的实例才有树。
Qt 只在**进程启动那一刻**读这个变量，所以再多的轮询、重播 `SPI_SETSCREENREADER`、或任何窗口调用
都救不回一棵已经没挂 provider 的树——这条同时也排除了所有「再等等看」的方案。
`wechat_accessibility_unavailable` 的消息因此直接点名 `QT_ACCESSIBILITY=1`，并且仍然要求重启
（顺序只有「先设变量、再重启」有效）；
本次改动已经把该变量应用到用户环境里。核对（只读）：

```bash
reg query "HKCU\Environment" /v QT_ACCESSIBILITY    # 应当返回 1
py -3.12 -B scripts/enable_wechat_uia_flag.py --check
```

需要重启微信时（例如掉树、或改了上面的环境变量）：先看登录窗是哪一种状态——**记住的账号只需点「登录」
确认，不要靠反复重启去试**（重启一个已登录的微信正是丢登录态的动作，见下面两节）。

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
- **树的寿命：没人碰窗口的时候它很稳定**（2026-11-01 实测）。两段无干预观察：
  21:19:31–21:43 连续 **24 分钟**树在；22:17:28–22:21:29 约 **4 分钟**树在。
  早前那些「几十秒就没了」的读数**全部是我自己的窗口调用造成的**（我为了「看一眼」「切一下」
  去动面板），不是微信自己会掉树；曾写过的「树只能活约 15 秒」这类说法**已撤回，别再引用**。
  但最小化仍然不是解决办法——它在本 build 上确实会毁树（18:27 那次实测），只是不能把上面那些
  死亡记在它账上。可执行的结论只有一条：**别碰窗口**，让面板展开、侧栏不折叠，桥就能长期工作。
- **唯一实测有效的恢复动作**：重启微信客户端并走完一次登录流程（重启**必须带着**
  `QT_ACCESSIBILITY=1`，否则复现同一「无 provider」状态，见上；本机账号已记住，
  登录窗显示「当前登录用户大肥鱼」+「登录」按钮，无需扫码）。实测状态序列：
  `需在手机上完成登录 → 正在进入 → MAIN`，随后 `session_list` 10 项、目标群在列。
  注意该按钮的 UIA `Invoke()` 会**返回 true 而什么都不做**（同 `select_chat` 的撒谎
  行为），必须用真实点击。

### 登录窗有两种状态，处置完全相反（7422c01）

`mmui::LoginWindow` 出现在**两种**需要相反处置的状态里。旧分类器只看这个窗口存不存在，
于是把两种都报成 `wechat_logged_out`——而 `wechat_logged_out` 的处置是「先登录」，最常见的
做法就是重启微信，**重启会摧毁一个还活着的登录态**。2026-11-01 本机实测：

| 登录窗实测形态 | 代码返回 | 该怎么处置 |
|---|---|---|
| 记住账号：文本「当前登录用户大肥鱼 / 登录 / 切换账号」，且树里有一个**真 `ButtonControl` 名为「登录」** | `wechat_login_confirmation` | 打开微信点一下「登录」确认即可；**不要重启微信**（会话本来有效，重启才是丢登录态的原因） |
| 已登出：文本「仅传输文件 / 扫码登录」+ 一个「二维码」按钮、没有「登录」按钮 | `wechat_logged_out` | 扫码登录后再启动群桥 |
| 第三种（22:46 实测）：文本「需在手机上完成登录」，**没有**「登录」按钮 | 落到 `wechat_logged_out`（判据只有「有没有登录按钮」） | 需要操作员**本人手机**确认，代码无法自动化；群桥在此状态下只能等人工 |

判据是 `_login_window_offers_confirmation()`：它走**已经找到的那个** `mmui::LoginWindow`，
在 `maxDepth=20` 内找 `ControlTypeName == ButtonControl` 且 `Name` 去空白后**逐字等于「登录」**
的控件（不是「名字里含登录二字」）。任何一步读不出来都返回 `False`，于是退回较弱的
`wechat_logged_out` —— 没有证据就断言「你的会话还在，只需确认」正是绝对不能做的那个猜测。
`wechat_login_confirmation` 与 `wechat_logged_out` 一样是 surface-loss 码（两侧名单都有），
所以它照旧走慢梯重试；区别只在**日志里那句话不再教人去重启微信**。

### 会话侧栏被折叠时（9637d19）

实测形态：操作员折叠了会话列表，`session_list` **消失**，而 `chat_message_list` 与
`chat_input_field` **都还在**，目标群就显示在屏幕上。改动前桥报的是 `control_missing`，
而 `control_missing` 是 surface-loss 码 ⇒ 子进程退出 ⇒ 宿主按重启梯无限重试——面对一个
**任何 respawn 都展不开的侧栏**，桥就这么死循环了。现在的行为分三条：

1. `current_chat_title()`：取 `chat_input_field` 失败 ⇒ 返回 `None`（连聊天面板都没开，不猜标题）；
   `chat_input_field.Name` 带着**当前打开会话的精确标题**，所以当 `session_list` 真的不存在时，
   就用这个面板头作为标题（`return input_title.strip() or None`）。
2. `_assert_unique_title()`：只有在列数失败（列表不可用）时，才接受「打开的正是目标群」这一个证据；
   否则抛 `sidebar_collapsed`（消息直接写明「展开侧栏，或把目标群留在屏幕上」），不再谎报成
   `duplicate_group_title`——那个词说的是「两个会话同名」，会把人支去找重名。
3. **列表存在但没有唯一选中项时，一律不降级**：仍按两属性互相印证判定，不一致就抛
   `title_unavailable`。那是真歧义，必须当错误。

这个妥协是有界的：只适用于操作员用**精确标题**点名的那个群，每次读写前后仍会重查标题，
而没有列表根本切不了群，所以它不可能读到或写到别的会话。`sidebar_collapsed` **刻意不在
`SURFACE_LOST_CODES` 里**（`test_collapsed_sidebar_is_not_reported_as_a_lost_surface` 守着这条断言），
因此不会退出、不会上慢梯。

关于「不抢屏也能发送」，实测把可选通路一条条排除：

- Enter 走的是全局键盘注入，而键盘一次只属于一个窗口；`SetFocus` 在最小化窗口上
  **返回 false 且不激活**（自有窗口实验 `operator_kept_focus=true`），所以隐藏态
  根本拿不到键盘。
- 定向 `PostMessage`(WM_CHAR / WM_KEYDOWN) 投给**未聚焦**的标准 EDIT 也不生效
  （`delivered_without_focus=false`，且已带消息泵，排除假阴性）。
- ⇒ 真正不需键盘的通路只剩 InvokePattern 触发微信自己的「发送」控件
  （`send_by_invoke`，现为 `press_enter` 的首选路由 1）。

### 「这台 build 没有发送控件」是个假的结论——4fe8b1d 纠正

`--probe` 曾经报 `send_candidates: 0`，读起来像「本 build 不暴露发送控件」，
那会把后台发送彻底推回键盘通路——而隐藏窗口永远拿不到键盘。实测两处都是**我自己的代码问题**：

- **深度**。`mmui::XOutlineButton` 名为「发送」的按钮在 `mmui::MainWindow` 下**第 20 层**。
  旧的兜底遍历停在 18 层，定向查找又传了 `FirstChild=True`（把每层搜索限制在第一个子节点，
  而按钮在输入工具栏的**后面**分支上），两条路都到不了它。现在是 `CONTROL_WALK_DEPTH = 26`、
  `CONTROL_WALK_BUDGET = 6000`（都按实测树推出来：空闲会话约 170 个节点，留长消息列表的余量）。
- **超时**。uiautomation 2.0.29 的控件工厂**不接受任何 timeout 关键字**（签名实测：
  `searchFromControl, searchDepth, searchInterval, foundIndex, element, Name, SubName,
  RegexName, ClassName, AutomationId, Depth, Compare, searchProperties`）——写 `Exists=False`
  会被塞进 `searchProperties`，工厂返回一个**惰性**控件，第一次读属性才真正搜索，用的是库默认
  `TIME_OUT_SECOND = 10`。而 `SEND_LABELS` 当时是 `sorted()` 的集合，三个根本没用到的英文别名
  排在「发送」前面，于是一个不存在的标签就要烧掉整 10 秒。现在 `SEND_LABELS` 是**有序元组**，
  第一位就是本机实测在用的「发送」；探针自己用 `Exists(SEND_PROBE_TIMEOUT_S=0.6, 0.05)` 限时，
  不带惰性/剪枝关键字。
- **顺序**。docstring 原先说「定向查找比遍历树便宜」，这也是错的。修完以后在同一条活体树上量：
  一次有界遍历走完 170 个节点 **141ms** 就拿到按钮，而四个 Name 过滤探测同样答案要 1515ms
  （uiautomation 每个 Name 过滤都从根重新推导一遍树）。所以现在是**遍历先跑**，带标签的探测
  降级为「遍历一个也没找到」时的兜底（窗口中途脱离、或树比预算更深）。判定谓词统一在
  `_looks_like_send()`，两条通路用同一把尺子。

本机活体计时（同一条树，修前/修后）：

| 通路 | 修前 | 修后 |
|---|---|---|
| `_send_by_name_hint()` | 25.9s | 作为兜底保留，每次探测由 `Exists(0.6, 0.05)` 限时 |
| `_send_affordance()` | 34.5s | **156ms** |
| `--probe` 的 `send_candidates` | 0 | **1**（`发送` / `mmui::XOutlineButton`） |
| 一次有界遍历 | — | 170 节点 / 141ms |

仍未证的只剩一件事：**本 build 是否真的接受这个 Invoke**。`send_by_invoke()` 只报告
「控件存在且 `Invoke()` 返回成功」，交付与否仍由读回消息列表判定（这台 build 的
`select_chat` 已经示范过「返回 true 而什么都没发生」的撒谎行为），所以撒谎会在读回处被抓，
不会被当成功。

因此**桥绝不主动最小化**：`autoMinimize` 保留为根级开关（默认 false），但按上面的实测
它会让群桥失去树，属于「无人值守机专用、且明知会断桥」的选项，日常必须保持关闭。
本机 `group-chats.json` 已实测把它写回 `false`。（代码里仍有几处注释在说反话，逐条列在
下面「代码文本的跟进状态」一节，别照做。）

已闭环的部分：宿主已于 17:29 重启装上新 JS（`autoMinimize` 键已实测被校验器接受，
写入 false 无 `invalid-group-config`）；`poll_failed` 洪水已变成每次一条真实错误码 +
慢梯退避。慢梯**上限是两分钟**：`surfaceLossRestartDelaysMs = [30_000, 60_000, 120_000]`
（d69c7e9 之前顶档是 10 分钟，那意味着操作员修好微信后还要再等十分钟静音期）；
另一条快梯 `restartDelaysMs = [2_500, 5_000, 10_000, 30_000]` 给非 surface 故障用。
两条梯子由码名**在两侧名单里是否命中**来选：适配器 `SURFACE_LOST_CODES` 决定子进程要不要
以 `SURFACE_LOST_EXIT_CODE = 4` 退出，运行时 `SURFACE_LOSS_CODES` 决定退出后走慢梯还是快梯；
分类同时跑在 `#start()` 的失败路径上（冷启动时子进程根本没进轮询循环，只有退出事件可骑
的话就漏掉了最常见的「面板已关」这一路）。

轮询诊断现在**按 60 秒节流**（`ERROR_FRAME_WINDOW_S = 60.0`，9637d19）：同一条码不变的判断
一个窗口内只写一帧。两种情况绝不抑制——**码变了**（旧理由已过期，新症状不能藏在旧症状后面），
以及**致命码**（那一帧是宿主据以知道子进程为什么要退出的东西）。之前 750ms 节奏下的同一个
面板关闭状态能刷出每小时 80 行完全相同的日志，把唯一一条可处置的线淹掉了。

仍待活体复验（诚实边界，别当已通）：

1. **焦点守卫的真机形态**：守卫按「进程归属」判定（`GetFocusedControl().ProcessId`
   与微信主窗口 pid 相同）。该 API 本机可用性与语义已实测（前台 Chrome 的
   `OmniboxViewViews` EditControl 报 `hwnd=0` + 可用 pid，与 mmui 子控件同形），
   但 **mmui 真机上焦点被报成什么仍未活体复验**。复验当时做不成的原因是「没有树」，而这有两个
   已查明的来源、都不是「微信自己会掉树」：一是 `QT_ACCESSIBILITY` 缺失使进程从启动就没挂
   provider（c857cfb 的实测根因）；二是树存在时我自己的窗口调用把它毁掉（见上节 24 分钟 /
   4 分钟无干预实测）。

   这一项**不能用 `--probe` 复验**：`probe_evidence()` 输出的是 window / 三个 control /
   `send_candidates`，**不含焦点控件**。可行的复验办法只有一条非写路的：由操作员手工把光标放进
   微信输入框，再用只读 UIA 查询 `GetFocusedControl()` 的 `AutomationId`/`ClassName`/`ProcessId`/
   `NativeWindowHandle` 四个属性（不点击、不发消息、不动窗口）。写路径本身不算复验手段，因为它
   会把回车发进群。**当前代码没有这种只读焦点探针**（`--probe` 里没这项），补一个属于 `scripts/`
   的改动、不在本次文档写面内，因此这里登记为待办。目前已实测的部分只有间接证据：
   `_focus_is_contained()` 的 docstring 记着「最小化窗口上 UIA 把焦点报成一个中间 pane」
   （用自有 Tk 窗口复现：`TkChild`，句柄既非顶层也非输入框），据此才把判定从「同一控件」
   改成「同一进程」。mmui 自己报什么仍未直接观测。
2. **`send_by_invoke` 是否被本 build 接受**：同样待复验；`--probe` 现在会输出
   `send_candidates`，树一恢复就能一次读出，不必再猜。
3. 守卫按 #37 保守：证明不了键盘在微信内就拒发（宁可少发一条，也不把回车注入
   操作者正在用的程序）。这是「不控屏」优先于「必发出去」的有意取舍。

错误码现在区分**五种**「没有主窗口」：`wechat_login_confirmation`（记住的账号，点「登录」确认，
别重启）、`wechat_logged_out`（扫码；以及 22:46 实测那种要操作员手机确认的形态）、
`wechat_accessibility_unavailable`（面板可见但没挂 provider → 先设 `QT_ACCESSIBILITY=1` 再重启微信）、
`wechat_panel_closed`（壳窗被推到屏外/托盘尺寸 → 重开面板，别最小化）、
`main_window_missing`（没开微信）。分类器是 `classify_missing_main_window()`：先查
`mmui::LoginWindow`（再按有没有「登录」按钮分两种），否则在根窗口的子窗口里找带 `Qt` 类名、
名字含「微信/Weixin/WeChat」的壳窗，量它的 `BoundingRectangle`——**非离屏且宽高都 ≥ 400**
就是「面板明明开着却没有树」（实测 743x872、1477x880 都是可见且 0 节点），报
`wechat_accessibility_unavailable`；否则（含 X 关闭后停在 -32000,-32000 的 276x45 托盘尺寸壳）
报 `wechat_panel_closed`；几何读不出来时保守归离屏，即 `wechat_panel_closed`。

### 错误码全表（与代码逐条对齐，2026-11-01）

左列是 `scripts/wechat_group_uia.py` 里 `ERROR_MESSAGES` 的**全部 24 个键**，一个不多一个不少；
「消息」列就是字典里那句给操作员看的英文原文（同一次 `git grep -n "ERROR_MESSAGES = {"` 可复算）。
最后一列写这个码是不是 **surface-loss 码**——即它出现在**轮询**里时，适配器会把它记为
`fatal_code`、写一帧诊断，然后以 `SURFACE_LOST_EXIT_CODE = 4` 退出子进程，宿主随即走**慢梯**
（30s → 60s → 120s 封顶）；不是 surface-loss 的码则**不退进程**，桥继续按 `pollIntervalMs` 轮询。

> ⚠️ 判定只看 `SURFACE_LOST_CODES`（适配器）与 `SURFACE_LOSS_CODES`（宿主运行时）这两个集合，
> 不看 `ERROR_MESSAGES` 里有什么；也不只看退出码——`#onExit` 明确写着「它的退出码本身不够，
> 要的是稳定的错误码」。致命判定只发生在 `poll_frames()` 里（SafetyError 的码命中集合，
> 或裸 COMError 时 `backend.surface_state()` 分类出的码命中集合）；`handle_request()` 里同样的
> 码作为请求错误返回，**不会**触发退出。

| 错误码 | 消息（代码原文） | 什么时候出现 | surface-loss？ |
|---|---|---|---|
| `invalid_json` | The request is not valid JSON. | stdin 来的一行不是合法 JSON | 否 |
| `invalid_request` | The request shape is invalid. | 请求形状不对（缺 `type`、`send_text` 参数不合法、未知异常兜底） | 否 |
| `unknown_request` | The request type is not supported. | 请求 `type` 不是 health / send_text / stop | 否 |
| `unknown_chat` | The configured group chat ID is unknown. | `chat_id` 不在配置里；运行时会先以 `unknown-group` 拒发 | 否 |
| `duplicate_group_title` | The target group title is ambiguous. | **列表可用**但目标标题出现 0 次或 ≥2 次；`select_chat` 找不到唯一项 | 否 |
| `target_title_mismatch` | The current chat title does not match the target. | 同一个码有**两处抛出**：`_require_chat()`（读/写过程中标题不是目标，内部文本 `current chat differs from target`）与 `select_chat()`（所有激活尝试——Invoke，以及 opt-in 下 SetFocus+Click——都没让标题真的变过来，内部文本 `target chat could not be activated`）。操作员看到的是 `ERROR_MESSAGES` 那句，处置通常是把目标群置顶或还原窗口 | 否 |
| `target_draft_not_empty` | The target input contains an existing draft. | 目标输入框里已有内容，不敢叠加 | 否 |
| `input_verification_failed` | The target input did not retain the exact text. | 写入后回读不相等 | 否 |
| `input_not_cleared` | The target input was not cleared after sending. | 有回显但输入框没清空 | 否 |
| `readback_ambiguous` | The send read-back contains multiple matching messages. | 回读里匹配到多条同文消息，无法确定是哪条 | 否 |
| `outcome_unknown` | The send outcome is unknown; blind retry is forbidden. | 已按下发送却读不到唯一回显；`request_id` 再用来时原样返回，绝不盲重试。运行时把 `outcome_unknown`/`readback_ambiguous`/`input_not_cleared`/`restore_failed` 四个都归入 `UNKNOWN_SEND_CODES` 走对账 | 否 |
| `request_id_conflict` | The request ID was already used for another payload. | 同一 `request_id` 换了 chat/text | 否 |
| `restore_failed` | The previous chat or input state could not be restored. | 收尾恢复原聊天/原草稿失败；结果被改判为失败，绝不当成功 | 否 |
| `ui_failure` | The UIA operation failed before a send was attempted. | 发送尝试之前抛了非 BridgeError 的异常 | 否 |
| `poll_failed` | A read-only polling cycle failed. | 轮询失败但**分类不出**具体 surface 原因时的兜底；同样经 60s 节流 | 否 |
| `probe_failed` | The read-only UIA probe failed. | `ERROR_MESSAGES` 里备着的只读探针失败码（`--probe` 路径目前用退出码 1 + `type:"error"` 帧表达） | 否 |
| `send_disabled` | Sending is disabled until the operator enables it. | `DSH_WECHAT_GROUP_ALLOW_SEND != 1` | 否 |
| `wechat_logged_out` | WeChat is on its login screen; log in before starting the group bridge. | `mmui::LoginWindow` 在，且树里**没有**名为「登录」的 `ButtonControl`（含 22:46 那种「需在手机上完成登录」） | **是**（两侧名单都有） |
| `wechat_login_confirmation` | WeChat is asking to confirm the remembered account; open WeChat and press 登录 there. | `mmui::LoginWindow` 里有真「登录」按钮＝记住的账号，会话仍有效。**处置只有「点确认」，没有重启**——这是 7422c01 的全部意义 | **是**（两侧名单都有；慢梯是对的，因为它确实还没有窗口可用，只是不能读成「去登录」） |
| `wechat_panel_closed` | WeChat's panel was closed; reopen it and leave it open. | 有 `Qt` 壳窗但无 mmui 树，且它离屏/尺寸极小（实测 X 关闭后停在 -32000,-32000 的 276x45、iconic） | **是** |
| `wechat_accessibility_unavailable` | WeChat's panel is on screen but exposes no accessibility tree (WM_GETOBJECT returns 0). Set QT_ACCESSIBILITY=1 in the user environment, then restart WeChat - Qt attaches the provider only at process start, so a restart without it reproduces the same state. | 壳窗可见且宽高 ≥ 400 却没有 mmui 节点（实测 743x872、1477x880，`WM_GETOBJECT` 返回 0） | **是**（两侧名单都有） |
| `main_window_missing` | No WeChat window was found; start WeChat and log in. | 既无主窗、无登录窗、也无微信壳窗 | **是** |
| `focus_not_on_target` | Keyboard focus could not be proven to be on the WeChat input; nothing was typed. | 四条通路（Invoke 发送控件 → 微信已持键盘时 SendKeys → 定向 PostMessage → 一次 SetFocus 后复验）都证明不了键盘落在微信输入框，**一个字都没打** | 否 |
| `sidebar_collapsed` | WeChat's session sidebar is collapsed; expand it, or keep the target group open on screen. | 列表不可用且打开的会话头不是目标群（9637d19）。以前这情况报 `control_missing`/`duplicate_group_title`，于是永远重启重试一个 respawn 展不开的侧栏 | **否**（刻意排除；有断言守着 `assertNotIn`） |

### 表外但会出现在日志里的码

`ERROR_MESSAGES` 之外，代码还会发出这些稳定的码；「surface-loss」列同样按上面两个集合判：

| 错误码 | 出处 | surface-loss？ |
|---|---|---|
| `control_missing` | `UiaBackend._control()`：所需 AutomationId 缺失**或被多个控件持有**（`KNOWN_CONTROL_IDS` = `session_list` / `chat_message_list` / `chat_input_field`，必须唯一） | **是（仅适配器侧）**：在 `SURFACE_LOST_CODES` 里，轮询命中即退出走慢梯。9637d19 之后「折叠侧栏」不再归它，改判 `sidebar_collapsed` |
| `backend_closed` | `UiaBackend._control()` / `surface_state()`：后端已经 `close()` | **是（仅适配器侧）**：在 `SURFACE_LOST_CODES`，**不在**运行时 `SURFACE_LOSS_CODES`——被 `wechat-group-runtime.test.mjs` 的 `notASurface` 名单显式豁免（它是「桥自己关了」，不是「没了 surface」） |
| `unsupported_platform` | `UiaBackend.__init__()`：非 win32 | **是（仅适配器侧）**：同上，`notASurface` 豁免 |
| `dependency_missing` | `UiaBackend.__init__()`：没装 uiautomation | **是（仅适配器侧）**：同上，`notASurface` 豁免 |
| `message_layout_unverified` | `read_visible_rows_as_messages()`（由 `UiaBackend.read_messages()` 调用，`allow_unverified` 取自 `DSH_WECHAT_GROUP_ALLOW_UNVERIFIED`）：未开 `allowUnverifiedRead` 就读群 ⇒ fail-closed | 否。处置：在 `group-chats.json` 里置 `"allowUnverifiedRead": true` |
| `invalid_config`（snake_case，**适配器侧**） | `load_config()` / `WechatGroupAdapter._validate_groups()`（配置 `version != 1`、groups 为空、字段类型不对、非 `command` 模式既无 `triggerNames` 又无 `allowUnverifiedTrigger`、重复群 id 等）；`main()` 的兜底也写这个码 | 否（启动期直接失败，退出码 1） |
| `invalid-group-config`（kebab-case，**宿主侧**） | `wechat-group-config.mjs` 的 `loadWechatGroupConfig()` / `normalizeGroup()`：根级或群级出现 `ROOT_KEYS`/`GROUP_KEYS` 之外的键、类型不对、id/前缀不合规等 | **否，而且根本不重试**：`plugin-src/host/channels/weixin/group-source.mjs` 在**建 runtime 之前**就把它捕获，换成 `unhealthyGroupRuntime(code)`（`ready:false`、`handles()` 恒 false、`lastError` 就是这个码）。Python 子进程**一次都不会被 spawn**，两条重启梯都不参与；账号的 iLink 私聊完全不受影响（这是有意的隔离：坏配置不能拆掉直聊） |
| `invalid_message_shape` | `read_visible_rows_as_messages()`（单行不是 dict）/ `WechatGroupAdapter._read_target()`（后端返回的形状不是 `RawMessage`） | 否 |
| `invalid_event` | `validate_message_event()`（出站事件不满足 v1 契约：字段集合不严格相等、`reply_target != conversation_id`、身份边界被破坏等，宁可不发也不发错的） | 否 |
| `not_ready` | `WechatGroupAdapter.poll()`：基线还没建完 | 否 |
| `title_unavailable` | `UiaBackend.current_chat_title()`：**列表可用**却没有唯一选中项，或选中项标题与聊天头不一致 | 否——真歧义，必须留成错误（降级只允许发生在列表缺席时） |
| `input_unsupported` | `UiaBackend.read_input()` / `set_input()`（输入框没有 ValuePattern / 只读 / 拒收文本） | 否 |
| `bridge_error` | `BridgeError` 默认码与 `main()` 的最外层兜底 | 否 |
| `window_minimised` | **已不存在于 `scripts/` 与 `src/`**（`grep -rn` 零命中，只在 `test/channels/weixin/wechat-group-runtime.test.mjs` 的假进程里当任意非 surface 码用）。旧版手册把它列成桥会抛的码，是**错的**，已删。真实行为：最小化时 `ensure_window_restored()` 未 opt-in 直接返回（测试断言「一个 Win32 调用都不许发」），切群走 InvokePattern，发送走 `focus_not_on_target` 守卫 | — |
| 运行时层（kebab-case，来自 `wechat-group-runtime.mjs` / `wechat-group-process.mjs`） | `unknown-group`、`group-not-ready`、`shared-bridge-required`；进程层另有 `process-exit`、`process-not-ready`、`process-spawn-failed`、`process-write-failed`、`process-stopped`、`adapter-error`、`health-failed`、`invalid-jsonl`、`invalid-protocol`、`journal-invalid`、`journal-unavailable`、`request-id-conflict`、`send-rejected`、`start-timeout`、`stop-failed`、`stop-timeout` | 都不在这两个集合里（集合成员全是 snake_case 的适配器码）；`#onExit` 拿不到稳定码时记 `process-exit` 并走**快梯** |

### 代码文本的跟进状态（c857cfb 之后）

c857cfb 已经**改掉了两处最危险的代码文本**：`classify_missing_main_window()` 的 docstring 重写为
上面那五条实测状态清单（并明写「RETRACTED … **Never advise minimising**」），
`ERROR_MESSAGES["wechat_panel_closed"]` 也只剩 `reopen it and leave it open`。这条修复由两个测试钉住：
`test_panel_closed_message_does_not_advice_minimising` 与（改写过的）
`test_panel_closed_message_names_the_headless_fix`——后者以前断言消息里**必须出现** `minimise`，
也就是说旧测试曾把这条有害建议当成验收标准，现在它断言的是 `reopen` 在场、`minimis/minimiz` 缺席。

仍有**四处注释/文档字符串**写着「最小化还能喂桥」，它们是**代码文本，不是结论**，别照做：

1. `UiaBackend.maybe_auto_minimize()` 的 docstring：「The headless operating point is therefore
   minimised, where InvokePattern still switches chats and sends」；
2. `UiaBackend.select_chat()` 里路由 1 的注释：「InvokePattern … works with the window minimised」；
3. `UiaBackend.ensure_window_restored()` 的 docstring：「InvokePattern, which works while the
   window is minimised or hidden」；
4. `wechat-group-config.mjs` 里 `autoMinimize` 的注释：「minimise is the only state where a hidden
   WeChat still feeds the bridge」。

实测结论（8ef691d 的撤回记录 + 本机复测）：最小化**同样会毁掉这棵树上的树**（18:27 实测：
`SW_SHOWMINNOACTIVE` 之后窗口仍可见非图标化，UIA 全桌面 0 个 mmui 控件），所以这四处说的「最小化
态仍可用」都不成立。但**不要把早期的树死亡记在最小化账上**——早期那些几十秒的短命读数全部来自
我自己的窗口调用（见上一节的 24 分钟 / 4 分钟无干预实测）。核对方式只有一种：只读
`py -3.12 -B scripts/wechat_group_uia.py --probe`，期间**不要碰窗口**。

### 为什么桥不会自己把你的窗口拉回来

还原窗口（`ShowWindow(SW_RESTORE)` + `SetForegroundWindow`）会把屏幕从正在用电脑的人手里抢走，
所以插件**默认不做**：`ensure_window_restored()` 没有 opt-in 就直接 return，一条 Win32 调用都不发
（`test_default_restore_is_a_no_op_and_touches_no_window_api`、以及带真实句柄的反漏检版本
各断言一次 `fake_user32.mock_calls == []`）。这里**不会**抛 `window_minimised`——那个码已经从
`scripts/` 与 `src/` 里消失了（旧版手册把它当桥的现行码来写是错的）。最小化态的真实行为是：
切群走 InvokePattern（不需键盘、不动焦点），发送则被焦点守卫拦住并抛 `focus_not_on_target`，
桥保持离线而不是抢占键盘。确有需要（例如无人值守机）才在账号配置里显式打开：

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
  // 读 / 发 / 抢屏还原 / 自动最小化四个根级布尔开关，默认全关，按需逐项打开：
  "allowUnverifiedRead": true,
  "allowSend": true,
  "allowWindowRestore": false,
  "autoMinimize": false,
  "groups": [
    {
      "id": "uia_<stable-random-id>",
      "title": "精确群名（与 session_item_ 一致）",
      "commandPrefix": "/dsh",
      "mentionMode": "command",
      "allowSelf": false
      // 想让直接 @ 也能触发：改 mentionMode，并且下面两样**至少给一个**
      // （mention 系模式下两者都不给 ⇒ invalid_config）：
      // "mentionMode": "mention-or-command",
      // "triggerNames": ["机器人名"],     // 未来 build 若暴露可读的 @ 名字
      // "allowUnverifiedTrigger": true,   // 本机形态：名字被抹成 ___，只能按 @[...] 形状认
    }
  ]
}
```

根级键的**允许集合**（`wechat-group-config.mjs` 的 `ROOT_KEYS`）：`version`、`pollIntervalMs`、
`groups`、`allowUnverifiedRead`、`allowSend`、`allowWindowRestore`、`autoMinimize`；
群级键（`GROUP_KEYS`）：`id`、`title`、`commandPrefix`、`mentionMode`、`allowSelf`、
`allowUnverifiedTrigger`、`triggerNames`。出现集合外的键或类型不对一律 `invalid-group-config`，
群桥不启动。`mentionMode` 只有 `command` / `mention` / `mention-or-command` 三种；
非 `command` 时必须给 `triggerNames` 或 `allowUnverifiedTrigger`，否则同样判 invalid。

没有此文件时**不会启动 Python 进程**，私聊 iLink 行为完全不变。

## 实测证据（2026-10-31）

- 真实群 `零食快递洗鞋打扫外卖代写`（175 人）：
  - 观察模式启动成功，基线建立、两次轮询 0 新事件（群内确实无新消息）
  - 打开发送开关后发送 `DSH probe2 ...` → `ok=true`，下一次轮询**捕获到该消息**为 1 条新事件，`sender=uia-unverified:row`、`addressed=false`
- 已验证的失败假设（勿重复尝试）：气泡左右对齐（整行同 x/w）、`TextPattern`/`ValuePattern`/`LegacyIAccessible`（本机均 AttributeError）

## 已知风险

1. **无法区分自己与他人**：若群成员恰好手工发了与机器人完全相同的一句，观察侧无法分辨。
2. **默认不能自动回复**：`mentionMode` 默认 `command`，未验证身份的行永远不 addressed。
   772a02e 之后群可以显式改 `mention` / `mention-or-command`，加上 `triggerNames` 或
   `allowUnverifiedTrigger` 让直接 @ 也触发；但被抹名的 `@[___]` 只证明“有人被 @ 了”，
   **证明不了被 @ 的是不是机器人**，所以这条触发永远建立在逐群显式 opt-in 之上，不是默认能力。
3. **UIA 依赖已登录且树健在的窗口**：`--probe` 会把「没有主窗口」的几种原因分开报
   （`wechat_login_confirmation` / `wechat_logged_out` / `wechat_panel_closed` /
   `wechat_accessibility_unavailable` / `main_window_missing`），处置完全不同：记住的账号**只需点
   「登录」确认，绝不能重启微信**（重启正是丢登录态的动作）；面板可见却无 provider 时，
   必须**先设 `QT_ACCESSIBILITY=1` 再重启**，裸重启只是复现同一个无树状态（c857cfb）；
   操作员折叠侧栏报 `sidebar_collapsed`，重启子进程对它毫无办法（它不在 surface-loss 名单里，
   所以桥不会陷入无限重试）。
4. **滚出可视区的历史消息不可回溯**：只读当前可见气泡。

## 安全设计要点（已实现，有测试）

- 单会话锁（`threading.Lock`）：`start` / `poll` / `send_text` / `health` / `close` 全部串行；发送前后逐次复核标题。
- 选群**首选 InvokePattern**（协议级、不动焦点、不注入合成输入），并且**永不假设它成功**——
  本 build 会返回 True 而什么都不切，所以必须回读标题确认；`SetFocus()+Click()` 只在
  `allowWindowRestore` opt-in 下作为第二路尝试，且拒绝在 `IsOffscreen` 的项上点击（缓存矩形
  会落到桌面别的像素上）。`SelectionItemPattern.Select()` 同样撒谎，已弃用。
- 恢复原聊天；恢复失败判 `restore_failed`，不当作成功。
- 发送幂等：`request_id` 预约后先落盘状态，`unknown` 永不盲重试。
- 未验证身份默认一律 `addressed=false`，不得执行命令、不得走 owner 豁免；唯一的放宽是**该群自己**
  写 `"allowUnverifiedTrigger": true`，且它只改变「这条行不算冒充某个成员」的判断，
  永远不产生成员身份（`from_user_id` 仍是 `uia-unverified:row`），其它群一律照旧拒。

## 回滚

```bash
# 恢复官方 5.8.0 包
cp -a "C:/Users/37533/.dsh/plugin-backups/dsh-im-5.8.0-pre-wechat-groups/dsh-im" \
      "C:/Users/37533/.dsh/profiles/desktop/node_modules/@xmanrui/dsh-im"
# 然后重启 DSH Desktop
```

或直接删除账号级 `group-chats.json`（群桥不再启动，私聊不受影响）。
