# 07 · 下一步待办（dsh-im rv5.8.0 · 2026-11-02）

> 权威台账。每轮收尾只改本文件，不改报告正文。
> 本轮闭环项已带提交号；未闭环项带「为什么没做」，不写「请老大手动」。

## 已闭环（2026-11-02 本轮）

- [x] H1 全量测试基线转绿（`os.tmpdir()` 对 esbuild 子进程不可写）→ `87b9f2c`
- [x] H2 入库构建产物漂移守卫 → `0306fda`（产物 `b075e39`、治理变更产物 `57392f6`）
- [x] H3 渠道能力矩阵由源码生成（双语、受检契约收窄）→ `017e3ae` + `0ef3a36`
- [x] H4 贡献与安全治理骨架（7 文件 + 交叉引用判据）→ `f3ad28e`
- [x] 八维对标报告（含学习记录与改造执行记录）→ `f3ad28e` + `f2ba9a6`
- [x] 门禁终读数：`npm run check` exit 0（4761 tests / 4753 pass / 0 fail，另 4 条判据全绿）

## 已闭环（2026-11-02 第二轮：推送 / M1 / 架构文档）

- [x] ① 推送与 PR：本账号对 `xmanrui/dsh-im` 只有 pull 权限 ⇒ 走 fork 通道。
  已建 fork `lxh113377/dsh-im`（`gh api -X POST repos/xmanrui/dsh-im/forks`），
  分支 `feat/wechat-groups` 推上 fork，并向上游开 **draft PR #516**
  （base `main`，65 commits / 81 files，正文含四项改造判据表）。
  复核口径：`git ls-remote fork refs/heads/feat/wechat-groups` == `git rev-parse HEAD`（现值 `d041215`）；
  `gh pr view 516 --json state,headRefOid` → `OPEN` + 同一 oid。
- [x] ② M1 渠道注册表 → `f192d38`：`plugin-src/host/channel-registry.mjs` 成为 14 渠道
  集合与顺序的唯一来源（configKey / applyName / apply + 可选 deliveryKey / withoutDeliveryService，
  原先这三处手抄 + apply() 里的 `'wecomApp' ? 'wecom-app'` 字符串三元比较全部塌缩）；
  `test/channel-registry.test.mjs` 8 条钉住「注册表 ⇄ 磁盘目录」配对、apply 指向同源、
  激活顺序、逐渠道 deliveryService 契约，并禁止 index.mjs 再自带渠道清单。
  负向对照（实测）：造一个无注册项的 `channels/matrixtest/` → 配对判据红；删除 → 8/8 绿。
- [x] ③ ARCHITECTURE.md → `ARCHITECTURE.md`（356 行 / 8 个一级章节）。两轮派发 arch-doc-writer 队友均未落盘（连续 2 次失败 ⇒ Lead 自干并登记根因）。全部引用路径实测存在（40 条，missing=0）；数字现读现引（§8.2 给复算命令）；中英 README〈设计〉段已指向本文。**未**把它加进 `package.json` 的 `files`：那会改动被编进
  bundle 的 manifest，逼出一笔 `npm run build` 的产物提交，而此刻并行会话正改着
  `src/channels/weixin/wechat-group-runtime.mjs` 与其测试未提交 —— 重建会把他们未提交的源码扫进我的
  `lib/index.js`，等于用我的提交署名他们的代码（R328）。⇒ 登记为待办：等该文件提交落定后再
  「改 files + 重建 + 同笔提交产物」。

## 未闭环（下一轮候选，按优先级）

- [ ] H4.1 治理判据写进 CI 的独立 job（目前只挂在 `npm run check` 的单 job 内）
- [ ] M2 `src/channels/shared` 按 session/permission/delivery/history 四域拆目录
- [ ] M3 吞吐/延迟基准脚本（`scripts/benchmark-channels.mjs`），CI 警告态
- [ ] M4 覆盖率并入 CI（`--experimental-test-coverage`）
- [ ] M5 跨平台 ffmpeg stub，让 6 条语音用例在 Windows CI 也执行（skipped 8 → ≤2）
- [ ] L3 独立网关形态可行性评估（对标 matterbridge / LangBot）

## 未取证（诚实登记，不冒充已完成）

- 未 clone 运行任何上游项目（本轮只有源码/文档/GitHub API 阅读）
- 未做跨框架「同一条群消息」行为对照实验
- 未与上游做同口径吞吐对比（本仓零基准）

## 已知外部约束

- 当前 GitHub 账户 `lxh113377` 对本仓 `xmanrui/dsh-im` 只有 **pull** 权限（`gh api ... --jq .permissions` → `{"push":false}`；直推 `git push --dry-run` → 403）。
  ⇒ 走 fork 通道：已建 fork `lxh113377/dsh-im` 并加为本地 remote `fork`，分支已推 fork，向上游开 **draft PR #516**（base `main`）。
  复核口径：`git ls-remote fork refs/heads/feat/wechat-groups` == `git rev-parse HEAD`；PR head 与本地同 oid。后续每次 `git push fork feat/wechat-groups` 会自动前进该 PR。
- fork PR 的 CI 需上游 owner 批准工作流运行才跑（`gh pr checks 516` 目前为空即此原因，不是判据缺失）；本地以 `npm run check` 代替。
- 部署面：desktop profile 以符号链接指向本仓（`~/.dsh/profiles/desktop/node_modules/@xmanrui/dsh-im -> D:/codex/DSH-IM/rv5.8.0`），
  实测 HEAD blob / 工作树 / profile 实际加载三处 `lib/index.js` sha256 同为 `323954de972af6b9`。
