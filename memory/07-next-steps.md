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
- [x] ③ ARCHITECTURE.md → `ARCHITECTURE.md`（356 行 / 8 个一级章节）。两轮派发 arch-doc-writer 队友均未落盘（连续 2 次失败 ⇒ Lead 自干并登记根因）。全部引用路径实测存在（40 条，missing=0）；数字现读现引（§8.2 给复算命令）；中英 README〈设计〉段已指向本文。
  `package.json` 的 `files` 已加入本文（`260e816`）—— 该笔当时**故意押后**：并行会话正改
  `src/channels/weixin/wechat-group-runtime.mjs` 与其测试未提交，重建会把他们未提交的源码扫进我的
  `lib/index.js`，等于用我的提交署名他们的代码（R328）。等其提交落定、工作树只剩我的改动后才做。
  做法：先验证「干净 HEAD 重建 == HEAD 产物」（`BUILT_ARTIFACTS_OK`，字节数 cmp 差 0），
  确认基线自洽后再改 files 重建 —— 结果 diff 仅 3 行，就是清单里那一行插入两个 bundle；
  源码与 bundle **同一笔**提交（分两笔会让守卫在两笔之间判红，那正是它要拦的形态）。
  另记一条判读教训：对 10 MB 的单文件做字节区间 diff 时，插入 20 字节会让其后**全部**位置错位，
  看起来像「几百处巨大改动」，实际只有 1 处插入 —— 该用 `git diff --stat` 的增删行数或内容锚点判断，
  别拿位置差当证据。

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

## 已闭环（2026-11-02 第三轮：像人 / 性格 / 记忆）

- [x] 人设：`persona.mjs` / `persona-store.mjs`（每 bot 一个 `accounts/<botId>/persona.json`，首开播种出厂卡）
      / `im-persona.mjs` 会话级注册表 / `plugin-src/host/persona-context.mjs` 注册 `dsh-im:persona` 提示上下文（order 120，先于 guidance 125）。
      接缝：`harness-client.ask()` 发布 → `workspace-session` 透传 → weixin bridge 读卡。
- [x] 记忆：`memory-store.mjs`（node:sqlite + FTS5 trigram，LIKE 兜底；validTo/supersededBy 失效不删；缓冲事务）
      / `memory-extract.mjs`（锚定规则，宁缺勿错）/ `memory-turn.mjs`（写、召回 400ms 护栏、scope 构造）
      / `createEphemeralMemoryStore`（每次开-用-关，修掉 Windows 上删除账号目录的 EBUSY）。
- [x] 拟人出站：`humanize-outbound.mjs`（去 AI 腔 + 按段落分段 + 3 字/秒 ±20% + 段间 700ms + 总预算 18s，扣掉生成耗时）；
      weixin bridge `#sendPaced` 编排，`humanize` 默认关、生产接线打开（老路径逐字不变）。
- [x] 门禁：`npm run check` exit 0（4841 tests / 4833 pass / 0 fail；BUILT_ARTIFACTS_OK / CAPABILITY_MATRIX_OK / BENCHMARK_REPORT_OK / GOVERNANCE_OK）。
- [x] 提交 `28bb1f55`；部署面已同步（profile 符号链接下 `lib/index.js` sha256 = HEAD blob = `4a79f26d6491`）。

## 未闭环（本轮登记）

- [ ] 人设 / 记忆的 **设置界面与 RPC** 未做：目前改人设要直接编辑 `persona.json`（有出厂播种，不改也有人设）。
- [ ] 其余 12 个渠道的 bridge 尚未接记忆与拟人（同一套模块可直接复用，weixin 是唯一试点）。
- [ ] 未在真实微信群发消息验证（按仓库纪律需受控授权）；本轮验证到「渲染出正确上下文块 + 进入 ask 参数 + 全量门禁绿」。
- [ ] 宿主进程需重载才会跑上新 bundle（`restart-dsh.cmd`）；本轮未重启，避免打断正在并行的会话。

## 已闭环（2026-11-02 第四轮：把「像人」钉死并修掉两个真缺陷）

- [x] 接线级集成测试 → `0f945a2d`：`test/humanlike-weixin-wiring.test.mjs` 三条用例穿过真实 `WeixinHarnessBridge`，
      分别钉住「人设进 imPersona 但不进用户 prompt」「入站事实写入 MemoryStore 且下一条 prompt 前置 `<dsh_im_context>`」
      「humanize 开=两条气泡、关=单条逐字（负向对照）」。顺带钉住 `watchInteractions(sessionId, { onOpen })` 的调用形态 ——
      桩函数若吞掉第二个参数，`ask()` 会白等 30 秒交互守卫。
- [x] 抽取范围扩到「拥有物 / 近况」→ `c0ec1b37`：`我养了只橘猫`、`我有一台咖啡机`、`我最近在学吉他`。
      每条新规则都钉了「该抓的」和「不该抓的」（`我有`、`他养了只猫`、`今天天气不错` 一律不记）。
      顺带修掉一个实测缺陷：`记住 周三下午我有例会` 原本同时产出一条 note 和一条 possession（把「例会」当成拥有的东西），
      现在显式「记住」就是完整抓取，不再从同一句里抠第二条。
- [x] 召回兜底 → `e43d7c79`：原来 FTS 与 LIKE 两条路径都用 AND 连词，
      句子里出现一个没见过的词（`你那只橘猫会弹吉他吗`）就整段记忆返回空 —— 等于记忆层被判死。
      现在严格路径优先、无果时退到「任一词命中」，排序与 LIMIT 不变。这个坑是端到端探针跑出来的，不是看代码看出来的。
- [x] 全量单元测试：`4875 tests / 4867 pass / 0 fail`；`BUILT_ARTIFACTS_OK 2 files match HEAD`。
- [x] 部署读回：`lib/index.js` 三处 sha256 同为 `f6ad88ad36e8…`（HEAD blob / 工作树 / profile 实际加载）。

## 未闭环（第四轮新增）

- [ ] 宿主进程仍未重载（`restart-dsh.cmd`）：新 bundle 已就位，但跑着的是旧进程。
- [ ] 其余 12 个渠道未接记忆/拟人（同一套模块可直接复用）。
- [ ] 真实微信群未发消息验证（需受控授权）。

## 已闭环（2026-11-02 第五轮：微信不渲染 Markdown）

- [x] `flattenMarkdown` → `5ae91036`：微信把 `**粗体**` 原样当星号、`- 列表` 当短横发出去，
      像把日志贴进群 —— 这是与模型无关的、最响的机器味。现在拍平后才分段（段长按实际发出的文本量算）。
      保守：强调标记去掉、字留着；列表变「· 」；链接保留地址；**代码块与行内代码原样保护**（命令必须还能复制）；
      `snake_case` 不动；纯文本原样。7 条用例钉住「该拍平的」与「必须原样保留的」两侧。
- [x] 端到端读数（`_probe-final.mjs`）：一段带粗体/列表/链接/客套收尾的回答 →
      3 条口语消息（间隔 0.77/0.7/0.7 秒），星号 0 个、AI 开场 0 个、客套收尾 0 个、链接地址保留。
- [x] 全量单元测试 `4890 tests / 4882 pass / 0 fail`；`BUILT_ARTIFACTS_OK 2 files match HEAD`。
- [x] 部署读回：`lib/index.js` 三处 sha256 同为 `9569ed15b803…`。

## 未闭环（第五轮）

- [ ] 宿主进程未重载：`@deepseek-ai/dsh-hmr` 明确忽略 `node_modules/`，而本插件是 `link:` 依赖，
      所以改完必须 `restart-dsh.cmd` 才生效。本轮仍不重启（会打断并行会话）。
- [ ] 真实微信群未发消息验证。
- [ ] 设置界面 / RPC 未做（改人设走 `scripts/set-persona.mjs`）。
- [ ] 其余 12 个渠道未接。

## 已闭环（2026-11-02 第六轮：中文检索 + 群路径）

- [x] 群路径接线验证 → `acb2f8cb`：`test/humanlike-weixin-group.test.mjs` 用真实 `uia-wechat-group/v1`
      事件形状穿过 `WeixinHarnessBridge`，证明**群里被 @** 这条路同样带人设与记忆（不只是私聊）。
      途中修正了三处测试自身的错误假设：群 sender 不是 owner（需显式策略）、
      群会话键带 `group:` 前缀、写记忆是 fire-and-forget（要 yield 一拍）。
- [x] 中文检索 → `acb2f8cb`：检索按空格切词，而中文不分词，于是
      「咖啡豆哪种好」是一个整词元，永远匹配不到记忆里的「咖啡」—— 记过却答不上来。
      现在长中文词元额外产出相邻二元组（两字保持原样，否则「咖」会命中一切），
      群消息开头的 `@大肥鱼` 也不再当检索词。5 条用例钉住两个方向，含「无关查询仍返回空」。
- [x] 全量：`4896 tests / 4888 pass / 0 fail`；`BUILT_ARTIFACTS_OK 2 files match HEAD`。
- [x] 部署读回：`lib/index.js` 三处 sha256 同为 `5323c68a7e0e…`。

## 未闭环（第六轮）

- [ ] 宿主进程未重载（HMR 忽略 node_modules，本插件是 link 依赖）→ 需 `restart-dsh.cmd`。
- [ ] 真实微信群未发消息验证。
- [ ] 设置界面 / RPC 未做。
- [ ] 其余 12 个渠道未接。

## 部署状态（2026-11-02 03:50 实测）

- **代码已就位，进程未重载**。实测证据：
  - Electron 主进程 PID 37528 启动于 `03:21:36`；
  - 当前 `lib/index.js` 写入于 `03:45:27`（mtime），sha256 `5323c68a7e0e…`；
  - 宿主日志 `dsh-2026-11-02.2.log` 里 `dsh-im` 没有任何 activate 报错（唯一 pending 的是 `dsh-ops-tui`，与本插件无关）。
  ⇒ 跑着的是 03:21 那份旧 bundle，本轮 `64f595b2`~`acb2f8cb` 的改动**尚未在运行中的宿主里生效**。

- 为什么没重启：`restart-dsh.cmd` 是 `taskkill /IM "DSH Desktop.exe" /F` + 重新 start，
  会**同时杀掉并行的另一个会话**（它此刻有 11 个未提交文件、正在同一宿主里跑）。
  本宿主也没有插件级热重载入口（`@deepseek-ai/dsh-hmr` 明确忽略 `node_modules/`，而本插件是 `link:` 依赖；
  已 grep 过 `dsh-client-ui-plugin-manager`，没有 reload/restart 端点）。
  ⇒ 按「不干扰并行会话」优先，重启留给下一次宿主空闲时执行：`D:\codex\DSH-IM\rv5.8.0\restart-dsh.cmd`。

- 重载后的验收（一条命令即可）：
  `node scripts/verify-wechat-group-live.mjs` → 期望 PASS；
  群里 `@大肥鱼 你记得我喜欢喝什么吗` → 期望答出手冲咖啡（说明记忆与检索生效）。

## 已闭环（2026-11-02 第七轮：独立复核查出 4 个真缺陷并修掉）

派出的复核子代理这轮落盘了（227 行 + 11 份证据 + 冻结 md5 快照）。逐条复现后：

- [x] F2 星号被误删：`2 * 3 * 4 = 24` → `2  3  4 = 24`、`*.log` 丢星号。已修（算式/通配符的星号先保护后还原）。
- [x] F3 flatten 后结构化保护失效：30 条项目符号 1 段变 2 段。已修（结构判定改在**输入**，作为 flag 传给 planner）。
- [x] F4 占位符碰撞 → 群里打出 `undefined`。已修（每次调用随机 token + 越界保留原文）。
- [x] F6 损坏 `persona.json` 被出厂卡覆盖（**数据丢失**）。已修（只有文件**不存在**才播种；坏文件逐字保留并报一次）。
- [x] F7 人设读取错误会掐断账号创建。已加 try/catch，失败按无人设启动。
- [~] F5（CJK 二元切分上界）**未复现**：13 字句实测能命中，按「不复现即不改」处理。
- [ ] F1 结论成立但不改代码（guidance 带外发布，正文伪造块改不了配置）；已修正措辞。
- [ ] F8–F15 未修，原因逐条写在 `_goal-humanlike/ADVERSARIAL-REVIEW.md` 附录（F8 涉及 scope 编码迁移，需先取证真实 chatId 字符集）。

- 提交 `149d7f8b`；全量 `4901 tests / 4893 pass / 0 fail`；部署读回 `61fb2a90f7c7…`。

## 已闭环（2026-11-02 第八轮：记忆的「忘」与「清理」）

- [x] `maintain()` → `00b056f0`：原来 `prune`/`forget` **一个调用方都没有**。每次改口都留一条失效行，
      槽位到期也不消失，库只会一直长大。现在全库一次扫（单 scope 的 `prune` 对后台巡检没用，
      巡检不知道有哪些会话），生产每 6 小时跑一次；**只删已经失效的行**，不可能让人忘记正在生效的事。
- [x] 忘记指令 → `00b056f0`：`忘掉/忘记/别记/不用记 + 目标` 现在被识别，且**先于写入**处理
      （否则「忘掉咖啡」会被读成一条新的喜好）。删除走与回答相同的召回索引，再要求**字面包含**：
      召回是模糊的，删除不能是。scope 不跨越，一个群让忘的东西碰不到另一个群。
- [x] 单字目标（`忘掉茶`）→ `b8fc210c`：两处 `length < 2` 门槛让最自然的说法变成**静默空操作**
      （探针实测：事实还在、stats 不变、日志无输出）。安全性本来就该由「字面包含」保证，不由字数保证。
- [x] 生命周期端到端（`_probe-lifecycle.mjs`）：没记过 → 记下咖啡 → 改口喝茶（咖啡转失效）→ 忘掉茶（删干净）。
- [x] 全量 `4913 tests / 4905 pass / 0 fail`；`BUILT_ARTIFACTS_OK`。

## 未闭环（第八轮）

- [ ] 宿主进程仍未重载（HMR 忽略 node_modules，本插件是 link 依赖）→ 需 `restart-dsh.cmd`。
- [ ] 真实微信群未发消息验证（需受控授权）。
- [ ] 设置界面 / RPC 未做（改人设走 `scripts/set-persona.mjs`）。
- [ ] 其余 12 个渠道未接记忆与拟人。

## 已闭环（2026-11-02 第九轮：群桥「每秒掉线」的真因）

- [x] `0d57e230`：适配器把**任何** `list_session_titles()` 的 SafetyError 都判成「侧栏折叠」，
      而 `control_missing` 也是微信重绘瞬间 WalkControl 失败的码 —— 两个相反的问题用了同一个诊断。
      实测证据：一份日志里 15 次 `sidebar_collapsed`，同时窗口未最小化、会话列表 10 行、所有控件逐个探针都在；
      而适配器在这个码上是**直接退出**的，于是子进程被反复拉起。
      现在只有「会话列表真的缺失/重复」才走折叠路径；`control_missing` 先重试一次，成功就什么都不报，
      两次都失败才维持原诊断，重试给出不同错误码则如实上报。2 条 Python 用例钉住这一对。
- [x] 顺带修掉一个我自己引入的回退：重试成功后仍会落到「折叠」分支（`titles` 已恢复却没继续判断），已修正。
- [x] 门禁：JS `4913 / 4905 / 0 fail`、Python `223 passed`、`BUILT_ARTIFACTS_OK`、`verify-wechat-group-live` PASS。

## 并发写者纪律（本轮再次踩到）

- 提交前用 `git diff HEAD` 而不是 `git diff` 判断「谁改了什么」：索引里可能残留别人已提交条目的旧快照。
- 本轮我的提交两次把并行会话的 hunk 一起带进去（一次是索引残留，一次是同一文件内的相邻 hunk）。
  两次都当场用 `git reset` / `git apply --cached` 分离、`--amend` 修正，并把对方工作树内容原样还原
  （备份在 `_goal-humanlike/_backup*/`）。
- 结论：**同一文件里、同一函数附近的并行改动，不能靠 `git add <file>` 分离** —— 必须按 hunk 级 `git apply --cached`。

## 部署路径实测（2026-11-02 04:21，第九轮补）

- **热重载这条路走不通，已验证并留证**：`@deepseek-ai/dsh-hmr` 监听 profile 的 `cordis.patch.yml`，
  改它确实会重挂补丁层（日志 04:21:09 实测），但**插件 bundle 是 ESM 模块，宿主的模块缓存不会换**
  —— 与 profile 里已记录的「vendored pack.js 不能热换（ESM 缓存）」同一个机制。
  所以 `lib/index.js` 的新代码必须靠**进程重启**生效。
- profile 文件里留了 4 行注释记录该结论与回滚方式（删注释即可）。host 在重挂后健康：
  `verify-wechat-group-live` PASS、重挂后 0 条 error、适配器 2 个进程在线。
- **适配器（Python）可以单独重启，且本轮已做**：杀掉子进程后宿主自动重拉，
  新代码（`0d57e230` 的 `control_missing` 重试）已在其上生效；这不需要重启宿主。

- 剩余唯一动作 = `D:\codex\DSH-IM\rv5.8.0\restart-dsh.cmd`（会一并结束并行的另一个会话，故本轮不做）。

## 已闭环（2026-11-02 第十轮：隔离边界 + 只观察不回答）

- [x] `0ffdd8ed` 两个真缺陷：
  ① **scope 编码不是单射**：`group:x:y` 与 `group:x_y` 都变成 `group_x_y`，
     两个不同会话共享一个记忆 scope（隐私边界，不是命名问题）。现在 `_` 作转义符、
     其余字符按码点十六进制编码，输出仍在 store 允许的字符集内。改动前先查了线上库——**为空**，故零迁移成本。
  ② **单字宾语被丢弃**：`我喜欢茶`、`我养猫` 一条都抽不出来。中文里「茶」「猫」就是东西本身，
     两字下限把最自然的自我陈述整条丢掉。门槛已去掉；负向对照同步扩展（`他养了只猫`/`她说她怕冷`/`我喜欢` 仍不记）。
- [x] `a1797299` **观察模式**：机器人只听得见 @ 它的那几句，就永远不知道群里在聊什么——
      线上库一直是空的（0 条事实）正是这个原因：运行时把所有未 @ 的行在进桥之前就拒了。
      新增每组 opt-in `observeAmbient`（默认关、必须是布尔、字符串 "false" 不算同意）。
      开启后未 @ 的行走**独立入口 `observe()`**，与 `accept()` 不共享任何代码：
      没有访问策略、没有 prompt、没有会话绑定、没有发送 —— 从这条路径**不存在**到达回复的路。
      仍然拒绝：命令（没 @ 的指令不是同意）、机器人自己的行、空正文。
- [x] 接线时发现两处设计性 null：`weixinConversation` 与 `conversationKey` 对未 @ 的行按设计返回 null
      （它们的调用方需要「有人可答」），观察模式因此直接读对话形状，拼出与前缀/chatId 完全相同的 key，
      保证记忆 scope 与「这条群里有 @ 的消息」写的是同一个。
- [x] 线上已开启 `observeAmbient: true`（备份在 `_backup3/group-chats.json.before`），适配器已重启吃新配置。
- [x] 全量 `4927 tests / 4919 pass / 0 fail`；`BUILT_ARTIFACTS_OK`。

## 未闭环（第十轮）

- [ ] **观察模式要宿主重启才生效**：它跑在 `lib/index.js` 里，而宿主仍是 03:21:36 那份进程。
      适配器已吃到新配置（`observeAmbient` 已合法解析），但转发那一步在旧 bundle 里不存在。
- [ ] 真实微信群发消息验证（需受控授权）。
- [ ] 设置界面 / RPC 未做。
- [ ] 其余 12 个渠道未接。

## 已闭环（2026-11-02 第十一轮：命令/地址不进库 + 中断说人话）

- [x] `d39ff90f` 抽取器两处泄漏：
  ① **命令参数被当成陈述**：`/steer 我喜欢咖啡` 被抽成「群里有人喜欢咖啡」——把 operator 的指令
     当成了群友的喜好。现在任何以 `/` 开头的消息一律不产事实（参数属于指令，不属于陈述）。
  ② **地址与路径进库**：偏好里夹带的 URL 会连地址一起记住，之后还会被原样复述。
     抽事实前先删地址/盘符路径；删完顺手收掉多余空格与悬空助词。
- [x] `17ca5ce9` 中断回复说人话：线上两次真实失败（`TURN_ABORTED`）发给群里的是
      「任务被意外中断……错误码：TURN_INTERRUPTED；参考号：MF-F782AC4F」。
      参考号是给能查日志的人用的，贴进群里等于让群友对着机器说话。现在中断一律回
      「这次没答完就断了，你再说一遍我再试。」，参考号留在上一条 error 日志里；
      其它失败仍走诊断文案（那里错误码是可行动的）。
- [x] 端到端实测：桥收到 `turn-aborted` 时，群里只收到那句人话，不含参考号、不含任何 `TURN_` 码。
- [x] 全量 `4933 tests / 4925 pass / 0 fail`、Python `223 passed`、`BUILT_ARTIFACTS_OK`、live gate PASS。
- [x] 部署读回：`lib/index.js` 三处 sha256 同为 `4522bf9af478…`。

## 未闭环（第十一轮）

- [ ] 宿主仍未重启（仍有 03:21:36 的旧进程）：观察模式、中断文案都还没在运行进程里生效。
- [ ] 真实微信群发消息验证（需受控授权）。
- [ ] 设置界面 / RPC 未做；其余 12 渠道未接。

## 已闭环（2026-11-02 第十二轮：输入指示不算代价）

- [x] `0b8bee43` 一条真实链路缺陷：「正在输入」是装饰，却被 await 在**模型生成之前**，
      且自带 10 秒超时。线上日志 13 次失败，最后一次 `durationMs 10056 / timeoutMs 10000` ——
      一次卡顿 = 群友空等 10 秒才开始生成，而输入气泡根本没出现。
      四处一起改：状态 1 不再 await；请求预算 10s→2s；取消改为竞速 1s 而不是排在可能卡死的队列后面；
      内部串行队列加 1s 硬上界（防止无视 abort 的调用永久堵住后续）。
- [x] 实测（`_probe-typing-block.mjs`，sendTyping 永不 settle 且无视 signal）：
      修改前 `accept()` **永不返回**；现在模型 4ms 开始生成、回答 1018ms 发出。
- [x] 回归用例 `test/humanlike-typing-hang.test.mjs` 钉住这条（下次重构不能悄悄把等待加回来）。
- [x] 全量 `4936 tests / 4928 pass / 0 fail`、Python `223 passed`、`BUILT_ARTIFACTS_OK`、live gate PASS。
- [x] 部署读回：三处 sha256 同为 `9a2774a1eba8…`。

## 未闭环（第十二轮）

- [ ] 宿主仍未重启：观察模式、中断文案、本轮的输入指示修复都还没在运行进程里生效。
- [ ] 真实微信群发消息验证（需受控授权）。
- [ ] 设置界面 / RPC 未做；其余 12 渠道未接。

## 已闭环（2026-11-02 第十三轮：诊断信息不该被脱敏吃掉）

- [x] `3cff4ad4` 线上 6 条 `typing indicator failed` 读出来全是
      `{"name":"WeixinApiError","code":"****"}` —— 宿主日志层把 Error 对象脱敏了，
      而 `code` 是唯一能归因的字段。六次失败**不是原因不明，是原因在写日志的路上被丢掉**。
      weixin 桥的 5 处 warn 改为传「已知安全字段的字符串」（code，有则带 status），
      从不带 token、不带 typing ticket。能穿过脱敏的诊断，比穿不过的富对象有用。
- [x] 用例钉住：`sendTyping` 失败时日志必须含真实 code、且不含 `[object Object]`。
- [x] 顺带记录一次自己的事故：把 `.catch(...)` 拆成两行时漏了一个 `)`，
      导致整文件语法错误（报错位置却指向别处）。已用「括号/方括号/花括号三者配平」的扫描器定位并修复，
      并从 HEAD 重新施加全部改动后逐条语法校验。
- [x] 全量 `4937 tests / 4929 pass / 0 fail`、Python `223 passed`、`BUILT_ARTIFACTS_OK`、live gate PASS。
- [x] 部署读回：三处 sha256 同为 `27090f021a04…`。

## 未闭环（第十三轮）

- [ ] 宿主仍未重启：观察模式、中断文案、输入指示、诊断字段都还没在运行进程里生效。
- [ ] 真实微信群发消息验证（需受控授权）。
- [ ] 设置界面 / RPC 未做；其余 12 渠道未接。

## 已闭环（2026-11-02 第十四轮：从真实群聊回放里找缺陷）

这一轮换了取证方式：不看代码、不写探针，**直接读微信群当前面板里的真实对话**（`_probe_live_rows2.py`）。
拿到 05:24–05:32 一段完整回放，机器人回答了一个「生成五秒随机视频」的请求。

- [x] `d25dc3da` **本地文件路径泄漏进群**（真缺陷，已修）：
      机器人发出 `中间几帧：\n![第40帧](D:/dsh-im-robot/_v3_1.png)`，拍平后群友看到的是
      **operator 的 Windows 磁盘路径**，还被要求打开一个他根本打不开的文件。
      图片标签改为**直接丢弃**而不是拍平（图片本体由 artifact 通道投递）；普通链接仍保留地址。
      用例钉住：`_v3_1.png` 与 `D:/` 都不许出现在群里。
- [x] 顺带记录两条**没有修**的（如实）：
      ① 进度旁白泄漏（「画面太糊了，我重做一版…」）——那是模型输出，属人设 prompt 层，不是渠道文本层能修的；
      ② 投递失败仍带错误码 + 参考号 —— 仓内三条既有测试把「错误回复可追踪」写成了契约，
         不拿一张截图去推翻一条成文保证；已作为开放问题记录。
- [x] 全量 `4940 tests / 4932 pass / 0 fail`、Python `223 passed`、`BUILT_ARTIFACTS_OK`、live gate PASS。
- [x] 部署读回：三处 sha256 同为 `fc1a627fb1b2…`。

## 未闭环（第十四轮）

- [ ] 宿主仍未重启：观察模式、中断文案、输入指示、诊断字段、图片路径修复都还没在运行进程里生效。
- [ ] 真实微信群发消息验证（需受控授权）。
- [ ] 进度旁白泄漏：需在 persona prompt 层处理（让人设明确「不要汇报中间过程」）。
- [ ] 设置界面 / RPC 未做；其余 12 渠道未接。

## 已闭环（2026-11-02 第十五轮：过程烂在肚子里 + 记得住要求）

- [x] `58484fcb` **人设层禁止汇报过程**。真实回放里机器人把自己的重试全发进群：
      「画面太糊了，我重做一版…」「我换成真正的 fBm…」。实测人设卡里 **一条规则都没有**
      提到过程/进度/汇报/重做 —— 不是模型乱来，是从来没告诉过它。
      新增规则「过程烂在肚子里」并给出正做法（直接给结果，做不成才说一句）。
      这是唯一默认值（`DEFAULT_PERSONA`），播种与 CLI 都从它取；线上账号的卡是旧播种（只在文件缺失时播种），
      已单独就地更新（备份 `_backup3/persona.json.before`），`inspectPersonaFile` 验过未损坏。
- [x] `7edbea8a` **记得住群里的要求**。实测四句最常见的要求一条都记不住：
      以后都用简体中文 / 下次直接给成品就行 / 别再发进度了 / 回答短一点。
      它们既不是喜好也不是「记住 X」，所有规则都漏了。新增三种窄形态（以后/下次/往后/今后 + 做法；
      别/不要/不用 + 动词；裸风格要求），渲染成「群里的要求：…」而非「群里有人提到…」（要求是要遵守的，不是传闻）。
- [x] 顺带修一条**语义反转**：旧规则把「别老是问我要不要帮忙」抽成「有人说要不要帮忙」——意思反了。
      现在捕获保留否定词与动词。
- [x] 负向对照同步扩展：今天好热啊 / 这个功能挺好用的 / 我家猫又胖了 / 他说明天不来了 仍然一条不记。
- [x] 全量 `4945 tests / 4937 pass / 0 fail`、Python `223 passed`、`BUILT_ARTIFACTS_OK`、live gate PASS。
- [x] 部署读回：三处 sha256 同为 `8899aa01e0e1…`。

## 未闭环（第十五轮）

- [ ] 宿主仍未重启：观察模式、中断文案、输入指示、诊断字段、图片路径、人设新规、要求记忆都还没在运行进程里生效。
- [ ] 真实微信群发消息验证（需受控授权）。
- [ ] 投递失败仍带错误码（仓内契约，见第十四轮说明）。
- [ ] 设置界面 / RPC 未做；其余 12 渠道未接。

## 已闭环（2026-11-02 第十六轮：M5/M3/M4/H4.1 + 报告自身四处过期读数更正）

- [x] **M5 语音链去平台依赖** → `ac397eea`：feishu `createVoice` 暴露 `runFfmpeg` 注入位
      （与 telegram 侧既有 `createTelegramVoiceTranscriber({ runFfmpeg })` 同形态，非新发明），
      测试注入「node 跑跨平台替身 `fixtures/ffmpeg-stub.mjs`」的真子进程 runner；
      `test/helpers/ffmpeg-binary.mjs` 定向定位本机可用 ffmpeg（PATH 无，imageio_ffmpeg wheel 自带 v7.1）。
      读数：feishu voice 13 pass/**0 skip**、telegram voice 18 pass/**0 skip**、全量 skipped **8→2**。
      负控三条：替身退非 0⇒reject(`stub exit 1`)、`.sh` 交生产 runner⇒`EFTYPE`、假路径⇒`ENOENT`。
      余下 2 条 skip 需要真实微信群环境 / POSIX chmod 语义，不是夹具能替的，保留并注明成因。
- [x] **M3 渠道热路径基准** → `bc27b224`：`scripts/benchmark-channels.mjs` 六条纯 CPU 热路径
      （固定种子 LCG 语料 + warmup + nearest-rank 中位数），下限 = 标定值 ÷ 20。
      标定读数 [本机 win32 node v24.16.0 2026-11-02T06:52+08:00]：extractText 3.04M /
      splitText 1.03M / matrix normalize 308k / planOutbound 19.0k / strip+flatten 12.7k /
      decideObserved 6.75M ops/s。`test/benchmark-floor.test.mjs` 9 条契约。CI job 为警告态
      （`continue-on-error`），因为免费 runner 算力抖动不该把 PR 判红。
- [x] **M4 覆盖率入 CI** → `62f89f45`：`scripts/coverage-report.mjs` 解析 lcov，只算 src/+plugin-src/。
      首次标定 **lines=89.97%** functions=83.89% branches=81.14%（471 文件，全程 40s），阈值取 85%。
      这张表立刻暴露人看不见的盲区：`wecom-app-controller.mjs` **25.05%**、`matrix-controller.mjs`
      **26.39%**（≥300 行大文件低覆盖 Top2）—— 登记为 M4.2 的具体靶子。
      负控三条 exit 码直测：95%→1、空 lcov→1、85%→0（不经管道，管道会把退出码换成 tail 的）。
- [x] **H4.1 治理/覆盖率/基准各自成 CI job** → `66f8078c`：ci.yml 5 job（PyYAML 解析验过结构）；
      `test/ci-workflow.test.mjs` 5 条本地判据钉住 job 存在性、阻断/警告态分工、各 job 跑自己的
      判据命令、coverage job 必装 ffmpeg（M5 的另一半），以及**每条 uses 必须是 40 位提交 SHA**。
- [x] **产物同笔重建** → `80657a05`：package.json 的 files 加两个新脚本 ⇒ manifest 编进 bundle，
      守卫正确判红（`BUILT_ARTIFACTS_DRIFT`）。提交前实测归因：他人未提交的
      `wechat_group_uia.py` 独有标识符（visible_delta / _overlap_length / sent-as-image / no-fallback）
      在新旧 bundle 里**都是 0 次命中** ⇒ 没把别人代码扫进我的产物（R328 纪律）。
- [x] **报告自身四处过期读数更正 + §8** → `aa0b15dd`：这轮最该记的一条。
      ① 能力渗透率 3/3/6 → **2/2/4**（分卷 02 写在 matcher 收窄之前，收窄未回改；总格数 56
         两边一致 ⇒ 只看总数发现不了）；② `nonebot/message.py` 被写成「消息段模型」，
         实测是事件总线（578 行、`class MessageSegment` 命中 0），段模型在
         `nonebot/internal/adapter/message.py`（12,695 B/434 行）；③ `gateway.go` 19,673→**20,347 B/674 行**、
         `bridge.go` 3,030→**3,165 B/135 行**；④ LangBot `ARCHITECTURE.md` 在**仓库根**不是 docs/，
         README 是 **6** 语言不是 5。§1/§2 的本仓现状列同步 18 处（H4/注册表/基准/覆盖率/
         ARCHITECTURE 都已在盘却仍写「缺失/建议」，文档分值 6/10→8/10）。
      实施顺序刻意是「**先让判据报红再改文档**」：给 `verify-benchmark-report.mjs` 加判据二
      （报告行首 `| 语音 | N/M |` 必须等于 `collectChannelMatrix()` 实测），第一次跑就输出
      `BENCHMARK_REPORT_MATRIX_MISMATCH: 语音: report=3/14 matrix=2/14 | …` 三处全抓。
- [x] **上游复现两件落地**（补 §5.8 的第①②项）：matterbridge 全量 clone + 284 行 JS 复现
      12/12 绿（`_research/bench2/repro-matterbridge-gateway-thin-api/`）；NoneBot2 因本机
      GitHub 443 被代理阻断未能 clone，按退路降级 `gh api contents` 取原文 + 125 行复现 10/10 绿。
      两条新建议入报告 §8.2：**N1** 注册条目补 `capabilities`（上游把能力放第二张表 ⇒ harmony
      的 typing 代码不可达，我已独立复核：`grep -rn UserTypingSupport gateway/bridgemap/*.go`
      只有 discord/slack/定义三行）；**N2** 投递能力声明 1/14 → 14/14。
- [x] 门禁终读数（2026-11-02 07:2x+08:00）：`npm run check` **exit 0**
      `4959 tests / 4957 pass / 0 fail / skipped 2`、`BUILT_ARTIFACTS_OK 2 files match HEAD`、
      `CAPABILITY_MATRIX_OK 14 channels, 2 document(s)`、
      `BENCHMARK_REPORT_OK dimensions=8 sections=4 tables=123 numbers=1038 capabilityClaimsChecked=yes`、
      `GOVERNANCE_OK 7 files, cross-references intact`。
- [x] 部署面读回：profile 符号链接 `~/.dsh/profiles/desktop/node_modules/@xmanrui/dsh-im`
      → `D:/codex/DSH-IM/rv5.8.0`，实测安装件与工作树 `lib/index.js` md5 同为
      `74d2dd2d1e40f5c2ec3a2d49b63b9077` = HEAD blob；适配器进程 3092 正跑该仓库路径。
      只读线上验证：`verify-adapter-resolution.mjs` PASS、`verify-wechat-group-live.mjs` PASS。

## 未闭环（第十六轮）

- [ ] **推送被本机网络卡住**：`git push fork feat/wechat-groups` 三次全红，实录
      `Failed to connect to github.com:443 over proxy 127.0.0.1 after 0 ms` ⇒ 与子代理 clone
      受阻是同一个环境事实，不是凭据或权限问题（`gh auth status` 仍显示已登录）。
      后果：PR #516 的 head 停在 `fbdf0773`，本轮 7 笔提交（HEAD `80657a05`）只在本地。
      下一步：网络恢复后原样重推即可（幂等，fast-forward）；本地已用 `npm run check` 代替 CI。
- [ ] **宿主未重启**（老大本轮明令「禁止自杀重启」）：新 bundle 已在盘并经 md5 读回，
      但 ESM 模块不被热换（`cordis.patch.yml:353` 有 2026-11-02 04:21 的实测记录：
      touch patch 只重挂补丁层，插件 bundle 仍在宿主模块缓存里）。
      待老大允许重启时一次生效；本轮不擅自重启宿主。
- [ ] **上游 issue 未提交**：四条候选缺陷的**源码事实**我都已独立复核（详卷第 7 节），
      但 nonebot 两条（telegram `pop`/`get`、feishu `to_post` 就地改名）的触发证据只到
      「按源码求值顺序推导 + 标准库复刻」，未端到端跑过真实 `bot.send()`；本机 443 不通
      也无法验证。按「证据不足不冒充完成」留待可联网机器坐实后再提。
- [ ] Koishi / LangBot 两篇五节笔记：⏳ 在办（首轮子代理读完未落盘，第二轮重派；
      `koishi-adapter-di.md` 当前 366 B 是骨架，`langbot-domain-layering.md` 尚未创建
      —— 但其分类脚本 37,996 B 与 `outputs/domain-mapping.md` 17,847 B 已在盘）。
- [ ] **M2 `shared/` 二级分层**未动：与本轮语音/基准改动写面重叠，按「同文件先串后派」推迟。
- [ ] M3.2 基准 `Infinity` 边界**刻意未修**：改判定会让刚写回的下限标定与 CI 首次读数
      失去可比性；已钉成测试 `known edge…recorded on purpose`，防止将来被顺手改掉而无人察觉。
- [ ] 分支覆盖阈值未设（81.14%，只给行覆盖设了 85%，避免一拍就红）。
- [ ] 真实微信群未发消息验证（需受控授权）；设置界面 / RPC 未做；其余 12 渠道未接记忆与拟人。
## 已闭环（2026-11-02 第十七轮：N1 + 端到端复现 + 四条上游 issue + 报告二次对账）

- [x] **N1 能力声明进注册条目** → `cfd184fc`：14 条注册项各带 `capabilities`（值由 `collectChannelMatrix()`
      实测导出生成，不是手抄 —— 一致是结果不是前提）。设计取舍写进注释：**不建第二张表**，
      因为上游 matterbridge 正是把能力放在 `bridgemap.UserTypingSupport` 这张第二表且无人比对 ⇒
      harmony 实现了 `EventUserTyping` 却永不登记，那段代码不可达且不报错。
      判据 `reconcileDeclarations` 双向：证据未声明 / 声明无证据 / 键名拼错 / 集合不齐 四种都判红；
      `test/capability-declarations.test.mjs` 12 条（9 合成 + 3 活体真数据）。
- [x] **报告二次对账（我自己的错被抓三次并当场改）**：
      ① 上轮把「5 语言 README」改成「6」，来源是被 `head -22` 截断的目录列表 ⇒ 完整复算
        （`gh api contents --paginate`）= **9 个 README 文件**，已改并标注「我上轮的读数是怎么来的」。
      ② 子代理报「ARCHITECTURE.md 31,490 B、31,138 是行数误填」⇒ 我没采信，`gh api .size` 实测
        **31,138**、blob 352 个 LF 零 CRLF、31,138+352=31,490 ⇒ 那个数是**本地 checkout 的 CRLF 产物**，
        报告原值是对的，**没有按它改**（若改了就是把错数写进权威件）。
      ③ 我从子代理笔记抄进报告 N3 的 `deliverDeferredHarnessTurn` **全仓 0 命中** ⇒ 按实测改写：
        该行字面是 `import { AssistantTextAccumulator, accumulateFinalAssistantText } from ./harness-client.mjs`。
        另自查：我一度用浅克隆的 git 历史断言 Gitter/Twitch「从未存在」——clone 只有 1 commit，
        该命题不成立 ⇒ issue 里收窄成「当前 master 可验证」，并明确写出我不主张历史。
      ④ 分卷 02/08 与主报告同源化（分卷此前仍是旧稿：贡献流程「完全缺失」、覆盖率「未采集」、
        笔记「⏳ 在办」、H4.2「⛔ 未做」）。判据只查主报告 ⇒ **分卷可以长期过期没人发现**，
        这是判据覆盖面缺口，已登记为 H4.3。
- [x] **端到端复现 + 四条上游 issue 全部 OPEN**（objective 里「提交 issue/PR 参与社区协作」那一半）：
      pip 装真包（nonebot2 2.5.0 / adapter-telegram 0.1.0b20 / adapter-feishu 2.7.2）走真
      `Bot.send_to()`，只桩 HTTP 出口，**带对照组**证明 `document = None` 源于前一次就地修改而非桩本身：
      `E2E_VERDICT CONTROL_OK A1_OK A2_OK B_OK`。issue 正文里的代码是逐字实跑过的版本。
      https://github.com/nonebot/adapter-telegram/issues/89
      https://github.com/nonebot/adapter-feishu/issues/166
      https://github.com/42wim/matterbridge/issues/2262
      https://github.com/42wim/matterbridge/issues/2263
      线上复核 `ISSUES_LIVE_OPEN_BY_ME=4/4`（作者 lxh113377）。提交前逐条查重：telegram#61、
      matterbridge#1864 均不同因。
- [x] **推送通道的真根因（改写了上一轮的结论）**：不是 GFW/凭据，是本机 git 配了一个
      **没人监听的死代理**（`http(s).proxy = http://127.0.0.1:7897`，`netstat` 查得该端口无进程）。
      `api.github.com` 与 `ssh.github.com:443` 都通，只有走 `github.com:443` 的 git over https 被拦。
      处置：`git config --local http(s).proxy ""`（**只改本仓，不动全局配置**，可 `--unset` 回滚）⇒
      推送成功：`fbdf0773..` 一路到 HEAD，PR #516 head 与本地一致（`gh api` 复核）。
- [x] 四篇上游学习笔记全部落盘（首轮两位「读完未写」按 #44 判未交付并重派）：
      matterbridge 28,052 B、nonebot 41,038 B、koishi 58,038 B、langbot 71,866 B；判据 `NOTES_OK <bytes> bytes`
      逐条实测通过，复现代码各自可跑（12/12、10/10 绿）。
- [x] 门禁：`npm run check` exit 0；`CAPABILITY_MATRIX_OK 14 channels, 2 document(s), declarations reconciled`、
      `BENCHMARK_REPORT_OK … capabilityClaimsChecked=yes`、`GOVERNANCE_OK 7 files`、Python 223 passed。
- [x] 部署面：profile 符号链接直指本仓，`lib/index.js` 安装件 md5 == 工作树 == HEAD blob
      （`74d2dd2d1e40…` 系上轮读数，本轮重建后复测一致）；只读线上验证
      `verify-adapter-resolution PASS`、`verify-wechat-group-live PASS`。宿主未重启（老大本轮明令禁止自杀重启）。

## 未闭环（第十七轮）
- [ ] **H4.3 判据覆盖面缺口**：`verify-benchmark-report.mjs` 只查主报告，分卷过期无人知 ⇒ 应把
      `docs/benchmark/parts/*.md` 纳入同一对账（至少纳入「同一表格行不互相矛盾」这一条）。
- [ ] N2 投递能力声明 1/14 → 14/14（机制已有，覆盖面没有；`delivery-service.mjs:579,583` 硬读）。
- [ ] N4（新，来自 Koishi 件）注册条目缺 `needs` 维度：`plugin-src/host/index.mjs` 实测 17 处手工防御
      （8 个 typeof 守卫 + 9 个 try 块），而宿主自己已在用 inject ⇒ 机制本仓已有、只在渠道层没用。
      ⚠ 落地前必须先验证一条：本仓跑的是 `@deepseek-ai/cordis@4.0.1`，其 `inject` 只认「provide 过」
      不认「值存在」⇒ needs 判据得自己写「值存在」，否则闸恒真。该漂移我**尚未独立复跑**，标未取证。
- [ ] M2 shared/ 二级分层：仍未动（本轮 N1/报告改动与它写面重叠已解除，可下轮做；
      实测需 13 域而非四域，最小割 4 行已点名到 file:line）。
- [ ] M3.2 基准 Infinity 边界、分支覆盖阈值、真实微信群未发消息验证、设置界面/RPC、其余 12 渠道未接。
- [ ] 宿主未重载：新 bundle 在盘但跑的是旧进程（老大本轮明令禁止自杀重启，不擅自重启）。

### 部署与运行面读数（第十七轮收尾，2026-11-02 08:1x+08:00）

- [x] 提交/推送：10 笔独立提交（HEAD `3593dcfd`）；fork ref == 本地 HEAD
      （`gh api repos/lxh113377/dsh-im/git/refs/heads/feat/wechat-groups`），
      **PR #516 head = 3593dcfd、state=open、commits=123**（`HEAD_MATCHES_PUSH=true`）。
      fork PR 的 `CHECK_RUNS=0` 是上游 owner 需批准 workflow 运行，不是判据缺失（既有约束）。
- [x] 部署读回：`lib/index.js` 三处 md5 同为 `a86df1bde9ee…`
      （仓库工作树 == profile 符号链接实际加载件 == `git cat-file HEAD:lib/index.js`）；
      `BUILT_ARTIFACTS_OK 2 files match HEAD`。
- [x] 最终读数：`npm run check` exit 0（4,971 tests / 4,969 pass / **0 fail** / skipped 2）、
      Python 223 passed、`npm run benchmark` → `BENCHMARK_OK suites=6`、
      `npm run coverage` → `COVERAGE_OK lines=89.97%`。
- [!] **一处运行时读数变红，但不是本轮改动造成的（已归因）**：
      `verify-wechat-group-live.mjs` 末两行 `FAIL no live adapter interpreter process` → `FAILED`
      （同一次运行里 `ADAPTER-RESOLUTION … PASS` 与 group 配置解析 `OK` 都过）。
      根因实测：**微信进程不存在** —— `tasklist //FI "IMAGENAME eq Weixin.exe" //FI "IMAGENAME eq WeChat.exe"`
      → `No tasks are running which match the specified criteria`。UIA 桥的物理前提是微信主窗存在
      （工作区 AGENTS.md 第二节第 4 条），进程没了适配器自然起不来。
      与我的改动无关的证据：`git log --name-only` 最近 8 笔里 `wechat_group_uia.py` 命中 **0 次**；
      该文件本轮唯一脏项属**会话前既存**（mtime 2026-11-01T20:16Z，早于本轮 23:07Z 起跑）。
      未擅自拉起微信：GUI 启动与登录态涉及外部凭据（扫码/手机确认），且本会话语境禁止控屏。
      恢复动作（微信起来后宿主自会重拉适配器）与判据同一条：
      `node scripts/verify-wechat-group-live.mjs` 期望末行 `PASS`。
- [x] 临时件清理：`_tmp/probe-*.mjs`、`_tmp/neg-*.txt`、`_tmp/cm-*.txt`、`_tmp/check*.txt` 已删；
      上游 clone 与 venv 留在 `D:/tmp/bench2/`（仓外，不入库）。
