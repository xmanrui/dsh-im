# 安全策略 · Security Policy

## 支持的版本

| 版本 | 支持状态 | 说明 |
| --- | --- | --- |
| 5.8.x | ✅ 安全更新 | 当前发布线 |
| 5.7.x 及更早 | ❌ | 请升级；旧版不再接受安全修复 |
| DSH 宿主 < `0.2.0-rc.2` | ❌ | 插件已声明不兼容 |

## 报告漏洞

**请不要公开开 issue。**

1. 邮件至 `3753318894@qq.com`，标题前缀 `[SECURITY]`；
2. 或在 GitHub 用 *Private vulnerability reporting*（仓库 Settings → Security → Advisories）；
3. 正文请包含：受影响版本、通道（weixin/feishu/…）、复现步骤、影响面（凭据泄漏/远程执行/越权）、
   以及是否已在公开渠道讨论过。

我们会在 **收到后 72 小时内** 首次回复；确认成立后给出修复版本与公开时间（默认修复发布后 7 天）。

## 本插件的信任边界（读之前先明确这些）

1. **凭据存放位置**：`~/.dsh/integrations/dsh-im/` 与 `~/.dsh/profiles/<profile>/…`，
   永不进入仓库；`scripts/verify-package.mjs` 在每次门禁里检查发布包是否夹带凭据。
2. **IM 管理接口的访问控制**：默认沿用 Harness 的浏览器认证 + Host/Origin 信任检查；
   `rpcAuthority` 可收紧为 `loopback`（只允许本机）。
3. **本地 UIA 桥（个人微信群）**：通过 UI Automation 驱动本机微信窗口，**等价于在本机拥有一个
   能读屏、能模拟输入的程序**。启用前请明确：它需要 `py -3.12` 与
   `scripts/requirements-wechat-group.txt` 的依赖，运行时会读取微信窗口内容。
4. **出站产物**：只有通过受信工具（`dsh_im_return_file`）显式登记的文件才会被发送；
   助手回复里的路径不会自动触发发送（ADR-0001 明文）。
5. **第三方 SDK**：飞书 / QQ / 企微 / WhatsApp / Matrix / 邮件 各渠道依赖独立 SDK，
   其供应链风险不在本仓库控制范围内，见 `THIRD_PARTY_NOTICES.md`。

## 不在本仓库范围内

- 宿主 DeepSeek Harness 本身的漏洞 → 报给 Harness 仓库；
- 各平台（微信/飞书/钉钉…）服务端问题 → 报给对应平台；
- 用户自行修改 `~/.dsh` 配置引入的风险。
