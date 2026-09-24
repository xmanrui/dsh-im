# Issue #70：九渠道 Harness 问题与审批兼容修复方案

方案日期：2026-09-04。实施基线：dsh-im v4.9.0。状态：代码实施完成；4 个本机客户端实测通过，其余 5 个渠道待用户人工验收。

需求来源：[Issue #70](https://github.com/xmanrui/dsh-im/issues/70)。本方案针对已在 `dsh-v0.1.2-alpha.5 + dsh-im 4.9.0` 和 `dsh-v0.1.2-rc.1 + dsh-im 4.9.0` 上确认的回归：Harness 结构化问题仅出现在 DSH Web，IM 侧停留在“正在使用 `ask_user_question`”。

实施结果（2026-09-04）：已按本文的最小方案完成共用 Host 适配层、回归测试、发布 bundle 和变更日志。`dsh-v0.1.2-rc.1` 下，飞书、企业微信、钉钉、Telegram 各选一个机器人完成了真实客户端的提问与审批闭环；微信个人号、QQ、Slack、Discord、WhatsApp 按用户安排由用户手动验收。

## 1. 最终决定

在九个 IM 渠道共用的 modern Harness 适配层中，用一个小函数兼容读取新旧 DSH Session 事件：

1. Session 提供 `snapshotEvents()` 时，读取一次当前不可变快照。
2. Session 没有 `snapshotEvents()` 但仍提供 `events` 数组时，继续使用旧接口。
3. `#claimableAgent()` 用统一的 `events` 判定交互归属，并把同一份快照交给后续逻辑。
4. 结构化问题继续复用现有 `question/requested` 广播与回答回填机制。
5. 审批请求不再直接读取 `owner.session.events`，改为复用 `owner.events`。

这是 Host 级别的统一修复。企业微信、微信个人号、钉钉、QQ、飞书、Slack、Telegram、Discord 和 WhatsApp 不需要九份补丁。

本次不引入 DSH 版本判断、新配置项、新交互协议、新持久化数据或新依赖。

## 2. 范围与完成标准

### 2.1 必须修复

覆盖以下九个渠道：

1. 微信个人号
2. 飞书
3. 钉钉
4. 企业微信
5. QQ
6. Slack
7. Telegram
8. Discord
9. WhatsApp

每个渠道都必须保持以下完整闭环：

- dsh-im 所有的 Turn 中，`ask_user_question` 能进入原有渠道交互流程。
- IM 用户回答后，原 Harness Turn 继续，后续流式内容和最终答案送回同一会话。
- dsh-im 所有的 Turn 中，Harness 审批请求能进入原有渠道审批流程。
- IM 用户批准或拒绝后，结果只回填给原审批。
- 浏览器所有的 Turn、其他 Host 和其他 Session 的交互不能被 dsh-im 抢占。
- 旧 DSH 上已可用的问题、审批、流式回复、Session 绑定和取消行为不退化。

### 2.2 明确不做

- 不改写九个渠道已有的问题呈现、选项解析、审批文案和回复状态机。
- 不无条件拦截所有 Harness 交互；仍只接管有活跃 dsh-im interaction owner 的 Turn。
- 不为新旧 DSH 维护版本区间表，不解析 `package.json` 或 CLI 版本号。
- 不优化 Session 事件扫描或新增增量游标；每次交互读取一份完整快照已足够。
- 不把 AI Office 纳入本次九渠道验收；它使用同一 `harnessConnection()` 时会自然获得兼容修复，但不做 Office 专属改造。

## 3. 现象、证据与根因

### 3.1 已确认现象

- `dsh-v0.1.2-alpha.5 + dsh-im 4.9.0`：企业微信仅显示正在思考，DSH Web 已显示待回答问题。
- `dsh-v0.1.2-rc.1 + dsh-im 4.9.0`：已再次复现同样现象。
- dsh-im 已有渠道问题和审批的呈现与回填；失败发生在进入渠道处理器之前。

### 3.2 回归根因

dsh-im v4.9.0 的 `plugin-src/host/modern-harness-api.mjs` 在 `#claimableAgent()` 中要求 `agent.session.events` 必须是数组。

DSH 在 [`5660f44d`](https://github.com/deepseek-ai/deepseek-harness/commit/5660f44d29f47fca2612c92ecffe6fb699c486f1) 中将 Session 日志读取拆成 `eventAt()` 和 `snapshotEvents()`，并移除公开 `events` getter。[`dsh-v0.1.2-rc.1` 的 Session](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/core/session/src/index.ts#L588-L616) 因此有 `snapshotEvents()`，但没有 `events`。

```text
user-questions/request 或 approval/request
  -> #claimableAgent(request.agent)
  -> Array.isArray(agent.session.events) === false
  -> 返回 null 并调用 next()
  -> 交互被交给 DSH Web
  -> dsh-im mux 没有 question/requested / approval/requested
  -> 九渠道的 onInteraction 都不会执行
```

审批路径还有第二个相同假设：`#requestApproval()` 直接使用 `owner.session.events` 查找未决策的 `approval/asked`。因此不能只让 `#claimableAgent()` 通过，还必须让审批扫描复用兼容快照。

### 3.3 现有测试为什么没有发现

`test/host-modern-harness-api.test.mjs` 的问题和审批 fixture 都使用 `const session = { id: 'session', events: [] }`。这只模拟了旧 Session 形状，没有模拟 rc.1 的“只有 `snapshotEvents()`、没有 `events`”，因此用例会假通过。

### 3.4 与 Issue 早期报告的边界

Issue 最初的 `dsh-im 3.0.4 + DSH 0.1.0-rc.5` 报告发生在 modern Host 适配层引入之前，不能仅凭相同表象认定为本次 API 回归。

“在 Web 作答后，67 分钟长 Turn 的后续消息未送达 IM”也尚未证明是同一根因。本次会验证“用户在 IM 回答问题/审批后，同一 Turn 继续并完成投递”，但不在没有新复现证据时重写长 Turn 订阅生命周期。

## 4. 九渠道为什么能统一修复

九渠道的 production controller 都会调用 `harnessConnection(ctx, config)`。当 Host 没有旧 `apiProxy` 且未显式设置 `harnessBaseUrl` 时，它们共用 `modernHarnessApi(ctx)`。

| 渠道 | production 接入 | 原有交互呈现 | 是否改渠道代码 |
| --- | --- | --- | --- |
| 企业微信 | `plugin-src/host/channels/wecom/production.mjs` | `WecomBridge` 自有 `onInteraction` | 否 |
| 微信个人号 | `plugin-src/host/channels/weixin/production.mjs` | `WeixinBridge` 自有 `onInteraction` | 否 |
| 钉钉 | `plugin-src/host/channels/dingtalk/production.mjs` | `DingTalkBridge` 自有 `onInteraction` | 否 |
| QQ | `plugin-src/host/channels/qq/production.mjs` | `QqBridge` 自有 `onInteraction` | 否 |
| 飞书 | `plugin-src/host/channels/feishu/production.mjs` | `FeishuBridge` 自有卡片/文字交互 | 否 |
| Slack | `plugin-src/host/channels/slack/production.mjs` | 复用 `TextHarnessBridge` | 否 |
| Telegram | `plugin-src/host/channels/telegram/production.mjs` -> `channels/shared/production.mjs` | 复用 `TextHarnessBridge` | 否 |
| Discord | `plugin-src/host/channels/discord/production.mjs` -> `channels/shared/production.mjs` | 复用 `TextHarnessBridge` | 否 |
| WhatsApp | `plugin-src/host/channels/whatsapp/production.mjs` | 复用 `TextHarnessBridge` | 否 |

九渠道在收到 mux 中的 `question/requested` 或 `approval/requested` 后，已有各自或共享的呈现流程。当前回归使这两类帧在 Host 适配层就被丢失，修复共用上游入口即可覆盖全部九渠道。

## 5. 最小实现方案

### 5.1 文件内兼容函数

在 `plugin-src/host/modern-harness-api.mjs` 内增加非导出函数，不新建模块：

```js
function sessionEvents(session) {
  if (typeof session?.snapshotEvents === 'function') {
    const events = session.snapshotEvents();
    if (Array.isArray(events)) return events;
  }
  const events = session?.events;
  return Array.isArray(events) ? events : null;
}
```

- 优先新 DSH 的公开 `snapshotEvents()`。
- 新接口不存在或返回非数组时，再读取旧 `events`。
- 不吞掉 `snapshotEvents()` 本身抛出的真实 Host 错误。
- 不修改、排序或另行缓存返回的数组。

### 5.2 统一交互归属快照

`#claimableAgent()` 收敛为：

```js
#claimableAgent(agent) {
  const session = agent?.session;
  const sessionId = session?.id ?? agent?.id;
  const events = sessionEvents(session);
  if (typeof sessionId !== 'string' || !events) return null;
  return hasActiveHarnessInteractionOwner(this.#scope, sessionId, events)
    ? { sessionId, events }
    : null;
}
```

仍然必须由 `hasActiveHarnessInteractionOwner()` 确认当前 Session 存在未完成、可重连的 dsh-im Turn。不匹配时继续调用 `next()`，把处理权留给 Web 或其他 Host 处理器。

### 5.3 问题与审批

`#requestQuestion()` 不改协议或流程。owner 可被识别后，它会按现有机制建立 pending 记录、广播 `question/requested`、校验答案、广播 `question/resolved` 并恢复 Turn。

`#requestApproval()` 保留现有审批 ID 匹配算法，只替换事件来源：

```js
for (let index = owner.events.length - 1; index >= 0; index -= 1) {
  const event = owner.events[index];
  // 原有 approval/decided、approval/asked、callId 逻辑不变
}
```

这同时修复 owner 判定和审批扫描两处旧 API 假设。使用同一份快照，还能保证“归属判定”与“审批 ID 选择”观测到同一时点的 Session 日志。

## 6. 旧 DSH 兼容策略

兼容性按运行时能力选择，不按版本号选择：

| Host / Session 形状 | `harnessConnection()` 路径 | 修复后行为 |
| --- | --- | --- |
| 旧 Host 提供 `ctx.apiProxy` | 直接复用 `apiProxy` | 不进入 modern 适配层，行为不变 |
| modern Host，Session 有 `snapshotEvents()` | `modernHarnessApi(ctx)` | 读新接口；覆盖已复现的 alpha.5 和 rc.1 |
| 较早 modern Host，Session 只有 `events` | `modernHarnessApi(ctx)` | 回退读旧数组，保持原行为 |
| 过渡 Session 同时提供两者 | `modernHarnessApi(ctx)` | 优先 `snapshotEvents()` |
| 两者都不提供 | `modernHarnessApi(ctx)` | 不声称交互，安全调用 `next()` |
| 显式配置 `harnessBaseUrl` | 旧远程 HTTP/WebSocket 路径 | 不进入 modern 适配层，行为不变 |

该策略可兼容旧 DSH，且不要求 dsh-im 增加 DSH npm 依赖。将来预发布标签或正式版号变化时，只要 Session 保持上述任一能力，就不需要改分支。

## 7. 修复后的统一链路

### 7.1 结构化问题

```text
IM 入站消息
  -> 渠道 Bridge 调用共用 HarnessClient.ask()
  -> HarnessClient 在 interactionScope 登记当前 Turn owner
  -> DSH 调用 user-questions/request
  -> modernHarnessApi 用 snapshotEvents() / events 识别 owner
  -> mux 广播 question/requested
  -> 原渠道 onInteraction 发送问题
  -> 用户在原会话作答
  -> 原渠道状态机解析并 respondInteraction()
  -> modernHarnessApi.respond() 验证并恢复 DSH Turn
  -> 后续流式内容与最终答案继续返回原渠道
```

### 7.2 审批

```text
Harness 写入 approval/asked
  -> DSH 调用 approval/request
  -> modernHarnessApi 用同一 Session 快照确认 owner
  -> 在 owner.events 中按原 callId 规则选中 approvalId
  -> mux 广播 approval/requested
  -> 原渠道 onInteraction 发送审批
  -> 用户批准/拒绝
  -> modernHarnessApi.respond() 核对 sessionId + approvalId + outcome
  -> Harness 写入 approval/decided 并继续 Turn
```

## 8. 代码改动清单

### 8.1 需要修改

| 文件 | 最小改动 |
| --- | --- |
| `plugin-src/host/modern-harness-api.mjs` | 增加 `sessionEvents()`；调整 `#claimableAgent()`；审批扫描改用 `owner.events` |
| `test/host-modern-harness-api.test.mjs` | 增加新旧 Session 形状的问题和审批回归用例 |
| `CHANGELOG.md` | 在 `Unreleased / Fixed` 记录九渠道对新 DSH Session API 的问题/审批兼容修复 |
| `lib/index.js` | 由 `npm run build` 重建，确保 npm 实际入口包含修复 |

### 8.2 不需要修改

- `plugin-src/host/harness-connection.mjs`：已正确选择旧 `apiProxy` 或 modern 适配器。
- `src/channels/shared/harness-client.mjs`：owner 登记、mux 消费、回答校验和重连机制已存在。
- `src/channels/shared/harness-question.mjs` 和 `harness-approval.mjs`：问题/审批语义未变。
- 九个渠道的 Bridge、Runtime 和 production controller：下游交互逻辑已有覆盖，不复制修复。
- 配置、状态文件和 UI：不需要迁移。

## 9. 测试与验证

### 9.1 Host 适配层回归测试

调整 `test/host-modern-harness-api.test.mjs` 的 Session fixture，让内部可变日志与暴露的 Session API 分离：

```js
const events = [];
const currentSession = {
  id: 'session',
  snapshotEvents: () => Object.freeze([...events]),
};
const legacySession = { id: 'session', events };
```

`currentSession` 不能保留 `events` 属性，否则用例仍然无法防住真实回归。

最少覆盖以下矩阵：

| Session API | 结构化问题 | 审批 | 预期 |
| --- | --- | --- | --- |
| 只有 `snapshotEvents()` | 是 | 是 | dsh-im owner 接管、响应并完成 Turn |
| 只有 `events` | 是 | 是 | 旧 DSH 行为不变 |
| 两者都有，`events` 放入过期数据 | 是 | 是 | 使用 `snapshotEvents()` 的当前数据 |
| 两者都没有 | 是 | 是 | 不报错、不抢占，调用 `next()` |
| API 有效但 Session/Turn 不属于 dsh-im | 是 | 是 | 调用 `next()`，保持 Web owner |

成功用例还要断言：

- 问题答案或审批 outcome 确实回到 DSH waterfall 请求。
- `question/resolved` 或 `approval/resolved` 被广播。
- 交互之后的 `assistant/message` 和 `turn/end` 仍被 `HarnessClient.ask()` 消费。
- `ask()` 返回交互之后的最终文本，不停在“正在使用”。
- abort/cancel 仍清理 pending interaction，不留过期请求。

优先复用现有两个 adapter 闭环用例，只抽取一个小型 Session fixture 切换 API 形状，不新建模拟 Harness 框架。

### 9.2 九渠道自动化覆盖

本次故障位于所有渠道之前，不增加九份重复的 Session API 测试。自动化分两层证明覆盖：

1. `test/host-modern-harness-api.test.mjs` 证明共用 Host 适配层能在新旧 DSH 上产生并回收问题/审批。
2. 现有渠道 Bridge 测试证明 interaction 到达后可被原生呈现和回填。企业微信、微信个人号、钉钉、QQ、飞书使用自有 Bridge 用例；Slack、Telegram、Discord、WhatsApp 的共性由 `test/channels/shared/text-harness-bridge.test.mjs` 覆盖，渠道差异由各自现有测试覆盖。

执行顺序：

```bash
node --test test/host-modern-harness-api.test.mjs
npm test
npm run check
```

`npm run check` 会重建 client/host bundle、运行全量测试并验证发布包。完成后再确认生成的 `lib/index.js` 已包含 `snapshotEvents` 兼容路径。

### 9.3 真实 DSH 兼容验收

| DSH 环境 | dsh-im | 问题 | 审批 | 目的 |
| --- | --- | --- | --- | --- |
| `dsh-v0.1.2-rc.1` | 当前待发布代码 | 本机实测通过 | 本机实测通过 | 已关闭当前 API 回归 |
| 仅暴露 `session.events` 的旧 modern Session | 当前待发布代码 | 自动化通过 | 自动化通过 | 证明旧 Session API 向后兼容 |
| 提供旧 `ctx.apiProxy` 的 Host | 当前待发布代码 | 现有 adapter 用例通过 | 保持原旁路 | 不进入本次 modern 适配层 |

旧 Session 的兼容性采用能力 fixture 验证，没有把版本号写入生产逻辑；真实旧 DSH 客户端未在本轮重复启动。

### 9.4 九渠道真实客户端烟雾

发布记录必须如实区分“自动化已覆盖”和“真实客户端已验收”。

| 渠道 | `ask_user_question` | 审批 | 交互后最终回复 | 当前状态 |
| --- | --- | --- | --- | --- |
| 企业微信 | 通过（回复 `1`） | 通过（回复“批准”） | 通过 | 本机客户端实测 |
| 微信个人号 | 待验收 | 待验收 | 待验收 | 用户手动测试 |
| 钉钉 | 通过（回复 `1`） | 通过（回复“批准”） | 通过 | 本机客户端实测 |
| QQ | 待验收 | 待验收 | 待验收 | 用户手动测试 |
| 飞书 | 通过（选项按钮） | 通过（批准按钮） | 通过 | 本机客户端实测 |
| Slack | 待验收 | 待验收 | 待验收 | 用户手动测试 |
| Telegram | 通过（回复 `1`） | 通过（回复“批准”） | 通过 | 本机客户端实测 |
| Discord | 待验收 | 待验收 | 待验收 | 用户手动测试 |
| WhatsApp | 待验收 | 待验收 | 待验收 | 用户手动测试 |

问题烟雾必须检查问题和选项可见、回答只被消费一次、最终回复可见。审批烟雾至少覆盖批准或拒绝中的一条，并确认不串到其他会话。

本机实测使用 `dsh-v0.1.2-rc.1`，时间为 2026-09-04 02:59–03:06（Asia/Taipei）。四个渠道都检查了问题/选项可见、回答后原 Turn 恢复、审批参数可见、批准后命令执行、最终回复送达；四个审批测试标记文件均在命令内删除并经本机再次确认不存在。

### 9.5 已执行的自动化

- 修复前：仅 `snapshotEvents()` 和双接口优先级场景的问题、审批共 4 个用例稳定失败，复现旧实现的 API 形状缺口。
- 修复后定向测试：`node --test test/host-modern-harness-api.test.mjs`，9/9 通过。
- 完整检查：`git diff --check && npm run check`，2111/2111 通过，发布包校验通过。
- `lib/index.js` 已由构建脚本重建，并包含 `snapshotEvents()` 优先、`session.events` 回退的兼容逻辑。

## 10. 验收标准

代码实施结果如下；其余 5 个渠道的真实客户端状态仍按上表等待用户补录：

1. 已通过：rc.1 上，企业微信能收到并回答 `ask_user_question`。
2. 已通过：rc.1 上，企业微信能收到并处理审批请求。
3. 已通过：四个实测渠道在问题或审批完成后，同一 Turn 的最终回复均送达 IM。
4. 已通过自动化：旧 `session.events`、新 `snapshotEvents()`、双接口优先级三种形状的问题和审批均成功。
5. 已通过：两种 Session API 形状的 Host adapter 回归测试通过。
6. 已通过：非 dsh-im owner 以及没有可读事件 API 的 Session 均委托给 `next()`。
7. 已通过：`npm run check` 完成 2111 个测试，生成的 npm 入口包含修复。
8. 已记录：九渠道状态逐项列出，未实测的五个渠道明确标记为“用户手动测试”。

## 11. 风险与回滚

| 风险 | 控制 |
| --- | --- |
| 抢占本应在 Web 回答的交互 | 保留 `hasActiveHarnessInteractionOwner()` 为唯一归属判定，非 owner 继续 `next()` |
| 审批匹配错误 | 保留 `approval/decided` 排除、pending 排除和 `callId` 匹配，只替换事件来源 |
| 旧 DSH 回归 | 保留 `events` 回退和旧 `apiProxy` 旁路，用两种 fixture 和真实旧环境验证 |
| 长 Session 快照成本 | 每次交互只读一次；DSH 已缓存全量不可变快照，不再加第二套缓存 |
| 只修问题、遗漏审批 | 同一变更同时修改 owner 判定和审批扫描，两类交互都有新旧 API 用例 |

本次无配置、数据或状态迁移。若发布后发现问题，回滚 `modern-harness-api.mjs` 与重建的 `lib/index.js` 即可，不需要清理机器人配置或 Session 文件。

## 12. 实施顺序

1. 先把现有问题和审批 adapter 用例切换为只暴露 `snapshotEvents()` 的 fixture，确认未修复代码能稳定失败。
2. 增加 `sessionEvents()`，修改 `#claimableAgent()` 和审批扫描。
3. 增加 `events` 旧接口、双接口优先级、无接口委托和非 owner 委托用例。
4. 运行定向测试、全量测试和 `npm run check`，重建发布 bundle。
5. 先在 `dsh-v0.1.2-rc.1 + 企业微信` 验证问题、审批及交互后最终回复。
6. 在代表性旧 DSH 上做同样验收。
7. 完成其余渠道烟雾，如实更新本文档验收表。
8. 更新 `CHANGELOG.md`，发布修复版。

## 13. 结论

当前回归不在九个渠道的呈现层，而在它们共用的 modern Host 交互归属入口。最小且完整的修复是：用一个文件内函数兼容 `snapshotEvents()` 和 `events`，让问题与审批共用同一份 Session 快照，其余协议、渠道桥接和状态机保持不变。
