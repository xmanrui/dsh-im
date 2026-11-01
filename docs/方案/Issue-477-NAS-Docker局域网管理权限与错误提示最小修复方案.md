# Issue #477：NAS／Docker 局域网管理权限与错误提示最小修复方案

日期：2026-10-31（Asia/Taipei）。

状态：最小修复已实施，4,800 项自动化测试及两个支持版本共 450 项真实 HTTP 检查通过。尚未完成真实 NAS 跨设备、实际反向代理、Desktop 和真实安装升级验收。实施与验证结果见第 10 节；前面的方案保留为设计与验收依据。

关联 Issue：[局域网 Docker／NAS 部署下「通用设置」与「更新」不可用](https://github.com/xmanrui/dsh-im/issues/477)。

分析基线：本地 dsh-im `5.8.0`／`51da1101`，并核对远端 `main` 的 `b579825e`。本地落后 19 个提交；与本问题直接有关的权限注册、共享 RPC 错误处理及局域网验证脚本在两者间没有变化。Host 入口已有其他功能变更，实施时应基于届时最新主分支做局部修改。

## 1. 修复决定

**让通用设置和插件更新复用已有的 `rpcAuthority`，默认沿用 DSH 的认证与 Host／Origin 校验；显式配置 `loopback` 时继续限制为本机访问。错误提示在现有 RPC 包装层统一修正。**

采用一个方案，不增加第二套远程管理机制：

- 不新增配置开关、权限角色、令牌、管理代理、诊断接口或运行依赖。
- 不识别 Docker／NAS，也不按私有 IP 网段自行放行；部署地址是否可信由 DSH 判断。
- 不改变接口路径、请求载荷、成功响应、配置文件格式或业务处理流程。
- 不拆分更新的查询与安装权限；整个更新通道复用同一策略，安装资格继续由现有更新服务校验。
- 不改渠道消息收发、会话、机器人凭据、主动投递或后台清理算法。

本次主要生产逻辑集中在三个 Host 接线位置和一个共享错误处理函数。现有 UI 继续显示收到的错误信息，原则上不需要增加组件或页面状态。

## 2. 已确认的问题

### 2.1 两条接口绕开了已有统一配置

| 位置 | 当前行为 | 影响 |
| --- | --- | --- |
| `plugin-src/host/inbound-ttl-rpc.mjs` 的 `installInboundTtlRpc()` | 注册时固定 `authority: 'loopback'` | 同通道中的附件保留、手动清理、图片限制、群记录保留全部被限制 |
| `plugin-src/host/update-rpc.mjs` 的 `installUpdateRpc()` | 注册时固定 `authority: 'loopback'` | `update.status`、`update.check`、`update.install` 全部被限制 |
| `plugin-src/host/index.mjs` | `startUpdate(ctx)` 未传入管理策略 | 即使修改更新注册逻辑，也必须补齐入口配置透传 |
| `plugin-src/management-rpc.mjs` | `loopback` 请求检查实际 Host，以及存在时的 Origin | NAS IP／域名访问返回 HTTP 403，业务处理函数尚未执行 |

普通渠道和侧边栏等接口已经使用 `trusted-host` 默认策略。它们可用而上述两类功能失败，与该代码路径一致。

### 2.2 错误状态既被弱化，也可能没有被记录

`callManagementRpc()` 将所有非取消异常包装成 `management-unreachable`，显示“检查 DSH 连接或重新登录”，仅在 `cause.status` 为合法整数时写入 `details.httpStatus`。

已核对声明兼容的 DSH `0.2.0-rc.2`、`0.2.1-rc.2`：浏览器 RPC 在非 2xx 响应时抛出普通 `Error`，状态码在固定格式的消息中，未设置 `status`：

```text
transport failure for /api/dsh-im/dsh-im-settings: HTTP 403
```

因此只增加 `cause.status === 403` 分支不能解决真实浏览器问题。必须同时补上这类已确认格式的状态提取。

上游依据：[0.2.0 客户端 RPC](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/client/connection/src/client/rpc.ts)、[0.2.1 客户端 RPC](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/src/client/rpc.ts)。

### 2.3 复用 DSH 授权具有现成依据

- DSH `0.2.0-rc.2` 在分发 HTTP 管理请求前，先检查 Host／Origin，再检查浏览器认证。
- DSH `0.2.1-rc.2` 同样执行信任与身份校验，并在分发插件的精确 Fetch 路由时要求 `owner` 身份。
- 插件继续通过现有 `/api` Fetch 注册路径访问这些能力，不自行增加旁路。

上游依据：[0.2.0 Host RPC](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/client/connection/src/rpc-host.ts)、[0.2.1 Host RPC](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/src/rpc-host.ts)、[Host／Origin 检查](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/src/api-request-trust.ts)。

403 不只可能来自插件的 `loopback` 限制，也可能来自 DSH 的 Host／Origin 或身份权限检查。前端不能仅凭 403 宣称“已确定是本机访问限制”。

## 3. 修复后的访问规则

以下规则覆盖通用设置的全部读写／清理操作，以及更新的全部三个方法。

| 条件 | 预期 |
| --- | --- |
| 默认配置，已认证且通过 DSH 信任检查的本机请求 | 正常访问，业务行为保持原样 |
| 默认配置，已认证且通过 DSH 信任检查的局域网 IP／域名请求 | 正常进入业务处理 |
| 显式 `rpcAuthority: trusted-host` | 与默认配置一致 |
| 显式 `rpcAuthority: loopback`，本机 Host／Origin，且通过 DSH 认证 | 正常进入业务处理 |
| 显式 `rpcAuthority: loopback`，局域网 IP／域名请求 | HTTP 403，业务处理不执行 |
| 信任检查通过，但无有效登录态 | 由 DSH 返回 HTTP 401，业务处理不执行 |
| Host 不可信、Origin 不匹配或显式跨站请求 | 由 DSH 返回 HTTP 403，业务处理不执行 |
| DSH 0.2.1 的非 owner 调用者访问精确 Fetch 路由 | 继续由 DSH 拒绝 |
| 非法 `rpcAuthority` 值 | 沿用 `resolveRpcAuthority()` 的报错与现有模块启动失败隔离，不静默放宽 |

**预期行为变化必须公开说明：原先默认配置下被拒绝的可信远程设置／更新请求，将获得与普通 IM 管理接口一致的访问能力。** 本次不能同时声称“修复远程更新”与“更新仍然默认仅限本机”。

旧版 [Issue #61 方案](Issue-61-npm更新检查与手动更新方案.md) 第 9.1 节规定更新固定使用 `loopback`。本方案调整这一项历史决定，保留其中关于安装确认、来源、执行器、并发及恢复的限制。实施时在旧方案增加简短后续说明和本文链接，保留历史验收记录。

## 4. 最小实现

### 4.1 通用设置沿用现有配置

在 `installInboundTtlRpc()` 注册处，将：

```js
{ authority: 'loopback' }
```

改为：

```js
{ authority: options.config?.rpcAuthority }
```

`undefined` 继续由已有 `resolveRpcAuthority()` 解析为 `trusted-host`。Host 入口已经传入 `{ config }`，无需增加第二条配置通道。

保留 `/dsh-im-settings` 和现有 endpoint 分发，TTL、图片及群记录处理函数全部不改。`plugin-src/host/sidebar-settings.mjs` 中“TTL 仍仅限本机”的过时注释同步修正，侧边栏实现不改。

### 4.2 更新接口补齐配置透传

Host 入口改为：

```js
startUpdate(ctx, { authority: config.rpcAuthority });
```

`installUpdateRpc(ctx, options = {})` 注册时改为：

```js
{ authority: options.authority }
```

保留 `options.runtime`、`options.service` 的现有测试注入方式，以及服务关闭和初始化失败隔离。

不改 `createUpdateRpcHandler()`、`update-service.mjs`、`update-runtime.mjs` 的业务逻辑：

- 查询状态不会自动检查 npm，更不会自动安装。
- 安装仍只接受已有的 `checkId` 和 `requestId`，不能传入命令、路径、profile 或任意安装来源。
- 保留版本确认有效期、目标版本固定、安装状态复核、幂等处理和 profile 更新锁。
- 保留源码／链接安装保护、registry、Node 版本、profile 归属和执行器校验。
- 安装由当前 Host 执行；浏览器断开或取消请求不终止已经提交的安装。
- 保留待手动重启、失败恢复及现有手工更新说明。

远程接口可访问不等于所有 Docker 安装都能按钮更新。镜像内源码／链接安装、不可写目录或不支持的执行环境，继续按现有业务限制反馈；本次不增加 Docker 镜像更新器，也不强行覆盖安装。

### 4.3 统一修正传输错误提示

在 `plugin-src/management-rpc.mjs` 内用少量私有函数或局部逻辑完成，不新建错误框架。

状态提取规则：

1. 优先采用现有合法整数 `cause.status`，范围保持 `100–599`。
2. 没有合法结构化状态时，只匹配当前调用路径的完整消息：`transport failure for /api/${rpcEndpoint(channel)}: HTTP NNN`，`NNN` 必须为合法的三位状态码，前后不得有额外内容。
3. 不搜索任意文本中的 `403`，不读取任意嵌套字段，不解析响应正文，不将其他 endpoint 的错误套到本次请求。
4. 无法确定状态时使用中性兜底；不猜测为登录失效或特定网络故障。

保留 `error.code = 'management-unreachable'`，以及 `cause`、`details.operation`、`details.stage`、`details.occurredAt`。提取到状态时填入现有 `details.httpStatus`。通过消息和状态细化表达，不要求所有渠道适配新错误码。

建议固定文案：

| 情况 | 用户可见信息 |
| --- | --- |
| 401 | DSH 登录状态无效或已过期，请通过有效启动链接重新登录。 |
| 403 | DSH 拒绝了当前管理请求（HTTP 403）。请检查访问权限、可信地址配置及代理设置；若启用了仅本机访问，请按该限制访问。 |
| 404 | DSH 管理接口不存在（HTTP 404），请检查 Host 与插件版本及代理路径，重启后重试。 |
| 5xx | DSH 管理服务暂时异常，请检查服务状态或稍后重试。 |
| 其他状态／未知传输异常 | DSH 管理请求失败，请检查服务状态和网络连接后重试。 |

403 提示不要求重新登录，不引导远程 NAS 用户把浏览器地址直接改为自己电脑的 localhost。具体的 `--trusted-host`、Host／Origin 和 `rpcAuthority` 排查步骤放在 README，避免把配置教程塞进每个错误提示。

404 文案保留 `HTTP 404`，使更新面板已有的“Host 不支持更新接口”识别继续生效；用组件测试确认，而不是另造一套 UI 错误映射。

原有行为保持：

- `AbortError` 或已取消信号仍直接抛出原异常。
- 成功结果和 `{ ok: false, error: ... }` 业务失败原样返回；更新失败、参数校验等不被误判为传输失败。
- 不自动重试，不重放保存、清理或安装请求。
- UI 不直接展示原始异常消息、响应正文、token、cookie、命令或文件路径。

### 4.4 复用现有国际化

新的中文固定文案加入 `src/channels/shared/i18n-en/diagnostics.mjs` 和 `src/channels/shared/i18n-ru/diagnostics.mjs`。它们已经被现有客户端词典导入，不新增词典模块或翻译调用链。

保留旧文案的词条用于兼容已有调用与历史内容。检查各语言现有导出／合并机制，执行词典覆盖和 UI 国际化测试。共享目录的 `AGENTS.md` 要求新增文案覆盖全部已有语言，并保持占位符一致。

## 5. 不影响正常功能的约束

| 功能 | 实施约束 |
| --- | --- |
| 本机 Web、Desktop | 原有成功请求、面板加载、保存与更新流程保持；不能依赖浏览器一定提供 Origin |
| 显式本机限制 | 两条新接入统一配置的接口都必须实际收到 `loopback`，不能只测试注册函数默认值 |
| 普通渠道、侧边栏、主动投递 | 不改权限接线和成功路径；共享层变化只细化传输失败提示 |
| 群记录／附件数据 | 不改保留默认值、范围校验、文件格式、清理范围、定时器或保存后重排清理的行为 |
| 图片输入 | 不改字段、限制范围、保存方式或模型输入策略 |
| 插件更新 | 不改安装服务、来源限制、确认、锁、执行器、取消语义和重启要求 |
| 业务错误和取消 | 原错误码、业务结果及取消信号不变 |
| 代理及域名 | 不修改请求 Host／Origin，不信任转发头绕过 DSH，不放宽 CORS 或监听地址 |

现有正常功能是否保持，由回归结果判断，不能仅凭“只改两行”保证。共享错误包装影响全部使用该函数的渠道，应保留已有错误码和诊断字段以控制影响范围。

## 6. 测试与验收

### 6.1 权限与配置传递

扩展现有测试，不另建测试框架：

- `test/management-rpc.test.mjs`：将“TTL 默认仍拒绝局域网”的旧预期改为统一策略矩阵；覆盖默认、显式 `trusted-host`、显式 `loopback`，以及本机、局域网 IP、域名。真实注册后的 TTL、图片、群记录 get／set 和 TTL sweep 都应被覆盖，不能只测通用路由放行。
- `test/update-rpc.test.mjs`：三个更新 endpoint 均验证默认／trusted-host 放行和 loopback 拒绝。使用注入 service 计数，确认被拒请求不会触发查询或安装；保留任意命令／路径参数拒绝测试。
- 在已有 Host 插件工厂测试位置补配置透传断言：`config.rpcAuthority` 到达更新及通用设置注册；避免只测独立函数而漏掉 `startUpdate()` 接线。
- `test/rpc-authority.test.mjs`：现有默认值和非法值校验继续通过。

这些路由单测发生在 DSH 身份校验之后，不能用它们证明“未登录会被拒绝”；认证必须由真实 Host HTTP 检查覆盖。

### 6.2 错误处理与页面反馈

在 `test/management-rpc.test.mjs` 覆盖结构化状态与真实 DSH 消息两种输入，至少包含 401、403、404、500、无状态异常，以及：

- `status` 与消息不一致时，合法结构化状态优先。
- 其他 endpoint、仅包含数字、追加敏感内容、非法状态值等不匹配精确格式。
- 403 文案不会出现重新登录指引；未知异常不会被错误归因为 401。
- `code` 和现有诊断字段保持，敏感原始信息不出现在公开文案中。
- 取消仍抛原异常；任何失败只调用底层 RPC 一次；业务失败不被重新包装。

`test/channels/shared/connection-diagnostics.test.mjs` 保留管理错误与渠道服务商错误的区别。增加新文案／状态断言，不为了更新文案修改渠道错误分类逻辑。

复用 `test/group-history-ui.test.mjs`、`test/image-input-settings-ui.test.mjs` 和 `test/update-ui.test.mjs`。关键用例通过真实 `callManagementRpc()` 包装错误后传入组件，检查群记录、附件 TTL、图片与更新面板实际显示正确提示，401／403 不导致自动重试或安装；404 保留更新面板原有提示。再运行已有正常读取、保存、输入保留、更新确认和轮询生命周期测试。

新增词条通过现有英文／俄文覆盖与动态翻译测试，避免只修中文。

### 6.3 真实 Host HTTP 验证

扩展 `scripts/verify-lan-management.mjs`，复用它的临时 DSH_HOME、空机器人配置和启动链接登录方式：

1. 默认策略下，将更新／TTL 的旧 403 断言改为业务可达；补图片与群记录接口的读取、保存、重新读取。
2. 对 localhost、127.0.0.1、可信局域网 Host、可信域名，覆盖新接入的两条管理通道。
3. 未登录／伪造 cookie、未信任 Host、Origin 不匹配、跨站请求，对设置和更新通道分别继续验证拒绝。
4. 显式 `rpcAuthority: loopback` 时，对两条通道分别验证局域网拒绝、本机成功。
5. 保留现有渠道、侧边栏／投递相关回归；现有脚本列出的渠道不是完整目录，实施时核对并补齐当前已注册渠道，特别是邮箱。
6. `update.status` 应到达业务层；`update.check/install` 的分发和拒绝由注入服务单测覆盖。该 HTTP 脚本不执行真实插件安装，不为凑成功而取消源码安装保护。

在项目声明支持的 DSH `0.2.0-rc.2`、`0.2.1-rc.2` 构建上分别运行。按实际版本检查脚本的启动／登录方式，若需适配，只局部调整测试脚本，不能修改生产 DSH 来绕过认证。

该脚本仍是通过回环 TCP 携带不同 Host／Origin 的 HTTP 验证，报告中明确这一限制，不替代 Docker／NAS 的跨设备浏览器验收。

### 6.4 部署与正常功能验收

使用独立测试环境完成以下检查，记录 DSH／插件版本和安装方式：

| 环境 | 关键验收 |
| --- | --- |
| 本机 Web | 通用设置读写、手动清理测试数据、更新查询与既有更新限制均正常 |
| Desktop | 设置与更新面板正常；已有可用的本机更新流程、手工更新说明不退化 |
| Docker／NAS + 另一台设备浏览器 | 用 NAS IP 登录，群记录、附件 TTL、图片限制可读写并在刷新／重启后保持；渠道列表和侧边栏正常 |
| 可信域名 + 反向代理 | 正常 Host／Origin 可访问；失配仍拒绝，并显示权限／配置提示 |
| 显式 loopback | 同一个部署的远程请求被拒，本机请求仍正常 |
| 可安装的独立 npm 测试实例 | 远程手动检查 → 用户确认 → 当前 Host 安装 → 待重启 → 手动重启核验；取消确认不安装 |
| 源码／链接或不支持更新的容器实例 | 面板可查询，现有安装限制及手工处理说明正常，不强行安装 |

保存与清理仅使用临时数据；更新使用可丢弃的 npm 测试实例。不能在用户日常实例上安装插件或清理附件来完成验收。

消息处理不在改动范围内；运行现有渠道回归，并在测试机器人环境抽样验证正常收发与主动投递。未具备的跨设备或真实安装环境，必须记录为未验证，不能将单测通过写成现场已修复。

## 7. 文件修改范围

| 文件 | 计划变更 |
| --- | --- |
| `plugin-src/host/inbound-ttl-rpc.mjs` | 注册时读取已有 `config.rpcAuthority` |
| `plugin-src/host/update-rpc.mjs` | 注册时读取传入的 `authority` |
| `plugin-src/host/index.mjs` | 向更新注册透传策略 |
| `plugin-src/management-rpc.mjs` | 精确提取 HTTP 状态、按状态生成固定提示，保留原错误契约 |
| `plugin-src/host/sidebar-settings.mjs` | 仅修正关于 TTL 权限的过时注释 |
| `src/channels/shared/i18n-en/diagnostics.mjs`、`src/channels/shared/i18n-ru/diagnostics.mjs` | 补齐新文案 |
| 上述权限、诊断、设置 UI、更新 UI 测试 | 更新旧策略预期，补充接线、失败提示与回归 |
| `scripts/verify-lan-management.mjs` | 扩展两条接口的真实 HTTP 验证，保留原认证拒绝检查 |
| `README.md`、`README.en.md`、`CHANGELOG.md` | 说明统一策略、默认行为变化、部署要求及更新资格边界 |
| `docs/方案/Issue-61-npm更新检查与手动更新方案.md` | 增加指向本方案的后续策略说明，不重写历史验收 |
| `lib/index.js`、`lib/client.js` | 实施阶段通过构建更新，包含打包后的词典；不手改产物 |

不修改存储实现、清理服务、更新服务与执行器、渠道消息处理代码。若实施时发现必须修改这些部分才能通过验收，应先重新确认问题范围，不顺手扩大本次修复。

## 8. 文档、实施顺序与完成条件

README 应明确：

- `rpcAuthority` 默认 `trusted-host`，适用于普通管理、通用设置和更新；它不替代 DSH 的可信地址配置和登录认证。
- 自定义域名按原启动方式加入 `--trusted-host`，代理保留实际 Host 和端口，并与 Origin 匹配；不自动修改用户代理或 DSH 监听设置。
- 需要仅本机管理时沿用现有配置：

```yaml
- id: xmanrui-dsh-im
  config:
    rpcAuthority: loopback
```

该配置限制的是统一管理范围。无需新增配置迁移；旧的显式 `loopback` 继续有效。使用默认策略的可信远程用户获得新增设置／更新能力。

实施顺序：

1. 从最新主分支建立独立修复工作区，保留当前工作区已有修改；核对本文涉及接口与当前版本没有漂移。
2. 补上针对真实问题的测试：两条通道的默认远程访问、显式限制、Host 配置透传，以及真实 DSH 异常格式。
3. 完成三处权限接线和共享错误提示，补词典与文档；不改业务服务。
4. 运行相关测试，再执行仓库既有 `npm run check`，完成构建、全量测试和发布包检查。新增失败应定位原因，不能通过删除拒绝断言或放宽校验使其通过。
5. 对支持版本运行扩展后的 `node scripts/verify-lan-management.mjs /path/to/built/deepseek-harness`，再做上述部署验收。
6. 检查构建差异只包含本次预期变更，形成结果记录；版本与发布按项目正常流程处理。

完成条件：默认可信远程访问可以使用全部相关设置；更新可以进入原有完整业务流程；显式本机限制、未认证与跨站拒绝仍有效；401／403／网络等失败不再混为“重新登录”；本机与已有功能回归通过；未验证环境如实列出。

回退方式：如需立即收紧全部插件管理访问，可使用已有 `rpcAuthority: loopback` 并按原方式重启。若需撤销本次功能变更，回退修复版本／提交及对应构建产物即可；本方案没有数据格式迁移。已经安装的插件版本与已保存设置不会因撤销权限修复自动回滚，更新仍按原恢复流程处理。

## 9. 本次方案阶段的证据边界

- 已阅读 Issue、相关注册与调用代码、现有测试、更新历史方案和局域网验证脚本，并核对远端主分支。
- 已核对两个声明支持的 DSH 版本的真实客户端异常格式和 Host 认证分发路径。
- 前序排查运行了 `management-rpc`、`update-rpc`、`rpc-authority` 共 15 项测试，全部通过；其中包含旧版“局域网必须被拒绝”的预期。这证明原有限制存在，不代表修复已通过。
- 方案阶段只保存了文档，当时尚未执行新增测试、构建、真实 HTTP 和部署验收。后续实施结果记录如下，不将计划用例视为已通过。

## 10. 实施与验证结果（2026-10-31）

### 10.1 实施位置与实际范围

- 首次实施基线：远端 `main` 的 `713b1c413b3b783a411608668047b0591423ca4b`（`5.8.0`）。创建 PR 前已同步至 v5.9.0 发布提交 `009e7f717c25b298b9d609025cfe285670663814`，沿用主分支的版本号和依赖，不为本次修复单独提升版本。
- 分支：`codex/fix-issue-477-lan-management`。
- 独立工作区：`/Users/manruixie/.codex/worktrees/issue-477-lan-management/dsh-im`。
- 原项目工作区已有的文件保持原样，仅同步本方案的实施结果；实现和构建产物位于独立修复工作区。本次未发布、未部署，也未修改日常 DSH 的配置或安装。

实际生产改动与方案一致：

1. 通用设置注册读取 `options.config?.rpcAuthority`。
2. Host 入口向更新模块传入 `config.rpcAuthority`，更新注册读取 `options.authority`。
3. 共享 RPC 包装层新增两个小型私有函数，精确提取 HTTP 状态并选择固定提示；保留原 `management-unreachable` 错误码、诊断字段、业务结果与取消语义。
4. 同步英文、俄文词条和侧边栏权限注释。
5. 更新中英文 README、Changelog 和 Issue #61 历史方案的后续说明。

没有修改更新服务／执行器、配置存储、清理算法、图片策略、渠道消息处理、依赖或锁文件。UI 生产组件无需改动，直接呈现共享层的新提示。

### 10.2 回归测试与问题复现

先补测试、后修改实现。新增测试在旧实现上出现 5 处失败，覆盖默认设置访问、默认更新访问、Host 权限透传、真实 DSH 状态提取和误导文案。修改实现后，核心测试全部通过。

| 验证 | 实际结果 |
| --- | --- |
| `management-rpc`、`update-rpc`、`host` 三组核心测试 | 26 项通过 |
| 设置／更新 UI、共享诊断、动态国际化及俄文测试 | 101 项通过 |
| 最终 `npm run check` | 构建成功；4,800 项测试全部通过；失败、取消、跳过均为 0；发布包检查通过 |
| `git diff --check` | 通过 |

最终检查命令：

```sh
node --test test/management-rpc.test.mjs test/update-rpc.test.mjs test/host.test.mjs
node --test test/group-history-ui.test.mjs test/image-input-settings-ui.test.mjs test/update-ui.test.mjs test/channels/shared/connection-diagnostics.test.mjs test/client-i18n-dynamic.test.mjs test/client-i18n-ru.test.mjs
npm run check
git diff --check
```

第一次全量测试发现 `test/sidebar-settings.test.mjs` 另有旧策略断言，要求默认／trusted-host 下的通用设置也返回 403；两个子用例及其父测试失败。按本方案将其调整为“侧边栏与通用设置使用同一权限策略”，保留显式 loopback 拒绝以及两条通道不混用业务方法的断言后，重新运行完整检查通过。没有放宽 DSH 认证检查或删除拒绝场景。

新增用例实际覆盖：

- TTL、图片、群记录的读写，以及手动清理的权限矩阵；拒绝请求不触发处理，图片写入不创建文件。
- 更新的 `status/check/install` 均使用相同策略，拒绝时不调用服务；保留参数白名单及取消不终止已提交安装的原测试。
- 当前 endpoint 的完整传输消息与合法 `status` 字段；结构化字段优先；错误 endpoint、额外文本／换行、非法数字不误匹配。
- 401、403、404、5xx、未知失败不再共用重新登录提示；业务错误保持原结果，取消保持原异常，不自动重试。
- 真实 `callManagementRpc()` 包装后进入 React 组件：群记录、TTL、图片、更新面板提示正确；中／英／俄设置提示有效；更新面板不会因 401／403 自动重试或安装，404 保留原手动更新提示。
- 既有更新确认、安装来源保护、并发锁、版本与恢复、输入保留、轮询生命周期和渠道回归均包含在最终全量测试中。

### 10.3 两个原版 DSH 的真实 HTTP 结果

当前机器没有可用的既有 DSH 构建目录，因此在 `/private/tmp/dsh-im-issue477-validation` 下独立安装官方 npm 的两个指定版本。仅用符号链接组织成验证脚本期望的 CLI／bundle 目录结构，没有修改 DSH 源码、认证逻辑或发布包代码。

运行环境：macOS，Node.js `v24.19.0`。每次脚本运行使用独立临时 DSH_HOME、Web profile、空机器人配置、随机端口和真实启动链接交换的浏览器 cookie；结束后停止自建进程并清理临时 profile。

| 原版 DSH | 修复插件入口 | 结果 |
| --- | --- | --- |
| `@deepseek-ai/dsh@0.2.0-rc.2` | 本分支构建的 `lib/index.js` | 225 项 HTTP 检查通过 |
| `@deepseek-ai/dsh@0.2.1-rc.2` | 同一构建产物 | 225 项 HTTP 检查通过 |

运行命令：

```sh
node scripts/verify-lan-management.mjs /private/tmp/dsh-im-issue477-validation/dsh-0.2.0-rc.2
node scripts/verify-lan-management.mjs /private/tmp/dsh-im-issue477-validation/dsh-0.2.1-rc.2
```

检查内容包括：

- 默认配置下可信 LAN Host 的设置与更新状态可访问；显式 trusted-host 下可信域名可访问。
- TTL、图片限制、群记录保留均完成“读取 → 保存 → 再读取”，两次 Host 重启后的值仍正确。
- 本机 `127.0.0.1`、`localhost` 正常；所有 14 个渠道的状态入口正常，补齐原脚本遗漏的邮箱。
- 侧边栏查询、投递入口的业务分发正常；清理只操作空测试环境。
- 未登录／伪造 cookie 返回 401；不可信 Host、跨 Origin、跨站和两个可信地址之间的 Origin 失配返回 403。
- 对设置的全部读写／清理及更新的全部三个方法逐一验证拒绝，显式 loopback 下可信 LAN 仍返回 403，本机设置与更新状态仍成功。
- 更新状态查询可达且不会授权安装；该脚本没有触发真实安装或自动执行 npm 更新。

这是实际原版 CLI、认证中间件和构建后插件共同参与的 HTTP 检查。TCP 始终连接回环，LAN IP／域名由请求的 Host／Origin 携带；不能将这 450 项检查称为真实 NAS／Docker 跨设备验收。

### 10.4 构建产物与改动核对

`lib/index.js`、`lib/client.js` 均由项目原构建脚本生成，没有手工修改。首次实施时重建基线源码发现，`713b1c41` 的旧产物尚未包含已合入 #495 的部分二维码诊断源代码；之后的 v5.9.0 发布已同步这些产物。创建 PR 前重新基于该发布提交构建，保留主分支已有逻辑及版本号。客户端构建仍包含随工作区位置变化的依赖路径标签。

最终验证产物 SHA-256：

```text
lib/index.js   632802e6add5f4650e8781cb8881d27789da673974f1521bc3296f47dd71b5ca
lib/client.js  f4317315bdf6d141ee80c26ce6b4b084049df5d8a7b2fb0c291ebe930c0d78d8
```

完整测试日志和两个 HTTP 检查日志保存在本地 `output/issue-477-20261031/`，不作为发布包内容。

### 10.5 尚未验证的部署场景

- 真实 Docker／NAS 与另一台设备上的浏览器：本机 Docker daemon 不可连接，也没有本次任务提供的 NAS 测试实例。
- 实际反向代理：本次只验证原版 Host 对真实 HTTP 请求头的接受／拒绝，没有部署代理服务。
- Desktop 原生界面与真实 npm 安装升级：本次验证 React 组件、更新服务回归和原版 Web HTTP，没有在日常 Desktop 或用户 profile 上执行升级。
- 真实 IM 收发与主动投递：全量自动化覆盖渠道行为，HTTP 覆盖管理入口；未使用真实机器人凭据发送消息。
- DSH 的非 owner 精确路由拒绝仍依赖原版实现；本次未构造非 owner 身份的独立实测。

结论：最小修复及自动化／原版 HTTP 验证完成，默认可信远程请求与显式本机限制均符合方案。以上部署场景仍需在对应独立环境补验收，不能据此宣称所有现场部署已经验证。

### 10.6 创建 PR 前同步主分支与复测

主分支在首次实施后发布 v5.9.0。修复分支已 rebase 到 `009e7f71`：保留完整 v5.9.0 发布记录，本修复仍列于 Unreleased；两份构建产物通过原构建脚本重新生成，未手工合并打包代码。

同步后再次运行 `npm run check`，4,800 项测试全部通过，失败、取消、跳过均为 0，发布包检查通过。两个原版 DSH 的 HTTP 脚本也重新执行，各 225 项通过。最终产物哈希已更新至第 10.4 节。

本轮日志位于 `output/issue-477-20261031/pr-final-check.log`、`pr-http-0.2.0.log` 和 `pr-http-0.2.1.log`。第 10.5 节未实测的部署场景保持不变；创建 PR 不代表已经发布修复版本或完成现场部署。
