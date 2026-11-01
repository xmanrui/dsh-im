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

## 未闭环（下一轮候选，按优先级）

- [ ] H4.1 治理判据写进 CI 的独立 job（目前只挂在 `npm run check` 的单 job 内）
- [ ] M1 渠道注册表取代 `plugin-src/host/index.mjs` 的 14 条手工接线
- [ ] M2 `src/channels/shared` 按 session/permission/delivery/history 四域拆目录
- [ ] M3 吞吐/延迟基准脚本（`scripts/benchmark-channels.mjs`），CI 警告态
- [ ] M4 覆盖率并入 CI（`--experimental-test-coverage`）
- [ ] M5 跨平台 ffmpeg stub，让 6 条语音用例在 Windows CI 也执行（skipped 8 → ≤2）
- [ ] L1 `ARCHITECTURE.md`（对标 LangBot 的 31 KB 架构文档）
- [ ] L3 独立网关形态可行性评估（对标 matterbridge / LangBot）

## 未取证（诚实登记，不冒充已完成）

- 未 clone 运行任何上游项目（本轮只有源码/文档/GitHub API 阅读）
- 未做跨框架「同一条群消息」行为对照实验
- 未与上游做同口径吞吐对比（本仓零基准）

## 已知外部约束

- 当前 GitHub 账户 `lxh113377` 对本仓 `xmanrui/dsh-im` 只有 **pull** 权限（`gh api repos/xmanrui/dsh-im --jq .permissions` → `{"push":false}`），
  `git push --dry-run` 实测 `remote: Permission ... denied`（403）。⇒ 本轮改动**已全部本地提交**（8 笔，HEAD `f2ba9a6`），未推送。
- 分支 `feat/wechat-groups` 在远端不存在；远端有 54 个分支头，含 `main`（`dd500d2`）。
- 部署面：desktop profile 以符号链接指向本仓（`~/.dsh/profiles/desktop/node_modules/@xmanrui/dsh-im -> D:/codex/DSH-IM/rv5.8.0`），
  实测 HEAD blob / 工作树 / profile 实际加载三处 `lib/index.js` sha256 同为 `323954de972af6b9`。
