import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { WeixinHarnessBridge } from "../../../src/channels/weixin/weixin-bridge.mjs";
import { WeixinStateStore } from "../../../src/channels/weixin/state-store.mjs";
import { WechatGroupProcess } from "../../../src/channels/weixin/wechat-group-process.mjs";
import { WechatGroupRuntime } from "../../../src/channels/weixin/wechat-group-runtime.mjs";

const TITLE = "零食快递洗鞋打扫外卖代写";
const GROUP_ID = "uia_group_room";
const SCRIPT = "D:\\codex\\DSH-IM\\rv5.8.0\\scripts\\wechat_group_uia.py";

function fakeHarness() {
  const asked = [];
  let created = 0;
  return {
    asked,
    async ensureRunning() { return true; },
    async createSession() { created += 1; return `session-${created}`; },
    async sessionExists() { return true; },
    async getSessionModels() { return { models: [], selected: null }; },
    async isSessionRunning() { return false; },
    async hasActiveTurn() { return false; },
    async ask(sessionId, prompt) {
      asked.push({ sessionId, prompt });
      return "E2E-ANSWER-1";
    },
  };
}

async function eventually(predicate, message, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(message);
}

// Read the real group tail through a second, read-only Python probe.
function readGroupTail() {
  const code = [
    "import json, os, sys",
    "os.environ['DSH_WECHAT_GROUP_ALLOW_UNVERIFIED'] = '1'",
    "sys.path.insert(0, 'D:/codex/DSH-IM/rv5.8.0/scripts')",
    "import wechat_group_uia as m",
    "g = m.GroupConfig(id='uia_group_room', title='零食快递洗鞋打扫外卖代写')",
    "b = m.UiaBackend()",
    "a = m.WechatGroupAdapter([g], b)",
    "a.start()",
    "msgs = b.read_messages()",
    "print(json.dumps([x.text for x in msgs], ensure_ascii=False))",
  ].join("\n");
  const out = execFileSync("py", ["-3.12", "-B", "-c", code], { encoding: "utf8" });
  return JSON.parse(out.trim().split(/\r?\n/).pop());
}

// Manual live acceptance only: it needs the target group visible and pinned in
// the running WeChat window, real UIA, and both opt-in switches. It is skipped
// unless DSH_WECHAT_GROUP_LIVE_E2E=1 so the regular suite never depends on a
// desktop session.
test("a real group message wakes the agent and the answer lands back in the group", { skip: process.env.DSH_WECHAT_GROUP_LIVE_E2E !== "1" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wx-e2e-"));
  const statePath = join(dir, "state.json");
  const configPath = join(dir, "group-chats.json");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const config = {
    version: 1,
    pollIntervalMs: 400,
    groups: [{
      id: GROUP_ID, title: TITLE, commandPrefix: "/dsh",
      mentionMode: "command", allowSelf: false, allowUnverifiedTrigger: true,
    }],
  };
  await writeFile(configPath, JSON.stringify(config));

  const harness = fakeHarness();
  const state = await new WeixinStateStore(statePath).load();
  const contextEnhancement = { botId: "wx_e2e", getSettings: () => ({ direct: { enabled: false }, group: { enabled: false } }) };
  const accessPolicy = {
    isPrivileged: () => false,
    getSettings: () => ({
      direct: { mode: "allowlist", open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] }, allowlist: { users: [] } },
      group: { mode: "allowlist", open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] }, allowlist: { users: [] } },
    }),
  };

  const ilink = [];
  const ilinkApi = { sendText: async (request) => { ilink.push(request); return { providerMessageIds: ["ilink-1"] }; } };
  let runtime = null;
  const bridge = new WeixinHarnessBridge({
    api: {
      sendText: async (request) => (runtime?.handles?.(request.toUserId)
        ? runtime.sendText(request)
        : ilinkApi.sendText(request)),
    },
    baseUrl: "https://ilinkai.weixin.qq.com/", token: "e2e", ownerUserId: "owner-e2e",
    harness, state, contextEnhancement, accessPolicy,
    logger: { error() {}, warn() {}, info() {}, debug() {} },
  });

  const groupProcess = new WechatGroupProcess({
    config, scriptPath: SCRIPT, configPath,
    journalPath: join(dir, "journal.jsonl"),
    logger: { error() {}, warn() {}, info() {}, debug() {} },
  });
  runtime = new WechatGroupRuntime({ config, process: groupProcess, harness });
  // The runtime owns only the Python side; the bridge is injected by the account.
  t.after(async () => { await runtime.stop().catch(() => undefined); });

  await runtime.start({ bridge });
  assert.equal(runtime.status.ready, true);

  // A real /dsh message into the configured group, through the real UIA sender.
  const requestId = `e2e-in-${Date.now()}`;
  await runtime.sendText({ toUserId: GROUP_ID, text: "/dsh E2E-IN-1", requestId });

  // The poller must surface it, the bridge must reach the model, and the answer
  // must be written back through the same UIA transport.
  await eventually(() => harness.asked.length > 0, "the group message never reached the agent");
  assert.equal(harness.asked[0].prompt.includes("E2E-IN-1"), true);

  await eventually(
    () => bridge.status.messagesReplied >= 1,
    "the agent answer was never delivered back to the group",
  );

  await eventually(
    () => readGroupTail().includes("E2E-ANSWER-1"),
    "the answer is not visible in the real group",
    30000,
  );
});
