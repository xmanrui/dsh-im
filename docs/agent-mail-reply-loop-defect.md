# Agent Mail 自动回复自激循环 —— 缺陷记录

**邮箱**：`c3h3dsh@agent.qq.com`（腾讯 Agent Mail，`alias_bdXIgBSOZN7BTjnyeLDCB8x85nlgp4qT`）
**发现时间**：2026-09-17T16:5x Z
**状态**：循环已自行停止（停在 7 封），根因未修复

## 1. 现象

对同一封测试邮件（Message-ID `<tencent_EDC3D4864B69E72E35D30456231EE094C306@qq.com>`，
主题「Agent 邮箱链路测试」，2026-09-17T16:10:48Z 收到）的自动回复，出现持续自激回信。

Sent 文件夹实测（UTC）：

| # | 时间 | 备注 |
|---|------|------|
| 1 | 16:31:30 | 正常回信，内容干净 |
| 2 | 16:31:45 | **正文泄露内部过程旁白**（见 §4） |
| 3 | 16:32:52 | 正文 `渠道回信测试：链路正常。` |
| 4 | 16:37:02 | 观察期间新增 |
| 5 | 16:48:38 | 观察期间新增 |
| 6 | 16:51:14 | 观察期间新增 |
| 7 | 16:52:07 | 观察期间新增，之后停止 |

约 20 分钟内从 3 封增至 7 封。本机**无** dsh-im 进程、`~/.dsh/logs/` 无相关日志，
说明发送方在另一台机器/另一个会话上运行。

## 2. 根因

`c3h3-dsh-im` 的 email 渠道把**每个不同 Message-ID 映射为独立会话**
（`src/channels/email/state-store.mjs` 的 `rememberThreadId()` / `conversationForThreadId()`）。

`bots/email_9b295ef4019bfd69361b3151/state.json` 中可见：

```
direct:<tencent_5046EC86310160D5E2CD4D513D246C00960A@qq.com> -> session-ee620158-...
direct:<tencent_EDC3D4864B69E72E35D30456231EE094C306@qq.com> -> session-40b727a2-...
direct:<tencent_82915D2CA67EAC313CFC29F587C18DBA5207@qq.com> -> session-ba766e40-...
```

自发回信会作为**新邮件**回流进 INBOX，其 Message-ID 未被 `seenMessageIds` 覆盖，
于是被当作新的用户来信 → 新建会话 → 再次自动回复 → 再回流。

`seenMessageIds` 当前只登记了 2 条入站 ID：

```json
["<tencent_5046EC86310160D5E2CD4D513D246C00960A@qq.com>",
 "<tencent_EDC3D4864B69E72E35D30456231EE094C306@qq.com>"]
```

**关键缺口：出站回信的 `rfc_message_id` 从未写入 `seenMessageIds`。**

## 3. 修复方向

1. **出站回声抑制**：回信成功后，把它自己的 `rfc_message_id` 写入 `seenMessageIds`。
2. **引用链判定**：若来信的 `in_reply_to` / `references` 指向本机已发出的回信，直接丢弃。
3. **同 thread 幂等**：对同一原始邮件记录「已自动回复」，禁止二次自动应答。
4. **特征识别**：回信正文带 `(OpenAI/<model>) 回复:` 前缀，可作为回声判定特征之一。

## 4. 附带缺陷：内部过程旁白泄露进外发邮件

第 2 封（16:31:45，`msg_ZVvS1pi73KY_kJ-W-iG9ZRwt`）把 Agent 内部过程旁白原文发给了收件人：

```
I'll check what email capability exists in this environment before replying.
This workspace has an agent-mail channel. Let me read its protocol and runtime to reply correctly.
The `c3h3-dsh-im` project has an agent-mail channel. Let me find the stored credentials and the send path.
I have the transport. Now let me find the stored credentials for this mailbox.
Credentials live in a token-config store. Let me locate that store and the mailbox config.
I have the mailbox credentials and protocol. Let me verify the account identity before replying.
```

即「分步直推 / 过程旁白」被当作邮件正文投递。

**规则：回信正文只允许包含面向用户的最终答复**，不得包含工具调用旁白、凭据名
（如 `DSH_EMAIL_PASSWORD_...`）、本地路径、内部会话/项目信息。

## 5. 发送接口备忘（实测可用）

- 回复：`POST https://api.agent.qq.com/v1/aliases/{alias_id}/messages/{message_id}/reply`
  body `{body, body_format, reply_all}`
- 新发：`POST .../messages/send` body `{to:[{email}], subject, body, body_format}`
- 必带 `Authorization: Bearer <token>` 与 UA
  `agently-cli/1.0.15 (windows/amd64; agent/workbuddy)`（UA 错误会被拒为 `unsupported client`）
- token 存于 `~/.dsh/.credentials.yaml` 的
  `DSH_EMAIL_PASSWORD_9B295EF4019BFD69361B3151`，值为 JSON：`{address, accessToken, refreshToken}`
- scopes：`alias:read mail:delete mail:read mail:send`
- 限流：**10 req/min、200 req/hour、daily_send_quota 50**，超限返回 `429 Too Many Requests`
  （排查时限流很易触发，注意退避）

## 6. 本次处置结果（2026-09-17T16:54Z）

- 已向原始测试邮件 `msg_ZeEFYmcJjp5YkqzTSjOnqwPOH8DcXtJtrPWHrWP2xqb0gg` 发送**一封干净回信**：
  - 接口：`POST /v1/aliases/{aid}/messages/{id}/reply`
  - 首次返回 `428 CONFIRMATION_REQUIRED`，带 `confirmation_token` 重提交后 **200 `{queued:true}`**
  - 落到 Sent：`msg_EoC_RKfrl3OAD95DxPE9aZBYSyF-8fYY_yPj_Jqm9jpnfw` @ 16:54:19Z
  - 正文仅含结论与双方邮箱地址，**不含**任何过程旁白/凭据名
- **注意**：`CONFIRMATION_REQUIRED` 是正常的发信两步确认，不是错误；
  发送实现必须自动带 token 重试（`agent-mail.mjs` 的 `#sendWithConfirmation` 已处理）。

### 仍未修复
自激循环的根因（§2/§3）**未修改代码**，仅记录。若该邮箱持续被自动回复，
将反复触发回声回流并消耗 `daily_send_quota 50`。建议优先实现「出站 Message-ID 回声抑制」。

---

# 更正（2026-09-18）：循环已修复，当前故障是 OAuth 过期

> 本文档 §2/§3 的结论**已过时**。最新实测更正如下。

## A. 回声循环修复已落地

提交 `8f93edc`「fix(email): de-duplicate on the message id, not only the cursor」
把**已见集合**（以 RFC Message-ID 为键，`state.hasSeen` / `markSeen`）变成真正的投递
守卫，不再依赖游标。`email-runtime.mjs` 约 449 行会跳过 Message-ID 已见过的邮件。
实测 `state.json` 的 `seenMessageIds` 现有 16 条。

**结论：自激循环不再是当前的阻塞点。**

## B. 当前真实故障：access token 与 refresh token 双双过期

直连实测（2026-09-18）：

| 探测 | 结果 |
|------|------|
| `GET https://api.agent.qq.com/v1/me`（带存储的 accessToken） | **HTTP 401** `{"error":{"code":"AUTHENTICATION_REQUIRED","message":"Invalid or expired access token"}}` |
| `POST https://auth.agent.qq.com/oauth/token`（`grant_type=refresh_token`） | **HTTP 401** `{"err_code":-21653,"error":"invalid_grant","error_description":"refresh token is invalid or expired, please re-authenticate"}` |

两个 token 同时失效，因此传输层**无法自愈**：`#request()` 在 401 时会刷新一次并重试，
但刷新本身被拒，于是每次调用都 fail-closed。

## C. `Execution failed: MultipleInvalid` 是表象，不是根因

`MultipleInvalid` 是 Agent Mail / QQ 服务端栈抛出的 cerberus 风格**多字段校验错误**。
在 `c3h3-dsh-im` 源码树中**完全不存在**（已 grep `src/`、`plugin-src/`、`test/`，零命中）。
它是服务端在拒收 Agent 回信时返回的信封，被当作该轮次的失败文本呈现给 Agent。

## D. 正确处置：走 QR 设备码流程重新授权

流程已实现，无需改代码：

- `startAgentMailDeviceFlow()` → `POST https://auth.agent.qq.com/oauth/device?func=1`
  返回 `poll_url` / `browser_url` / `input_code` / `expires_in`
- `pollAgentMailDeviceFlow({ pollUrl })` 轮询至 `status === 'authorized'`
- 把返回的 token 回写 `DSH_EMAIL_PASSWORD_9B295EF4019BFD69361B3151`

**必须由用户用微信扫码**，无法无人值守完成。

注意：`poll.mjs` 依赖 `/tmp/agent-mail-pending.json`，而沙箱会在工具调用之间清空 `/tmp`，
因此该流程必须在**同一步内连续完成**：启动设备码 → 写 pending 文件 → 展示二维码 → 轮询。

## E. 相邻未修问题（原 §4，仍然有效）

「内部过程旁白泄露进外发邮件」是**独立的**质量问题。规则不变：回信正文**只允许**包含
面向用户的最终答复——不得包含工具调用旁白、凭据名（如 `DSH_EMAIL_PASSWORD_...`）、
本地路径、内部会话/项目标识。
