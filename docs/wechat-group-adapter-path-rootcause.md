# 微信群桥 process-exit 根因：适配器脚本路径算错（已实测定位）

日期：2026-11-01 02:35–02:50 (+08:00) · 仓库 D:/codex/DSH-IM/rv5.8.0 · 分支 feat/wechat-groups

## 结论（一句话）

宿主每 30 秒重试的那个 Python 子进程，既不是环境问题、也不是适配器逻辑问题：插件把适配器脚本路径算成了 D:/scripts/wechat_group_uia.py，
py 在解释器启动阶段就报 can't open file（stderr 恰好 153 字节）后退出，宿主只看到 process-exit。

## 证据链（全部可复跑）

### 1. 打桩命中路径（决定性证据）

把一份会写日志的桩文件放到四个候选路径，宿主下一次 spawn 立刻写下了它真正执行的绝对路径：

```
file = D:\scripts\wechat_group_uia.py
argv = [D:\scripts\wechat_group_uia.py, --config, C:\Users\37533\.dsh\integrations\dsh-weixin\accounts\wx_c087f36721de6f68e06924cf\group-chats.json]
cwd  = C:\Windows\system32    at = 02:39:14（之后每 30 秒一条，共 6 条）
```

日志落在 D:/codex/DSH-IM/rv5.8.0/_diag/candidate-hit.txt。

### 2. 153 字节可精确复现（前三轮为何复现不出）

```bash
py -3.12 -B "D:/scripts/wechat_group_uia.py"   2>&1 >/dev/null | wc -c   # => 153  <= 命中
py -3.12 -B "D:/a.py"                          2>&1 >/dev/null | wc -c   # => 129  负控：随路径长度变化
py -3.12 -B "D:/x/scripts/wechat_group_uia.py" 2>&1 >/dev/null | wc -c   # => 156  负控：不是恒 153
```

stderr 原文：

```
D:\fj-actions-runner\_work\_tool\Python\3.12.10\x64\python.exe: can't open file 'D:\\scripts\\wechat_group_uia.py': [Errno 2] No such file or directory
```

解释器在**执行脚本第一行之前**就退出了 —— 与之前两条独立观察完全自洽：首行 trace 钩子从未被调用；宿主从未打印过我们代码才会打的 sanitized error 帧。

### 3. 路径是怎么算错的

plugin-src/host/channels/weixin/production.mjs 里写死：

```js
pluginRoot: resolve(import.meta.dirname, '../../../..'),
```

但同一份源码有两种消费形态：

| 形态 | import.meta.dirname | 上溯四级落到 | 结果 |
| --- | --- | --- | --- |
| 未打包（plugin-src） | …/plugin-src/host/channels/weixin | 仓库根 | 正确 |
| 打包后（lib/index.js） | …/dsh-im/lib | dsh-im 的上一级 | 错误 |

本机又是 link: 安装（profiles/desktop/node_modules/@xmanrui/dsh-im 是指向仓库的符号链接），Node 把入口解析到真实路径，
于是一路退到 D:\，拼出 D:/scripts/wechat_group_uia.py。

附带结论：这条与之前那条「部署包哈希恒等于源码哈希」的假证据同源 —— 符号链接让所有文件哈希比对都失去判别力。

## 修复

新增 src/channels/weixin/adapter-script.mjs 的 findAdapterScript()：从模块自身目录向上找，**只认 package.json 里 name 含 dsh-im 的那个包**，
再取它下面的 scripts/wechat_group_uia.py，且必须是真实普通文件。

- 不再假设往上几级是包根，打包/未打包两种布局给出同一结果；
- package.json 门槛来自负控要求：本机 D:\scripts 恰好真实存在（无关目录），没有这个门槛时上溯搜索会再次选中它，测试里已把该情形固化为红/绿对照；
- production.mjs 不再传 pluginRoot，改由 group-source.mjs 用 import.meta.dirname 自解析。

## 判据（可复跑）

```bash
cd /d/codex/DSH-IM/rv5.8.0
node --test test/channels/weixin/adapter-script.test.mjs   # 期望末行 ℹ pass 7 / ℹ fail 0
node scripts/verify-adapter-resolution.mjs                  # 期望末行 PASS
npm test                                                   # tests 4719 / pass 4710 / fail 1（飞书 esbuild 临时目录权限，预存在）
```


## 第二轮筛查（03:00–03:35 追加）：又揪出两个真实缺陷

### 缺陷 2：重启后不重新挂接 bridge —— 适配器活着但群永远闭嘴

现象：宿主内的 Python 适配器确实在跑（PID 20668，02:51:46 起存活 8 分钟，35 秒烧 4.25 秒 CPU = 持续轮询），
tee 日志还能看到它稳定发出 `addressed: true` 的真正入站行：

```
OUT {"type":"message","message":{...,"addressed":true,"text":"LIVE-1793474619425",
     "from_user_id":"uia-unverified:row","reply_target":"uia_group_room"}}
```

但宿主**一个字都没回**，而且日志里连 `rejected group event` 都没有 —— 属于「静默丢弃」。

根因（`src/channels/weixin/wechat-group-runtime.mjs`）：`#start()` 失败时会 `this.#bridge = null`，
而重试入口 `#restart()` 只调 `process.start()`，**从不把 bridge 放回去**；`#onMessage()` 第一行是
`if (!this.#accepting || !this.#bridge) return;` —— 于是每个事件都在无日志的情况下被吞掉。

修复：新增 `#startBridge` 记住账号级 bridge，`#restart()` 在 `#bridge` 为空时重新挂接；
并把静默丢弃改成带原因的日志（`dropped group event while intake was closed` / `... no account bridge attached`）。

回归测试（2 条，均已红→绿）：
- `a restart after a failed start keeps the account bridge so real rows still arrive`；
- `a dropped event names its reason instead of vanishing`。

### 关于「153 字节」的历史误判（诚实记录）

此前几轮把它归因为 PYTHONHOME/PYTHONPATH 泄漏，实测**站不住**：直接 spawn 时无论怎么注入这些变量，
stderr 都是 0 字节或 1000+ 字节的 path-configuration 文本，从未出现 153。真正的 153 是
`py` 报「can't open file 'D:\\scripts\\wechat_group_uia.py'」，与 PYTHON* 无关。

## 判据（补充）

```bash
node --test test/channels/weixin/wechat-group-runtime.test.mjs   # 期望 ℹ pass 12 / ℹ fail 0
```

## 本轮收口状态（2026-11-01 03:40）

已完成并有证据：
- 根因定位：适配器路径算成 D:/scripts/... → 153 字节 stderr → process-exit（打桩命中 + 字节数复现 + 负控）。
- 代码修复：findAdapterScript()（package.json 门槛）+ 不再传 pluginRoot；提交 65918d0。
- 另外两个缺陷同轮修复并加了回归测试：重启不重挂 bridge、事件静默丢弃。
- 全量测试：tests 4721 / pass 4712 / fail 1（飞书 esbuild 临时目录权限，预存在）。
- verify-package / npm build / verify-adapter-resolution 全绿；deployed lib/index.js md5 与仓库 HEAD 一致。
- 用修复后的真实代码路径（group-source → 真 UIA → 真群）实测：ready + 发送成功 + 回读入站行 admitted。

仍未闭环（结构性，非能力缺口）：
- 运行中的 Host 进程仍持有启动时加载的旧 bundle。HMR 的默认 ignored 含 **/node_modules，
  且依赖遍历显式跳过 node_modules（dsh-hmr/lib/index.js:240-241, :201, :480），
  本机 @xmanrui/dsh-im 是 link: 符号链接，两条路径都不在监听范围 → 不重启装不进新代码。
- 重启会终止本会话，所以「宿主重启后线上验证」只能由重启后的新会话完成。

给下一轮（重启后）的验收清单：
1. 日志不再出现 `group adapter stderr (153 bytes)`；
2. 进程列表出现 `python.exe -B …\scripts\wechat_group_uia.py --config …` 且持续存活（不再是 D:\scripts）；
3. 群里发 `/dsh 测试`（不是 @，@ 在本设计下永不触发）→ 收到 Agent 回复；
4. 日志若出现 `dropped group event ...` 则说明还有第三个缺陷，按日志原因续查。

## 仍未闭环（诚实边界）

运行中的宿主仍执行**启动时刻**加载的旧 bundle：dsh-hmr 的默认 ignored 含 **/node_modules（lib/index.js:240-241），且依赖遍历显式跳过 node_modules（:201/:480），
而本机 @xmanrui/dsh-im 是符号链接，改动落在 node_modules 与链接目标之间，两条路径都不在监听范围。
因此本修复必须在宿主重启后才会生效；重启会终止本会话，自证闭环只能由重启后的下一次会话完成。
