# dsh-im 兼容原版 DSH 0.1.5：实施与实测记录

日期：2026-09-09，Asia/Taipei。

本次最终改动全部位于 dsh-im。使用未经本次修改的 DSH `0.1.5-alpha.1`，确认全部管理入口可用，并通过本机飞书、钉钉、企业微信和 Telegram 各一个机器人的真实收发测试。此前修改 DSH 的方案已经撤销，其历史测试不作为本次验收依据。

## 实现

新增 `plugin-src/management-rpc.mjs`，共用两个入口：`registerManagementRpc()` 和 `callManagementRpc()`。

- Host 通过公开的 `ctx.connection.fetch.register()` 注册每个逻辑渠道的固定 POST 路由，路径为 `/api/dsh-im${channel}`。
- Client 继续使用 DSH 原生 `connection.rpc.call('/api', 'dsh-im' + channel, { method, payload }, signal)`，由 DSH 负责请求编号和响应关联。
- 适配模块解包后调用现有 handler，保留原业务结果，并为缺少 `error.details` 的失败结果补充 `{}`。
- 所有版本共用同一实现，没有版本分支、备用地址重试、额外 HTTP 服务、DSH 私有接口调用或运行时方法替换。
- 覆盖十个 IM 渠道、Office、更新、入站 TTL 和主动投递管理。保留消息收发、连接监督、凭据存储以及已有 Harness 新旧接口适配。
- 原有启动流程继续先注册管理入口，再初始化渠道；初始化错误可通过管理接口返回，其他渠道继续启动。
- 注册清理由 DSH 原生 Fetch registry 的调用者生命周期负责。

`/api` 仍执行 DSH 原有浏览器认证、Host／Origin 检查和缓冲请求体限制。适配模块落实 dsh-im 的 `rpcAuthority`：默认回环访问；`trusted-host` 使用已通过 DSH 认证和信任检查的请求；更新与 TTL 管理始终仅限回环。取消信号继续传给业务 handler。

更新了兼容元数据、中英文 README 和 dsh-im 自身构建产物。插件版本仍为 `4.17.0`，本次提交兼容修复，不发布 npm 包。

## 原版 DSH 兼容矩阵

每个版本使用独立临时 `DSH_HOME` 和 Web profile，不读取真实机器人的配置；全部加载同一份最终 dsh-im 构建。测试直接使用各版本原生客户端 RPC 调用器，以验证真实包络解析和错误响应，而不只检查 HTTP 状态码。

| 原版 DSH | 14 个管理入口 | 原生客户端错误解析 | 原生路由生命周期 | HTTP 认证与输入检查 |
| --- | --- | --- | --- | --- |
| `0.1.2-alpha.4` | 通过 | 通过 | 通过 | 通过 |
| `0.1.2-alpha.5` | 通过 | 通过 | 通过 | 通过 |
| `0.1.2-rc.1` | 通过 | 通过 | 通过 | 通过 |
| `0.1.3-alpha.1` | 通过 | 通过 | 通过 | 通过 |
| `0.1.5-alpha.1` | 通过 | 通过 | 通过 | 通过 |

14 个入口包括 11 个 `connection.status`、`update.status`、`settings.inbound-ttl.get` 和 `target.list`。空配置的渠道正确返回未配置或空列表；`target.list` 使用不存在的测试 botId，预期得到标准 `unknown-bot` 业务错误，不能把该结果当成真实投递成功。

另外验证 TTL 非法参数的 `bad-request` 和补全后的 `details` 可以通过原生客户端解析。每个版本分别用其原生 Connection 和 Cordis 验证登记、拒绝重复登记、卸载后 404、重新登记后 200。dsh-im 的生产渠道测试还覆盖全部渠道的初始化失败隔离和卸载后重新启动。

实际 CLI HTTP 服务均验证：无认证 401、非受信任 Origin 403、无效 JSON 400、错误媒体类型 415。测试过程中未修改或重新构建任何 DSH。

此矩阵覆盖 Web profile，不代表更早版本、未列出的版本、Desktop 或用户数据降级已经完成实测。

## 本机全部渠道状态

真实服务进程 PID 为 `22480`，工作目录是 `/Users/manruixie/code/new-dsh/dsh-v0.1.5-alpha.1`，监听 `127.0.0.1:3080`，使用原有 `/Users/manruixie/.dsh`。先停止旧服务，再按原命令启动服务加载新的 dsh-im 构建。

| 渠道 | 真实状态及设置页结果 |
| --- | --- |
| 飞书 | 9/9 在线，全部 healthy，页面显示运行正常 |
| 微信 | 1/1 在线，healthy，页面显示运行正常 |
| 钉钉 | 2/2 在线，全部 healthy，页面显示运行正常 |
| 企业微信智能机器人 | 2/2 在线，全部 healthy，页面显示运行正常 |
| 企业微信应用 | 未配置，空机器人列表，页面显示尚未绑定 |
| QQ | 1/1 在线，healthy，页面显示运行正常 |
| Slack | 1/1 在线，healthy，页面显示运行正常 |
| Telegram | 1/1 在线，healthy，页面显示运行正常 |
| Discord | 1/1 在线，healthy，页面显示运行正常 |
| WhatsApp | 1/1 在线，healthy，页面显示运行正常 |
| Office | 未配置，页面显示尚未配置 |

实际浏览器打开原版 DSH `0.1.5-alpha.1-5dda764` 的 IM 设置页，逐一切换了全部 11 个渠道标签，确认前端调用和状态显示正常。未修改机器人配置或连接设置。

更新状态、TTL 读取和下面四个真实机器人的主动投递目标查询也全部成功。主动投递部分只验证读取接口，没有另外发送主动投递消息。

## 四个本机客户端的真实收发

从已登录的原生客户端发送英文测试消息，明确要求不调用工具、不访问文件、不做修改，只回复唯一标记。以下均为本次原版 DSH 进程启动后新发送的消息。

| 渠道 | 机器人 | 客户端实际回复 |
| --- | --- | --- |
| 飞书 | 今天是牢梁 | `DSHIM_ONLY_FEISHU_OK_1788896955980` |
| 钉钉 | 牢梁 | `DSHIM_ONLY_DINGTALK_OK_1788896955980` |
| 企业微信 | 今天是梁子 | `DSHIM_ONLY_WECOM_OK_1788896955980` |
| Telegram | 今天是梁子，`@deepseekharness_dsh_bot` | `DSHIM_ONLY_TELEGRAM_OK_1788896955980` |

飞书、企业微信通过客户端可访问性文本确认独立的机器人回复；Telegram 和钉钉通过客户端截图确认完整回复正文。钉钉初次截图中的回复区域为空，切换会话后重新打开，原回复的完整标记正常显示；没有追加修改代码或重发测试消息来替代这条回复。

钉钉、企业微信、Telegram 所选机器人的进程内统计均从收到 0／回复 0 变为收到 1／回复 1。飞书以客户端的完整回复作为收发证据。测试后四个所选机器人仍为 connected/healthy。

其余已配置渠道完成连接状态与设置页验证，未宣称完成真实消息收发；未配置的企业微信应用和 Office 不计为在线。

## 检查与文件边界

- `npm run check`：2,579 项测试通过，无失败、跳过或取消；构建和发布包验证通过。
- 完成兼容元数据更新后，重新构建并验证发布包，再用最终构建重跑五个原版 DSH 矩阵；随后完成真实收发和设置页检查。
- `git diff --check`：通过。
- 五个 DSH 工作区的 HEAD 未变化，Git 状态均干净。
- 各版本已记录的 Connection `src/index.ts`、`src/rpc-host.ts`、`lib/index.js` SHA-256 均与实施前恢复后的基线一致。

同一份最终 dsh-im 构建 SHA-256：

```text
lib/index.js  d613938b455a559441c8f5ccdf28c402a005e5716fcfea4ca4f504955da21b9a
lib/client.js 4173cf2aad41343afa636a6229d307a0260aaff67e93d40b565e56f872527002
```

## 本机证据

汇总目录：`/var/folders/6h/2_xlp0zn1qq1vbr_8ykqs5z80000gn/T/dsh-im-original-live-ukb0yot_`。

- `service.json`：原版服务 PID、路径和插件构建哈希。
- `before-bots.json`、`after-bots.json`：真实收发前后的全部渠道状态和管理查询。
- `real-message-tests.json`：四个测试机器人、标记、客户端观察和收发统计。
- `settings-ui.json`：实际浏览器逐个渠道标签的状态检查。
- `compatibility-matrix.json`：五个原版 DSH 的最终矩阵结果。
- `dsh-unchanged.json`：DSH 工作区与文件基线核对。
- `npm-check.log`：完整检查结果。

矩阵独立 profile 和脱敏启动日志位于 `/var/folders/6h/2_xlp0zn1qq1vbr_8ykqs5z80000gn/T/dsh-im-original-matrix-z3rqu5pz`；测试进程均已停止。本机 `3080` 的原版 DSH 服务继续运行。临时证据目录可能被系统清理，本记录保留结论、范围及唯一消息标记，不记录认证令牌或机器人密钥。
