# 本地运行环境 —— 重启、取 token、核对与重装

> 用途：**换一台终端、重启机器、或者换一个不记得上下文的助手之后，照着它就能把这套环境恢复到可用状态。**
> 全部路径、端口、哈希、界面取值均为 2026-09-15 在本机实测所得，命令可直接复制。
> 相关：[ADR-0002 表现层样式契约](adr/0002-presentation-layer-style-contract.md)。

## 0. 先读这一句

**本次重启不需要重装。磁盘上已经是最新构建**（已安装副本的 `lib/client.js` 与 `lib/index.js` 哈希与仓库 HEAD 逐字节相同），
版本号改写也已在位（已安装副本为 `4.20.3-local.0`）。

**重启的唯一作用是：让正在运行的进程重新加载当前宿主端产物。**
客户端产物（`lib/client.js`）刷新浏览器即生效，但宿主端（`lib/index.js`）只在进程启动时装载一次，
所以磁盘更新了、运行中的进程却仍是旧的 —— 这才是需要重启的原因。

重启后要做的只有两件事：**把两个实例拉起来**，然后**按 §4 核对**。
重装步骤见附录 A，本次不用执行。

## 1. 固定坐标

| 项 | 值 |
|---|---|
| 仓库 | `D:\ProjectSomething\dsh-im` |
| 分支 | `refine/ui-settings-hierarchy` |
| 基点 | `0d36ae3`（实测等于 `origin/main`） |
| 停机时 HEAD | **本文件所在的那个提交**（用 `git log -1 --format=%H -- docs/local-environment.md` 取，见 §4.3），基点之上 **83** 个提交 |
| 证据目录（**不在版本控制内**） | `D:\ProjectSomething\dsh-im-ui-evidence` |
| 宿主源码（**只读，禁止修改**） | `D:\ProjectSomething\deepseek-harness` |
| dsh CLI | `C:\Users\speak\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js`，由 PATH 上的 `dsh` 调用 |
| node | `E:\nodejs\node.exe` |

### 两个实例

| | **3080（真实实例）** | **3081（隔离自检实例）** |
|---|---|---|
| DSH_HOME | `C:\Users\speak\.dsh`（默认，不设即为此值） | `C:\Users\speak\.dsh-imui` |
| profile | `web` | `imui` |
| 端口 | 3080（默认） | 3081 |
| 语言 | English | 中文 |
| 真实机器人 | 只配了飞书 | 无 |
| 插件安装形态 | **真实拷贝** | **符号链接** → `D:\ProjectSomething\dsh-im` |
| 改完仓库要不要重装 | **要** | **不要**（链接自动跟随仓库） |

- 3080 安装路径：`C:\Users\speak\.dsh\profiles\web\node_modules\@xmanrui\dsh-im`
- 3081 安装路径：`C:\Users\speak\.dsh-imui\profiles\imui\node_modules\@xmanrui\dsh-im`

因为 3081 是指向仓库的符号链接，**它读的就是仓库当前的 `lib/`**，版本号也永远等于仓库 `package.json` 的版本号。

⚠️ 桌面脚本的文件名是 `start‑dsh.ps1`，其中那个连字符是 **U+2011（非断行连字符）**，不是普通减号。请用 Tab 补全，不要手打。

## 2. 启动两个实例

### 3080

双击桌面 `start‑dsh.ps1`。该文件完整内容就是三行：

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Host "Starting DSH Web..."
dsh web
```

等价的手工命令（在任意目录执行均可，profile 由 DSH_HOME 决定，不依赖工作目录）：

```powershell
dsh web
```

预期：终端打印监听地址并**自动打开浏览器**；进程命令行形如
`"E:\nodejs\node.exe" ...\@deepseek-ai\dsh\lib\bin.js web`。

### 3081

停机前它由一个常驻后台作业持有，其完整命令行为（已从进程表读出，非推测）：

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$env:DSH_HOME = "C:\Users\speak\.dsh-imui"
$env:DSH_WEB_URL = ""
Remove-Item Env:\DSH_SESSION_ID -ErrorAction SilentlyContinue
dsh --profile imui --port 3081 --no-open 2>&1
```

**这个作业会随本次重启一起结束，不需要在停机前主动去停它。**
重启后按上面这段重新拉起即可（工作目录无关紧要，端口 **3081**，profile **imui**，DSH_HOME **`C:\Users\speak\.dsh-imui`**）。
最后一行可以简写成 `dsh --profile imui --port 3081`；**去掉 `--no-open` 就会自动开浏览器，token 直接从地址栏拿**。

预期：终端打印监听地址、不自动开浏览器（若保留 `--no-open`）；进程命令行含 `--profile imui --port 3081 --no-open`。

## 3. 取当前有效的 token 并自测

**token 由服务在启动时打印，不落盘**（在 `C:\Users\speak\.dsh` 下全目录搜索当前 token，唯一命中是会话缓存文件里的偶然出现，不可用作来源）。
每次重启都从**启动终端输出**或**浏览器地址栏**取。

### 自测

```powershell
# 期望输出 200（把 <TOKEN> 换成实际值）
Invoke-WebRequest "http://127.0.0.1:3080/?token=<TOKEN>" -MaximumRedirection 0 |
  Select-Object -ExpandProperty StatusCode

# 期望输出 401 —— 这是「服务活着」的信号，不需要 token
try { Invoke-WebRequest "http://127.0.0.1:3080/" -MaximumRedirection 0 }
catch { [int]$_.Exception.Response.StatusCode }
```

实测判据：不带 token、带错误 token、以及 `/api/health` **三者都返回 401**。
所以 **401 = 服务在跑且认证生效；连接被拒 = 服务没起**。没有免认证的健康检查端点。
## 4. 重启后你自己能验证的清单

### 4.1 版本号：确认改写仍在位

已安装副本（3080）必须读出 `4.20.3-local.0`：

```powershell
(Get-Content "C:\Users\speak\.dsh\profiles\web\node_modules\@xmanrui\dsh-im\package.json" -Raw |
  ConvertFrom-Json).version
```

⚠️ **不要用界面上的版本徽标核对这一项。** 实测：徽标在页面加载时用的是**构建时烘进 bundle 的**版本
（`plugin-src/client/index.js:218` 的 `IM_PLUGIN_VERSION`），随后才被宿主快照覆盖（同文件 `:251`）。
停机前它在界面上稳定显示 `v4.20.2` —— 那是**构建当时的仓库版本**，与「安装副本被改写后的版本」本来就是两回事。
更新判定读的是安装副本的 `package.json`（`plugin-src/host/update-service.mjs:122` 的 `runningVersion = manifest.version`），
所以核对点在那里，不在徽标上。

### 4.2 构建产物哈希：确认安装副本 == 仓库 HEAD

```powershell
$repo = "D:\ProjectSomething\dsh-im\lib"
$inst = "C:\Users\speak\.dsh\profiles\web\node_modules\@xmanrui\dsh-im\lib"
foreach ($f in @("client.js","index.js")) {
  $a = (Get-FileHash "$repo\$f" -Algorithm SHA256).Hash
  $b = (Get-FileHash "$inst\$f" -Algorithm SHA256).Hash
  "{0,-10} equal={1}" -f $f, ($a -eq $b)
}
```

停机时的实测值（重启后应当**逐位相同**）：

| 文件 | SHA256 | 字节 |
|---|---|---|
| `lib/client.js` | `9941BCD454101525BA5A1E62FF1A803ED1A476F389DC2D2BCEF34AFB4831CBE0` | 1010373 |
| `lib/index.js` | `60DCF64B969AC255779E8D1D3CC7B1BC77BEB67776071934F3FAC9149AFC2578` | 8570204 |

仓库与已安装副本这两个文件**都相等**。等号成立就说明「磁盘上安装的就是 HEAD 的构建」——
这也是 §0 说「本次不需要重装」的依据。

### 4.3 仓库状态

```powershell
cd D:\ProjectSomething\dsh-im
git rev-parse HEAD                  # 期望 = 本文件所在的提交（见下方说明）
git rev-list --count 0d36ae3..HEAD  # 期望 83
git log -1 --format=%H -- docs/local-environment.md   # 停机时的 HEAD
git status --porcelain              # 期望无输出
git rev-parse origin/main           # 期望 0d36ae3
```

> 「停机时 HEAD」之所以写成自指、而不是一串写死的 sha：**本说明自己也是这个分支上的一笔提交**，
> 把 sha 写进正文，提交它就会让那个 sha 失效（第一次就是这么踩到的）。用自指则永远成立。

### 4.4 界面标志物：确认跑的是当前构建

三个标志物都取自本分支最近几笔改动，**停机前在 3080 上逐个实测过**。
打开 设置 → IM bots，在浏览器控制台粘这一段：

```js
document.querySelector(".dim-scanButton").getAttribute("data-kind")        // 期望 "secondary"
document.querySelectorAll(".dim-channelHelpButton").length                  // 期望 0
document.querySelectorAll('[role="tab"]').length                             // 期望 12
getComputedStyle(document.body).getPropertyValue("--dim-font-mono").trim()  // 期望宿主等宽栈（非空）
getComputedStyle(document.body).getPropertyValue("--dim-gap-3").trim()      // 期望 "3px"
getComputedStyle(document.documentElement).getPropertyValue("--dim-gap-3").trim() // 期望 ""
```

| 标志物 | 期望 | 证明什么 |
|---|---|---|
| 扫码按钮 `data-kind` | `secondary` | 本分支最后一笔改观感的提交（`d34c799`）已生效；旧构建是 `primary` |
| `.dim-channelHelpButton` 数量 | `0` | 频道头的帮助已改成内联文字，那个「?」圆按钮不存在了 |
| `[role="tab"]` 数量 | `12` | 渠道切换是**一排可换行的 tab 条**，不是第二列导航（`7c1afc0`） |
| `body` 上的 `--dim-font-mono` | 宿主等宽栈、非空 | token 层声明在 `body` 上（宿主在 `<body>` 发布 `--dsw-*`） |
| `--dim-gap-3` 在 `body` / 在 `<html>` | `3px` / 空串 | 同上：声明位置正确，没有被冻在 `:root` 的回退值上 |

**肉眼等价物**（不想开控制台就看这三处）：

1. 进「设置 → IM bots」，**左侧渠道是一排可换行的 tab 条**，页面里没有第二列渠道导航。
2. 渠道标题旁边**没有「?」小圆按钮**，说明文字直接写在标题下面。
3. 扫码接入按钮是一个**中性描边的胶囊**；鼠标悬停时**只有底色变化、描边不变**（原生 `.outline` 按钮的行为）。
   旧构建在深色主题下会给它描一圈近白色的边。

## 5. 恢复后的测试口径

```powershell
cd D:\ProjectSomething\dsh-im
npm test
```

预期：**2793 项 / 2749 通过 / 43 失败 / 1 跳过**（`2793 = 2749 + 43 + 1`）。
那 43 项全部是既有的 Windows 平台性失败（POSIX 权限位、Host apiProxy 组装、安装/重启时序、路径分隔符），
干净 main 基线同样失败，且**失败测试名集合与基线逐条一致**。

⚠️ 安装/重启时序那一族**跑与跑之间会波动**，所以「失败数从 43 变 42」**不代表修好了任何东西**；
口径一律以**失败测试名集合**为准，不以失败条数为准。

改样式后另跑 UI 门禁（期望 **174 项全绿**）：

```powershell
cd D:\ProjectSomething\dsh-im
node --test test/client-native-border-contract.test.mjs test/client-role-form-contract.test.mjs `
  test/client-toolbar-role-contract.test.mjs test/client-ui.test.mjs `
  test/context-enhancement-ui.test.mjs test/client-delivery-settings.test.mjs `
  test/model-setting-ui.test.mjs test/workspace-editor.test.mjs test/bot-alias-ui.test.mjs `
  test/channels/dingtalk/client-ui.test.mjs test/channels/telegram/client-ui.test.mjs
```
## 6. 未决与待办

**权威来源**（按优先级，不依赖任何助手的记忆）：

1. `D:\ProjectSomething\dsh-im-ui-evidence\handoff\00-STYLE-MEMO.md` —— 恢复工作口径的第一入口；
   数字与行号一律锚定提交号，旧结论参照系不同时会标注适用范围。
2. `docs/adr/0002-presentation-layer-style-contract.md` —— 表现层的四条层叠机制、验收口径、已收敛轴与四项裁决。

**技术侧：没有未完成的收敛工作。** 四项待定已按维护者授权逐项决定并落盘，理由与实测值写在 ADR-0002 的 Consequences 与备忘第八章。

**等待维护者，不是技术未决**：

| 项 | 状态 |
|---|---|
| README 六张设置页截图重拍 | 卡环境：原图是 macOS chrome + DPR 2；3080 上 `set viewport 1282 837` 能复现构图，但 DPR 固定为 1、没有 macOS 标题栏。方案见证据目录 `handoff/readme-screenshot-plan.md` |
| P3 提案与 PR 正文 | 待过目，见证据目录 `P3-proposal.md`、`PR-body.md` |
| PR 分组与压缩 | 地图见证据目录 `handoff/pr-map.md`（定格在 82 个提交 / `7fb6b80`，之后又落了本说明这一笔）：7 桶。`lib/` 占净 diff 的 46%，逐提交审阅时约 65%，所以「排除构建产物再审」在本仓库不可行 |
| 「变淡」复核 | 24 条逐条清单（元素 / 旧值 / 新值 / 对比度前后 / 在 3080 哪里看）见证据目录 `handoff/fade-review.md` |
| push / 开 PR | **均未做**，需显式授权 |

## 附录 A：将来确实需要重装时（本次不需要）

3080 的已安装副本是**真实拷贝**而不是链接，所以仓库改了它不会自动跟随。
只有当 §4.2 的哈希核对**不相等**、而且你确实想把磁盘上的安装刷成 HEAD 时才需要重装。

```powershell
cd D:\ProjectSomething\dsh-im
git rev-parse HEAD                       # 先记下要装的 sha
npm run build                            # 必须先构建：install 拷的是工作树当前内容
node bin\dsh-im.mjs install --source .
```

**两个已知副作用**（读 `bin/dsh-im.mjs` 得到，不是推测）：

1. 它执行的是 `dsh plugin --profile web add --save-exact <仓库绝对路径>`，会**改写**
   `C:\Users\speak\.dsh\profiles\web\package.json` **里的依赖写法** —— 从现在的 registry 版本范围
   `"@xmanrui/dsh-im": "^4.20.2"` 变成仓库绝对路径。
2. 因为是拷贝，重装后安装副本的版本号会**回到仓库的 `4.20.2`**，附录 B 的改写要重做一遍。

只想同步产物、不动 profile 与版本号，用这个更小的做法即可：

```powershell
cd D:\ProjectSomething\dsh-im
npm run build
Copy-Item lib\client.js "C:\Users\speak\.dsh\profiles\web\node_modules\@xmanrui\dsh-im\lib\client.js" -Force
Copy-Item lib\index.js  "C:\Users\speak\.dsh\profiles\web\node_modules\@xmanrui\dsh-im\lib\index.js"  -Force
```

（3081 是符号链接，上面两种做法都不需要 —— 它永远读仓库。）

## 附录 B：版本号改写（本次只核对，不重做）

**核对**：§4.1 的命令，期望 `4.20.3-local.0`。

**它为什么存在**：更新判定在 `plugin-src/host/update-service.mjs:197` ——
`canInstall` 要求 `semver.gt(已发布版本, 运行中版本)`。npm 上 `@xmanrui/dsh-im` 的 latest 是 `4.20.2`，
把安装副本写成 `4.20.3-local.0` 之后 `gt` 为假，界面上的「一键更新」保持禁用，不会被换回发布版。

**本案里它是唯一一道保护**：3080 的 profile 依赖当前是 registry 写法 `^4.20.2`，
宿主因此**不认为**它是 source 安装（`plugin-src/host/update-runtime.mjs:283` 的 `sourceInstall` 为假），没有第二道拦截。
（3081 的依赖写成 `link:...`，`sourceInstall` 为真，天然免疫。）

**将来若要重做**（例如附录 A 的重装之后）：

```powershell
$pj = "C:\Users\speak\.dsh\profiles\web\node_modules\@xmanrui\dsh-im\package.json"
$lines = Get-Content $pj
$lines = $lines -replace '^(\s*)"version":.*$', '$1"version": "4.20.3-local.0",'
Set-Content -Path $pj -Value $lines -Encoding UTF8
Select-String -Path $pj -Pattern '"version"'      # 核对
```

改完刷新浏览器再看更新面板即可。
