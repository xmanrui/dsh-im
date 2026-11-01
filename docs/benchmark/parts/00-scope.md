## 0. 对标项目集合与选择依据

本仓定位（ADR-0001 原文）：「横向建设统一语义，纵向逐个渠道打磨」。它同时具备三层身份：

1. **IM 渠道接入层** —— 15 个渠道目录（14 个用户渠道 + `shared`），把平台事件规范化为统一语义；
2. **Agent 桥接层** —— 把 IM 消息送入 DeepSeek Harness 会话，并把回复、产物、审批流回投到原会话；
3. **cordis 插件** —— 以 `package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml` 挂载，构建产物 `lib/index.js` 入库随包发布。

因此对标集合按这三层各取 2-3 个上游，而不是只找「也接了很多 IM」的项目：

| # | 上游项目 | 与本仓对应的层 | 一手数据（复算时间 2026-11-02T00:2x+08:00） | 选择理由 |
| --- | --- | --- | --- | --- |
| 1 | `koishijs/koishi` | 第 3 层：插件生态 / 适配器契约 | `gh api repos/koishijs/koishi` → **6,309 stars** | 插件式机器人框架，适配器与 service 注入是其核心抽象 |
| 2 | `nonebot/nonebot2` | 第 3 层：插件加载与依赖 | `gh api repos/nonebot/nonebot2` → **7,777 stars** | Matcher/适配器驱动 + 插件热加载，与本仓「按渠道适配器结构接入」同类 |
| 3 | `langbot-app/LangBot` | 第 1 层：多 IM 覆盖 | `gh api repos/langbot-app/LangBot` → **18,657 stars** | 明确同时覆盖 QQ / 微信 / 飞书 / 钉钉 / Discord / Telegram / Slack，是与本仓功能交集最大的项目 |
| 4 | `zhayujie/chatgpt-on-wechat` | 第 1 层：个人微信 / 公众号接入 | `gh api repos/zhayujie/chatgpt-on-wechat` → **47,731 stars** | 中文 IM + LLM 场景装机量最大，个人微信侧能力边界最有参考价值 |
| 5 | `42wim/matterbridge` | 第 2 层：桥接抽象 | `gh api repos/42wim/matterbridge` → **7,609 stars** | 多协议桥接网关，桥接契约与消息翻译是最干净的对照组 |
| 6 | `wechaty/wechaty` | 第 2 层：单渠道深度 / 协议层 | `gh api repos/wechaty/wechaty` → **23,461 stars** | 个人微信协议层事实标准，用于界定「UIA 桥」的能力天花板 |
| 7 | `matrix-org/matrix-appservice-bridge` | 第 2 层：桥接状态机 | `gh api repos/matrix-org/matrix-appservice-bridge` → **187 stars** | 官方桥接库，双 puppet 模型与本仓 matrix 渠道直接对应 |

本仓自身基线（同一时刻取数，详见分卷 05）：

- `gh api repos/xmanrui/dsh-im` → **3,044 stars / 310 forks / 86 open issues**，`pushed_at` 2026-11-01T13:07:26Z，MIT；
- 本地 HEAD `0ae0e13`（分支 `feat/wechat-groups`），1090+ 提交；
- `src` 278 个 mjs / 81,354 行；`test` 293 个 mjs / 129,003 行；用例 4,736 条；
- `lib/index.js` 10,100,334 B + `lib/client.js` 1,823,532 B（入库产物，见 2.3 与改造 ②）；
- 仓库缺 `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` / `SECURITY.md` / ISSUE 模板 / PR 模板（`ls` 实测，见分卷 05）。