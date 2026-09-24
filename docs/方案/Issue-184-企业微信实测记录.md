# Issue 184 企业微信实测记录

日期：2026-09-09，Asia/Taipei。

结论：部分通过，不能据此关闭 Issue 184。新建会话时的 preset 缺失分类与重选恢复流程已通过真实企业微信测试；旧会话恢复时，原版 DSH 0.1.5 仍会提前丢失结构化的 preset 错误码。

## 环境与方法

- 客户端：本机已登录的企业微信，机器人“今天是梁子”。
- Harness：原版 `0.1.5-alpha.1`，工作区 `/Users/manruixie/code/new-dsh/dsh-v0.1.5-alpha.1`，监听 `127.0.0.1:3080`，使用原有 DSH_HOME。
- 插件：本地 dsh-im 4.17.1 工作区构建，包含本次修复及下述适配层补充。
- 从标准 preset 复制独立的 `issue184-live-20260909`，通过真实客户端选择、创建测试会话并完成基线收发；随后将临时 preset 移出发现目录，重启服务，验证恢复失败。
- 普通测试消息均要求不使用工具、不访问文件、不进行修改，只回复唯一标记。

## 实际结果

| 场景 | 真实结果 | 判定 |
| --- | --- | --- |
| 临时 preset 存在时正常收发 | 客户端收到 `ISSUE184_BASELINE_OK_20260909` | 通过 |
| 移走 preset 后恢复旧会话，初版修复 | `INTERNAL_UNKNOWN`，reason 为 `INTERNAL`，参考号 `MF-81A2AFD9` | 未通过 |
| 补充现代适配层后恢复同一旧会话 | `INTERNAL_UNKNOWN`，reason 为 `GATEWAY_INTERNAL`，参考号 `MF-D0BBCA76` | 未通过 |
| preset 缺失时 `/new` 后发送消息 | `PRESET_UNAVAILABLE`，reason 为 `AGENT_PRESET_NOT_FOUND`，参考号 `MF-39B91A40`，客户端显示完整恢复步骤 | 通过 |
| `/presetlist` → `/preset standard` → `/new` 后发送消息 | 客户端收到 `ISSUE184_RECOVERY_OK_20260909`，lastMessageError 清空 | 通过 |
| 企业微信错误日志关联 | 同一参考号可查到，但附加诊断为 `undefined` | 仍有缺口 |

## 实测发现与本次补充

`plugin-src/host/modern-harness-api.mjs` 原先只读取 `error.failure`。本机 DSH 在进程内抛出的 RemoteError 直接携带 `code`、`message`、`details` 和 `isDSHRemoteError: true`，没有 failure 包装，因此在进入共享分类器前就退化成了 internal。

本次增加一行结构识别：保留原有 error.failure，同时接受带 `isDSHRemoteError` 标记的直接错误。新增两个测试，覆盖真实错误结构的透传，以及未带标记的普通错误仍保留 internal 分类。没有增加依赖。

剩余的旧会话问题发生在 DSH 自身 `packages/api/session-controller/src/agent.ts` 的 resolve 异常处理：它把 resume 的异常包装成 `gateway/internal`，details 为空，也没有保留 cause。直接调用真实 session/prompt 得到的诊断为：

```text
gateway/internal
resume failed for session "<测试会话>": RemoteError: agent-presets: preset "issue184-live-20260909" not found (available: standard, ptc, minimal, cordis)
```

所以共享分类器即使支持斜杠，也无法仅凭结构化 code 识别这个恢复故障。本次没有追加对错误文案的猜测匹配，没有修改 DSH 源码。

企业微信日志缺口也得到确认：`wecom-bridge.mjs` 的入站异常处理只输出 `wecomSendDiagnostic(error)`，该函数对 Harness 异常返回 undefined。参考号确实存在，底层异常详情没有随它输出。这与微信 bridge 直接记录原始异常的实现不同，先前不能将微信代码的结论推广到企业微信。

## 恢复现场与验证

- 机器人原有 preset、workspace、model、上下文增强和访问设置均已与测试前快照比对一致。
- `/session` 恢复原绑定的命令返回“未找到该会话”，尽管原会话仍在原生 session/list 中；随后在 Harness 停止期间，只将该机器人的当前会话绑定恢复为测试前保存的值，保留原会话数据和消息去重记录。
- 临时 preset 已移出 DSH 的 preset 目录；测试消息及测试会话记录保留作为证据。
- 测试期间为验证日志临时启用自带 console logger 插件；最后已按原启动方式重启，移除测试日志覆盖配置。
- 结束时本机两个企业微信机器人均为 connected / healthy，原版 DSH 工作区 Git 状态干净。
- `npm run check`：2587 项测试全部通过，构建和包校验通过；这不代替上表未通过的真实恢复测试。

企业微信实测所用 `lib/index.js` SHA-256：`66fc86f29a216bac08595df9a349e6e17c06917e273d9a9695786afff4e790c6`。

推送前同步了远端 main 的 iMessage 渠道提交 `3febdcd`，从合并后的源码重新生成构建产物并执行 `npm run check`：2598 项测试全部通过，构建和包校验通过。该同步后的构建没有重新进行企业微信实测；上文真实收发结论对应上述哈希。

本机详细证据位于 `/tmp/dsh-im-184-live-FqQN3n`，包括初始状态、底层 RPC 错误、新建会话缺失诊断、恢复状态、最终设置核对及完整检查日志。临时目录可能被系统清理；本记录不包含认证令牌或机器人密钥。
