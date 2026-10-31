# DSH-IM Personal WeChat Group Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bidirectional, access-controlled personal WeChat group chats to DSH-IM 5.8.0 through the currently logged-in Windows WeChat window while preserving the existing iLink direct-message path.

**Architecture:** A Python native-UIA adapter emits a versioned JSONL group-event protocol. A Node child-process/runtime boundary validates it and reuses `WeixinHarnessBridge` for group policy, context, Sessions and replies. Group sends return through the same adapter and require target-chat verification plus visible read-back.

**Tech Stack:** Node.js 24, existing `.mjs` channels and `node:test`; Python 3.12 stdlib + `uiautomation`; JSON Lines; Windows UIA.

**Spec:** `docs/superpowers/specs/2026-10-31-wechat-groups-design.md`

## Global Constraints

- Base is tag `v5.8.0`, commit `e84df7034ab82de9844d142aff36b7c8f377c9ea`, branch `feat/wechat-groups`.
- Do not guess iLink group fields. Only local events with `source="uia-wechat-group/v1"` enter the new group path.
- No paid/Plus component, no new WeChat window, no `ShowWindow/SetWindowPos/SwitchToThisWindow`, no visible console.
- Direct messages keep `p2p:` and existing iLink behavior. Group messages use `group:<chatId>` and separate sender from reply target.
- Every implementation task starts with a failing test and observes that failure before implementation. No mock is accepted as live group E2E.
- Use `ESBUILD_BINARY_PATH=D:\codex\tmp\esbuild-medium\esbuild.exe` and `TEMP=TMP=D:\codex\tmp` for build/test commands in this session.

## Review Focus

- Wrong-chat send: Task 2 and its live gate verify the exact title immediately before read/send and restore the previous chat.
- Echo/replay: Tasks 1–3 test self suppression, identical consecutive texts, persistent IDs and baseline-on-restart.
- Group policy bypass: Task 1 proves direct/group scopes are not interchangeable and unaddressed events never reach Harness.
- Member/session confusion: Task 1 proves same-group shared and cross-group isolated Sessions; replies/deferred outcomes go to group ID.
- UI/version/permission failure: Task 2 fails closed when controls are absent, target title mismatches, input is not cleared, or read-back is absent.

---

### Task 1: Versioned Group Event Normalization and Harness Routing

**Files:**
- Create: `src/channels/weixin/wechat-group-conversation.mjs`
- Modify: `src/channels/weixin/weixin-bridge.mjs`
- Test: `test/channels/weixin/wechat-group-conversation.test.mjs`
- Test: `test/channels/weixin/weixin-bridge.test.mjs`

**Interfaces:**
- Produces `weixinConversation(message) -> {kind, chatId, senderId, senderName?, conversationTitle?, replyTarget, addressed}`. Direct fallback preserves legacy fields; local group input requires the complete v1 schema.
- `conversationKey(message) -> "p2p:<senderId>" | "group:<chatId>"`.
- Each account keeps one HarnessBridge and one deferred coordinator. UIA supplies events and a send transport selected by configured group ID; deferred entry.id supplies the stable outbound idempotency key. Interaction entry additionally enforces actual sender equals pending actor, and local group events never receive iLink owner privileged bypass.
- Consumes no Python process API, so it can be implemented independently of Tasks 2–3.

- [ ] **Step 1: Write failing schema/routing tests**

Cover valid v1, unknown source, missing chat/member/reply target, `addressed=false`, direct compatibility, direct-vs-group access, same-group shared Session, cross-group isolation, group context enhancement, final/deferred reply targets, and direct+group deferred recovery through one coordinator. Include A-question/B-answer and approval negative tests (no resolve and no consumed answer), forged owner IDs, cross-group display-name isolation, group batch/isDirect=false, and command/busy/notice/error/interaction target checks. Include a negative test proving group deny cannot be overridden by direct open.

- [ ] **Step 2: Verify RED before implementation**

Run: `node --test test/channels/weixin/wechat-group-conversation.test.mjs`

Expected: FAIL because `wechat-group-conversation.mjs` does not exist.

- [ ] **Step 3: Implement normalization and thread it through accept/process/send**

Validate exact v1 fields and configured event shape; keep direct fallback. In `accept`, apply `kind`, actual member and addressed. In processing, use `replyTarget` for all sends/typing/deferred routes and `senderId` for actor/interaction checks. Capture group context and use `group:<chatId>`.

- [ ] **Step 4: Verify focused tests and existing Weixin tests**

Run: `node --test test/channels/weixin/wechat-group-conversation.test.mjs test/channels/weixin/weixin-bridge.test.mjs test/channels/weixin/weixin-runtime.test.mjs`

Expected: all listed tests pass; no direct-message assertion changes.

- [ ] **Step 5: Commit**

Run: `git add src/channels/weixin/wechat-group-conversation.mjs src/channels/weixin/weixin-bridge.mjs test/channels/weixin/wechat-group-conversation.test.mjs test/channels/weixin/weixin-bridge.test.mjs && git commit -m "feat: route Weixin group conversations"`

### Task 2: Native Windows UIA Adapter and Python Protocol

**Files:**
- Create: `scripts/wechat_group_uia.py`
- Create: `tests/python/test_wechat_group_uia.py`
- Create: `scripts/requirements-wechat-group.txt`

**Interfaces:**
- Stdin requests: `health`, `send_text{request_id,chat_id,text}`, `stop{request_id}`.
- Stdout: `ready`, `message{message:<v1 event>}`, `send_result`, `health_result`, `stop_result`, sanitized `error`.
- `send_text` success returns `{ok:true,provider_message_ids:[id]}` only after exact-chat send and read-back. No DSH access/session logic belongs here.

- [ ] **Step 1: Write failing pure-Python tests**

Use fake controls/backend for command-only trigger parsing, empty trigger, allowSelf/self-echo, longest-overlap diff with identical consecutive text, persistent cursor/baseline/restart, duplicate titles, wrong-chat send refusal, missing read-back, outbound_id idempotency/unknown result, malformed request and stop cleanup. Add races for title-check→user-switch, poll/outbound interleaving and restore-time user-switch; every UIA operation shares one session lock and submit revalidates chat plus input ownership. Add live-tail gates for history scrolling, zero/insufficient overlap, virtual-list replacement and >1-screen bursts; old commands must never replay. Add persistent journal crash cases after Enter, before/after read-back and before send_result, plus same-ID different-payload and multi-chunk idempotency. Real @ versus typed @ must remain unconfirmed and cannot enable mention routing. Keep a separate read-only live probe that prints control names/types without selecting or sending.

- [ ] **Step 2: Verify RED**

Run: `py -3.12 -B -m unittest discover -s tests/python -p "test_wechat_group_uia.py" -v`

Expected: FAIL on missing `scripts.wechat_group_uia` or unimplemented behavior.

- [ ] **Step 3: Implement pure protocol/dedup logic, then the UIA backend**

Use `windowsHide` on the Node side, never launch WeChat. Attach only `mmui::MainWindow`; locate exact controls by current UI evidence. Baseline before emitting; use longest-overlap sequence diff and a persistent cursor instead of UIA RuntimeId; preserve sender/target identity. Serialize select/read/write/submit/restore under one UIA session lock; revalidate normalized title, chat_id and input ownership immediately before Enter, clear only the exact injected text on mismatch, and never override a newer user selection during restore. Verify input cleared and one visible sent message. Reserve outbound request IDs before send and return unknown without blind retry when reconciliation is unclear. Pin `uiautomation==2.0.29`.

- [ ] **Step 4: Verify pure tests and read-only live probe**

Run the unittest command above, then `py -3.12 -B scripts/wechat_group_uia.py --probe`

Expected: pure tests PASS; probe prints current window/control evidence and performs no selection, text entry, send, or window operation.

- [ ] **Step 5: Commit**

Run: `git add scripts/wechat_group_uia.py scripts/requirements-wechat-group.txt tests/python/test_wechat_group_uia.py && git commit -m "feat: add native WeChat group UIA adapter"`

### Task 3: Group Config, Child Process and Group Runtime

**Files:**
- Create: `src/channels/weixin/wechat-group-config.mjs`
- Create: `src/channels/weixin/wechat-group-process.mjs`
- Create: `src/channels/weixin/wechat-group-runtime.mjs`
- Test: `test/channels/weixin/wechat-group-config.test.mjs`
- Test: `test/channels/weixin/wechat-group-process.test.mjs`
- Test: `test/channels/weixin/wechat-group-runtime.test.mjs`

**Interfaces:**
- `loadWechatGroupConfig(path) -> null | {pollIntervalMs,groups[]}`; absent file returns null, malformed/duplicate config throws.
- `WechatGroupProcess.start/health/sendText/stop/status`; `sendText({toUserId,text})` maps to the Task 2 request and returns provider IDs.
- `WechatGroupRuntime.start/stop/waitForIdle/status`; attaches to the existing single `WeixinHarnessBridge` owned by the account, forwards only valid configured events and exposes UIA sendText. It never constructs a second deferred coordinator. `start` accepts `{bridge}`, and `handles(chatId)` selects the UIA transport only for configured groups.

- [ ] **Step 1: Write failing config/process/runtime tests**

Cover absent/malformed/duplicate config, unknown group event, invalid JSONL, health/send timeout, no historical replay after process restart, outbound request-ID dedup/unknown reconciliation, send result routing, stop without orphan, and group-only bridge construction.

- [ ] **Step 2: Verify RED**

Run: `node --test test/channels/weixin/wechat-group-config.test.mjs test/channels/weixin/wechat-group-process.test.mjs test/channels/weixin/wechat-group-runtime.test.mjs`

Expected: FAIL because the three production modules do not exist.

- [ ] **Step 3: Implement config, process protocol and runtime**

Validate IDs/titles/triggers; spawn `py -3.12 -B` with `windowsHide:true`; correlate request IDs; apply bounded timeouts and baseline-on-start; do not log full message text. Runtime attaches to the existing account bridge and never creates another deferred coordinator. Convert malformed/duplicate config and missing Python into group-only unhealthy status without throwing into iLink.

- [ ] **Step 4: Verify all Task 3 tests plus Task 1 integration**

Run the three Task 3 test files and `test/channels/weixin/wechat-group-conversation.test.mjs`.

Expected: all pass, including negative timeout/unknown-group/stop cases.

- [ ] **Step 5: Commit**

Run: `git add src/channels/weixin/wechat-group-config.mjs src/channels/weixin/wechat-group-process.mjs src/channels/weixin/wechat-group-runtime.mjs test/channels/weixin/wechat-group-config.test.mjs test/channels/weixin/wechat-group-process.test.mjs test/channels/weixin/wechat-group-runtime.test.mjs && git commit -m "feat: add WeChat group bridge runtime"`

### Task 4: Optional Host Lifecycle and Group Settings

**Files:**
- Modify: `src/channels/weixin/weixin-runtime.mjs`
- Modify: `plugin-src/host/channels/weixin/production.mjs`
- Modify: `plugin-src/client/access-policy-settings.js`
- Modify: `plugin-src/client/channels/weixin/index.js`
- Modify: `README.md` and `docs/上下文增强.md`
- Test: `test/channels/weixin/weixin-runtime.test.mjs`
- Test: `test/channels/weixin/production.test.mjs` and affected client tests

**Interfaces:**
- When `accounts/<botId>/group-chats.json` is absent, no process or status regression is allowed.
- When present, Host constructs Task 3 runtime with the same workspace/harness/state/access/context providers and starts/stops it with the account.

- [ ] **Step 1: Add failing optional-lifecycle/client assertions**

Verify absent config preserves old runtime; present config starts/stops group runtime; group failure does not stop iLink; client no longer disables/clears Weixin group settings.

- [ ] **Step 2: Verify RED, then implement wiring**

Run focused tests and observe the new assertions fail. Add optional group runtime start/stop/status and production factory. Enable group policy/context UI and accurate member-label text. Update docs for local UIA scope and limitations.

- [ ] **Step 3: Verify focused tests and build**

Run: `npm run build` and the affected Weixin/client tests.

Expected: build completes; focused tests pass; no new user-facing literal lacks required translations.

- [ ] **Step 4: Commit**

Run: `git add src/channels/weixin/weixin-runtime.mjs plugin-src/host/channels/weixin/production.mjs plugin-src/client/access-policy-settings.js plugin-src/client/channels/weixin/index.js README.md docs/上下文增强.md test/channels/weixin && git commit -m "feat: enable WeChat group lifecycle and settings"`

### Task 5: Full Validation, Managed Deployment and Live Evidence

**Files:**
- Create: `docs/wechat-group-runbook.md`
- Create: account-level `group-chats.json` outside Git for the selected live group
- Create: sanitized validation evidence outside the published package

**Interfaces:**
- Deployment uses `resources/app/lib/desktop-cli.js plugin --profile desktop add --save-exact <source>`; no ordinary CLI and no manual `node_modules` edit.

- [ ] **Step 1: Run complete automated validation**

Run Python tests, `npm test`, `npm run build`, `node scripts/verify-package.mjs`, and affected negative controls. Record pre-existing Feishu proxy baseline separately; do not hide any new red test.

- [ ] **Step 2: Review and commit only session-owned files**

Run `git status --short`, `git diff --check`, `git diff --stat e84df703..HEAD`, and `git show --stat HEAD`. Confirm no dependency-lock, scratch, credentials, log, or unrelated Feishu file enters the feature commits.

- [ ] **Step 3: Back up and deploy through Desktop management**

Back up the current package and config. Run `npm pack --dry-run` and inspect the tarball for every Python/Node group file; deploy the built source through the managed entry; compare package/lib hashes and directly assert those files exist in the actual profile. Verify Python 3.12 and `uiautomation.__version__ == "2.0.29"` in the deployed runtime environment. Prove the currently loaded Desktop instance, not just source hash or version equality; use restart only if evidence proves it is required and read back afterward.

- [ ] **Step 4: Validate a real group and negative path**

With a dedicated group and second authorized account when available, send a unique token, verify exact group/member/body, one Session and one ACK; verify non-target/non-authorized input yields no ACK. Otherwise run the documented self-token supplemental gate and mark second-account evidence explicitly unclosed.

- [ ] **Step 5: Commit runbook/evidence pointers and evaluate the goal**

Record commands, outputs, deployment hash/mount evidence, rollback, and any external-resource gap. Do not mark the persistent goal complete without the whole required live evidence.
