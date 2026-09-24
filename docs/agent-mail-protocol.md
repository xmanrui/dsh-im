# 腾讯 Agent 邮箱（agent.qq.com）接入要点

> **实现方式**：调用官方 `@tencent-qqmail/agently-cli`（子进程 + JSON stdout）。
> 早期版本曾手写 HTTP 客户端，因 `app_id` 并非公开常量而无法刷新令牌，已废弃。
> 文中 REST 细节仅作背景参考，实际以 CLI 为准。

## 为什么用官方 CLI

手写客户端在收信上可用，但**刷新令牌始终被拒**（`invalid_grant`）。根因：

```
app_id 是【服务器每次授权分配的】，不是客户端常量。
旧文档里写的 cli_002e8cd1f5e97858 是错的 ——
服务器接受它并签发 access_token，但对应的 refresh_token 会被拒。
```

实测证明（在 `+me` 返回中读取）：

```
旧授权: app_id = cli_002e8cd15c306a19
再授权: app_id = cli_002e8cd1c82b8966
```

**同一个客户端，两次授权拿到不同的 app_id。**

CLI 内部完成了钥匙串存储、`expires_at` 主动刷新、`withWatchReauth` 重授权，
实测刷新成功：

```
agently-cli auth refresh → {"status":"refreshed","token_status":"valid"}
```

因此传输层改为驱动 CLI，插件**不再存储任何令牌**，约 200 行 OAuth/刷新代码被删除。

## 常量

| 名称 | 值 |
|---|---|
| API_BASE | `https://api.agent.qq.com` |
| AUTH_BASE | `https://auth.agent.qq.com` |
| 凭据存储 | **加密文件钥匙串** `~/.local/share/agently-cli/{bootstrap_token.enc,master.key}` |
| CLI 配置 | `~/.agently-cli/config.json`（含授权的 `app_id`）|

**UA 必须匹配 CLI 自身**：服务器按 User-Agent 校验客户端，自定义标识会被拒为
`unsupported client`。用 CLI 时无需关心——它自带正确的 UA。

## 账号隔离：`AGENTLY_WORKSPACE`

CLI 按 workspace 隔离账号。**没有 `--alias` 参数**（邮箱别名自动识别）。

```bash
AGENTLY_WORKSPACE=<name> agently-cli +me
```

一个 workspace 对应一份登录。渠道把每个邮箱的地址作为 workspace 名，
使多个 Agent 邮箱互不串号。

**回退规则**：若指定 workspace 无登录，CLI 会回退到 `default`。
这会让第二个邮箱**读到第一个账号**，因此传输层用 `#assertIdentity` 校验
CLI 返回的地址与配置是否一致，不一致即拒绝启动。

## OAuth 设备流（微信扫码）

**这里是最容易翻车的地方**，官方文档没写清楚：

1. `agently-cli auth login` 输出授权链接后**不退出**，一直等扫码 ——
   必须后台运行（`nohup ... &`），否则前台卡住。

2. 授权页上的二维码是**微信登录二维码**，嵌在
   `open.weixin.qq.com/connect/qrconnect` 的**跨域 iframe** 内。

   **不要把页面 URL 编码成二维码** —— 扫出来只是一串网址，登不了。

   取真实二维码（从 network 里找图片直链）：

   ```bash
   curl -sL "https://open.weixin.qq.com/connect/qrcode/<CODE>" -o qr.jpg
   # 470x470 JPEG
   ```

3. **二维码有效期约 2–3 分钟**。过期后 network 出现
   `action=connect_qrconnect_longpull_success_408`，进程报
   `authorization expired, please retry`。

4. **扫码后必须点「确定」**。扫码成功 ≠ 授权完成，页面会进入**账号选择页**，
   必须选邮箱并点「确定」，否则 CLI 永远等不到凭据，`auth status` 一直是
   `not_logged_in`。**这个失败没有任何报错提示。**

5. **代理会打断凭据换取**。扫码后 CLI 要去 `auth.agent.qq.com` 换 token，
   有代理时可能报 `unexpected EOF` —— **页面显示"登录成功"但 CLI 没拿到凭据**。

   ```bash
   nohup env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
     -u ALL_PROXY -u all_proxy -u NODE_USE_ENV_PROXY \
     agently-cli auth login > /tmp/login.log 2>&1 &
   ```

   成功时日志尾部是 `OK: 认证成功`。

## 限流：官方不给数字

**三个官方来源全都没有限额数字**：文档（63 行）、官方 skill（233 行）、`--help`。

唯一来源是 `+me` 返回的 `data.rate_limits`（schema 声明字段存在，但不给值）：

```bash
agently-cli +me   # 读 data.rate_limits
```

**因此代码不硬编码轮询间隔**，而是运行时读取并推导，留一半额度给读信/回信：

```javascript
const usable = Math.floor(perMinute / 2)
const interval = Math.ceil(60000 * perRequest / usable)
```

### 429 必须退避

被限流后**按固定间隔重试 = 持续打满额度 = 永不恢复**。渠道现在：

- 识别 429（`status` / `code` / 消息文本三种形态）
- 退避：延迟倍增，**15 分钟封顶**
- 成功一次即重置
- 暴露 `retryAt` 供 UI 展示

### 重新授权 / 注销重建 **都不能重置额度**

实测三次，全部仍 429：

| 尝试 | 结果 |
|---|---|
| `auth logout` + 重新登录 | ❌ |
| 重新扫码授权（新 token） | ❌ |
| **管理端注销地址 → 重建 → 重新授权** | ❌ |

**限流按账号算，与授权、地址、CLI 都无关。只能等。**

## 管理端（`https://agent.qq.com/page/setting`）

侧栏底部 →「管理邮箱地址」→ 每个地址有「解绑」/「注销地址」（后者不可逆）。

- **注销后 token 立即失效**：`401 Invalid or expired access token`，
  必须重新授权。
- **90 天保留期内无法换地址**：注销后新建，前缀输入框是**只读的**，
  官方提示"新建地址将复用该地址，暂不支持修改"。

## 两步确认

写操作（发信/回复）首次返回 `confirmation_required` 与
`confirmation_token`，带 token 重发同一命令即完成。渠道的 `#withConfirmation`
自动处理。

**注意**：正文通过 `--body <text>` 传递。`--body-file -` **不是 stdin** ——
CLI 会把 `-` 当文件名，报 ENOENT。

## 命令要点

| 命令 | 说明 |
|---|---|
| `+me` | 身份 + `rate_limits` + `constraints` |
| `auth login\|logout\|refresh\|status` | 授权管理 |
| `message +list\|+read\|+search\|+watch\|+send\|+reply\|+forward\|+trash\|+delete` | 邮件操作 |
| `attachment +upload\|+download` | 附件 |

- stdout 是**纯 JSON**，`tip:` 行在 stderr。
- **退出码恒为 0**（即使返回错误文档），只能靠 `ok` 字段判断成功。
- `--print-output-schema` 可查任意命令的输出字段。

## 与标准 IMAP/SMTP 的差异

| 维度 | 标准邮箱 | Agent 邮箱 |
|---|---|---|
| 认证 | 邮箱授权码（IMAP/SMTP）| **微信扫码 OAuth** |
| 实现 | imapflow + nodemailer | **官方 CLI 子进程** |
| 令牌 | 长期有效 | 1 小时过期，CLI 自动刷新 |
| 限流 | 无 | **有，且官方不公布数字** |
| 适用范围 | 任意邮箱 | 仅腾讯 Agent 邮箱 |
