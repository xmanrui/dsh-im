# Issue #231：客户端面板接入方案

日期：2026-09-19。代码基线：`d766a4f`，dsh-im `4.21.2`。状态：已在 `codex/issue-231-client-panel` 实施并完成自动化检查及真实桌面端/Web 验收，尚未发布；详见[实施与验收记录](Issue-231-客户端面板接入验收.md)。

需求来源：[Issue #231](https://github.com/xmanrui/dsh-im/issues/231)。目标：提供一个小型客户端服务，让宿主复用现有 IM 管理面板；dsh web 默认继续使用「设置 → IM机器人」，不需要新增配置或迁移数据。

## 1. 方案结论

新增客户端服务 `dshImClient`，只包含 `version`、`render()`、`setSettingsVisible()`、`settingsVisible()`。设置页和外部嵌入共用同一个面板构建函数，底层渠道组件、RPC、目录选择器和样式继续复用。

可见性控制直接使用 DSH 的 `slots.inject()` 和它返回的清理函数：显示时订阅槽位并注册，隐藏时取消整个订阅及其当前注册。DSH 已负责槽位晚到、消失和重新声明，不再引入通用状态机、事件总线或注册管理框架。

服务名称选 `dshImClient`，与现有 host 侧 `dshIm.send/listBots/listTargets` 清楚区分；不新增别名。`version: 1` 表示接口协议版本，不是 npm 包版本。

## 2. 现状核对

| 位置 | 已确认的事实 | 设计影响 |
| --- | --- | --- |
| `plugin-src/client/index.js`：`IMSettingsTab` | 已包含标题、版本、更新、渠道导航、通用设置和机器人管理内容 | 整体复用，不拆成宿主可填充的多个区域 |
| 同文件：`apply()` | 统一建立渠道 RPC 和目录选择器，再注册一个 `settings.section` | 把这组依赖供给同一个 builder |
| 同文件：`inject` | 当前依赖 `slots`、`connection`、`locale`、`workspaces` | 保留，不增加桌面端服务依赖 |
| `plugin-src/client/build.mjs` | `react`、`react-dom` 已 external，由宿主模块加载器提供 | 返回普通 React element，不另建 React root 或打包第二套 React |
| `plugin-src/client/interface-language.js` | 界面语言镜像在插件加载时安装，独立于设置页显示 | 隐藏设置入口不会停止语言镜像 |
| DSH 槽位渲染器 | 提供语言变更刷新和槽位错误边界 | 直接嵌入需补齐这两个薄层，不能假设离开槽位后仍自动获得它们 |
| DSH Tauri `definePanel()` | 在 `sidebar.panellist` 注册导航入口，在 `main` 注册面板内容 | 当前诉求是侧栏入口加主内容区面板，不要求把全部内容挤入窄导航栏 |

生命周期语义已核对本机 DSH `0.1.2-rc.1` 发布包及 `0.1.5-rc.2` 源码：`slots.inject()` 返回幂等 disposer，取消等待和当前声明期 effect；槽位重新声明会重新执行回调。`slots.register()` 返回注销函数。此证据用于设计，不等于本次改动已通过这些版本的实测。

## 3. 对外接口与精确语义

```ts
interface DshImClient {
  readonly version: 1;
  render(props?: { preferredSectionId?: string }): React.ReactElement | null;
  setSettingsVisible(visible: boolean): void;
  settingsVisible(): boolean;
}
```

服务以 `ctx.provide('dshImClient', Object.freeze(service))` 发布。这是同一客户端插件运行时中的服务，不是 HTTP API，也不是跨窗口传输协议。宿主通过自身的服务注入机制消费它。

### 3.1 `render()`

- 同步返回一个新的 React element，包含完整面板和本包的局部错误保护；不缓存 element。
- 不挂载 DOM，不改变设置入口的显示状态，不主动安装样式，不在调用本身发起额外请求。现有组件挂载后的数据加载行为保持原样。
- 内部持有现有 RPC、目录选择器和语言服务，宿主不需要重新组装这些依赖；对外只接受明确列出的参数，不开放任意 props 覆盖内部依赖。
- 组件类型在一次插件加载期间保持稳定。父组件重复调用 `render()` 不应让面板反复卸载或重置表单；每次新建的是 element，不是组件定义。
- 参数 `preferredSectionId` 仅指定首次挂载时选中的栏目。合法值使用现有渠道 ID，另加 `global-settings`；省略或无效值回退到 `weixin`，保持当前默认值。
- 已挂载后改变该参数不会抢走用户当前选择。确需重新定位时由宿主显式重新挂载，不新增导航命令或状态同步服务。
- 插件已卸载后的旧服务引用调用 `render()` 返回 `null`。已挂载面板由消费方在服务依赖退出时卸载；提供方不能替宿主管理 React 树。

V1 按每个客户端一个活跃 IM 管理面板接入。需要使用外部入口的宿主应隐藏设置入口，避免同屏重复管理同一组机器人。此次不承诺多个面板同时显示时的状态同步，不扩展现有组件中的固定 DOM ID 为一套多实例系统。

### 3.2 `setSettingsVisible(visible)`

- 默认开启。只有宿主显式传入 `false` 才撤下本包的设置入口；`render()` 不会隐式隐藏它。
- 传入 `false` 时，撤销当前入口，也取消尚未完成的槽位等待。槽位之后出现也不能把入口重新注册回来。
- 传入 `true` 时，恢复正常等待与注册；槽位已就绪则注册，未就绪则等待。
- 同值重复调用无副作用；任何时刻最多一份等待订阅和一份有效入口。
- 接口只接受 boolean，错误类型抛 `TypeError`，不使用字符串真值转换。插件卸载后的调用直接忽略。
- 开关仅存在于当前插件实例的内存里，不写配置文件、localStorage 或 host 状态。桌面端隐藏入口不会影响另一个浏览器中的 dsh web；刷新或重新加载后恢复默认，再由宿主按需接管。
- 隐藏入口不停止机器人、不修改账号数据、不撤销外部已挂载的面板。设置入口恢复后按当前组件生命周期重新挂载，不承诺保留未保存表单。

### 3.3 `settingsVisible()`

返回“当前设置入口是否已成功注册”，不是“设置弹窗是否打开”，也不是“宿主希望显示的值”。

| 当前情况 | 返回值 |
| --- | --- |
| 默认启用且槽位已声明 | `true` |
| 请求显示但仍在等待槽位 | `false` |
| 已隐藏，或槽位当前被撤销 | `false` |
| 插件已卸载 | `false` |

查询方法只读，不额外注册入口或发出事件。

## 4. 最小实现结构

### 4.1 一个 builder，两个入口

在 `apply()` 中保留现有 RPC 和目录选择器的创建方式，把它们整理为一个 `panelDependencies` 对象。新增固定组件 `IMPanel` 和 `buildPanelElement(props)`：

```text
settings.section ──→ buildPanelElement(props) ──→ IMPanel
dshImClient.render ─→ buildPanelElement(props) ──→ IMPanel
                                                  │
                                      语言刷新 + 局部错误边界
                                                  │
                                            IMSettingsTab
                                                  │
                                      现有渠道组件 / RPC / 目录选择
```

设置页注册的组件是调用 builder 的薄包装，入口 ID 仍为 `xmanrui-dsh-im`、顺序仍为 `21`、标签仍为双语「IM机器人」。RPC 依赖统一由 builder 注入，避免外部嵌入路径漏接更新、投递、通用设置或目录选择能力。

原来的 `IMSettingsTab` 继续导出，现有直接测试和渠道组件不需要整体重写；只为它增加 `preferredSectionId` 的初始选择处理。

### 4.2 入口开关复用 DSH 生命周期

使用一个私有小函数管理本包唯一的设置入口，放在 `index.js` 即可。只需保留以下闭包变量：

- 当前 `slots.inject()` 的 disposer；存在即表示已启用注册或等待。
- 当前入口是否实际注册，用于查询。
- 本次插件实例是否已销毁，用于阻止旧引用再次注册。

显示流程：尚未启用时调用一次 `ctx.slots.inject('settings.section', callback)`；callback 注册入口并记录实际状态，返回清理函数。该清理函数先清除实际状态，再调用 `slots.register()` 的 disposer。

隐藏流程：先清空持有的 injection disposer，再调用它。由 DSH 一并取消等待、回调 effect 和入口注册。再次隐藏为空操作；再次显示创建一个新的订阅。

槽位撤下后，声明期清理函数将实际状态置为 false；如果仍启用，DSH 在槽位恢复时重新运行 callback。无需自己监听槽位事件，也无需轮询可用性。

初始化顺序固定为：准备 builder 和开关 → 启用默认设置入口 → 发布可选服务。发布之后不再无条件恢复默认值，避免覆盖消费方接到服务后立即发出的隐藏要求。

把接入初始化放在一个 `ctx.effect()` 中，返回显式清理函数。清理时先标记销毁，再取消当前 injection、清除实际状态；服务注册自身继续由 Cordis effect 清理。后来通过开关建立的 injection 也必须使用捕获的本插件 `ctx`，并由同一个清理函数持有其最新 disposer。

不把缺失的 disposer 替换成空函数并宣称隐藏成功。已核对的 DSH 版本有真实 disposer；其他非标准宿主须满足该现有槽位契约。测试替身也应模拟真正的清理语义。

### 4.3 嵌入所需的两项保护

`IMPanel` 在挂载期间订阅已有 `locale/change`，语言变化时重新渲染，卸载时解除订阅。继续使用现有翻译函数和词典；不要通过更改 React key 刷新语言，以免丢失表单状态。缺少事件订阅能力的旧环境保留初次渲染能力，不要求增加服务依赖。

新增一个很小的 `IMPanelErrorBoundary`，共享于两个入口。正常情况下不增加可见布局；发生 React 渲染错误时只显示「IM 面板加载失败」及「重试」按钮，重试重新挂载其子树。错误提示提供中英文。现有业务请求失败仍走各渠道自己的提示，错误边界不承担网络重试、遥测或日志导出。

插件级样式、语言镜像、会话渠道图标仍按现有方式在 `apply()` 安装一次。它们不归设置入口开关管理，也不在每次 `render()` 时重复安装。

## 5. dsh web 兼容要求

以下是发布验收条件，不能只依靠代码看起来兼容：

1. 没有消费方时，web 仍注册且只注册一个原有设置入口；原顺序、标签、默认微信栏目和主要界面不变。
2. 用 `typeof ctx.provide === 'function'` 检查可选能力。缺少该能力时跳过服务发布，默认设置页仍正常可用；不把 `provide` 添加到必须满足的依赖清单。
3. 保留现有 `inject` 数组和 `package.json` 的 web 平台声明、加载依赖；不导入 `dsh-tauri`，不注册 `sidebar.panellist` 或 `main`。
4. 不新增服务端能力，不修改任何渠道配置、消息链路、权限逻辑、已有 HTTP/RPC 协议和兼容版本声明。
5. 两个入口继续使用同一套管理 RPC，包括 loopback 恢复提示、更新查询、全局设置以及 `uiWorkspace`/旧 `workspaces` 的目录选择兼容逻辑。
6. 默认不修改现有布局 CSS。宿主负责容器的高度、留白与滚动；如果后续明确要求窄栏承载，需要单独验证容器宽度适配，不能将目前依赖视口宽度的布局误当成任意容器自适应。

`ctx.provide` 存在但服务重名等真实装配错误不应被宽泛 catch 静默吞掉。兼容分支仅针对缺失的可选能力，避免掩盖接入问题。

## 6. 宿主接入约定

桌面端在依赖 `dshImClient` 的生命周期中完成以下动作：

1. 校验 `version === 1` 和接口可用；旧版 dsh-im 没有该服务时，不激活这个集成模块，继续保留原设置入口。
2. 用自身的 `definePanel()` 注册侧栏入口与内容，面板 render 调用 `im.render()`。容器结构和图标由桌面端决定。
3. 确认入口与内容注册可用后，显式调用 `im.setSettingsVisible(false)`。`definePanel()` 可能只是建立了等待订阅，拿到 handle 不等于用户已经有可达入口，不能因此提前隐藏设置页。
4. 集成模块退出或侧栏入口不可用时，恢复设置入口，并注销自己的面板。消费方的依赖清理同时卸载内容，停止组件现有轮询。

只画示意调用，不把它当作可以直接复制的完整桌面端插件：

```js
const panel = definePanel(ctx, {
  id: 'dsh-im',
  label: 'IM机器人',
  icon: ImIcon,
  render: () => im.render(),
});

// 宿主确认对应入口和内容已就绪后：
im.setSettingsVisible(false);

// 集成退出时执行，绑定到宿主自己的 effect 清理：
const cleanup = () => {
  im.setSettingsVisible(true);
  panel.dispose();
};
```

面板切换出去时是否保持挂载由宿主决定。卸载后再打开会重新读取状态；不新增 keep-alive、跨入口共享 React 状态或窗口间同步机制。

## 7. 改动清单

| 文件 | 改动 |
| --- | --- |
| `plugin-src/client/index.js` | 共享 builder、固定面板包装、初始栏目参数、入口生命周期开关、可选服务发布 |
| `plugin-src/client/panel-error-boundary.js`（新增） | 简单局部错误提示与重试 |
| `plugin-src/client/i18n.js` | 错误提示和重试文案，复用现有翻译机制 |
| `test/client-ui.test.mjs` | 把“注册的组件必须等于 IMSettingsTab”改为验证渲染行为及依赖接线；保留原 web 断言 |
| `test/client-service.test.mjs`（新增） | 服务契约、注册时序、销毁、共享面板和语言刷新测试 |
| `docs/client-integration.md`（新增）、中英文 README | 对外接口、默认行为、生命周期义务和接入示例；README 添加简短入口 |
| `lib/client.js` | 通过现有构建生成，不手工编辑 |

不增加运行时依赖、公共控制器类、额外配置项或新的构建流程。host 源码不在本次功能改动范围内。

## 8. 验证与验收

### 自动化验证

测试应验证对外行为和实际有效注册数量，不只断言几个内部布尔值。生命周期替身需覆盖延迟声明、回调 disposer、取消等待和重新声明，并补一个基于真实 Cordis context 的卸载检查。

| 场景 | 必须得到的结果 |
| --- | --- |
| 默认启动，支持/不支持 `provide` | web 都只有一个设置入口，内容、标签和依赖可用；后者只缺少新服务 |
| 槽位未声明时隐藏，再声明 | 有效注册始终为零，无延迟复活 |
| 已注册后隐藏、显示及同值重复调用 | 有效注册数量为 1 → 0 → 1；重复调用不叠加、不反复卸载 |
| 显示期间槽位撤下再恢复 | 查询随实际状态变为 false/true，只恢复一份入口 |
| 等待中或已注册时卸载插件 | 注册、订阅和服务全部清理；旧服务引用无法复活入口，render 返回 null |
| 提供服务时消费方立即隐藏 | 初始化后仍隐藏，不被默认注册步骤覆盖 |
| 调用 render 本身 | 新 element、无挂载请求、不修改设置可见性 |
| 父组件重渲染、用户已切换栏目 | 保留面板状态，不因新 element 重置 |
| 有效/无效 preferredSectionId | 初次选择正确，无效值和默认值均落到微信 |
| 设置页与外部容器渲染 | 使用同一面板；更新、全局设置、渠道 RPC 和目录选择器均接通 |
| 隐藏设置入口后挂载外部面板 | 外部管理功能与语言镜像仍可用 |
| 两个独立客户端实例 | 一端隐藏不会更改另一端可见性 |
| 中英文切换、组件卸载 | 已挂载面板及时翻译，卸载后无遗留语言订阅 |
| 人为触发子组件渲染错误 | 仅本面板显示错误提示；重试可恢复健康子树 |

实施时先运行相关 client、语言镜像、loopback 和目录选择测试，再运行仓库标准 `npm run check`（构建、全量现有测试和包验证）。执行结果见实施与验收记录。

### 实际界面验收

- 原版 dsh web：打开设置，确认入口位置与原来一致；切换所有渠道和通用设置，抽查机器人列表、目录选择、更新弹窗、中英文和断线提示。
- 对照已有支持版本选择一个旧版和实际目标新版进行上述回归；测试记录注明版本，未验证的版本不宣称新增支持。
- 客户端嵌入：在真实 DSH 客户端中用一个测试消费插件挂载服务面板，验证隐藏/恢复设置入口、关闭/重开以及禁用/重新启用插件。
- 双客户端：浏览器与桌面端连接同一个 host，确认桌面隐藏入口后浏览器设置入口仍存在。
- DSH Tauri 最终接入验收由桌面端配合完成；dsh-im 提供接口的 PR 完成不等于桌面端已发布入口。

## 9. 实施顺序与回退

一次小 PR 完成：先收拢共享面板并验证原设置页，再增加局部错误保护、语言刷新和初始栏目参数，最后接入可见性开关及服务发布，补齐行为测试与接入文档。

先合并接口能力，桌面端随后接入。仅安装新版 dsh-im 的 web 用户无需操作。集成失败时桌面端先恢复设置入口并退出集成；包级回退使用旧版 dsh-im 即可，不存在数据格式迁移。旧版缺少新服务时消费方必须能不启用这一集成。

## 10. 参考依据

- [本需求 Issue #231](https://github.com/xmanrui/dsh-im/issues/231)。
- [dsh-market PR #633：共享面板 builder 与 render 服务](https://github.com/dsh-market/dsh-market/pull/633)。参考其接口方向，不复制其独立 section gate 或市场业务逻辑。
- [DSH Tauri definePanel 实现，固定版本](https://github.com/dsh-tauri/deepseek-harness-desktop/blob/6282d270774cabc9df178813a802de35e6d96797/packages/dsh-tauri/src/client/panel/index.ts)。
- 本地核对：DSH `0.1.5-rc.2` 的 `packages/client/ui-renderer/src/client/registry.ts`（注入生命周期）、`scoped-slots.tsx`（语言刷新与错误边界），以及 `0.1.2-rc.1` 对应发布包。
