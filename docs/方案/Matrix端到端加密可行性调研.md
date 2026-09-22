# Matrix 端到端加密可行性调研

日期：2026-09-18。基线：《Matrix 渠道接入方案》§11 PR3 前置 spike。状态：调研结论已采纳并完成 PR3 实装（主选 `@matrix-org/olm` WASM 路线），落地范围边界与真机测得 API 契约见本文 §5；主链收发的端到端接线见方案文档 §11 与 `src/channels/matrix/matrix-crypto.mjs`。方法：只读调研，全部证据来自直抓 npm 注册表、unpkg、GitHub API、crates.io 与规范站；外部内容皆按不可信数据处置。环境注：调研环境的网络栈会按同义形改写部分标识符与域名，落依赖时以注册表实际解析名与钉版校验和为准。

## 1. 结论

1. 可行：在 Node ≥22.19、纯 ESM、零原生编译、可离线随包分发的约束下，`@matrix-org/olm@3.2.15`（libolm 官方 Emscripten→WASM 构建；Apache-2.0；零运行时依赖；无 install/postinstall 钩子）即可完成入站 Megolm 解密与出站设备间 Olm/群组 Megolm 加密；PR3 最小闭环（入站解密、出站加密、to-device 密钥共享，不含 key backup 与交互式验证）用该包可闭环。
2. 该包处"冻结维护"态：GitHub 镜像 `archived:true`，规范源在 GitLab 侧仓库；npm 末次发布 3.2.15（2023-10-27）。能力面无缺：Account/Session/PkEncryption/PkDecryption/PkSigning/SAS/OutboundGroupSession/InboundGroupSession/pickle/unpickle 俱在 wasm 导出中。风险在维护不在能力，集成层须自维。
3. 包名注意：非 scoped 的 `olm` 是 0.0.0 占位弃用包；可安装正源为 scoped `@matrix-org/olm@3.2.15`，依赖清单必须钉住此名。
4. `matrix-js-sdk`（Apache-2.0、Element 维护、活跃、`engines.node>=22`、`type:module`）的 E2EE 已切换至 matrix-rust-sdk 之 Rust 密码学 WASM 绑定（运行时依赖 crypto-wasm 包），协议完整度最高（SSSS、key backup、cross-signing、交互式验证、legacy 迁移），但 crypto wasm 约 7.8 MB 且自带同步/存储栈，与 dsh-im 自有 undici 栈并行引入有架构分叉成本。
5. 题面点名候选证伪：`@matrix-ai/matrix-sdk` 注册表 404、检索无仓库，不存在（系 matrix-js-sdk 与 Rust 侧 crate 之混淆）；`rustolm` 404 不存在；`multiverses` 检索与 Olm 无关；`olm-sys`/`olm-rs` 为原生 FFI 绑定，违反零原生约束剔除；纯 JS Olm/Megolm 只有玩具仓库。受维护生产实现皆走 C++→WASM（libolm）或 Rust→WASM。
6. Node 端先例：Node bot `piagent-matrix`（MIT、`type:module`）以 matrix-bot-sdk + matrix-js-sdk 42.x 做 E2EE + 持久 crypto store + 交叉签名脚本，证明 Node 22 持久存储路线可落地。

## 2. 候选矩阵

| 候选 | 形态/版本 | 许可 | 维护 | 体积/依赖 | Node22 纯 ESM 无构建加载 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| `@matrix-org/olm@3.2.15` | C++→Emscripten→WASM；CJS 胶水（ESM default interop），附 asm.js 回退备份 | Apache-2.0 | 冻结（2023-10 末发；镜像归档；规范源 GitLab） | 整包约 651 KB；`olm.wasm` 约 153.6 KB；零运行时依赖、无 install 钩 | 可行：须先 `await Olm.init(opts)` 再 `new Olm.Account()/Session()`；`locateFile`/`wasmBinary` 可注入；Node 分支以 `fs`/`path` 读 wasm、`crypto.randomBytes` 供熵、TextDecoder 缺时手译；不依赖 WebCrypto/Worker，Node 路不 fetch | 主选 |
| matrix-rust-sdk 之 Node/WASM 绑定（crypto-wasm 包） | wasm-bindgen 产物；cjs/mjs 双轨入口 + 类型声明 | Apache-2.0 | 活跃（2026-09） | wasm 约 7.83 MB | 可行但 API 面巨大，存储/编排皆需自建 | 备选底座 |
| `matrix-js-sdk`（`initRustCrypto`） | 纯 TS 编译产物 | Apache-2.0 | 活跃（Element） | 约 12 运行时依赖 + 上行 wasm | 可行：Node 须 `useIndexedDB:false` + 自维持久 store；crypto 栈非线程安全，同 store 同时刻仅许单实例 | 备选（协议全、体积最重） |
| 纯 Rust Olm/Megolm crate（matrix-rust-sdk 侧，`libolm-compat` 特性） | Rust 源 crate | Apache-2.0 | 活跃 | — | 分发物可为 wasm，但构建须引入 Rust 工具链 | 参考源/测试预言 |
| `olm-sys`/`olm-rs` | libolm FFI | Apache-2.0/ISC | 低维护 | 需本机链接 libolm | 否 | 剔除 |
| `olm`（非 scoped） | 0.0.0 占位（deprecated） | ISC | 无 | 199 B | — | 勿钉此名 |
| 纯 JS Olm/Megolm | 2 个玩具仓库 | MIT 等 | 无 | — | — | 不可依赖 |

## 3. 推荐

- 主选：`@matrix-org/olm@3.2.15` WASM 直连 + dsh-im 自维 Olm/Megolm 编排层。逐条对治约束：零原生编译（注册表实核无 scripts、无 dependencies）、体积最小（热路径 wasm 约 150 KB、整包约 651 KB，可离线随包分发并以包内校验件核验）、许可宽松（Apache-2.0）、Node 22 纯 JS/WASM 无构建工序、能力面恰覆盖 PR3。工量量估：新增 `e2ee` 子树约 8–12 源文件、生产码约 2,000–3,500 行（账户/会话 pickle 持久化、to-device 路由、Megolm 会话与轮换、乱序去重、pkenc 密钥共享、一次性密钥水位管理），测试约 1,000–2,000 行（以 matrix-js-sdk 侧 Apache-2.0 legacy crypto 测试与 `libolm-compat` 语义为基准）；依赖 +1 包。
- 备选：`matrix-js-sdk`（`initRustCrypto`，Rust 绑定后端）。若 PR3/PR4 需要 key backup、SSSS、cross-signing、交互式验证而不愿自维协议编排则取之；代价：约 +12 传递依赖、+7.8 MB wasm、以 SDK 之同步/存储替 dsh-im 路（或双栈并行）、单实例约束。工量约 3–6 胶水文件、300–800 行。
- 不建议裸用 crypto-wasm 绑定包：类型声明面即 164 KB、存储/编排皆需自建，工效不若经由 matrix-js-sdk。

## 4. 风险

1. 密钥/设备持久化（pkenc、pickle、device_id 稳定绑定）：Account/Session/PkDecryption 皆有 pickle/unpickle；密钥、pickle 口令、device_id 三者须同盘持久且单写者（文件锁）；store 丢失须重新注册设备。缓解：启动校验 pickle 可解 + device_id 与服务端 `/devices` 一致，不一致即告警、勿静默重置。
2. 并发：Rust 后端 README 明示非线程安全、同 store 禁双实例；olm 路线同样须单写者串行化 store 事务。
3. to-device `m.room_key`：收（sync to_device 时间线 → PkDecryption 解出 → 按 session_id 导入 InboundGroupSession，记 first_known_index）与发（每目标设备建出站 Olm.Session 传 `m.room_key`，含 session_id/session_key/message_index）皆闭环；一次性密钥用后 `remove_one_time_keys` + `mark_keys_as_published`；`UNKNOWN_DEVICE`/session 失配以 `/keys/query` 重查询重试。均在 wasm 能力圈内。
4. `m.room_key_request`/forwarded key：olm 包不内置自动应答，须自维应答状态机（请求节流、去重、应答）；属安全关键码，需测试覆盖。
5. 冻结维护：钉版 + 随包校验件核验；升级通道经规范源自建会引入 Emscripten 工具链，故优先钉成品。
6. 后续 key backup/SSSS 增量成本：olm 导出仅有 sha256/ed25519 验签/SAS；AES-256-GCM 与 PBKDF2 派生取 `node:crypto` 内建（`aes-256-gcm`、`pbkdf2` 俱在，零新依赖）；SSSS、cross-signing（PkSigning Ed25519）、交互式验证（SAS）各为一段协议编排工作量——此为主选路线主要隐性成本，亦是切换到备选的触发条件。
7. 命名风险：调研环境对包/仓库名有同义改写；钉住依赖以注册表实际解析名为准。

最小可用接收解密路径（无 key backup、无交互验证，PR3 范围）：登录后持久 device_id 与显示名 → 建 `Olm.Account` 发布身份密钥与一次性密钥水位 → sync to_device 收 `m.room_key` 解密导入 InboundGroupSession → timeline `m.room.encrypted`（`m.megolm.v1_aes_sha2`）解密，未知 session 标不可解并可发 `m.room_key_request`，乱序/过早密钥暂存待补 → 出站每房 OutboundGroupSession 计数/计时轮换，新会话向全部已检索设备分发给发（各设备以身份密钥+一次性密钥建出站会话），未达设备重查 → 全部密钥/会话 pickle 落盘、单写者串行；未验证设备数据以 "unverified" 标记展示。

## 5. PR3 实装范围边界与真机测得 API 契约

实装落地面（`src/channels/matrix/matrix-crypto.mjs` 编排层、`matrix-crypto-store.mjs` 持久层，经 `matrix-runtime.mjs` 接入收发主链，并由 `plugin-src/host/channels/matrix/production.mjs` 按 `botId` 注入 store）：设备与一次性密钥经 `/keys/upload` 注册与服务端 `query_keys` 校验；Megolm 房间加解密；房间密钥经对设备（to-device）消息 `m.room_key` 共享、`m.forwarded_room_key` 转发、`m.room_key_request` 请求；重放以已见 `message_index` 集合去重；未达密钥之密文事件暂存待补、密钥到达即冲流交回主链；设备与 `device_id` 漂移即拒起而非静默重置；account/PkDecryption/群会话 pickle 与口令经 store 单写者串行落盘，重启复原同身份。以上以 `test/channels/matrix/matrix-crypto.test.mjs` 真机 WASM 环回锁死契约。

明确不在本期范围（后续增强，非缺陷）：加密房间内 `m.file`/`m.image`/`m.audio`/`m.video` 等附件之规范 AES-256-CTR + SHA-256 封装加解密——此类附件在加密房间按明文字段（`url`、`file` 对象未加封装）随 Megolm 事件发送，属用户可见之既定降级而非规范加密附件，与 Element 等端存在互操作差异；交叉签名（cross-signing）、SSSS 密钥备份与恢复、交互式设备验证（SAS/emoji）之协议编排皆未接通，`recoveryKey` 通道字段预留而行为空。切换至备选 `matrix-js-sdk`（`initRustCrypto`）可获此全栈，代价见 §3。

真机测得 libolm WASM（`@matrix-org/olm@3.2.15`）API 契约——编排层据以下实测定形，非循文档或 matrix-js-sdk 约定，且由真机环回测试防回归锁死：`PkEncryption` 经 `set_recipient_key` 后 `encrypt(body)` 返回对象 `{ciphertext, mac, ephemeral}`；`PkDecryption` 以 `init_with_pickle`/`generate_key` 起，`decrypt(ephemeral, mac, ciphertext)` 以该参数序解出明文体（`Account` 之 `pick_all` 不存在，取 `pickle`/`unpickle`）。`Utility` 之 `ed25519_verify(publicKey, message, signature)` 参数序固定，序倒即抛 `OLM.INVALID_BASE64`。`InboundGroupSession.decrypt(ciphertext)` 返回对象 `{plaintext, message_index}`（非裸字符串），`first_known_index()`、`OutboundGroupSession.message_index()`、`session_id()`、`session_key()` 皆为取值方法，`last_message_index` 属性缺席——编排层对解密返回之字符串/对象双形态兼容处理。`Account` 之 `identity_keys()` 返 JSON 串含 `curve25519`/`ed25519`，一次性密钥经 `generate_one_time_keys`/`one_time_keys()`/`remove_one_time_keys(session)`，回退密钥经 `generate_fallback_key`/`unpublished_fallback_key()`/`forget_old_fallback_key()`，皆经 `sign`/`pickle` 配套。

## 6. 来源

olm 包之 GitHub 镜像元数据（`archived:true`、homepage 指 GitLab 规范源）与 GitLab 源仓库；npm 注册表 `@matrix-org/olm`（3.2.15/2023-10-27、Apache-2.0、解包尺寸约 651,084 B、零依赖、README 载 `Olm.init`/`locateFile` 用法）；unpkg 文件面（`olm.wasm` 153,573 B、`olm.js`、`olm_legacy.js`、`checksums.txt(.asc)` 在场）与 `olm.js` 源之 Node 分支实码；非 scoped `olm` 注册表占位态；`matrix-js-sdk` 注册表与 develop 分支 `package.json`（node>=22、type:module、deps 含 crypto-wasm 绑定）/`README.md`（`initRustCrypto`、Node 存储要求、线程安全 WARNING、SSSS/key backup/cross-signing/verification 诸节）；crypto-wasm 绑定之注册表与 unpkg 文件面（wasm 7,833,454 B、双轨入口）；matrix-rust-sdk 主仓与 bindings README；crates.io 之纯 Rust Olm/Megolm crate 与密码学总库元数据；`rustolm` 等名 404 证伪；`piagent-matrix` 先例仓与其 manifest；Matrix 规范站与规范仓之 `m.room.encrypted`/`m.megolm.v1_aes_sha2`/`m.olm.v1.curve25519`、to-device `m.room_key`/`m.room_key_request`/`m.forwarded_room_key` 诸节。
