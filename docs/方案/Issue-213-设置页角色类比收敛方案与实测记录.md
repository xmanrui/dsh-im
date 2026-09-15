# Issue 213 · 设置页角色类比收敛方案与实测记录

对应上游 issue：[#213 UI 优化：界面内容/文字/容器过于拥挤，可读性下降](https://github.com/xmanrui/dsh-im/issues/213)

## 1. 判据

这一轮不按「看起来挤不挤」改，按一条可检验的判据：

> **对每一个待收敛元素，在宿主里找最近的「类似职位/层级」，采用它的值。**
> 宿主确有类似角色 → 按其值收敛，并附宿主文件:行 或实测值作证据。
> 全宿主确无类似角色 → 不自创，收敛到原生令牌或宿主习语，记为「习语收敛」。

「改一处是否影响所有同类位置」是分族的依据：达不到这条的，属于改名，不计入完成。

## 2. 宿主词汇表（从打包产物逐字抄录）

宿主设置页的样式不是文档，而是打包进
`node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-*\lib\client.js`
的压缩 CSS。下列值是从那些 bundle 里**逐字抄出来**的，改动前应先核对是否仍然一致。

### 2.1 行与字段

| 角色 | 宿主声明 | 出处 |
| --- | --- | --- |
| 设置行标题 | `14px/22px 400`，`label-primary` | General 页 `.title`（实测 "Language"） |
| 行卡片 | `border:.5px solid border-l4; border-radius:16px; gap:12px; padding:12px 14px` | models `.rowCard` |
| 行名（卡片内） | `14px; 500; line-height:22px; label-primary` | models `.rowName` |
| 行尾标签 | `border:.5px solid border-l3; border-radius:4px; padding:1px 6px; 11px/16px` | models `.rowTag` |
| 字段 | `flex-direction:column; gap:6px` | models `.field` |
| 字段标签 | `12px/18px 500`，`label-secondary` | models `.fieldLabel` |
| 提示 | `12px/18px`，`label-tertiary` | models `.advancedHint`；plugin-inventory `.hint` |

**两个 12/18 说明角色不可互换**：`label-secondary` 是给子块起头的说明
（`.fieldLabel`、`.modelCatalogTitle`、`.customizedSummary`）；`label-tertiary` 是提示与路径
（`.advancedHint`、`.editorRoute`、`.modelFieldLabel`）。

### 2.2 选择器与菜单（实测于 3080）

宿主设置页**没有**行级 `<select>`：General 页四个选择器（Full access / English / Compact / Queue）
全是 `button[aria-haspopup=menu]`，实测 `display:flex; gap:12px; padding:0 14px; height:36px`，内含 chevron svg。

其 portal 菜单实测：`position:fixed`、`z-index:1100`、**右缘与触发器右缘对齐**、在触发器下方 **4px**、
圆角 20、白底、`padding:4px`、0.5px 发丝线 + 极淡阴影。

**字段内的枚举才是真 `<select>`**：官方 models bundle:1300-1305 / :1680-1685 / :2093-2098 渲染
`div.field > span.fieldLabel + select.input.selectInput`。

```css
.input{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);width:100%;height:32px;
  font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  border-radius:8px;padding:0 10px;font-size:14px;line-height:22px}
select.input{cursor:pointer;max-width:240px}
.input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
.input:disabled{opacity:.6;cursor:default}
.selectInput{appearance:none;background-image:url("…12px chevron…");
  background-position:right 12px center;background-repeat:no-repeat;background-size:12px 12px}
```

### 2.3 标题、标签栏、分割线

| 角色 | 宿主值 | 出处 |
| --- | --- | --- |
| 页面标题 | `18px/… 600` | plugins `.heading` |
| 卡内标题 | `14/22 500 label-primary` | models `.editorTitle`、`.rowName` |
| 菜单内分区标题 | `12/18 500 label-tertiary` | input-trigger `.sectionTitle` |
| 菜单内分组标题 | `12/16 400 label-tertiary` | input-trigger `.groupTitle` |
| 标签栏 | `border-bottom:.5px solid border-l2; align-items:flex-end; gap:22px; margin-top:2px` | plugins `.tabs` |
| 标签 | `padding:7px 1px 9px; 13px/20px; label-tertiary`，**无 min-height** | plugins `.tab` |
| 标签指示条 | `height:2px; border-radius:2px 2px 0 0; label-primary`，**无动画** | plugins `.tab[data-active=true]:after` |
| 展开触发器 | `gap:6px; padding:2px 4px; border-radius:6px; 12px/18px 500 label-secondary` | models `.customizedSummary` |

**分割线是位置角色，不是装饰**：`l4` 表面外框 / `l2` 同一表面内的块间线 / `l3` 控件外框与标签 /
`l3` 虚线 空缺占位。

## 3. 逐族收敛

| 族 | 改了什么 | 判据依据 |
| --- | --- | --- |
| 行级 vs 字段级选择器 | 4 个行级 `<select>` → `button` + portal 菜单（新建 `row-selector.js`）；5 个字段级保留，套官方 `.input`/`.selectInput` | §2.2 |
| 三条标签栏 | Context enhancement / General / 更多机器人设置 合并到同一份宿主 `.tabs`/`.tab` 值 | §2.3 |
| 行文字 | `cursor: text` 落在**文字叶子**（不是整行），`user-select: text`；卡片头解除 `user-select: none` | 宿主行文本是纯文本，只声明在文字上 |
| Context 面板内部 | 页脚按钮改宿主表单动作尺寸 `36/r18/0 14`；两个 textarea 统一 chrome；删恒空的 grid 轨 | models `.editorActions` 按钮族 |
| 残余桶 | `.dim-channel` 取 `.navCell`；`.dim-targetRow`/`.dim-accessUserRow` 取 `.editor`；`.dim-botList` 取 `.cards`；`.dim-listSection` 取 `.section`；对话框圆角 24→32；z 阶 35→40 并新增 1100 给 portal 菜单 | 见 §2 与实测 |
| 控件内部布局 | 胶囊的 `display/align-items/gap` 从 `.dim-modelSelector` 移到元素无关的 `.dim-rowControl` | §2.2 的 `flex/gap 12` |
| 卡片工具条 | `.dim-botCardTop` `flex-start` → `center` | 宿主 `.rowHead` 是 `center` |
| 五条面内分隔 | `border-l3` → `border-l2` | §2.3 分割线角色 |
| 行标题 vs 字段标签 | 行标题**不动**（14/22/400）；三个字段包装 13/20/500 → **12/18/500 secondary** | §2.1 |
| 11px 一档 | 按角色拆开：11 条提示 → 12/18；9 条标签保留 11px 并把行高统一到宿主的 16 | §2.1 + ADR-0002 |
| 标题层级 | `.dim-listHeading h3` 由 tertiary 400 → **primary 500** | §2.3 卡内标题 |
| 代码卫生 | 拆开跨两级类名（新增 `.dim-blockTitle`）；新增 `--dim-line-11` 收敛 8 条字面量 | — |

### 3.1 核对后确认**不需要改**的（有效的否定结论）

收敛不等于「每个表面都要动」。以下几处经取证后判定保持原样，理由一并记录，避免后人重复排查：

| 表面 | 结论 | 依据 |
| --- | --- | --- |
| `role=listbox` | **角色选对了，不改 ARIA** | 宿主确实有 `role=listbox`，但那是 input-trigger 的**建议输入**表面（`.viewport` 只是滚动区，外层 `.menu` 才是卡片）；宿主设置页自己的行选择器实测是 `button[aria-haspopup=menu]`，与我们的 `menu`/`menuitemradio` 同族 |
| `.dim-rail` 的容器布局 | **保持横向换行** | 它按标记是 tablist，但按角色是宿主的 `.navCell` 单元格所在的那条**横向渠道条**（原代码已在用 `--dsw-specific-sidebar-nav-item-active`）；有对标值的是单元格，不是容器 |
| `.dim-presetHeader` 用 secondary | **维持**（撤销过一次误改） | 宿主两个 12/18 说明角色不可互换：`secondary` 是**子块说明**（`.fieldLabel`/`.modelCatalogTitle`），`tertiary` 是**提示与路径**。该提案引用的 `.sectionTitle` 是弹出菜单内部标题，类比例子选错 |
| `.dim-updateStatus` 之外的分隔线 | 已全部核对 | 表里只剩三种拼法且分布干净（`l2` 22 / `l4` 7 / 虚线 4） |
| 面向用户的指南 | **不需要改** | `上下文增强.md`/`context-enhancement.md`/`访问模式.md` 只写语义（开关、字段、提示词、原子保存、草稿规则），**一处也没描述弹窗形态** |
| `PROACTIVE_DELIVERY.md` 的「下拉框」 | **不需要改** | 它指投递目标的两个**字段级** `<select>`（`.dim-targetField` / `.dim-targetSuggestionField`），正是按宿主角色**保留未换**的那两个 |

## 4. 实测与守卫

### 4.1 门禁与 CI

每次改动后跑 14 个测试文件（**199 例**），并重建 `lib/` 产物、复制到运行副本后核对哈希一致。最终 **199/199 通过**。

其中 **5 个契约测试共 32 例**：`client-row-control-contract`（9）、`client-role-form-contract`（10）、`client-disclosure-contract`（6）、`client-native-border-contract`（5）、`client-toolbar-role-contract`（2）。

CI 跑的是全量 `npm run check`（构建 + `test/*.test.mjs` + `test/channels/*/*.test.mjs` + `scripts/verify-package.mjs`）。**本机 Windows 下全量有 87 条既有失败，全部落在服务端/Host 测试文件**（`update-service` 11、`host-harness-connection` 10、`inbound-file` 4、`stores` 3、`workspace` 3 等），形态是 Windows 特有（`C:\...` 路径正则、`mode 0600` 权限位、ENOENT 拒绝），**CI 上一条都不出现**。改样式前先确认**失败集合**没有变化，不要只看数字。

### 4.2 变异测试（每例先用哈希确认文件真被改动，跑完再还原并复核哈希）

| 变异 | 哈希 | 结果 |
| --- | --- | --- |
| 行文字 `cursor: text` → `auto` | `FF7C6052 → 8D3F4922` | 6 pass / **1 fail** |
| 面板页脚按钮 `36px` → `28px` | `FF7C6052 → D7BA1E28` | 48 pass / **1 fail** |
| 标签栏 `align-items: flex-end` → `center` | `FF7C6052 → 80C86F25` | 48 pass / **1 fail** |
| 标签 `padding: 7px 1px 9px` → `6px 2px 8px` | `FF7C6052 → B20CE94C` | 48 pass / **1 fail** |
| 共享箭头旋转 `rotate(90deg)` → `180deg` | `05DB7154 → B6984E4A` | 4 pass / **1 fail** |
| 给箭头加内联 `transform` | `F1F2B6A7 → E7849E36` | 4 pass / **1 fail** |
| 行容器自声明几何 | `A0EC7348 → 925C922A` | 4 pass / **1 fail** |
| 诊断键角色去掉颜色 | `7B26989D → 0BE44710` | 5 pass / **1 fail** |

**教训（已写入 ADR）**：变异的**还原**必须用与施加同等唯一的锚点。一次还原因子串在表里匹配到 7 处按钮规则而
静默失败，表停在被变异的状态，直到按哈希核对才发现。

### 4.3 浅深两主题实测（每族 2 代表）

| 族 | 浅色 | 深色 |
| --- | --- | --- |
| 行控件 | `36px` / 圆角 `18` / `rgb(245,246,247)` / `flex` `gap 12` | `36px` / 圆角 `18` / `rgb(53,54,56)` / `flex` `gap 12` |
| 行文字 | 文字上 `text`，文字右侧槽内 `auto` | 同 |
| 提示档 | `12px/18px` `rgb(129,133,140)` | `12px/18px` `rgb(173,178,184)` |
| 标签档（保留） | `11px/16px` | `11px/16px` |
| 卡内标题 | `14px/22px 500` `rgb(15,17,21)` | `14px/22px 500` `rgb(249,250,251)` |
| 卡片工具条 | 上 6px / 下 6px（居中） | 同 |
| portal 菜单 | `fixed` / `z 1100` / `gap 4` / `rightDelta 0` / 白底 | 同几何，底色 `rgb(53,54,56)` |
| 诊断 textarea（剪贴板降级路径） | `704×144`，白底深字 | `704×144`，`rgb(35,35,36)` 底浅字 |

## 5. 自行裁决与放弃项

| 项 | 裁决 | 理由 |
| --- | --- | --- |
| 行级 select 换、字段级留 | 分治 | 宿主行选择器是 button+menu，字段内枚举确实是 `<select>`（§2.2） |
| 字段 select 右内边距 28px 而非官方 10px | 有意偏离 | 官方 10px 会让长选项文字压到箭头下；仅此一处，已注释 |
| 标签指示条删掉 `scaleX(.45)` 动画 | 采纳宿主 | 宿主 `.tab:after` 无任何 transform/transition |
| 卡片头解除 `user-select: none` | 采纳宿主 | 宿主 `summary` 不设该属性 |
| 开关 OFF 轨道保留 `border-l3` | 习语收敛 | 宿主开关是共享组件，CSS 不在任何 settings bundle，**无可对标值，改动即自创** |
| `.dim-presetHeader` 由 tertiary 改回 secondary | 撤销一次误改 | 宿主两个 12/18 说明角色不同（§2.1）；提案引用的 `.sectionTitle` 是弹出菜单内部标题 |
| `.dim-listHeading h3` 由 tertiary 改回 primary | 采纳卡内标题角色 | 实测宿主内容页**无中间层标题**（§2.3） |
| 行标题不加粗到 500 | 保留 400 | 实测宿主设置行标题 `.hVGvvW_title` = 14/22/**400** |
| 分割线语义别名 | **评估后不做** | 表里只有三种拼法且分布干净（l2 22 处 / l4 7 处 / 虚线 4 处），别名买的是文档价值；代价是约 15 条跨文件断言改写。角色错位已修正，剩下的是命名 |
| 段落 `max-width: 760px` | 未采纳 | 宿主 `.section` 的上限；我们的面板本身已窄（实测内容宽 486–514px） |
| 菜单「卡片 + 内层滚动区」拆分 | 未采纳 | 结构改动；padding 随内容滚动的差异在本机实测中不可见 |

## 6. 未决项

无。上表各项均已裁决并说明理由。宿主无对应物的开关令牌按「习语收敛」处理，不需要人定。
