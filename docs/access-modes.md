# Access modes

## Personal deployments

The host plugin accepts an opt-in `personalAccess: true` setting for every chat channel. In this mode, only users explicitly saved in each bot's **direct-chat allowlist** can send messages. Open access modes and privileged-owner shortcuts cannot bypass that list. An empty, missing, or unreadable list rejects all messages; changing the saved list takes effect immediately. Each listed user's command permission is preserved. Add only your own platform identity for a personal deployment.

All group messages are ignored, except on Discord: an allowlisted user must own the server and explicitly mention the bot on **every** message. Server ownership is checked through Discord's API before creating a session. Replies remain in the source channel, including existing threads; no discussion thread is created and an unmentioned follow-up is ignored. An unavailable ownership check rejects the message.

Use `disabledChannels: ['whatsapp']` to keep WhatsApp's unofficial connection disabled even if it was previously configured. Disabled channels do not start their runtime or register connection controls. These options do not change the default behavior of other deployments.

```yaml
config:
  personalAccess: true
  disabledChannels:
    - whatsapp
```

On macOS, iMessage setup shows the scope of Full Disk Access and Automation before permission actions or connecting become available. The user must acknowledge that these grants also let commands run by the model read protected data such as Messages and Mail. Merely viewing the connection page does not request Automation permission.

## Per-bot access modes

Each Telegram bot has its own access-mode control on its bot card. Existing and newly connected bots both default to **Compatible mode**: DMs receive replies, while group messages require a mention of or reply to the bot. Restrictions apply only after explicitly switching that bot to **Safe mode (private-chat allowlist)**. Safe mode ignores every group message and admits only numeric User IDs in that bot's allowlist. Enter one ID per line. Switching back to Compatible mode retains the allowlist without enforcing it, so it is available when Safe mode is enabled again. An empty allowlist in Safe mode rejects all inbound messages for that bot.

Each WhatsApp bot also has its own access mode. Existing bots migrate to **Only me**, which is also the default for newly linked bots and accepts only self-chat messages from the linked account. **Selected contacts** additionally accepts direct messages from allowlisted phone numbers and ignores groups. Enter one number with its country or region code per line; a leading `+` is optional. **Open responses** accepts all direct messages, group messages sent by the linked account, and mentions of or replies to that account from other group members; this also lets an owner-only group act as a separate conversation. Switching modes retains the allowlist. An empty Selected contacts allowlist behaves like Only me, and rejected messages are ignored silently.
