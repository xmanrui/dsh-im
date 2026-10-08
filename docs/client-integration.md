# 客户端面板接入 / Client panel integration

dsh-im 发布可选客户端服务 `dshImClient`，供同一 DSH 客户端中的宿主插件嵌入完整 IM 管理面板。默认仍保留「设置 → IM机器人」；安装新版无需迁移数据或新增配置。host 侧的 `dshIm` 主动投递服务保持独立。

The optional `dshImClient` service exposes the existing IM management panel to a shell in the same DSH client. Settings → IM bots remains available by default. No migration or new configuration is required. The host-side `dshIm` delivery service is separate.

支持插件详情操作按钮的 DSH 中，dsh-im 详情页提供「打开 IM机器人」按钮，在主区域打开同一管理面板；「返回插件详情」返回该插件。此入口依赖可选的 `layout`、`pluginNavigation` 服务及 `plugins.detail.actions` 槽位，旧版 DSH 仍可通过设置入口访问。

On DSH versions with plugin detail actions, **Open IM bots** opens the same management panel in the main area, with **Back to plugin details** returning to this plugin. This entry uses the optional `layout` and `pluginNavigation` services and the `plugins.detail.actions` slot. Older DSH versions retain the Settings entry.

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

开关只影响当前客户端内存，不写服务器配置或浏览器存储。因此桌面端隐藏入口不影响另一个浏览器。刷新后恢复默认，由宿主再次按需接管。隐藏入口不会停止机器人或外部已挂载的面板。V1 按一个活跃管理面板接入，不提供多个面板间的状态同步。

Visibility is local to this client instance and is never persisted. A desktop shell cannot hide the entry in another browser. Reload restores the default until the shell opts in again. Hiding settings does not stop bots or unmount an embedded panel. V1 targets one active management panel and does not synchronize multiple copies.

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
- dsh-im 不依赖或注册桌面端侧栏槽位。容器的高度、留白、滚动和可达入口由宿主负责；现有面板不保证适配任意狭窄容器。
- 面板复用现有的管理 RPC、权限、目录选择和更新能力，无法借此绕过 host 权限限制。
- Without `ctx.provide`, the original settings section still registers. An optional shell integration stays inactive when an older dsh-im has no service.
- dsh-im neither imports nor registers desktop sidebar slots. The shell owns navigation, height, padding and scrolling. The existing panel is not guaranteed to fit an arbitrarily narrow container.
- Existing management RPC, permissions, directory selection and update behavior apply equally to both render paths.

## 可选桌面接入 / Optional desktop integration

源码仓库的 `integrations/desktop-panel` 提供可安装的桌面消费插件及安装说明，侧栏名称与设置页一致：中文「IM机器人」、英文「IM bots」。它只在桌面 iframe 中启用，普通浏览器仍保留设置入口。该独立目录不包含在 dsh-im 的 npm 发布包中，也不代表桌面端已经内置接入。

The source repository includes an installable desktop consumer and setup instructions in `integrations/desktop-panel`. Its sidebar label shares the settings translation: IM机器人 / IM bots. Only the desktop iframe opts in; standalone browsers retain settings. This separate directory is excluded from the dsh-im npm package and is not an upstream desktop integration release.

## 可选应用创建 / Optional Provider-owned account setup

Host 的 `dshIm` 服务提供 `setupVersion: 1` 和 `describeSetup(channel)`。飞书通道实际就绪后，`describeSetup('feishu')` 返回 `{ version: 1, channel: 'feishu', endpoint: 'dsh-im/app-setup', kind: 'credentials' }`；未就绪或不支持的通道返回 `undefined`。此版本仅声明 Lark／飞书凭证创建，不声明微信扫码能力。旧 Provider 没有描述接口时，消费端继续打开原生设置页。

The Host `dshIm` service exposes optional `setupVersion: 1` and `describeSetup(channel)`. The Feishu descriptor above appears only after its production controller is ready; unavailable or unsupported channels return `undefined`. This upstream slice advertises Lark/Feishu credential setup only. WeChat QR setup requires a separate verified external-consumer account prerequisite. Older Providers retain the native Settings fallback.

描述接口只返回能力信息。客户端沿用现有 `connection.rpc.call('/api', 'dsh-im/app-setup', { method, payload }, signal)` 管理传输，凭证直接提交给 Provider，不经过消费插件的 Host 服务、数据库或日志。DSH 的认证、Host／Origin 检查和 Provider 的 `rpcAuthority` 同样适用。

The descriptor contains capability metadata only. Clients use the existing authenticated management transport below, sending credentials directly to the Provider rather than through the consumer's Host service, database or logs. Native DSH authentication, Host/Origin checks and Provider `rpcAuthority` continue to apply.

```js
const descriptor = await hostDshIm.describeSetup('feishu');
const call = (method, payload, signal) => connection.rpc.call(
  '/api', descriptor.endpoint, { method, payload }, signal,
);
const started = await call('setup.start', { channel: 'feishu' });
// Credential fields are supplied by the Human and stay in this Client/Provider path.
const created = await call('setup.credentials', {
  attemptId: started.value.attemptId, appId, appSecret, domain: 'lark',
});
```

| Method | Payload | 行为 / Behavior |
| --- | --- | --- |
| `setup.start` | `{ channel: 'feishu' }` | 返回不透明 attempt ID 和 `expiresAt` / Returns an opaque attempt ID and expiry |
| `setup.credentials` | `{ attemptId, appId, appSecret, domain }` | `domain` 为 `lark` 或 `feishu`；验证并创建账户 / Verifies and creates an account |
| `setup.poll` | `{ attemptId }` | 恢复读取同一操作 / Resumes the same attempt |
| `setup.cancel` | `{ attemptId }` | 撤销提交前的操作；保留已完成账户 / Fences an uncommitted operation; retains a completed account |

返回遵循 `{ ok: true, value }` 或 `{ ok: false, error: { code, message, details } }`。状态为 `credentials`、`creating`、`ready` 或 `cancelled`；过期返回 `setup-expired`。每个 Provider 最多保留 32 个有效操作，每个操作 10 分钟。通道卸载或替换会撤销原注册所拥有的操作。浏览器关闭或请求中断本身不等于取消，客户端可保留 attempt ID 再轮询；取消需显式调用 `setup.cancel`。

Responses use the envelope above. States are `credentials`, `creating`, `ready` and `cancelled`; expiry returns `setup-expired`. At most 32 live attempts are retained, each for 10 minutes. Channel disposal/replacement fences attempts owned by the original registration. Closing a dialog or interrupting a browser request does not itself cancel setup: retain the attempt ID for polling, or explicitly call `setup.cancel`.

`ready` 只包含不透明 `accountRef` 和经过验证的账户描述（fingerprint、名称、连接状态及能力），不返回 Secret、secretRef 或原始平台错误。账户在首个连接启动前即保存为 `external-consumer`，不会先运行独立 Session。客户端仍需通过自身现有绑定流程认领该身份；应用权限、事件订阅和发布仍在平台后台配置。重复创建已有应用返回 `setup-account-exists`，原账户与凭证保持不变。提交前取消会回滚新凭证；取消已完成操作保留账户供后续绑定。

`ready` contains only an opaque `accountRef` and verified account description (fingerprint, name, connection status and capabilities), never credentials, credential references or arbitrary platform errors. The account is persisted as `external-consumer` before its first connection, preventing an initial standalone Session. The consuming application must still bind the identity through its existing ownership flow; platform scopes, event subscriptions and publication remain official-console operations. Repeating setup for a configured app returns `setup-account-exists` without changing its account or credentials. Pre-commit cancellation rolls back new credentials; cancellation after completion retains the account for later binding.
