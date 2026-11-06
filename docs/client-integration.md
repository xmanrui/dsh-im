# 客户端面板接入 / Client panel integration

dsh-im 发布可选客户端服务 `dshImClient`，供同一 DSH 客户端中的宿主插件嵌入完整 IM 管理面板。默认仍保留「设置 → IM机器人」；安装新版无需迁移数据或新增配置。host 侧的 `dshIm` 主动投递服务保持独立。

The optional `dshImClient` service exposes the existing IM management panel to a shell in the same DSH client. Settings → IM bots remains available by default. No migration or new configuration is required. The host-side `dshIm` delivery service is separate.

支持插件详情操作按钮的 DSH 中，dsh-im 详情页提供「打开 IM机器人」按钮，在主区域打开同一管理面板。面板不显示返回按钮，通过宿主侧边栏切换面板。此入口依赖可选的 `layout` 服务及 `plugins.detail.actions` 槽位，旧版 DSH 仍可通过设置入口访问。

On DSH versions with plugin detail actions, **Open IM bots** opens the same management panel in the main area. The panel has no back button; use the host sidebar to switch panels. This entry uses the optional `layout` service and the `plugins.detail.actions` slot. Older DSH versions retain the Settings entry.

「IM机器人」页面右上角的「会话记录」按钮与「通用设置」并列，打开各 IM 通道已绑定会话的只读列表；点击 Session ID 可查看用户与助手正文、刷新或加载更早消息。列表和正文页均提供「返回 IM机器人」。会话记录不注册独立侧边栏入口；只有宿主提供导航服务与主面板槽位时才显示按钮。目录覆盖标准机器人状态路径、微信账号状态和已配置的飞书旧版状态，不推断自定义 `dataDir` / `botsDir`。

**Session history**, next to **General settings** in the IM bots toolbar, opens a read-only list of bound IM sessions. Select a Session ID to read user and assistant text, refresh, or load earlier messages. Both the list and transcript provide **Back to IM bots**. History has no separate sidebar entry, and the toolbar action appears only when the host provides navigation and a main-panel slot. Discovery covers standard bot state, Weixin accounts, and configured Feishu legacy state; custom `dataDir` / `botsDir` overrides are not inferred.

支持 `sidebar.panellist` 的宿主同时提供左侧「IM机器人」入口，与插件详情操作共用同一个 `main` 面板。侧栏沿用插件页的双对话框造型，在 16×16 矢量画布上使用与宿主普通图标一致的 1px 描边，通过 `currentColor` 跟随侧栏颜色和传入尺寸；插件页仍使用原彩色图标。此入口不调用 `setSettingsVisible()`，设置入口和插件详情操作均保留。侧栏槽位消失时只移除侧栏入口，主面板或依赖服务退出时清理全部对应注册。

Hosts with `sidebar.panellist` also show **IM bots** in the left sidebar, targeting the same `main` panel as the detail action. The sidebar retains the catalog's linked speech bubbles as a 16×16 vector with the host's regular 1px stroke, using `currentColor` and the requested icon size; the catalog keeps its original color image. This entry does not call `setSettingsVisible()`: both existing entry points remain available. Sidebar withdrawal removes only its entry, while main-slot or navigation-service withdrawal cleans up all related registrations.

「IM机器人 → 通用设置 → 通用 → 侧边栏入口」可选择「自动隐藏」「始终显示」或「始终隐藏」。默认自动隐藏：没有已保存的渠道时显示，至少一个渠道保存成功后隐藏，删除全部渠道后恢复。离线渠道仍算已配置，扫码过程不算；隐藏不会停止机器人或关闭已打开的面板。设置保存在 DSH home 下的 `integrations/dsh-im/sidebar-settings.json`，通过独立的 `/api/dsh-im/dsh-im-sidebar` 管理接口读写，遵循与渠道管理相同的 `rpcAuthority`（默认 `trusted-host`），支持 DSH 已认证并通过 Host/Origin 校验的局域网与域名访问；TTL 等通用设置仍仅限本机。选择后自动保存并立即更新当前客户端，无需点击保存按钮；其他客户端在下一次管理操作或最多约 30 秒后同步。启动时先隐藏，收到 Host 确认零渠道配置或「始终显示」后才注册侧边栏入口，避免先显示再隐藏造成布局闪动。读取失败时保留上次确认的状态，初始保持隐藏；设置和插件详情入口始终独立可用。读取失败时仍可选择并保存「始终显示／始终隐藏」，恢复入口；自动模式仍须成功读取渠道配置。

**IM bots → General settings → General → Sidebar entry** offers Auto-hide, Always show, and Always hide. Auto-hide shows the entry with no saved channels, hides it after at least one channel is saved, and restores it when all channels are removed. Offline channels still count; pending QR logins do not. Hiding neither stops bots nor closes an open panel. The preference is stored in `integrations/dsh-im/sidebar-settings.json` under the DSH home and uses the dedicated `/api/dsh-im/dsh-im-sidebar` route. It follows channel management `rpcAuthority` (default `trusted-host`), allowing LAN and domain access already authenticated and admitted by DSH Host/Origin checks. General settings such as TTL remain loopback-only. Selecting a mode saves it automatically and updates this client immediately, without a Save button; other clients refresh after management operations or within about 30 seconds. Startup keeps the entry hidden until the Host confirms zero saved channels or Always show, avoiding a temporary row that shifts the sidebar. Failed reads retain the last confirmed visibility, initially hidden; Settings and plugin details remain independently available. Failed reads still allow saving Always show / Always hide to recover the entry; Auto-hide still requires a successful channel configuration read.

```ts
interface DshImClient {
  readonly version: 1;
  render(props?: { preferredSectionId?: string }): React.ReactElement | null;
  setSettingsVisible(visible: boolean): void;
  settingsVisible(): boolean;
}
```

## 接口语义 / Contract

| 接口 | 中文 | English |
| --- | --- | --- |
| `version` | 接口版本，当前为 `1`，不是软件版本 | Interface version, currently `1`; not the package version |
| `render(props?)` | 每次返回新 element；不挂载 DOM、不隐藏设置入口。完整面板包含现有功能、语言刷新与局部错误保护 | Returns a fresh element without mounting DOM or hiding settings. Includes existing functionality, locale updates and a local error boundary |
| `setSettingsVisible(visible)` | 只接受 boolean，重复调用无副作用。false 撤销入口及等待中的注册，true 恢复 | Accepts only booleans; repeated calls are idempotent. False removes both the entry and any pending registration; true restores them |
| `settingsVisible()` | 返回入口当前是否已注册，不表示设置弹窗是否打开。等待槽位、已隐藏或已卸载时为 false | Reports whether the entry is currently registered, not whether the settings dialog is open. False while waiting, hidden or disposed |

`preferredSectionId` 只决定首次挂载的栏目，支持 `weixin`、`feishu`、`dingtalk`、`wecom`、`wecomApp`、`qq`、`slack`、`telegram`、`discord`、`whatsapp`、`imessage`、`office` 和 `global-settings`。省略或无效值回退到微信。已挂载后改变该值不会覆盖用户选择；需要重新定位时由宿主重新挂载。

`preferredSectionId` selects the initial section using the IDs above. Missing or unknown IDs default to WeChat. Changing the prop after mounting does not override the reader's selection; remount deliberately to reset it.

`setSettingsVisible()` 只影响当前客户端内存，不写服务器配置或浏览器存储。因此桌面端隐藏设置入口不影响另一个浏览器。刷新后恢复默认，由宿主再次按需接管。隐藏入口不会停止机器人或外部已挂载的面板。V1 按一个活跃管理面板接入，不提供多个面板间的状态同步。此 API 与上方持久化的侧边栏入口设置独立。

`setSettingsVisible()` is local to this client instance and is never persisted. A desktop shell cannot hide Settings in another browser. Reload restores the default until the shell opts in again. Hiding settings does not stop bots or unmount an embedded panel. V1 targets one active management panel and does not synchronize multiple copies. This API is independent of the persisted sidebar preference above.

## 宿主接入 / Shell lifecycle

在宿主自己的可选集成插件中声明 `inject: ['dshImClient', ...宿主所需服务]`，检查 `version === 1`。使用与宿主共享的 React 实例，把 `im.render()` 返回的 element 挂在宿主管理的容器中。不要直接调用面板组件函数、缓存首次返回的 element 或另行打包 React。

Declare `dshImClient` in an optional integration plugin's `inject` list alongside the shell's own dependencies, and check `version === 1`. Render the returned element using the host's React instance. Do not call the component function directly, cache its first element, or bundle another React instance.

以下为生命周期示意；`mountShellPanel` 与 `unmountShellPanel` 由宿主实现，不属于 dsh-im API：

This illustrates the lifecycle. `mountShellPanel` and `unmountShellPanel` are shell-owned functions, not dsh-im APIs:

```js
export const inject = ['dshImClient'];

export function apply(ctx) {
  const im = ctx.dshImClient;
  if (im.version !== 1) return;

  return ctx.effect(() => {
    const unmountShellPanel = mountShellPanel({
      render: () => im.render(),
      onAvailable: () => im.setSettingsVisible(false),
      onUnavailable: () => im.setSettingsVisible(true),
    });
    return () => {
      im.setSettingsVisible(true);
      unmountShellPanel();
    };
  });
}
```

宿主必须确认新入口和内容均可访问后才隐藏设置入口。注册函数返回 handle 可能只表示已开始等待槽位，不能据此认定新入口已可用。退出集成时恢复入口并卸载 React 内容；依赖服务退出时同样清理。旧服务引用在 provider 卸载后 `render()` 返回 null、`settingsVisible()` 返回 false、开关调用不生效。

Hide settings only after both the replacement navigation and content are available. A registration handle may only represent a pending slot subscription. On integration exit or dependency loss, restore settings and unmount the React subtree. A stale service returns null from `render()`, false from `settingsVisible()`, and ignores visibility writes after provider disposal.

## 兼容与布局 / Compatibility and layout

- 老宿主缺少 `ctx.provide` 时只跳过新服务，原设置页正常注册。旧版 dsh-im 没有该服务时，让可选集成保持未激活即可。
- dsh-im 使用 DSH 通用的 `sidebar.panellist` 和 `main` 槽位，不依赖桌面端专用 API。自定义嵌入容器的高度、留白、滚动和可达入口由宿主负责；现有面板不保证适配任意狭窄容器。
- 面板复用现有的管理 RPC、权限、目录选择和更新能力，无法借此绕过 host 权限限制。
- Without `ctx.provide`, the original settings section still registers. An optional shell integration stays inactive when an older dsh-im has no service.
- dsh-im uses the generic DSH `sidebar.panellist` and `main` slots without desktop-specific APIs. Custom embedding shells own navigation, height, padding and scrolling. The existing panel is not guaranteed to fit an arbitrarily narrow container.
- Existing management RPC, permissions, directory selection and update behavior apply equally to both render paths.

## 可选桌面接入 / Optional desktop integration

新版通用侧栏入口无需安装此接入。以下独立接入用于旧版 Tauri 桌面壳；它会隐藏设置入口，与新版默认保留设置入口的行为不同。

The built-in sidebar entry does not require this integration. The separate integration below targets older Tauri shells and hides Settings, unlike the current built-in entry.

源码仓库的 `integrations/desktop-panel` 提供可安装的桌面消费插件及安装说明，侧栏名称与设置页一致：中文「IM机器人」、英文「IM bots」。它只在桌面 iframe 中启用，普通浏览器仍保留设置入口。该独立目录不包含在 dsh-im 的 npm 发布包中，也不代表桌面端已经内置接入。

The source repository includes an installable desktop consumer and setup instructions in `integrations/desktop-panel`. Its sidebar label shares the settings translation: IM机器人 / IM bots. Only the desktop iframe opts in; standalone browsers retain settings. This separate directory is excluded from the dsh-im npm package and is not an upstream desktop integration release.
