# Session timeout

English | [中文](会话超时.md)

Session timeout tells an IM channel that, when a conversation has been **idle for too long**, it should automatically unbind that conversation from its current Session. The next incoming message no longer reuses the previous Session — it starts a fresh one with a new context. Think of this as "auto-reset a conversation after the user has been away long enough", so a new question does not bleed into a stale context.

The feature is **off by default**; while it is off the plugin behaves exactly as it did before.

> The feature **only unbinds the binding; it never deletes Session logs**. The persisted log of a timed-out Session is preserved by Harness's immutability convention, and the `/history` command can still take the user back into that old Session to continue.

## 1. What "clear the context" means

"Clear the context" = unbind `conversationKey → sessionId`: a call to `ConversationStateStore.clearSession(key)` removes the conversation's binding to the current Session. When the next IM message arrives, `sessionFor(key)` returns null, so dsh-im's existing path automatically calls `createSession`, mints a new `sessionId`, and writes it back. This is the implicit behaviour dsh-im already had — **no new creation branch is needed**.

- The old Session is neither destroyed nor deleted.
- Its persisted log and Session record are preserved under Harness's immutability convention.
- `/history` can still find the old Session and continue it.

The optional file-cleanup tiers (`inbound` / `directory`) are added on top of "clear the context" — they are **orthogonal and optional**, controlled by the `cleanupScope` setting (described in §4 below).

## 2. Where the configuration lives

Session-timeout configuration is spread over three places. The split mirrors the existing inbound-ttl layering, and **no new configuration file is introduced**.

### 2.1 Runtime settings: `$DSH_HOME/integrations/dsh-im/settings.json`

**Purpose**: persists session-timeout's runtime settings (shared with `inboundAttachmentTtlHours`).

**Location**: `~/.dsh/integrations/dsh-im/settings.json` (on Windows: `%USERPROFILE%\.dsh\integrations\dsh-im\settings.json`). The `~` here is `$DSH_HOME`; if the env var is not set, it falls back to the user's home `.dsh`.

**Example**:

```json
{
  "version": 1,
  "inboundAttachmentTtlHours": 168,
  "sessionTimeout": {
    "enabled": true,
    "timeoutMinutes": 30,
    "scanIntervalMs": 300000,
    "cleanupScope": "none",
    "notify": true,
    "notifyText": "Session timed out; a new conversation has started. Use /history to continue the previous one."
  }
}
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `false` | Master switch. When `false`, no touch or scan happens |
| `timeoutMinutes` | `number` | `30` | Idle threshold (minutes), range 1–10080 (7 days) |
| `scanIntervalMs` | `number` | `300000` (5 min) | Scan interval (ms), range 60000–3600000 |
| `cleanupScope` | `"none" \| "inbound" \| "directory"` | `"none"` | File cleanup scope (see §4) |
| `notify` | `boolean` | `true` | Whether to send a notice before unbinding |
| `notifyText` | `string` | see example | Notice text (overridable through the i18n dictionary) |

**Document version & compatibility**: the `sessionTimeout` sub-object shares `version: 1` with inbound-ttl — **no new version number is introduced**. An old file without the sub-object is treated as defaults (`enabled: false`) and never misread. A damaged or future-version file falls back to "**disabled** + default threshold", so an unreadable intent never widens into session unbinding — the same fallback direction as inbound-ttl's "damaged → keep-forever".

**Write timing**: only the RPC `set` (including the startup write of host-config defaults) touches disk; `touch` and the periodic scan never do.

**Activity is not persisted**: each conversation's `lastActivityAt` / `runningSince` / `sessionId` live only in an in-memory Map and are never written into `settings.json`. Touches happen on every inbound message and every turn end, so persisting them would rewrite the whole file at high frequency and freeze a growing set of platform identifiers (chat_id / open_id) into the user's config file. The trade-off is that **a restart resets every idle window**: a conversation must idle for the full threshold again before it is cleaned up — see §5.4.

Earlier versions wrote a `sessionActivity` sub-object into this same file. The current version **ignores** it on load and removes the stale sub-object on the next `set` write.

### 2.1.1 Enable DSH diagnostic logs

dsh-im uses DSH/Cordis's logger. To observe settings loading, sweeper startup, message touches, and scan skip reasons, load the console exporter in the `cordis.yml` of the profile that actually runs DSH:

```yaml
- id: logger-console
  name: '@deepseek-ai/cordis-plugin-logger-console'
  config:
    showDiff: true
    levels:
      default: 2
      dsh-im: 3
      dsh-im:session-timeout: 3
      dsh-im:file-ingress: 3
      dsh-feishu: 3
```

Log levels are `0=error`, `1=info`, `2=warn`, and `3=debug`. dsh-im diagnostic logs are not automatically written into the repository; the console exporter writes to the Host stdout/stderr. In PowerShell, capture it with `pnpm dsh --profile <profile> "task" *> dsh-im-debug.log`.

Timeout diagnostics include the settings path, resolved `enabled` value, threshold, scan interval, tracked count, touches, running-turn protection, first-scan grace, and expiry count. Feishu file diagnostics include short message/file identifiers, download stage, error code, final Session workspace, staging directory, and file count; file contents are never logged.

### 2.2 Host config (cordis.yml injection)

**Purpose**: the `config` object cordis injects when the Host starts. Decides whether the feature starts enabled and what its startup defaults are. If you do not use cordis.yml, the same fields can go straight on top of your `config.json`.

**Example (cordis.yml snippet)**:

```yaml
config:
  sessionTimeoutEnabled: true
  sessionTimeoutMinutes: 60
  sessionTimeoutCleanupScope: inbound
  sessionTimeoutReplyTimeoutMs: 900000
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `sessionTimeoutEnabled` | `boolean` | `false` | Startup hard-switch. When explicitly `false`, the store's `enabled` is also vetoed |
| `sessionTimeoutMinutes` | `number` | `30` | Startup default threshold; store takes precedence when it has a value |
| `sessionTimeoutCleanupScope` | `"none" \| "inbound" \| "directory"` | `"none"` | Startup default tier |
| `sessionTimeoutReplyTimeoutMs` | `number` | `undefined` | Override used for the running-turn protection window; falls back to `config.replyTimeoutMs ?? 600_000` |

**Merge rule** (host config vs runtime store):

```
enabled         = hostConfig.sessionTimeoutEnabled === false ? false : store.enabled
timeoutMinutes  = store.timeoutMinutes ?? hostConfig.sessionTimeoutMinutes ?? 30
cleanupScope    = store.cleanupScope ?? hostConfig.sessionTimeoutCleanupScope ?? 'none'
other fields    = store value ?? default
```

That is: an explicit host config `false` is a hard veto; everywhere else the store wins over a host default. On startup, if the host config and the store disagree, the merged default is written back to the store so running-time RPC sees the same numbers. This means cordis.yml can disable it for the whole host while still letting users tune it through RPC.

### 2.3 `workspaces.json`

**Purpose**: persists per-bot/per-conversation directory-isolation records. The `'directory'` cleanup tier touches this file when it removes a `sessionDirectories[botId][conversationKey]` entry. Session timeout itself does **not** persist to `workspaces.json`; it only edits it during a `'directory'`-tier cleanup.

**Location**: `~/.dsh/integrations/dsh-<channel>/workspaces.json` (one per channel). No manual editing is needed.

## 3. How to enable

Use the order "edit the config → restart → fine-tune via RPC".

### 3.1 Approach A: edit settings.json (recommended for fresh deployments)

1. Stop the DSH Host.
2. Edit `~/.dsh/integrations/dsh-im/settings.json` and add the `sessionTimeout` sub-object:

   ```json
   {
     "version": 1,
     "inboundAttachmentTtlHours": 168,
     "sessionTimeout": {
       "enabled": true,
       "timeoutMinutes": 30,
       "cleanupScope": "none",
       "notify": true
     }
   }
   ```

3. Start the DSH Host. The plugin reads the file at startup and starts the sweep timer.

### 3.2 Approach B: cordis.yml startup defaults (recommended for cordis.yml deployments)

1. Add the fields shown in §2.2 to the `config` section of your cordis.yml.
2. Restart the DSH Host. The plugin merges the host config with the store and writes the merged result back to `settings.json`.
3. Later, when users adjust through the settings UI (or RPC), store values win over host defaults; on the next Host restart, host config reapplies its switch.

### 3.3 Approach C: runtime RPC tuning (no restart)

The `/dsh-im-settings` channel exposes three loopback-authority endpoints you can adjust while the Host is running:

| endpoint | input | returns | meaning |
| --- | --- | --- | --- |
| `settings.session-timeout.get` | `{}` | current settings snapshot | query current settings |
| `settings.session-timeout.set` | any subset of settings fields | merged settings | atomic write + reschedule |
| `settings.session-timeout.expire-now` | `{}` all / `{"conversationKey": "<key>"}` / `{"conversationKeys": ["k1","k2"]}` | `{ expired: [...] }` or `{ ... summary }` | manual trigger for ops and tests |

A successful `set` calls `service.resetSchedule()`; flipping from disabled to enabled will also `start()` the sweep timer, and the reverse will `stop()` it. `expire-now`'s `force=true` skips the `enabled` check, so **even with the feature off** you can force a cleanup.

The settings UI on the client side will be added in a later iteration; today you can hit the RPC directly.

## 4. File-cleanup tiers (`cleanupScope`)

File cleanup is **orthogonal and optional** on top of context clearing. Even with `cleanupScope='none'`, a timeout will still unbind `conversationKey → sessionId`, and the next message still starts a new Session.

| Value | Behaviour | Safety guarantee |
| --- | --- | --- |
| `none` (default) | Only unbinds the context; touches no files | Most conservative, totally backward compatible |
| `inbound` | Reuses `sweepInboundAttachments(workspace, 0, { isTracked: () => false })` to force-empty the `inbound/` subtree (under the recorded directory, and under the base when conversation-directory isolation is on) | Only touches inbound attachment directories |
| `directory` | On top of `inbound`, removes the whole `conv-<…>` directory and drops the matching `sessionDirectories` entry from `workspaces.json` | **Must pass four safety checks**; any failure degrades back to `inbound` (see §5) |

### 4.1 `inbound` tier (recommended when conversation-directory isolation is on)

The flow is:

1. Look up the recorded directory with `BotWorkspaceStore.sessionDirectoryFor(botId, conversationKey)`; if there is none, the base workspace becomes the base.
2. Call `sweepInboundAttachments(base, 0, { isTracked: () => false })` to force-delete every `.dsh-im/inbound/<timestamp-random>/` subtree under the base.
3. If the recorded `directory` differs from the base (i.e. isolation is on), run the same sweep over `directory`.

A cleanup failure does not block the unbinding; once the subtree is gone, the inbound-ttl-service next sweep just has nothing to do.

### 4.2 `directory` tier (the full tier — use with care)

The flow is:

1. Look up `sessionDirectoryFor(botId, conversationKey)?.directory`; if there is no record, **degrade to the `inbound` tier**.
2. Run the **four safety checks**. Any failure degrades back to `inbound` and logs a warning — nothing is deleted.
   - **is-base check**: `directory === defaultWorkspace || realpathSync(directory) === realpathSync(base)` is true → degrade; **the base workspace root is never deleted**.
   - **path-shape check**: `isConversationDirectoryPath(directory, { prefix })` is false → degrade, so a manually placed same-name directory is not removed.
   - **realpath check**: `realpathSync(directory)` fails (ENOENT, etc.) → degrade.
   - **outside-base check**: compute `node:path.relative(base, directory)`; if it starts with `..` or is absolute → degrade.
3. `rm(canonicalDirectory, { recursive: true, force: true })`.
4. Once the disk is cleaned, call `BotWorkspaceStore.clearSessionDirectory(botId, conversationKey, { alsoClearWorkspaceOverride: false })` to drop the `sessionDirectories` entry from `workspaces.json`.
5. A `workspaces.json` write failure here is **not** rolled back — it leaves the documented "directory gone, record still present" state; the next sweeper retries and warns.

## 5. The timeout-decision model

### 5.1 Touch points

Every inbound message and every agent turn end calls `service.touch(conversationKey, { botId, sessionId, at })` to reset that conversation's idle window:

- **Inbound message handling**: in the file-ingress executor, `touchBySessionId(sessionId)` is called fire-and-forget before staging, resetting the activity timestamp.
- **Agent turn end**: `session-sync-coordinator.mjs`'s `processEvent` for `turn/end` also fires-and-forgets a touch, so the idle timer starts counting from the reply completion.

Both touch points use fire-and-forget + try/catch: a tracking failure is only logged and never affects message delivery.

### 5.2 Scanning

Every `scanIntervalMs` (default 5 minutes, configurable), `scanAndExpire` iterates every conversationKey in the in-memory activity table, and for any entry where `now - lastActivityAt > timeoutMinutes * 60000`, it runs `expire()`. The scan neither reads nor writes disk.

### 5.3 Protection window (don't kill a long turn)

Each tracked record also stores `runningSince` — the time the most recent agent turn started. During a scan, if `now - runningSince < replyTimeoutMs * 1.5` (default 10 min × 1.5 = 15 min), the entry is **skipped for this pass**, so a long turn does not get unbound mid-flight. Past the protection window the entry expires normally.

### 5.4 First-scan grace

Because activity lives in memory only, every conversation starts out untracked after a process restart and its idle window is timed from scratch — a user who was away for eight hours gets a full threshold cycle after coming back instead of being unbound at boot.

On top of that, one grace remains: on the first scan, entries that are already past the threshold but with `age < thresholdMs + scanIntervalMs` are given a one-interval grace, so an entry that aged past the line between two scans is not cleaned by the very first scan after (re)scheduling. This is the same flakiness-avoidance philosophy as inbound-ttl's `TRACKED_PROTECTION_MS`.

### 5.5 Notification text (when `notify=true`)

Before unbinding, `expire()` calls `deliveryService.sendSessionSyncText(botId, targetId, sessionId, text)` for every sync target registered for that Session.

- The default text is "会话超时，已开启新会话；如需继续上一段，请使用 /history", routed through dsh-im's existing i18n dictionary — **never hardcoded**. The English translation is "Session timed out; a new conversation has started. Use /history to continue the previous one.".
- A failure on any one target is logged and **does not block the others or the unbinding itself**.
- If the Session has no registered sync target (the normal case for a regular Feishu DM), delivery falls back to the channel's proactive conversation-key route; a fallback failure is logged and never blocks the unbinding.

## 6. Relationship to existing behaviour

| Existing mechanism | Relationship |
| --- | --- |
| `inboundAttachmentTtlHours` / `inbound-ttl-service` | **Orthogonal**. Session-timeout cleanup is a one-shot immediate action; long-term attachment eviction still belongs to `inbound-ttl-service`. They never cancel each other; once a session-timeout cleanup empties an inbound subtree, the inbound-ttl sweep has nothing to do there |
| `replyTimeoutMs` (10-min per-turn timeout) | **Still in effect**. Session timeout does not replace or take over it; an in-flight agent turn is governed by it; the protection window here is `replyTimeoutMs * 1.5` |
| `/new` command's unbind | `/new` calls the same `ConversationStateStore.clearSession(key)` — **equivalent** to this feature; we are simply automating it on a timer |
| `/history` command | The feature never touches Session logs; `/history` can still find old Sessions and continue them |
| Conversation directory isolation (`conversationDirectory`) | The `directory`-tier cleanup reuses `sessionDirectoryFor`, `isConversationDirectoryPath`, `BotWorkspaceStore.clearSessionDirectory`; any failure degrades to `inbound` instead of deleting |
| `/dsh-im-settings` | Inbound TTL and session timeout share one fetch route; method prefixes dispatch `settings.inbound-ttl.*` and `settings.session-timeout.*` separately |

## 7. Disabling and rolling back

Set `enabled` back to `false` (or remove the `sessionTimeout` sub-object). After disabling:

- Scans, unbinds, and file cleanups all stop;
- Already-unbound conversations are not re-bound — the next user message starts a new Session;
- Already-deleted files are not restored — this is a deliberate cleanup action.

For one-off debugging, prefer **RPC `set enabled=false`** over deleting the file: deleting it lets the next start re-initialize from host config / defaults.

## 8. Where the code lives

| Path | Role |
| --- | --- |
| `src/channels/shared/session-timeout.mjs` | Pure functions: defaults, `normalizeSessionTimeoutSettings`, `validateSessionTimeoutField`, constants |
| `src/channels/shared/session-timeout-store.mjs` | `SessionTimeoutStore`: persisted settings sub-object (atomic write, ENOENT init, damage fallback); the activity table is memory-only and never persisted |
| `src/channels/shared/bot-workspace-store.mjs` | `clearSessionDirectory` (called by the `directory`-tier cleanup) |
| `plugin-src/host/session-timeout-service.mjs` | `createSessionTimeoutService`: scan, timeout detection, unbind, notify, file cleanup |
| `plugin-src/host/session-timeout-runtime.mjs` | `getSessionTimeoutRuntime`: per-process singleton + `ctx.effect` teardown; `registerSessionTimeoutStateSource` / `registerSessionTimeoutWorkspaceProvider` |
| `plugin-src/host/session-timeout-rpc.mjs` | `/dsh-im-settings` endpoints: `get`/`set`/`expire-now` |
| `plugin-src/host/harness-session-coordinator.mjs` | file-ingress executor injects `touchBySessionId` |
| `plugin-src/host/session-sync-coordinator.mjs` | `turn/end` handler injects `touchBySessionId` |

## 9. Acceptance criteria

- With the default config (`enabled: false`) behaviour is identical and there is no regression.
- With the feature on, a conversation idle past the threshold has its `conversationKey → sessionId` binding unbound on the next scan.
- **Core**: once unbound, the next IM message runs through `createSession` and a new `sessionId` is minted — the user continues in a fresh context.
- With `notify=true`, the bound IM channel receives "Session timed out; a new conversation has started. Use /history to continue the previous one.".
- With `cleanupScope='inbound'`, the `<workspace>/.dsh-im/inbound/` subtree is gone, and the inbound-ttl-service next sweep does not error.
- With `cleanupScope='directory'`, the `conv-*` directory is removed, the matching `sessionDirectories` entry in `workspaces.json` is dropped, and **the base workspace root is never deleted**.
- A long-running turn is not unbound mid-flight (protection-window test).
- Activity records never appear in `settings.json`; after a restart each conversation's idle window is timed fresh (in-memory tests).
- An entry that has expired but is still within the grace is not unbound by the first scan (grace test).
- A single target's notification failure does not block the others or the unbind.
- `session-timeout.get/set/expire-now` RPCs work; after a settings change the scan interval is rescheduled correctly.
- **The old Session is not destroyed** — its persisted log is still on disk before and after the timeout; `/history` can access it.
