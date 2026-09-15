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

三个契约测试共 13 例，逐一用变异测试验证过有牙（把缺陷放回去会变红）：

- `test/client-native-border-contract.test.mjs`——中性 token 边框与实心分隔线画在原生 0.5px hairline；
  高程阴影不配中性边框；账户 chevron 用内置的原生字形；**token 层声明在 `body` 上**（把声明移回 `:root` 会变红）。
- `test/client-role-form-contract.test.mjs`——设置行标签用原生行标题角色、组标题用原生 caption 角色、
  以 footer 结尾的卡片有底部内边距、禁用选择器保留表面只压暗文字、弹窗滚正文不滚自身 chrome、placeholder 用原生 placeholder token。
- `test/client-toolbar-role-contract.test.mjs`——标题栏的两个按钮共用一份 padding，且没有别的规则给它们单独的内联 padding。

改样式后至少跑这一条门禁（174 例）：

```sh
node --test test/client-native-border-contract.test.mjs test/client-role-form-contract.test.mjs \
  test/client-toolbar-role-contract.test.mjs test/client-ui.test.mjs \
  test/context-enhancement-ui.test.mjs test/client-delivery-settings.test.mjs \
  test/model-setting-ui.test.mjs test/workspace-editor.test.mjs test/bot-alias-ui.test.mjs \
  test/channels/dingtalk/client-ui.test.mjs test/channels/telegram/client-ui.test.mjs
```

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

1. **11px 提示文字的行高。** 宿主没有 11px 提示角色（最小的正文档是 12/18），所以插件是**未采纳宿主**、自建 11px 档，
   行高沿用插件自己实测的分布：17px 12 处、16px 8 处、无单位 1.45–1.55 共 4 处、18px 1 处；
   另有 3 处 `line-height: 1` 属于「?」字形按钮，不属这一族，**不要动**。宿主既无该档，强行统一只会在没人要求的情况下改动 13 条规则的渲染。
2. **20px 区块标题的字重。** 宿主两种说法：字体阶梯给 20px/500，而组件给 15px/600 与 18px/600。
   插件现取值 20/600/28（两者的混合）——即**未采纳宿主阶梯的 500**，保留组件一侧的 600。
3. **飞书二维码兜底块的皮肤。** `.bxf-qrFallback` 比钉钉、微信的同位规则多了 `width/height: 100%`、`border-radius: 8px`、
   `background: #f7f9ff`、`padding: 20px`（另两者只有 `padding: 24px`）。**来源不可考**：仓库是浅克隆，历史查不到，只能问作者。
4. **扫码按钮上那句 `data-kind="primary"`。** 实测零像素影响（rest 与 hover 在两种取值下逐字节相同），已删除（`d34c799`）。
