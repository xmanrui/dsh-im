---
status: accepted
date: 2026-09-15
updated: 2026-09-15
---

# 设置页表现层的单一归属与实测口径

设置页的表现层由一张共享样式表（`plugin-src/client/styles.js`）和十一个渠道各自的 `styles.js` 组成。它遵循两条硬规则：
**每个视觉角色只有一个所有者**；**颜色、字号、行高、字重、圆角、间距收敛到宿主 `--dsw-*` token 或插件自己的 `--dim-*` 别名，不在规则里重写值**。
违反第一条会产生「同一角色、多个作者」，最终生效者由 CSS 层叠规则决定而不是由代码位置决定；违反第二条会产生「同一个值的两种拼法」，改一处不影响另一处。
本文记录这两类缺陷的四种机制、验证口径、已经收敛的轴，以及证据决定不了、留给维护者的取舍。

## 一、四条「同一角色、多个作者」的机制

按可观察性从强到弱。前两条是通用 CSS 语义，后两条是本仓库的具体事实。

1. **不同长属性从不竞争。** `min-height` 与 `height` 同时参与计算，`used = max(min-height, height)`。两条规则各写一个，
   视觉结果是两者叠加，不是谁覆盖谁。实例：飞书 `.bxf-button[data-size="small"]` 把二维码按钮撑到 32px，与共享规则的 28px 并存，
   切换渠道时整行抖动 4px（`7a1977e`）。
2. **特异性遮蔽。** 高特异性整条规则胜出，与注入顺序无关。实例：共享 `.dim-panel .bxf-headingTools .dim-scanButton` 是 (0,3,0)，
   恒胜渠道表的 `.bxf-button[data-kind="primary"]` (0,2,0)；hover 上则是 (0,5,0) 对 (0,4,0)。
   注意 **`:not()` 计入其参数**——`:hover:not(:disabled)` 加的是两个类级权重，不是零。
3. **同特异性看 `<style>` 注入顺序。** `plugin-src/client/index.js:445-463` 先安装十一个渠道样式表、**最后**安装共享表
   （`installImStyles()` 在该数组第 458 行），因此**同特异性下共享表胜**。
   **钉钉是唯一例外**：它不在那张列表里，而在挂载时安装（`channels/dingtalk/index.js:403`；另有五个渠道与 `shared/token-channel.js` 也各自安装它），
   因此**同特异性冲突中钉钉胜**。任何将来的同特异性取舍都必须从这个顺序推理，不能凭「渠道表写在后面」。
   **变体：同特异性下，静止规则可以吃掉状态规则。** 特异性相同时层叠**不看**「谁更贴近状态」——一条**没有 `:hover`** 的静止规则，只要特异性与带 `:hover` 的规则相同、又安装得更晚，就会盖掉后者的悬停外观。
   真实一例（本轮实测）：渠道的 `.dxw-button[data-kind="primary"]:hover:not(:disabled)` 与共享的**静止**规则 `.dim-panel .dim-viewActions .dxw-button[data-kind="primary"]` **同为 (0,4,0)**（`:not()` 计入其参数），于是胜负由注入顺序裁决：weixin 表 110、共享表 120、dingtalk 表 121 → **WeChat 页的按钮悬停毫无反馈**，而 **DingTalk / QQ 页同一个按钮悬停变成 `rgb(67,69,74)`**。同一条规则、两种外观。
   **判据：看到「一条静止规则 + 一条状态规则」时，必须先把两边的特异性算出来**，不能因为「带了 `:hover` 所以更具体」就跳过计算。需要该角色稳定归属时，**把共享规则提到能独赢的特异性上，消除平局**，而不是依赖注入顺序。
4. **祖先限定的共享规则只在自己的祖先内匹配。** `.dim-panel …` 开头的规则到不了那五个挂到 `document.body` 的浮层：
   目录选择器（`workspace-directory-picker.js:280`）、别名对话框（`bot-alias.js:73`）、机器人名提示（`bot-alias.js:114`）、
   上下文对话框（`context-enhancement.js:370`）、更新对话框（`update-panel.js:235`），它们必须各自写规则。
   同一条事实的另一面：`--dim-*` 必须声明在 **`body`** 上——宿主在 `<body>` 发布 `--dsw-*`，而自定义属性在**声明它的那个元素**上替换，
   声明在 `:root` 会把这些 token 冻结成回退值（`12c1347`、`be85d9d`）。

## 二、验证口径：结论必须实测，读源码不算验证

本仓库的缺陷大多长成「这条规则看起来会生效 / 看起来已经死了」，而源码阅读对这类问题给出的答案
**在一轮工作里被实测推翻过四次**：判断 `data-kind=primary` 从不画实心按钮、判断存在 22 处跨渠道冲突、
判断状态点光晕在所有渠道都是死代码、判断两个渠道的进度条单位不一致。因此：

- **任何「生效 / 失效 / 可见 / 不可见」的结论都要在浏览器里量。** 静态扫描只用来**挑候选**，不用来下结论。
- **维护者报的现象一律当证据，不得因为「读源码看不出来」而判为未复现。** 读源码看不出差异**不等于**差异不存在 ——
  那说明**源码是盲的**，不说明现象不存在。真实一例：两条渠道的悬停规则逐字节对称，只读源码无论如何推不出
  「WeChat 的按钮悬停没有反馈」；只有在活 DOM 里枚举匹配规则，才看出那是两条 (0,4,0) 规则之间的平局，
  由 `<style>` 注入顺序裁决（weixin 表 110 / 共享表 120 / dingtalk 表 121）。
- **同特异性平局要消除，不要依赖注入顺序。** 发现平局时，正确做法是把该角色提到一个能独赢的特异性上；
  靠「谁最后安装」得到的结果会在渠道之间分叉。
- **变异测试必须先证明变异真的落到了文件上，否则「通过」可能什么都没测。** 删掉断言要保护的声明、
  跑测试、看到它变红，才算这条守卫有牙。但**变异本身可能是个空操作**：锚点字符串在文件里出现多次时，
  `String.replace` 会替换掉第一处、而那多半不是目标；文件没变，测试当然全过，于是被误报成「守卫无牙」
  或更糟 —— 被当成「已验证」。
  **规矩：施加变异后，先读回文件确认（比对哈希，或把变异后的那一行 grep 出来），再跑测试。**
  真实一例：给「浮窗配对」守卫做第二条变异时，锚点 `color: …; background: var(--dim-module-fill);`
  在别处也匹配，`.dim-contextTooltipExample` 一行原封未动，测试 8/8 全过；复核文件内容、换用唯一锚点重做，
  才是真正的 7 过 / 1 败。**没有这一步，变异测试的结论不可采信。**
- **测试条数变了必须逐条说明构成**（新增 / 合并 / 删除 / 重构丢失），并给出每条的文件与用例名。
  「少了几条」和「跑的是另一条命令」是两回事，不能靠印象解释。
- `getComputedStyle` 返回的是**活对象**：先把值读成字符串再比较，不要存下对象稍后再读。
- 选择器归属要按**规则块**解析；按行扫描会在跨行规则上漏项或错记。
- 判定「某个 token 的兜底是死代码」需要三条同时成立：token 声明在 `body` 上、所有浮层都挂到 `document.body`、
  `document.documentElement` 上量到该 token 为空串。
- 判定「一句标记有没有像素影响」用**活 DOM 翻转法**：在浏览器里改属性、前后各量一次，而不是推理。
- 仓库是**浅克隆**（`git rev-parse --is-shallow-repository` = true），历史不可用；
  任何「这是不是有意为之」的历史论证都不成立，只能标注来源不可考。

## 三、已经收敛的轴

每一条都做过「改一处是否影响所有同类位置」的对照；纯改名但尚未收敛的不计入。

| 轴 | 收敛到 | 代表提交 |
|---|---|---|
| 工具提示皮肤 | 一份共享皮肤（原 17 处） | `16e88b3`、`e8234f8` |
| 字号 / 圆角 / 间距 | `--dim-font-*` / `--dim-radius-*` / `--dim-gap-*` | `fd9ee3e`、`d26433f`、`9f8814f` |
| 主题色兜底 | 每个 token 一个兜底（原最多六个） | `46bdac7` |
| 悬停填充 / 堆叠层级 / 展开动效 / 错误色 | 各一个来源 | `58a5fbf`、`4b5cecf` |
| 边框（按子角色） | 宿主 hairline | `245dca4`、`40fa160` |
| 文字色调（提示、说明、空态与状态视图正文） | 宿主 `label-tertiary` | `9a7c952`、`0b36a08` |
| 字重 / 行高 | `--dim-weight-*` / 与字号 rung 配对的行高 | `e692e59`、`83cdb09` |
| 品牌色 | 只留在身份标识；画填充的控件统一用宿主动作色 | `03112fd` |
| placeholder | 宿主 placeholder 档 | `ab907c6` |
| 等宽字体栈 | 宿主 `--ds-font-family-code`，一个地址 | `da0d2fd`、`c79508c` |
| 状态点 | 共享 `.dim-stateDot` 角色 + tone | `54250ee`、`bbb5684` |
| 背景与颜色别名 | `--dim-module-fill` / `--dim-blue` / `--dim-danger` 单一来源 | `b2e2ef8`、`0be82a7` |

**别名与裸 token 的判据**：给宿主颜色起 `--dim-X: var(--dsw-alias-Y, Z)` 别名之后，同一个宿主 token 仍可能被裸写。
两种拼法同值不同源，改一处不影响另一处。查法是对每个别名统计裸 `var(--dsw-alias-Y` 与 `var(--dim-X)` 的出现次数。
**别名的名字必须覆盖宿主 token 的全部用途；覆盖不了就不合并**——`--dim-focus` 因此故意保留两种拼法，
因为 `--dsw-alias-brand-primary` 除焦点环外还画选中态开关和插件的墨色文字，把这些一并叫 focus 是错名。

## 四、已经固化的护栏

**五个契约测试共 32 例**，逐一用变异测试验证过有牙（把缺陷放回去会变红）：

- `test/client-native-border-contract.test.mjs`（5 例）——中性 token 边框与实心分隔线画在原生 0.5px hairline；
  高程阴影不配中性边框；账户 chevron 用内置的原生字形；**token 层声明在 `body` 上**（把声明移回 `:root` 会变红）。
- `test/client-role-form-contract.test.mjs`（10 例）——设置行标签用原生行标题角色、组标题用原生 caption 角色、
  以 footer 结尾的卡片有底部内边距、禁用选择器保留表面只压暗文字、弹窗滚正文不滚自身 chrome、placeholder 用原生 placeholder token、
  右槽只声明一次且 hover/focus/disabled 与基类同址。
- `test/client-toolbar-role-contract.test.mjs`（2 例）——标题栏的两个按钮共用一份 padding，且没有别的规则给它们单独的内联 padding。
- `test/client-disclosure-contract.test.mjs`（6 例）——三类展开共用一套解剖；手势（箭头旋转、展开时长、body 裁剪）只有一处声明；
  **全量扫描禁止任何 `h('details')` 带内联样式复活**；诊断展开用具名角色而非内联 chrome。
- `test/client-row-control-contract.test.mjs`（9 例）——行控件的皮肤、状态与内部布局只有一处声明；行文字是文本光标且可选中，
  只有控件拿手指针；`.dim-botList` 等容器各取宿主角色；11px 一档按宿主的两类角色拆开；portal 菜单自带字体；
  渠道表不得再声明已删的死类前缀。

改样式后至少跑这一条门禁（14 文件、199 例）：

```sh
node --test test/client-native-border-contract.test.mjs test/client-role-form-contract.test.mjs \
  test/client-row-control-contract.test.mjs test/client-disclosure-contract.test.mjs \
  test/client-toolbar-role-contract.test.mjs test/client-ui.test.mjs \
  test/context-enhancement-ui.test.mjs test/client-delivery-settings.test.mjs \
  test/model-setting-ui.test.mjs test/workspace-editor.test.mjs test/bot-alias-ui.test.mjs \
  test/channels/dingtalk/client-ui.test.mjs test/channels/telegram/client-ui.test.mjs \
  test/channels/weixin/client-api.test.mjs
```

> CI 跑的是全量 `npm run check`（`test/*.test.mjs` + `test/channels/*/*.test.mjs` + `scripts/verify-package.mjs`）。
> 本机 Windows 下全量有 87 条既有失败，全部落在服务端/Host 测试文件；**新增改动前先确认失败集合没有变化**，不要只看数字。

### 4.2 清单类工具（从代码生成，可重跑）

收敛的每一步都需要一份**从代码算出来、且能再算一次**的清单。手抄的清单不行：本仓库曾经出现过一份约 118 个表面的手抄清单，只存在于一次对话里，
等再次需要时它已经不存在了。因此把四类问题各做成一个可重跑的脚本：

| 脚本 | 回答什么问题 | 用法 |
| --- | --- | --- |
| `scripts/row-anatomy-audit.mjs` | 每个「设置类」块是按什么解剖搭的（行 / 堆叠 / 字段 / 提示 / 状态 / 组标题），哪些不是宿主那一种 | `node scripts/row-anatomy-audit.mjs [--json]` |
| `scripts/role-form-audit.mjs` | **同一角色在不同渠道是否穿了不同形态** —— 逐个值比对看不出这种失败，因为每种写法单独看都合法 | `node scripts/role-form-audit.mjs [--all] [--soft]` |
| `scripts/surface-audit.mjs` | 设置页能渲染出哪些表面（portal / select / menu / 条件挂载 / 数据门控），静态可枚举的那部分 | `node scripts/surface-audit.mjs [--json]` |
| `scripts/surface-probe.js` | 上一条的**第二阶段**：在真实页面里确认候选表面确实渲染、并读出计算值 | 在页面控制台 `await __surfaceProbe()` |
| `scripts/dead-rule-audit.mjs` | 哪条渠道规则永远赢不了层叠，或**根本没有渲染点**（附「被谁压掉」或「零引用」的证据） | `node scripts/dead-rule-audit.mjs [--json]` |

关于 `dead-rule-audit.mjs` 的一条**已知盲区**：它的第四个桶用 `selectors.every(...)` 判定，
**选择器里只要有一个活类，整条规则就逃出该桶**。更严的做法是逐令牌验证（抽出全部类令牌、全仓 grep 非样式表引用）
并做鉴别力自检 —— 最薄的那个令牌应当恰好命中 1 次，以此证明计数不是恒真。战役中正是用这个方法确认两个渠道表已无真死规则。

### 决策：内嵌展开只有一个机制（本轮）

设置页里「点一下、内容就地展开」这个手势曾经有**三个作者**：9 处渠道卡片走 `CollapsibleAccountSection`，
Context enhancement 手搓了一套触发器 + 面板，微信诊断详情直接用原生 `<details>/<summary>` 加两句内联样式。
三者互不相干，所以「展开时长」「箭头旋转」这类改动不可能一次覆盖全部。

收敛后只剩一套词表，声明在 `styles.js` 一处：

| 类 | 角色 |
| --- | --- |
| `dim-collapsible`（+ `is-open` / `data-open`） | 根，状态写在它身上 |
| `dim-collapsibleHead` | 触发器 |
| `dim-collapsibleChevron`（`DisclosureChevron` 是唯一渲染点） | 箭头，旋转是对根类的纯 CSS 反应 |
| `dim-collapsibleBody` / `dim-collapsibleBodyInner` | 内容区与裁剪 |

**没有合并的部分是刻意的**：渠道头部的 `dim-collapsibleHead` 是 `div[role=button]`，
因为头部里**含按钮**，换成真 `<button>` 会嵌套交互元素；
而 Context enhancement 的入口是真 `<button>` 且带 `disabled` 契约。
把后者塞进前者会丢掉禁用语义——那属于「功能丢失」，不允许。因此两者共享根类、箭头与展开时长，
各自保留自己的触发器元素。

**判据的可复跑形式**：`test/client-disclosure-contract.test.mjs`。
第 4 条断言全表 `rotate(90deg)` 恰好 1 处、`--dim-disclosure-duration` 恰好 1 个，
第 5 条全量扫描 `plugin-src/client`，禁止任何 `h('details')` / `h('summary')` 复活。

两次变异均已用哈希证明落地、各自只打中应打的守卫，并已还原：

- `styles.js` `05DB7154` → `B6984E4A`（`rotate(90deg)`→`180deg`）→ 4 pass / 1 fail（第 4 条）→ 还原 `05DB7154`，5/5。
- `collapsible-account.js` `F1F2B6A7` → `E7849E36`（给箭头加内联 `transform`）→ 4 pass / 1 fail（第 1 条）→ 还原 `F1F2B6A7`，5/5。

### 官方词汇表（从 bundle 实测提取，可直接引用）

宿主设置页的样式不是文档，而是打包进
`node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js` 的一条压缩 CSS。
下面这些值是**从那条 CSS 里逐字抄出来的**，不是推断；需要对齐宿主时以此为准，不要再凭截图猜。

| 角色 | 官方声明 |
| --- | --- |
| 行卡片 | `border:.5px solid var(--dsw-alias-border-l4); border-radius:16px; flex-direction:column; gap:12px; padding:12px 14px` |
| 行头 | `align-items:center; gap:10px` |
| 行名 | `color:label-primary; font-size:14px; font-weight:500; line-height:22px` |
| 行尾标签 | `border:.5px solid border-l3; color:label-secondary; border-radius:4px; padding:1px 6px; font-size:11px; line-height:16px` |
| 行操作区 | `align-items:center; gap:4px; margin-left:auto` |
| **图标按钮** | `width:28px; height:28px; color:label-tertiary; background:0 0; border:none; border-radius:6px`；**静止态无底色**，hover 才 `background:interactive-bg-hover` + `color:label-primary`；disabled `opacity:.4`；focus-visible `box-shadow:0 0 0 2px var(--dsw-alias-border-l3)` |
| 内联编辑面板 | `background:var(--dsw-alias-bg-module-platform); border-radius:12px; flex-direction:column; gap:14px; padding:14px 16px` |
| 面板标题 | `color:label-primary; font-size:14px; font-weight:500; line-height:22px` |
| 面板副题 | `color:label-tertiary; font-size:12px; line-height:18px` |
| 字段 | `flex-direction:column; gap:6px` |
| 字段标签 | `color:label-secondary; align-items:center; gap:10px; font-size:12px; font-weight:500; line-height:18px` |
| 高级网格 | `grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:8px; padding:8px 4px 2px` |
| 网格内字段 | `flex-direction:column; gap:4px`；其标签 `color:label-tertiary; font-size:12px; line-height:18px` |
| 提示行 | `color:label-tertiary; margin:0; font-size:12px; line-height:18px` |
| 文字按钮 | `height:28px; color:label-tertiary; background:0 0; border:none; border-radius:14px; padding:0 10px; font-size:12px; line-height:18px` |
| 按钮族 | 基准 `height:36px; border-radius:18px; padding:0 14px; font-size:14px; line-height:22px`；放进行操作区缩为 `height:28px; border-radius:14px; padding:0 10px; font-size:12px` |
| **板块级展开** | 官方用**原生 `details/summary`**：`summary{list-style:none; cursor:pointer; width:fit-content; color:label-secondary; border-radius:6px; padding:2px 4px; gap:6px; font-size:12px; font-weight:500; line-height:18px}` + `summary::-webkit-details-marker{display:none}`，三角用双 border 画：`:before{content:"";border-bottom:1.5px solid;border-right:1.5px solid;width:5px;height:5px;transition:transform .12s;transform:rotate(-45deg) translate(-1px,-1px)}`，`[open]` 时转 `rotate(45deg)` |

两点容易搞反的结论：

1. **官方有两套展开**，不是一套。行级用 `iconButton` + `aria-expanded` 的按钮；板块级用原生 `details/summary`。
   所以「插件用 `details` 就是不对」这个判断本身是错的——错的是**没有皮肤、用内联样式当皮肤**。
2. **图标按钮静止态没有底色。** 插件里凡是给这类按钮常驻底色的写法都是漂移。

### 本轮：行解剖的最后两处漂移

**Task progress display** 原本是 `display:grid; grid-template-columns:minmax(0,1fr)` 的堆叠块：标题在上、全宽 field 皮肤的 select 在中、说明在下，
和其余设置行的左右模板毫无关系。现在它是 `.dim-modelRow`（左 `.dim-rowText`：标题 14/22/400 + 实时状态 + 说明 + 错误；右 `.dim-rowControl` select），
并且 `.dim-feishuGroupControl` **不再声明任何几何**——一个布局只有一个作者。

**Context enhancement 展开态**曾重复它自己的标题，还带着弹窗时代的关闭按钮。现在：标题去掉、说明文字**降级为提示行而不是删除**、
入口变成真开关（收起仍然丢弃草稿，与关闭按钮原行为一致）。来源字段网格改用官方高级网格的数值，列宽不再由最长的那条注解决定。

**幽灵 tooltip 族**（`dim-channelTooltip`、`dim-globalTtlTooltip`、`dim-globalTtlHelp`、`dim-contextHeaderTooltip`、
`dim-contextFieldTooltip`、`dim-contextLegendTooltip`、`dim-accessLegendHelp`、`dim-accessUsersHelp`、`dim-contextFieldHelp`）
共 21 行声明被删除。证据是双向的：静态全仓扫描这 9 个类在 `plugin-src` 里**零 JS 引用**，动态探针在 3 个状态下**零元素**。
其中两条 `position: static` 覆盖唯一的作用就是给这些幽灵重新定位。守卫见 `test/client-row-control-contract.test.mjs` 第 5 条。

### 收口：审计口径的两处纠正与死代码清理

**「79 条 truly dead」这个说法不成立，已作废。** 重跑 `scripts/dead-rule-audit.mjs`（3 次逐字相同）：
DEAD / PARTIAL / uncertain **三个桶全是 0**，脚本里根本没有 "truly dead" 这个词。真实存在的是第四个信息桶
「类的渲染点为零」。所以本轮的工作不是「删被层叠压掉的规则」——那种规则一条都没有——而是**删真正无人渲染的类**。

该桶从 **41 → 5**，删掉 **36 条**（飞书 34 + 微信 2）：连接中的 orbit/connecting 整块、加载骨架整块、
未挂载的 responseMode 整块、以及零散的 note/eyebrow/headingCopy/errorIcon 等。删除前对 11 个类前缀**逐一独立复核**
（非样式 JS 引用数均为 0），并连带清掉两条只被它们使用的 `@keyframes bxf-pulse` / `bxf-shimmer`；
`bxf-rotate`（:276 仍在用）与 `bxf-revealProvision`（:438 仍在用）**必须保留**。

**剩下 5 条是假阳性，永不删。** 它们经 `avatarClass` 之类的 prop 插值真实落到 DOM
（`token-channel.js:97`、`:461` 的 className 模板），无渲染点桶**不看 dirty 标记**才把它们算了进来。

### 收口：诊断展开区的角色

微信诊断展开区的皮肤原本是**三条内联 style**（dl 的 grid、每个 dd 的 margin、降级 textarea 的 width）。
style 属性里的东西无法与表里其余决策一起重构——这正是它一路漂移的原因。现在键/值网格取宿主最近的两个角色
（键=字段标签，值=字段正文），兜底提示、剪贴板提示、只读 textarea 分别取 notice / hint / 字段输入框。
字段清单、剪贴板降级路径、`role=status`、`readOnly`/`aria-label`/`rows` 一字未动。

### 收口：本轮踩到并修掉的两个自伤

1. **浏览器夹具被我改哑了。** `b76883d` 移除原生 `summary` 后，`test/browser/weixin-diagnostics.fixture.js:79`
   仍在 `querySelector('summary').click()`，会抛 TypeError。它不在 `npm test` 的 glob 里，所以 CI 看不见——
   **「不在门禁里」不等于「没坏」**。已改点 `.dim-collapsibleHead`。
2. **我自己写的守卫过宽。** 它曾禁止 `plugin-src/client` 出现任何 `details/summary`，而**宿主自己的板块级展开就是
   原生 `details/summary`**。守卫已收窄为：禁止**用内联样式给原生展开当皮肤**——那才是当初真正的缺陷。

### 收口：实测能力的解锁与它立刻抓到的两处缺陷

本机此前没有可用的浏览器自动化，导致「实测优先于读源码」这条纪律长期只能靠人工。现已确认
**Python 3.12 + Playwright + Chromium 可用**，并写了两个可复用探针（浅/深两主题各跑一遍）。

它第一次跑就打脸了源码阅读，抓到两个只有渲染才看得见的问题：

1. 飞书 select 在改成行控件后**掉回 UA 表单字体 `13.3333px/normal` 与原生下拉箭头**——因为它的 `font: inherit`
   随旧皮肤一起被删、又不在 chevron 选择器组里。现由共享的 `select.dim-rowControl` 一处接住。
2. Model 胶囊的 `color` **取的是 UA 系统色**：浅色纯黑 `#000`、深色纯白 `#fff`，而不是 `label-primary`
   （`#0f1115` / `#f9fafb`）。差得很小，但它是「同一排四个控件里有一个颜色不一样」的真实来源。

修后四控件实测逐项相同：`36px` / 圆角 `18px` / 同底色 / `border 0` / `14px-22px` / `appearance:none`。

### 战役期间固化的六条证据（避免重复推理）

**1. 宿主有两个 12/18 说明角色，不可互换。** `label-secondary` 是**给子块起头的说明**
（`.fieldLabel`、`.modelCatalogTitle`、`.customizedSummary`）；`label-tertiary` 是**提示与路径**
（`.advancedHint`、`.editorRoute`、`.modelFieldLabel`）。战役中一次「把 `.dim-presetHeader` 从 secondary 改 tertiary」
的提案引用了 `.sectionTitle`/`.groupTitle` —— 那是**弹出菜单内部**的标题，不是卡片内子块说明，已撤销；
现有守卫 `client-role-form-contract.test.mjs`「the group caption keeps the native caption role」把它拦下过。

**2. 行标题 ≠ 字段标签（实测）。** 宿主设置行的左侧标题是 `.hVGvvW_title`（General 页 "Language"）= **14/22/400 label-primary**，
我们的 `.dim-modelRowLabel` 正好一致，**不要动**；容易被误引的 `14/22/500` 是 `.rowName`，即 Models 页**卡片行名**，另一角色。
字段包装才对 `.field`+`.fieldLabel` = **12/18/500 label-secondary**。

**3. 宿主内容页没有中间层标题。** 实测 Plugins / General 两页只有页面标题 `h2.heading`（18/600）与导航标题（16/24 500），
页面标题与卡片之间没有别的标题。所以「卡片列表上方的分区标题」没有直接对应物，取**卡内标题**角色
（`.editorTitle`/`.rowName` = 14/22/500 label-primary）。`.sectionTitle`/`.groupTitle` 的 tertiary 12 不适用。

**4. 原生选择器胶囊与 portal 菜单的锚定（实测）。** 宿主自己的四个行选择器是 `button[aria-haspopup=menu]`：
`display:flex; gap:12px; padding:0 14px; height:36px`，内含 chevron svg。其 portal 菜单 `position:fixed`、`z-index:1100`、
**右缘与触发器右缘对齐、下方 4px**、圆角 20、白底、padding 4。原生**字段内枚举**才用真 `select`（`.input`+`.selectInput`）。

**5. `dead-rule-audit.mjs` 的 `.every()` 盲区。** 它的「无渲染点」桶用 `selectors.every(...)` 判定：
选择器里**只要有一个活类，整条规则就逃出该桶**。更严的做法是**逐令牌**验证（抽出所有类令牌、全仓 grep 非样式表引用）
并做鉴别力自检（最薄令牌应恰好命中 1 次，证明计数非恒真）。战役中据此确认两个渠道表已无真死规则。

**5b. 分割线语义别名：评估后**不做**。** 想法是把四种线角色（`l4` 外框 / `l2` 面内 / `l3` 控件 / 虚线占位）
集中成 `--dim-line-*` 别名，35 个调用点改引用。实测表里其实只有**三种拼法**且分布干净
（`l2` 22 处、`l4` 7 处、虚线 `l3` 4 处、孤例 2 处），别名带来的是**文档价值而非一致性价值**；
代价是约 15 条断言钉住了字面拼法（其中多数测试文件需要先读取才能改）。
**结论：收益是注释级的，成本是跨文件的断言改写，本轮不改。** 真正的角色错位（五条面内分隔误用 `l3`）
已在战役中修正；剩下的是命名问题，不足以justify 这次改动。若将来要做，先给三个拼法各加一条注释即可，
不必引入 token。

**6. 变异测试的还原必须用与施加同等唯一的锚点。** 一次变异把 `.dim-contextFooter button` 的尺寸改回 28px，
还原时用的子串在表里匹配到 7 处按钮规则，**还原静默失败、表停在变异态**，直到按哈希核对才发现。
纪律：变异与还原都用整行或唯一选择器作锚点，并在还原后再算一次哈希与 `git diff`。

## Considered Options

- **逐处打补丁**：改动最小，但同一角色会在下一个渠道里再长出一个作者，缺陷反复出现。
- **只做改名（把字面值换成 token 名）而不收敛**：看起来整齐，但「改一处影响所有同类位置」并不成立，问题只是被移走。
- **另起一套插件自己的视觉语言**：宿主没有对应物的元素可以自由发挥，但设置页嵌在宿主界面里，
  两套语言并存会让同一角色出现两种外观；因此只有宿主确实没有对应物的元素才允许自定义，且必须收敛到单一来源。
- **单一归属 + 宿主对齐 + 实测验证**：改动量最大，且需要为「宿主自己也没有唯一答案」的部分留白；
  换来的是每个角色只有一个所有者，可以用一次改动影响所有同类位置。

## Consequences

- 新增任何视觉角色前，先确认宿主是否已有对应 token 或组件角色；有就直接照抄宿主的具体值。
- 新增共享规则时，若渠道表里已有同角色声明，必须从第 3 条的注入顺序推理谁胜，并删掉败方的声明而不是留着。
- 浮层（挂到 `document.body` 的表面）不会继承 `.dim-panel` 作用域的规则，必须单独写。
- 改动表现层后必须重建 `lib/` 产物并在真实实例上实测；源码阅读不作为验证。
- 证据目录（截图、实测日志、逐项账目）不在版本控制内，因此**结论必须回写到仓库**，否则下一任维护者看不到。

### 仍未由证据决定、保留现值并由维护者拍板的取舍

这四项都不是「还没查」，而是**查完了、宿主自己也没有唯一答案**。目前一律**保留插件现值**。

1. ~~**11px 提示文字的行高。** 宿主没有 11px 提示角色……~~ **本条已于战役中作废并拆开处理。**
   原文说「宿主没有 11px 提示角色」——**方向对，但表述过宽，而且被当成了「整档保留」的理由**。实测宿主有两档 11px：
   `11/16`（.rowTag、.cardIdentity）与 `11/17`（.details dt），但它们都是**标签/元信息**角色；
   宿主的**提示**角色是 `12/18`（.advancedHint、.hint）或 `12.5/18`。
   所以一刀切保留和一刀切收敛**都是错的**，处置如下：
   - **提示角色 11 条 → 12/18**：.dim-contextFieldHint、.dim-contextUnavailable、.dim-targetFormHeading p、
     .dim-targetSuggestionHeading p、.dim-accessUsersHeading p、.dim-globalInline、.dim-directoryPickerNotice、
     .dim-targetFeedback、.dim-directoryPathMeta span、.dim-feishuGroupControlStatus、.dim-globalTtlHints span
     （最后一条同时把颜色从 label-secondary 改为宿主提示角色的 label-tertiary）。
   - **标签/元信息角色 9 条保留 11px**：.dim-contextSwitchScope、.dim-targetTitle span、.dim-channelNote、
     .dim-feishuGroupAuthorizationEyebrow、.dim-feishuGroupCountdown、.dim-targetSessionSyncCopy small、
     .dim-feishuGroupQrFallback span、.dim-feishuGroupQrExpired small、.dim-feishuGroupAuthorizationCopy ol。
   - **2 处「?」字形按钮不动**（.dim-presetHelpButton、.dim-contextHelpButton），原判断仍然有效。
2. **20px 区块标题的字重。** 宿主两种说法：字体阶梯给 20px/500，而组件给 15px/600 与 18px/600。
   插件现取值 20/600/28（两者的混合）——即**未采纳宿主阶梯的 500**，保留组件一侧的 600。
3. **飞书二维码兜底块的皮肤。** `.bxf-qrFallback` 比钉钉、微信的同位规则多了 `width/height: 100%`、`border-radius: 8px`、
   `background: #f7f9ff`、`padding: 20px`（另两者只有 `padding: 24px`）。**来源不可考**：仓库是浅克隆，历史查不到，只能问作者。
4. **扫码按钮上那句 `data-kind="primary"`。** 实测零像素影响（rest 与 hover 在两种取值下逐字节相同），已删除（`d34c799`）。
