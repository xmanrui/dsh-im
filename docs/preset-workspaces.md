# Agent Preset workspace groups

## 中文

这是插件 Host 配置选项，默认关闭，不自动迁移任何已有聊天。在 Host 的插件配置（例如所用 profile 的 `cordis.patch.yml` 中该插件的 `config`）中加入：

```yaml
- insert:
    - id: xmanrui-dsh-im
      name: '@xmanrui/dsh-im'
      config:
        groupByAgentPreset: true
        feishu:
          groupByAgentPreset: false
```

根选项为渠道默认；渠道值可以覆盖它。修改后重启 Host，再在机器人设置中选择明确的 Agent Preset。选择 Preset 时创建或复用分组，已有明确 Preset 的机器人会在下一次创建会话时创建分组。关闭选项不会删除目录或移动会话。

- 仅默认 IM 工作目录（`<DSH_HOME>/im`）参与自动分组。目录为 `presets/<preset-id>`，工作区标题使用 Preset 的展示名称。
- 跟随 Host 默认时不创建分组。自选机器人目录、`/conv` 会话目录和飞书会话目录隔离优先，不会被分组覆盖。Matrix 的默认目录为自选目录，需显式使用默认 IM 目录才参与。
- 只影响后续新会话；已有会话的历史、绑定和位置保留。支持 `/new` 的渠道可发送 `/new` 后再提问；其他渠道使用其现有新会话操作。
- `/sessions`、`/session N` 和会话选择菜单使用当前已绑定会话的实际目录，重启或修改 Preset 后也保留旧会话的目录。同一自动分组内切换会话不会修改机器人默认目录或清除其他聊天；`/new` 后会话列表跟随后续新会话使用的 Preset 分组。
- 相同目录和 Preset 复用同一个分组，不按展示标题合并其他工作区；同名时附加 Preset ID，用户手动重命名后保留名称。
- 分组是 Harness 工作区，意味着同组新会话共享一个文件目录；各机器人、私聊及群聊仍保留各自会话历史。这不是用户权限或数据隔离功能。
- 保存 Preset 时若工作区创建或改名失败，Preset 设置不保存；已有会话不受影响。会话创建失败会正常返回错误，不退回未分组悄悄执行。

## English

This is an opt-in **Host plugin configuration** setting, off by default. In the plugin's `config` (for example in the active profile's `cordis.patch.yml`), set `groupByAgentPreset: true`. The YAML example above enables it globally and disables it for Feishu. Restart the Host after changing configuration; existing settings UI and preset commands continue to select the preset.

Only an explicitly selected preset and the default `<DSH_HOME>/im` directory participate. Selecting a preset creates or reuses `presets/<preset-id>` as a registered Harness workspace, named with the preset's display label. Already-selected presets are grouped on the next new session. Inherited Host defaults, manual bot directories, conversation workspace overrides and Feishu conversation directory isolation take priority.

Existing chats, bindings and history stay in place. On supported channels use `/new`, then ask again, to create a new session. Turning the option off neither deletes directories nor moves chats. A renamed group retains its title; unrelated same-name workspaces are never merged.

`/sessions`, `/session N` and session menus use the bound session's actual workspace, including after a restart or preset change. Selecting another session in the same automatic group preserves the bot's default directory and other chat bindings. After `/new`, the list follows the preset group for future sessions.

This is a real workspace directory shared by newly grouped sessions, not an access-control boundary. Bot and conversation histories remain separate. A registration failure surfaces as an error rather than silently running in the wrong directory; a failed preset save keeps the previous selection.
