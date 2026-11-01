## 3. 改进建议清单（按优先级）

> 排序依据写死在每一行「排序依据」列里：**先修「证明不了自己」的问题，再修「不够快」的问题**。
> 理由：一个绿不起来的门禁会让后续所有优化都失去可验证性；性能数字在门禁可靠之前没有意义。

### 3.1 高优先级（P0：影响可验证性或对外承诺）

| ID | 改进项 | 排序依据 | 预期目标 | 完成标准（可复跑判据） | 状态 |
| --- | --- | --- | --- | --- | --- |
| **H1** | 本机全量测试基线必须绿 | 基线红 = 之后任何「我修好了」都不可证 | 消除 `os.tmpdir()` 对 esbuild 子进程不可写造成的 1 条恒红 | `node --test test/*.test.mjs test/channels/*/*.test.mjs` 末行 `fail 0`；且该条用注入回归可复现变红 | ✅ 已落地（`87b9f2c`） |
| **H2** | 入库构建产物漂移守卫 | 用户加载的是 `lib/*.js` 字节；源码改了没重建 = 「修了但没生效」 | 让「源码 ≠ 入库产物」在 CI 上直接失败并点名文件 | `npm run check` 末段出现 `BUILT_ARTIFACTS_OK 2 files match HEAD`；注入一个字节 → `BUILT_ARTIFACTS_DRIFT` + 非零退出 | ✅ 已落地（`0306fda` + `b075e39`） |
| **H3** | 渠道能力矩阵由源码生成 | README 承诺过「支持 X」但实现没有，已发生多次返工 | 能力表可复算、漂移即失败 | `node scripts/channel-capability-matrix.mjs --check` → `CAPABILITY_MATRIX_OK 14 channels, 2 document(s)`；改一处实现 → 退出码 1 | ✅ 已落地（`017e3ae` + `0ef3a36`） |
| **H4** | 贡献与安全治理骨架 | 86 个 open issue、3045★，但仓库没有 CONTRIBUTING/SECURITY/模板 → 外部贡献无法进入流程 | 让第一次 PR 有明确的入口与检查清单 | `ls CONTRIBUTING.md SECURITY.md .github/ISSUE_TEMPLATE .github/PULL_REQUEST_TEMPLATE.md` 全部存在；CI 有一条 `verify-governance` 判据 | ⏳ 下一轮（见 §4 阶段二） |

### 3.2 中优先级（P1：影响工程质量与可维护性）

| ID | 改进项 | 排序依据 | 预期目标 | 完成标准 | 状态 |
| --- | --- | --- | --- | --- | --- |
| M1 | 渠道注册表取代 14 条手工接线 | 新增渠道 3 处手工改动，是扩展性第一瓶颈 | 单文件登记即可挂载一个渠道 | 新增 `channel-registry.mjs`，`plugin-src/host/index.mjs` 只遍历注册表；现有 14 渠道行为不变（全量测试绿） | 建议 |
| M2 | `shared/` 二级分层 | 83 文件 24,638 行平铺，最长 2,838 行 | 按 session/permission/delivery/history 四域拆分目录 | 目录数与最大文件行数下降，且 import 面收敛 | 建议 |
| M3 | 性能基准脚本 | 全仓零基准，性能差异无法量化 | 至少 1 条可复跑的吞吐/延迟基准，进 CI 但只警告 | `node scripts/benchmark-channels.mjs` 输出 JSON + 稳定判据 | 建议 |
| M4 | 覆盖率上报 | 4,752 用例但无覆盖率 → 高测试量低覆盖可能 | CI 产覆盖率并留档 | `npm test -- --experimental-test-coverage` 输出并入 CI artifact | 建议 |
| M5 | 语音/媒体链路去平台依赖 | 6/8 skip 依赖 POSIX ffmpeg | 跨平台 stub，让语音链路在 Windows CI 也执行 | skipped 从 8 降到 ≤2 | 建议 |

### 3.3 低优先级（P2：体验与生态）

| ID | 改进项 | 排序依据 | 预期目标 | 完成标准 | 状态 |
| --- | --- | --- | --- | --- | --- |
| L1 | 补 `ARCHITECTURE.md` | 上游 LangBot 有 31 KB 架构文档，本仓只有 ADR | 新人 10 分钟理解分层 | 文件存在且含三层图 | 建议 |
| L2 | 多语言 README | 上游 5 语言 | 至少 zh/en（本仓已有）→ 增 ja/es | — | 已部分 |
| L3 | 独立网关形态 | matterbridge/LangBot 可脱离宿主独立部署 | 评估可行性，不承诺 | 产出评估结论 | 建议 |
| L4 | 发布流水线 | 现无 release workflow | tag → 自动发布 npm + 校验 | `.github/workflows/release.yml` | 建议 |

### 3.4 与遗留台账的对账

本轮没有改动任何既有 P0 遗留项；上面 H1–H3 全部是**本轮新发现并由本轮闭合**（每项都有独立提交与注入式负控）。H4 与 M1–M5、L1–L4 登记为后续（见 §4）。