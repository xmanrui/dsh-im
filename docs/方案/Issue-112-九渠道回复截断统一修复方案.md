# Issue #112：九渠道回复截断统一修复方案

日期：2026-09-05。实施基线：dsh-im v4.10.0 / `e86e097`。状态：待实施。

需求来源：[Issue #112](https://github.com/xmanrui/dsh-im/issues/112)。[Issue #77 的用户评论](https://github.com/xmanrui/dsh-im/issues/77#issuecomment-5541128598) 提供了同一共享根因的补充证据。本方案只修复“多 step 回答最终只剩最后一段”，不处理 QQ 原生流式恢复或其他渠道展示优化。

## 1. 最终决定

在九个 IM 渠道共用的 `HarnessReplyTracker` 中一次修复回复截断：

1. 继续使用现有 `#stepText` 保存 `(step, index)` 文本，不引入新数据结构或中间层。
2. 收到 `assistant/chunk` 的 `text-delta` 时，从“只合并当前 step”改为“按 `(step, index)` 合并当前 Turn 已收到的全部正文”。
3. 收到带 `step` 的定稿 `assistant/message` 时，用定稿文本替换同一 step 的流式 delta，再重新合并整轮正文，避免重复。
4. 不带 `step` 的旧协议 `assistant/message` 保持现有“最新定稿覆盖当前答案”行为，不猜测它属于哪个 step。
5. 不改动九个渠道的 Bridge、Runtime、流式载体和最终发送逻辑。它们自然获得共享 tracker 返回的完整答案。
6. 不引入配置项、版本分支、持久化数据、定时器或新依赖。

这是一个共享文本归并错误，不是九个渠道各自的投递错误。因此只修共享层，不在九个渠道复制补丁。

## 2. 范围与完成标准

### 2.1 必须修复

一次覆盖以下九个渠道：

1. 微信个人号
2. 飞书
3. 钉钉
4. 企业微信
5. QQ
6. Slack
7. Telegram
8. Discord
9. WhatsApp

完成后必须满足：

- 同一 Turn 包含多个有可见文本的 step 时，最终 `answer` 包含全部 step 的正文，不再只剩最后一个 step。
- 同一 step 的流式 delta 不会与后续定稿 `assistant/message` 重复。
- step 内多个文本 part 继续使用单换行分隔；不同 step 使用空行分隔，避免 Markdown 文本粘连。
- 单 step 回答、无 `step` 旧事件、工具调用、思考内容、附件、审批、停止和超时行为保持不变。
- 静态回复渠道发送完整最终文本；可编辑/流式渠道不再在进入新 step 时撤回前文。

### 2.2 明确不做

- 不恢复 QQ 原生流式输出。
- 不增加“正在思考”、工具名称、emoji 或其他新进度样式。
- 不增加 Telegram 心跳或任何新定时器。
- 不改变渠道的流式、编辑、分段、Markdown、附件或失败降级方式。
- 不为九个渠道分别建立回答缓存或拼接器。
- 不通过文本前缀相似度等启发式规则判断事件是“全文”还是“当前 step”。

## 3. 术语与根因

- **Turn**：用户发起一次请求后，Harness 直到完成或停止的整轮处理。
- **step**：一个 Turn 内的一次助手生成阶段。工具调用前后通常会进入不同 step。
- **index**：同一 step 内文本 content part 的序号。
- **delta**：`assistant/chunk` 中的文本增量。
- **定稿消息**：`assistant/message`，是对所属 step 流式 delta 的持久化定稿。

当前 `HarnessReplyTracker` 已经把文本保存在 `#stepText`：

```text
key = "<step>:<index>"
value = 该 part 已收到的 delta 全文
```

问题不在“没有保存前文”，而在“取答案时只取当前 step”：

```js
const prefix = `${step}:`;
const text = [...this.#stepText.entries()]
  .filter(([partKey]) => partKey.startsWith(prefix));
```

进入下一 step 后，该过滤会立即排除之前的 step。后续 `assistant/message` 又直接覆盖 `#latestText`，所以最终 `tracker.answer` 只剩最后一段。

现有链路：

```text
Harness 事件
  -> 共享 HarnessReplyTracker
  -> HarnessClient.ask() 返回 tracker.answer
  -> askInWorkspaceSession()
  -> 渠道 Bridge 发送/完成答案
```

因此截断在渠道发送前已经发生，修复任意一个渠道的发送逻辑都不能从根本上解决。

## 4. 九渠道为什么能统一修复

九个渠道的 Harness Client 都直接继承 `src/channels/shared/harness-client.mjs` 导出的同一个 `HarnessClient`，且没有覆盖 `ask()` 或 `HarnessReplyTracker`。

| 渠道 | Harness Client | 是否需要渠道补丁 |
| --- | --- | --- |
| 微信个人号 | `src/channels/weixin/harness-client.mjs` | 否 |
| 飞书 | `src/channels/feishu/harness-client.mjs` | 否 |
| 钉钉 | `src/channels/dingtalk/harness-client.mjs` | 否 |
| 企业微信 | `src/channels/wecom/harness-client.mjs` | 否 |
| QQ | `src/channels/qq/harness-client.mjs` | 否 |
| Slack | `src/channels/slack/harness-client.mjs` | 否 |
| Telegram | `src/channels/telegram/harness-client.mjs` | 否 |
| Discord | `src/channels/discord/harness-client.mjs` | 否 |
| WhatsApp | `src/channels/whatsapp/harness-client.mjs` | 否 |

Slack、Telegram、Discord 和 WhatsApp 还共用 `TextHarnessBridge`；其他五个渠道有自己的 Bridge。这一差异只影响答案怎样显示，不影响答案文本来自同一共享 tracker。

## 5. 统一文本语义

### 5.1 `text-delta`

保留现有语义：

1. 使用 `${step}:${index}` 定位文本 part。
2. 把新 delta 追加到该 part。
3. 按 step 数字升序、index 数字升序重建整轮文本。
4. 同 step 的 part 以 `\n` 分隔，不同 step 以 `\n\n` 分隔。
5. 只有重建结果与 `#latestText` 不同时才产生新的 `{ type: 'text' }` 更新。

### 5.2 带 `step` 的 `assistant/message`

将它视为该 step 的权威定稿：

1. 删除 `#stepText` 中所有 `${step}:*` 流式 part。
2. 将 `assistantMessageText(event)` 的结果写入 `${step}:0`。
3. 从全部 step 重建整轮文本。

这样既保留前面 step，又不会把同一 step 的“流式草稿 + 定稿”发送两次。

### 5.3 不带 `step` 的 `assistant/message`

继续直接更新 `#latestText`，不与 `#stepText` 合并。这是对旧 DSH/测试 fixture 的兼容路径；因为事件没有 step 信息，共享层不应猜测归属。

### 5.4 非正文事件

以下行为全部保持现状：

- `reasoning-delta` 不进入最终答案。
- `tool/call` 只产生现有工具进度。
- `tool/result` 不暴露工具结果，只保留现有状态/错误处理。
- `turn/end` 仍只负责完成状态和原因，不再做一次文本猜测。

### 5.5 示例

事件：

```text
step 0 / text-delta       "我先检查现有实现。"
step 0 / assistant/message "我先检查现有实现。"
step 1 / text-delta       "问题在共享 tracker。"
step 1 / assistant/message "问题在共享 tracker。"
```

最终答案：

```text
我先检查现有实现。

问题在共享 tracker。
```

不应变成：

```text
我先检查现有实现。
我先检查现有实现。

问题在共享 tracker。
问题在共享 tracker。
```

## 6. 最小实现

只在 `HarnessReplyTracker` 内增加两个私有小函数；函数名可在实施时按现有命名风格调整：

```js
#accumulatedText() {
  const ordered = [...this.#stepText.entries()]
    .map(([key, text]) => {
      const [step, index] = key.split(':').map(Number);
      return { step, index, text };
    })
    .sort((left, right) => left.step - right.step || left.index - right.index);

  const steps = new Map();
  for (const part of ordered) {
    const texts = steps.get(part.step) ?? [];
    texts.push(part.text);
    steps.set(part.step, texts);
  }

  return [...steps.values()]
    .map((parts) => parts.join('\n').trim())
    .filter(Boolean)
    .join('\n\n');
}

#commitText(text, pushUpdate) {
  if (!text || text === this.#latestText) return;
  this.#latestText = text;
  pushUpdate({ type: 'text', text });
}
```

`text-delta` 分支仅将现有的“按当前 prefix 过滤”替换为：

```js
this.#stepText.set(key, (this.#stepText.get(key) ?? '') + event.data.chunk.text);
this.#commitText(this.#accumulatedText(), pushUpdate);
```

`assistant/message` 分支改为：

```js
const text = assistantMessageText(event);
const step = Number.isSafeInteger(event.data?.step) ? event.data.step : null;

if (step === null) {
  this.#commitText(text, pushUpdate);
} else if (text) {
  for (const partKey of [...this.#stepText.keys()]) {
    if (partKey.startsWith(`${step}:`)) this.#stepText.delete(partKey);
  }
  this.#stepText.set(`${step}:0`, text);
  this.#commitText(this.#accumulatedText(), pushUpdate);
}
```

实施时保留 `consumeAll()` 现有的事件排序、`seq` 去重、Turn 归属校验、相邻文本帧折叠和 `progressMode` 逻辑，不顺手重构。

## 7. 代码改动清单

### 7.1 需要修改

| 文件 | 最小改动 |
| --- | --- |
| `src/channels/shared/harness-client.mjs` | 增加整轮文本合并和统一提交小函数；调整 `text-delta` 与带 step 的 `assistant/message` 处理 |
| `test/harness-reply-tracker.test.mjs` | 新增共享 tracker 聚焦回归测试，避免把共享语义继续挂在单一渠道名下 |
| `CHANGELOG.md` | 在 `Unreleased / Fixed` 记录九渠道多 step 回复不再截断 |
| `lib/index.js` | 通过 `npm run build` 重建，不手工编辑 |

### 7.2 不需要修改

- 九个 `src/channels/*/harness-client.mjs`：它们已继承共享实现。
- 九个渠道的 Bridge 和 Runtime：投递方式未变。
- `src/channels/shared/text-harness-bridge.mjs`：它已消费 tracker 产生的文本更新和最终 `answer`。
- `src/channels/shared/workspace-session.mjs`：它已原样返回 `HarnessClient.ask()` 的答案。
- 配置、UI、状态存储和 i18n：没有新字段或文案。

## 8. 测试方案

### 8.1 共享 tracker 单元测试

`test/harness-reply-tracker.test.mjs` 至少覆盖：

| 场景 | 期望 |
| --- | --- |
| 单 step、单 index、多个 delta | 与现有行为一致，delta 按顺序追加 |
| 单 step、多 index | index 按数字升序，part 之间单换行 |
| 两个 step 都只有 delta | `answer` 同时包含两段，step 间空行 |
| 两个 step 都有 `assistant/message` | 两个 step 定稿按序合并 |
| 同 step 先 delta 后定稿 | 定稿替换 delta，文本只出现一次 |
| 无 `step` 的 `assistant/message` | 继续覆盖最新答案，保持旧兼容语义 |
| reasoning、tool/call、tool/result 与文本交错 | 非正文不进入 `answer` |
| 重复 seq、乱序输入、其他 Turn | 继续复用现有排序、去重和 Turn 过滤 |
| `turn/end` 后读取 | `finished`/`reason` 正确，`answer` 为整轮文本 |

测试事件应优先使用 Issue #112 可复现的真实字段形状。如果支持的 DSH 版本存在带 `step` 但内容是“整 Turn 全文”的 `assistant/message`，必须先明确协议语义，不通过前缀去重猜测修补。

### 8.2 九渠道回归

不为九个继承类复制同一组 tracker fixture。覆盖分为两层：

1. 共享 tracker 单元测试证明根因已修复。
2. 运行现有全量测试，证明九渠道的发送、流式完成、附件、停止和失败处理没有回归。

如需真实客户端验收，九渠道使用同一个场景：让 Harness 在同一 Turn 中产生至少两个带正文的 step，检查最终回复是否包含两段且每段只出现一次。验收记录应区分“共享代码已覆盖”和“该渠道已实机验证”，未实测的渠道不标记为实机通过。

### 8.3 执行命令

先运行聚焦测试：

```sh
node --test --test-reporter=spec \
  test/harness-reply-tracker.test.mjs \
  test/channels/feishu/harness-client.test.mjs \
  test/channels/dingtalk/harness-client.test.mjs \
  test/channels/weixin/harness-client.test.mjs
```

再运行完整检查：

```sh
npm run check
```

`npm run check` 必须完成 bundle 重建、全量测试和包验证。

## 9. 兼容与风险控制

| 风险 | 最小处理 |
| --- | --- |
| 定稿消息与流式 delta 重复 | 带 step 的 `assistant/message` 先替换该 step 缓存，再合并 |
| 旧 DSH 事件没有 step | 保留现有覆盖行为，不加版本判断 |
| 工具或思考内容进入最终答案 | 只合并 `text-delta` 和 `assistantMessageText()` 已白名单提取的 `text` part |
| 恢复前文后答案更长 | 继续使用各渠道现有分段、卡片旋转或最终投递机制，不新建限长策略 |
| 共享修复影响范围大 | 保持改动只在 tracker，用共享语义测试加全量渠道回归防护 |
| 额外内存占用 | 现有 `#stepText` 本就保存全部 step；本修复只改变合并视图，不增加长期状态 |

实施前需从当前支持的 DSH 版本中保留一份真实多 step 事件样本，用来确认“带 step 的 `assistant/message` 是该 step 定稿”。这是唯一需要确认的协议前提；一旦确认，不再增加运行时探测和复杂分支。

## 10. 实施顺序

1. 用真实字段形状写入一个会失败的“跨 step 累积”共享测试。
2. 增加 `#accumulatedText()` 和 `#commitText()`，替换当前 step prefix 过滤。
3. 增加带 step 的 `assistant/message` 替换用例，实现同 step 定稿覆盖。
4. 补齐单 step、无 step、工具交错和 Turn 隔离回归测试。
5. 更新 `CHANGELOG.md`，运行 `npm run build` 生成 `lib/index.js`。
6. 运行 `npm run check`。
7. 优先在 Issue #112 原始反馈的企业微信复测；其他渠道按现有客户端条件记录实测状态。

## 11. 验收清单

- [ ] 共享 tracker 的多 step delta 最终包含全部正文。
- [ ] 带 step 的定稿消息替换同 step delta，没有重复文本。
- [ ] 单 step 和无 step 事件保持旧行为。
- [ ] 推理、工具调用和工具结果不进入最终答案。
- [ ] `consumeAll()` 的排序、去重、批内折叠和进度模式未改变。
- [ ] 九渠道 Harness Client 仍全部继承共享实现，无渠道级拼接补丁。
- [ ] 现有回复、附件、审批、停止、超时和失败降级测试全部通过。
- [ ] `npm run check` 通过，生成 bundle 与源码一致。
- [ ] 企业微信原始复现场景中，最终回复不再只剩最后一行/最后一段。
- [ ] 各渠道实机验收状态如实记录，未实测不标记为已通过。

## 12. 修复后的预期结果

本修复完成后，九个渠道仍使用原有投递能力，唯一变化是它们收到的回答从“当前/最后 step 文本”变为“当前 Turn 已确认的完整线性文本”。

修复点只有一处，渠道接入点为零，无配置和数据迁移，可直接通过共享测试和现有全量回归验证。
