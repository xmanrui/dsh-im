# Conversation directory isolation

English | [中文](会话目录隔离.md)

Conversation directory isolation gives **every conversation its own directory**. Before a new Session is created, the plugin creates a directory under that conversation's base Workspace, derived from the conversation identity, switches the conversation's working directory to it, and only then creates the Harness Session. Model file reads, writes and commands therefore land per conversation, so several people sharing one bot do not overwrite each other's files and nobody has to create directories by hand.

The feature is **off by default**; while it is off the plugin behaves exactly as it did before.

## Enabling

**The switch is channel-wide by default**: add a top-level `conversationDirectory` object to that channel's `workspaces.json` and **every bot in that channel** inherits it — no botId required.

```json
{
  "conversationDirectory": { "enabled": true }
}
```

- File: `~/.dsh/integrations/dsh-<channel>/workspaces.json`, for example `~/.dsh/integrations/dsh-feishu/workspaces.json` for Feishu.
- `strategy` and `prefix` may be omitted and default to `per-conversation` and `conv-`.
- **Restart DSH after editing.** The plugin reads the file at startup only; a running Host neither sees the edit nor preserves it — the next save writes the in-memory snapshot back and drops it.

To enable just one bot, or to opt one bot out of a channel that enabled it for everyone, add a per-bot override:

```json
{
  "conversationDirectory": { "enabled": true },
  "conversationDirectories": {
    "<botId>": { "enabled": false }
  }
}
```

A per-bot value wins over the channel value; a bot with neither stays unisolated.

Either way it only affects Sessions created **afterwards**: existing Sessions keep their current working directory, so send `/new` (or switch workspace) to move a live conversation into its directory.

## Strategies

| Strategy | Directory | Behaviour |
| --- | --- | --- |
| `per-conversation` (default) | `<base>/<prefix><key>-<digest>` | One stable directory per conversation; repeated `/new` reuses it and never nests |
| `per-session` | as above plus a timestamp | Every new Session gets a fresh directory; old directories are kept — the plugin never deletes them |

## When prefix and strategy changes apply

Changing the **prefix** or **strategy** in the settings page needs **no bot removal and re-add**. A live Session's working directory is fixed when the Session is created and cannot move underneath it, so the change applies to a conversation's **next new Session**: when `/new` is sent (or the Session has lapsed and the next message creates one), the plugin sees the persisted directory record no longer matches the settings in force, derives a new directory below the **same base Workspace**, switches to it atomically, and **leaves the old directory and its files untouched**.

- Because a name is derived from the conversation key alone, restoring the previous prefix makes the next new Session **re-adopt the original directory**: the files are still there.
- Note that `/workspacelist` hides conversation directories matching the **current** prefix, so a directory minted under an older prefix reappears in the list after you rename it (`/workspacelist all` always shows everything).
- Hand-editing `workspaces.json` still requires a restart (the plugin reads that file at startup only); this section covers live changes made in the settings page or over the management RPC.

## Naming

The name is derived from the conversation key alone, so a restart or another machine recomputes the same directory:

- characters a filesystem rejects (`:` and friends) become `-`;
- because that substitution is lossy (`p2p:a-b` and `p2p:a:b` share a readable stem), the name always ends with an 8-character digest of the **original** key, which keeps names unique;
- the whole name stays within 100 characters; an over-long key is truncated and the digest is kept;
- the prefix defaults to `conv-` and may be set to 1-32 letters, digits, underscores or hyphens.

## Interaction with the workspace commands

While isolation is on, the conversation **owns** its working directory: every manual workspace write is refused (including at the store/RPC layer, with `workspace-manual-edit-disabled`).

| Command | Isolation on | Isolation off |
| --- | --- | --- |
| `/workspace` `/ws` | **No response** | Switches the bot default Workspace |
| `/conv` `/conversation` `/thread` | **No response** (set / clear / status) | Views, sets or clears the conversation Workspace |
| `/session <id>` | Only adopts a Session that already lives in this conversation's effective Workspace (the isolated directory); never changes any Workspace setting. Sessions from another Workspace are rejected | Aligns workspaces as before |
| `/workspacelist` | Available; hides conversation directories by default | Same |
| `/workspacelist all` | Lists every workspace, including conversation directories | Same |
| `/new` | Available (prepares or reuses the directory) | Same, without directory preparation |
| Settings Workspace editor | **Locked** | Editable |

## When it cannot apply

A failed `mkdir` or workspace switch (insufficient permission, full disk, path too long, unsupported Harness) **never blocks the message**: the plugin keeps creating the Session in the previous Workspace and says so in the `/new` reply, for example "(The conversation directory is not in effect: the directory could not be created (insufficient permission or disk space); this Session still runs in the previous Workspace.)". A warning is logged as well.

## Disabling and rolling back

Remove the `conversationDirectory` section (or set `enabled` back to `false`) and restart. Then:

- no new directory is created;
- directories and files already created are **left untouched** — the plugin never deletes them;
- conversations already running in their directory keep using it (it is now their workspace override); send `/conv clear` only **after** isolation is off to return one to the bot default Workspace.

## Where the code lives

| Path | Role |
| --- | --- |
| `src/channels/shared/conversation-directory.mjs` | Naming rules and settings validation (shared by Host and settings UI) |
| `src/channels/shared/conversation-directory-ensure.mjs` | Creates the directory, switches the workspace, degrades on failure |
| `src/channels/shared/new-command.mjs` | Shared `/new` body: clear binding, prepare directory, reply |
| `src/channels/shared/workspace-session.mjs` | Prepares the directory before a new Session is created |
| `src/channels/shared/bot-workspace-store.mjs` | Persists `conversationDirectories` and `sessionDirectories` |
