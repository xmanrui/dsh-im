# Issue #85：Telegram 长轮询阻塞发送最小修复方案

方案日期：2026-08-30。实施基线：v4.2.0 / `02ddea0`。状态：已实施并验证（2026-08-31）。

需求来源：[Issue #85](https://github.com/xmanrui/dsh-im/issues/85)。本文定义并记录关闭该 Issue 所需的最小改动及验收结果。

## 1. 决策

为每个 Telegram Runtime 创建一个私有、代理感知、最多 4 条同源连接的 Undici dispatcher，并让该 Bot 的长轮询和全部 Telegram HTTP 请求使用它。

同时满足：

- `fetch`、dispatcher 和 `FormData` 来自同一个固定版本的 `undici`。
- Runtime 在正常停止和启动失败时释放 dispatcher。
- 不修改进程全局 dispatcher。
- 不增加发送重试。
- 不修改现有超时和 `CHANNEL_DELIVERY_UNCERTAIN` 语义。

本次不重构生命周期、不建设通用 Transport 框架、不顺带处理其他 hardening 项目。

## 2. 原因

当前错误链路是：

1. `TelegramRuntime` 使用默认全局 `fetch` 创建 `TelegramApi`。
2. `getUpdates(timeout: 25)` 与消息发送、草稿更新和文件请求并发。
3. 报告环境的全局 dispatcher、代理或连接路径把同源请求串行化。
4. 发送请求排在长轮询后，先触发 15 秒超时。
5. Telegram API 将超时标记为 `telegram-timeout` 和 `deliveryOutcome = unknown`。
6. 上层正确转换为 `CHANNEL_DELIVERY_UNCERTAIN`。

Issue 中“Node 默认 Undici 只有一条连接”不是普遍成立的默认行为。独立 Agent 能恢复发送，只能证明问题位于实际 HTTP 传输路径。修复目标是让 Telegram 不再依赖进程全局传输状态。

## 3. 范围

本次包含：

- Telegram Bot API 长轮询和出站请求。
- Telegram 文件上传和平台文件下载。
- 每个 Runtime 私有的 dispatcher。
- `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 及对应小写变量。
- `TelegramApi` 的 `FormData` 注入点。
- 正常停止和启动失败时的资源释放。
- 核心回归、真实 multipart、基本资源所有权和发布包测试。

本次不包含：

- `start()` / `stop()` generation 或状态机重构。
- poll 崩溃后的新清理框架；继续由现有 supervisor 重连并调用 `stop()`。
- `inspectTelegramToken()` 的网络策略调整。
- Token、代理凭据和嵌套错误的通用脱敏框架。
- 双连接池、请求优先级或可配置连接数。
- 其他 IM 渠道改造。

## 4. 最小实现

### 4.1 依赖

增加精确运行时依赖 `undici: 7.29.0`。该版本满足项目 Node `>=22.19` 的运行条件。

`undici` 必须作为 Host bundle 的外置运行时依赖，避免源码环境可用但发布包无法解析，或被 esbuild 打入 bundle 后产生另一份实现。

### 4.2 Telegram HTTP 工厂

新增 `src/channels/telegram/telegram-http.mjs`：

```js
import {
  EnvHttpProxyAgent,
  FormData as UndiciFormData,
  fetch as undiciFetch,
} from 'undici';

export function createTelegramHttpTransport() {
  const dispatcher = new EnvHttpProxyAgent({ connections: 4 });
  let destroyed = false;

  return {
    fetchImpl: (url, options = {}) => undiciFetch(url, {
      ...options,
      dispatcher,
    }),
    FormDataImpl: UndiciFormData,
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      await dispatcher.destroy();
    },
  };
}
```

约束：

- 使用 `EnvHttpProxyAgent`，不使用会绕过标准代理变量的裸 `Agent`。
- `dispatcher` 写在 `...options` 后，调用方不能覆盖它。
- 不调用 `setGlobalDispatcher()`。
- 不调整 keep-alive 参数，不记录包含 Bot Token 的请求 URL。

### 4.3 TelegramApi

构造函数增加 `FormDataImpl = globalThis.FormData`，保存为私有字段；文件上传从 `new FormData()` 改为 `new this.#FormDataImpl()`。

Runtime 注入配套的 `undici.fetch + undici.FormData`。其他直接构造 `TelegramApi` 的调用继续默认使用全局 `fetch + FormData`，保持兼容。

不修改请求 payload、超时、redirect、文件限制和错误映射。

### 4.4 TelegramRuntime

增加 `#createHttpTransport` 和 `#httpTransport`：

- 构造函数默认 `createHttpTransport = createTelegramHttpTransport`。
- `#start()` 在 `createApi` 前创建并登记 transport。
- `createHttpTransport` 和 `createApi` 必须位于启动错误处理范围内。
- `createApi` 接收 `fetchImpl` 和 `FormDataImpl`。

`stop()` 只增加以下清理：

1. 捕获并清空当前 `#httpTransport`。
2. 沿用现有 abort 及 poll/bridge 有界等待。
3. 调用捕获 transport 的幂等 `destroy()`。
4. 销毁失败只记录固定 warning，不让 `stop()` 抛错或覆盖原始启动错误。

本次不改变现有 `start()` / `stop()` 状态机；既有启动取消竞态留给后续 hardening。

### 4.5 保持不变

- 普通发送默认 15 秒超时。
- `getUpdates` 为 25 秒长轮询并保留现有 10 秒余量。
- 文件上传默认 120 秒超时。
- timeout 继续映射为 `telegram-timeout + deliveryOutcome: unknown`。
- 上层继续产生 `CHANNEL_DELIVERY_UNCERTAIN`。
- 最终消息、编辑和文件上传均不自动重试。

## 5. 文件改动

| 文件 | 改动 |
| --- | --- |
| `package.json`、`package-lock.json` | 增加并锁定 `undici@7.29.0` |
| `src/channels/telegram/telegram-http.mjs` | 新增私有 transport 工厂 |
| `src/channels/telegram/telegram-api.mjs` | 注入匹配的 `FormDataImpl` |
| `src/channels/telegram/telegram-runtime.mjs` | 创建、注入和释放 transport |
| `plugin-src/host/build.mjs` | 外置 `undici` |
| `scripts/verify-package.mjs` | 校验直接依赖和 bundle 外置 |
| `test/channels/telegram/telegram-http.test.mjs` | 核心传输、真实 multipart 和 Runtime 资源所有权回归 |
| `test/channels/telegram/telegram.test.mjs` | 复用现有 API、超时及 uncertain 语义测试，无需修改 |
| `THIRD_PARTY_NOTICES.md`、`CHANGELOG.md` | 许可证和修复记录 |
| `lib/index.js`、`lib/client.js` | 通过现有构建命令生成 |

## 6. 最小测试集

### 6.1 长轮询不阻塞发送

使用本地 server 和真实 transport：保持 `/getUpdates` 不返回，再调用 `sendChatAction`，断言发送在释放长轮询前已经完成。使用事件顺序断言，不设置严格耗时阈值。

测试须隔离大小写两套代理环境变量，避免 CI 环境代理污染本地请求。

### 6.2 不依赖全局 dispatcher

在独立子进程中把全局 dispatcher 限制为一条连接并占住它，断言 Telegram 私有 transport 的请求仍能完成。

### 6.3 真实 multipart

通过真实 `undici.fetch` 向本地 server 执行一次 `sendDocument`，验证 multipart boundary、`chat_id`、文件名、媒体类型和二进制内容。其他 payload 继续由现有 fake fetch 测试覆盖。

### 6.4 基本资源所有权

通过 fake transport 覆盖四种情况：

- 正常 `start → stop` 只销毁一次。
- 连续两次 `stop()` 不重复销毁。
- `getMe` 失败会销毁并保留原始错误。
- `createApi` 抛错仍会销毁。

不在本次增加启动取消、重启代际和 poll 崩溃竞态矩阵。

### 6.5 现有语义与发布包

复用现有测试确认 uncertain 错误语义和“不发送 fallback 副本、不重试”保持不变，然后执行：

```text
npm run check
npm pack
在空临时目录安装 tarball
导入 lib/index.js
通过发布包执行一次本地 Telegram transport 请求
```

## 7. 验收标准

满足以下条件即可关闭 Issue #85：

- `/getUpdates` 未返回时，短 Telegram API 请求仍能先完成。
- Telegram transport 不受受限全局 dispatcher 影响。
- `sendDocument` 通过真实 multipart 成功。
- 正常停止、重复停止和启动失败不会重复销毁或遗留 transport。
- 标准代理变量仍由 Undici 官方代理实现处理。
- 现有 timeout、unknown delivery 和 `CHANNEL_DELIVERY_UNCERTAIN` 语义不变。
- 没有新增最终消息或文件上传重试。
- 完整构建、测试和干净发布包安装通过。

实施验收记录：`npm run check` 构建成功且 1949 项测试全部通过；实际 tarball 在空临时目录安装后可导入 `lib/index.js`，并可从安装包执行本地 Telegram transport 请求；本机 DSH 重启加载新构建后，在 Telegram Runtime 长轮询运行期间向真实会话发送成功，HTTP 投递返回 200。

## 8. 后续加固

以下内容单独建 issue，不阻塞 #85：

- Runtime 生命周期串行化或 generation 机制。
- Telegram Token、代理凭据和 transport error 统一脱敏。
- `inspectTelegramToken()` 使用同一网络策略。
- poll 崩溃后的即时资源回收。
- 多聊天、大文件和短消息混合负载评估。

## 9. 参考资料

- [Issue #85](https://github.com/xmanrui/dsh-im/issues/85)
- [Undici EnvHttpProxyAgent v7.29.0](https://github.com/nodejs/undici/blob/v7.29.0/docs/docs/api/EnvHttpProxyAgent.md)
- [Undici Fetch v7.29.0](https://github.com/nodejs/undici/blob/v7.29.0/docs/docs/api/Fetch.md)
- [Node.js fetch 自定义 dispatcher](https://nodejs.org/dist/latest/docs/api/globals.html#custom-dispatcher)
