## 7. 四项工程改造执行记录（按优先级高→低）

> 排序依据：**先修「证明不了自己」，再修「对外承诺不实」，最后修「没有证据的漂亮话」**。
> 一个红着的门禁会让后续所有优化的证据失效；一份与实际不符的能力表会变成对外承诺。
> 每项都给了「预期目标 / 完成标准 / 实测证据 / 负向对照」，且都是独立提交，可单笔回退。

### 7.1 改造 ①：本机全量测试基线转绿（优先级 1 · 高）

- **为什么排第一**：基线红（4,727 pass / 1 fail）意味着之后任何「我修好了」都无法验证。
- **执行顺序**：先定位（`esbuild` 子进程被拒写 `os.tmpdir()`）→ 再区分「Node 能写 vs 子进程不能写」→ 最后写可复用 helper。
- **预期目标**：把平台缺陷挡在测试外面，而不是让它伪装成产品缺陷。
- **完成标准**：`node --test test/*.test.mjs test/channels/*/*.test.mjs` 末行 `fail 0`。
- **实测证据**：改前 `4736 tests / 4727 pass / 1 fail`；改后 `4738 / 4730 / 0`（当时用例数）。
- **负向对照**：把 helper 里的可用性探测去掉（改回「拿第一个候选就用」）→ 该用例立刻回到 1 fail；还原后恢复 3 pass。
- **提交**：`87b9f2c`。

### 7.2 改造 ②：入库构建产物漂移守卫（优先级 2 · 高）

- **为什么排第二**：`dsh plugin add` 装的是发布包里的 `lib/*.js`。源码改了没重建 ⇒ 用户加载旧字节，表现为「修了但没生效」，而且排查会从错误前提开始。
- **执行顺序**：先证明构建确定性（两次 `npm run build` 产物 sha256 相同）→ 再写「工作树 vs git HEAD」比较 → 最后接进门禁。
- **完成标准**：`npm run check` 输出 `BUILT_ARTIFACTS_OK 2 files match HEAD`。
- **实测证据**：该守卫**当天就抓到一次真实漂移** —— 我把两个脚本加进 `package.json` 的 `files`/`check` 后，manifest 被编进 `lib/client.js`，门禁立刻报
  `BUILT_ARTIFACTS_DRIFT lib/client.js: committed ae521866f584 != built 06124e10e775 (first differing byte 23874)`，随后由 `b075e39` 补交重建产物。
- **负向对照**：端到端用例真的往 `lib/index.js` 追加一个字节 → CLI 报 DRIFT 并退出 1；还原后报 OK。另有「换成非探针字节仍必须判红」的第二条对照，证明豁免不是全豁免。
- **提交**：`0306fda` + 产物 `b075e39`。

### 7.3 改造 ③：渠道能力矩阵由源码生成（优先级 3 · 高）

- **为什么排第三**：README 的能力描述是**对外承诺**。已发生过「README 承诺 X、实现只有 Y」的返工；手写表格没有 owner、没有门禁。
- **执行顺序**：先定「哪些列算能力」→ 用真实渠道目录校准 matcher（三次误报纠正见下）→ 生成 → 围栏进两份 README → 进门禁。
- **完成标准**：`node scripts/channel-capability-matrix.mjs --check` → `CAPABILITY_MATRIX_OK 14 channels, 2 document(s)`。
- **matcher 校准（这是本项真正的成本）**：首版用 `image_key|imageKey`、`voice|audio`、`group|room`，在本仓 14 个渠道上跑出三处**假 ✅**：
  weixin 的 `image_key` 命中的是校验文案；Discord 的 `audio` 命中的是「拒绝附件」的错误提示；iMessage 的 `room` 命中一对一 API。收窄为「发送/上传调用的函数名」后重跑。
- **实测证据**：14 渠道 × 9 列 = 126 格，✅ **56** 格 / — **70** 格（`grep -o '✅'` 得 57，扣图例 1）。
- **负向对照**：把 `src/channels/imessage/imessage-api.mjs` 的 `sendText` 改名 → `--check` 退出 1；还原 → OK。
- **提交**：`017e3ae` + `0ef3a36`（双语与受检契约收窄）。

### 7.4 改造 ④：贡献与安全治理骨架（优先级 4 · 高）

- **为什么排第四（而不是第一）**：它不是「让已有工作可验证」，而是「让外部工作可进入」；在门禁不可信之前，治理文件只会把未经验证的流程固化下来。
- **执行顺序**：CONTRIBUTING（含门禁真相）→ SECURITY（含信任边界）→ 行为准则 → issue/PR 模板 → 交叉引用判据 → README 入口。
- **预期目标**：让第一次 PR 有明确入口与自查清单；让安全问题有私下通道。
- **完成标准**：`node scripts/verify-governance.mjs` → `GOVERNANCE_OK 7 files, cross-references intact`（7 个文件 + 每条必须引用对方，缺引用即红）。
- **负向对照**：把 CONTRIBUTING 里的 `SECURITY.md` 换成杜撰文件名 → 判据报 `GOVERNANCE_DANGLING: CONTRIBUTING.md -> SECURITY.md` 并退出 1；删除文件 → 报 `GOVERNANCE_MISSING`。
- **提交**：见本轮治理提交（7 个治理文件 + 2 个判据脚本）。

### 7.5 四项改造的完成顺序与可追溯性

```
H1 基线转绿   87b9f2c
H2 产物漂移   0306fda (+ 产物 b075e39)
H3 能力矩阵   017e3ae → 0ef3a36
H4 治理骨架   （本轮最后一笔）
```

每一项都在 `npm run check` 里有对应判据，且判据本身做过负向对照 —— 也就是说，**门禁绿不是「看起来绿」，是「删掉这一项会变红」**。
