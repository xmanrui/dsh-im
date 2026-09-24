# Deepseek Harness Desktop：IM机器人侧栏入口

这是使用 `dshImClient` 的可选桌面接入插件，侧栏名称与设置页共用
`dsh-im` 翻译词典：中文「IM机器人」，英文「IM bots」。它提供日常使用的
完整面板，不包含测试按钮，安装后应保留。

插件依赖已加载的 dsh-im 客户端接口 v1 和桌面端 `dsh-tauri` 的
`definePanel()`。已在 Deepseek Harness Desktop `0.15.6`、内置 DSH
`0.1.5-rc.2` 验证。它是独立的本地接入，不代表桌面端已内置该入口，
也不随 dsh-im 的 npm 包发布。

## 安装

先构建并在桌面端的 tauri profile 安装包含 `dshImClient` 的 dsh-im。
将 `DSH_CLI` 指向桌面端所使用的 DSH CLI，例如 macOS 默认安装位置对应：

```sh
DSH_CLI="$HOME/Library/Application Support/io.github.hairyf.deepseek-harness-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
```

然后从本仓库根目录运行：

```sh
node "$DSH_CLI" plugin --profile tauri add "link:$PWD/integrations/desktop-panel"
```

重启桌面端后，在侧栏点击「IM机器人」。这是链接安装，应保留本仓库目录；
也可以先把本目录复制到持久位置，再将 `link:` 指向该目录。
不要把已经安装、用于日常使用的接入当作临时验收插件清理。

## 行为

- 只在桌面 iframe 中启用；普通浏览器继续使用原「设置 → IM机器人」。
- 确认桌面入口和内容槽位均可用后，隐藏当前客户端重复的设置入口。
- 接入退出或槽位消失时恢复设置入口，清理自己的面板注册。
- 复用原有完整 IM 面板，不修改机器人配置、消息链路或全局可见性。
- 不修改已安装应用的文件；旧版 dsh-im 缺少服务时，此可选接入保持未激活。

## English

This optional local plugin adds **IM bots** to Deepseek Harness Desktop's sidebar,
using the same locale dictionary as Settings. It requires `dshImClient` v1 and
the desktop's `dsh-tauri` panel API. Install the directory into the desktop's
`tauri` profile using the command above, then restart the desktop. Keep the
linked directory available and retain the installed plugin for everyday use.
Standalone browser tabs keep their original settings entry. This integration
is not bundled in the dsh-im npm package or an upstream desktop release.
