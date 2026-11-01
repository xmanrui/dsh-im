# 贡献指南 · Contributing to dsh-im

> 本文件是外部贡献者唯一的入口。改代码之前先读完「门禁」一节：仓库的 CI 与本地判据是**同一套**，
> 本地绿了 CI 才会绿；反之本地不绿就别开 PR。

## 1. 环境

| 项 | 要求 | 备注 |
| --- | --- | --- |
| Node.js | **>= 22.19** | 由 `package.json` 的 `engines.node` 声明；CI 用 24 |
| 宿主 | DeepSeek Harness `0.2.0-rc.2` / `0.2.1-rc.2` | 由 `dsh.compatibility` 声明；不承诺未验证版本 |
| 操作系统 | Windows / macOS / Linux | Windows 是主力（含专用 CI job） |
| Python | 3.12（仅个人微信群 UIA 桥需要） | `scripts/requirements-wechat-group.txt` |

```sh
npm install
npm run check     # 唯一的完整门禁
node bin/dsh-im.mjs install --source .   # 装进当前 profile
```

## 2. 门禁（`npm run check` 到底做了什么）

```
npm run build                                  # 构建 lib/index.js + lib/client.js
npm test                                       # node --test，全量用例
node scripts/verify-package.mjs                # 发布包内容/凭据检查
node scripts/verify-built-artifacts.mjs        # 入库产物必须等于源码构建结果
node scripts/channel-capability-matrix.mjs --check   # README 能力矩阵必须等于源码
node scripts/verify-benchmark-report.mjs       # 对标报告八维齐全
```

**为什么后三条存在**（这是最容易踩的坑）：

1. **入库产物**：`dsh plugin add` 装的是发布包里的 `lib/*.js`，不是现场构建。所以改 `package.json`
   （它会作为 manifest 被打进 bundle）后，必须 `npm run build` 并把 `lib/*.js` 一起提交，
   否则用户拿到的还是旧字节，而你的源码修复看起来「没生效」。
2. **能力矩阵**：`README.md` / `README.en.md` 里的渠道能力表由
   `scripts/channel-capability-matrix.mjs` 从 `src/channels/*/` 生成。**不要手改表格**；
   改完实现后跑 `node scripts/channel-capability-matrix.mjs --write`。
3. **对标报告**：`docs/benchmark/` 下的报告必须覆盖八维与四个必需要素；新增报告请沿用同一骨架。

## 3. 提交规范

```
<type>(<scope>): <中文或英文短句，≤ 72 字符>

<body：为什么这么改、代价是什么、判据是什么>
```

`type` 取 `feat|fix|perf|refactor|docs|test|build|chore`；`scope` 取渠道名（`weixin`/`feishu`/`ci`/`channels`…）。

- **提交必须点名路径**：`git commit --only -- <files>`。本仓时常有多会话并行写，裸 `git commit`
  会把别人已暂存的内容一起带走。
- **一个提交只做一件事**；源码与其构建产物算同一件事，必须同一笔。
- **不要 amend 已推送的提交**（此仓有 post-commit 自动推送钩子）。

## 4. 新增一个渠道的五步

1. `src/channels/<name>/`：实现 api / runtime / bridge / controller / config-store / state-store；
2. `plugin-src/host/channels/<name>/{index,production,rpc}.mjs`：生产装配；
3. `plugin-src/host/index.mjs`：加入 import 与 `channels` 数组（这一步目前是手动的，见 3.2 M1）；
4. `plugin-src/client/channels/<name>/{index,api,styles}.js`：设置页卡片；
5. `test/channels/<name>/`：至少覆盖入站规范化、出站分片、错误降级三类。

完成后跑：

```sh
node scripts/channel-capability-matrix.mjs --write
npm run check
```

能力矩阵里新渠道的 `—` 格是**明确降级**（ADR-0001），不是缺陷；但 README 的渠道表里必须写清
「不支持什么」，不要留空让人猜。

## 5. 契约与不可让渡的红线

- **统一语义核心 + 渠道原生适配**（`docs/adr/0001-semantic-core-native-channel-adapters.md`）。
  新能力先定义用户语义、降级规则、验收标准，再进渠道实现。
- **不得为了新能力删除既有能力**：迁移必须「增量包裹 + 等价接管」，现有行为是基线。
- **凭据永不入库**：`verify-package.mjs` 会检查发布包；本地也不要提交 `~/.dsh` 下的任何配置。
- **社区行为**：参与讨论与评审即视为同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
- **i18n 字面量规则**：宿主机侧文案以中文原文为 key，调用 `t()`；新文案必须同时进每个
  `i18n-<lang>/` 与合并模块，`test/channels/shared/i18n-coverage.test.mjs` 会拦住漏项。

## 6. 报告缺陷

- 功能缺陷 → 用 `.github/ISSUE_TEMPLATE/bug.yml`，务必附：渠道、宿主版本、`node -v`、复现步骤、
  日志片段（脱敏）。
- 安全问题 → **不要开 issue**，见 `SECURITY.md`。
- 提 PR 前请自查 `.github/PULL_REQUEST_TEMPLATE.md` 的清单。
