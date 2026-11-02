import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// N2 对账判据：主动投递能力声明必须与实现一一对应，两个方向都判。
//
// 为什么需要它：r18 实测 14 个渠道里只有 feishu 声明过 describeDeliveryAccount，
// 而 dingtalk/email/matrix/qq/slack/wecom/wecom-app/weixin/whatsapp 早已实现
// sendProactiveText —— 能力在、路不通（delivery-service 拿不到声明就 capability-unavailable）。
// 这种缺口在原有 4,977 条测试里一条都没红，因为没有判据盯这个契约。
const CHANNELS = resolve(import.meta.dirname, '../src/channels');

async function channelDirectories() {
  const entries = await readdir(CHANNELS, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && e.name !== 'shared').map((e) => e.name).sort();
}

async function channelSource(name) {
  const chunks = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (entry.isFile() && entry.name.endsWith('.mjs')) chunks.push(await readFile(path, 'utf8'));
    }
  };
  await walk(resolve(CHANNELS, name));
  return chunks.join(String.fromCharCode(10));
}

/**
 * 该渠道是否通过 TokenBotController 获得声明。
 *
 * 为什么需要这个判断：discord / imessage / telegram 的 controller 是 TokenBotController 的
 * 子类，声明写在基类里（一份，不是三份副本）。逐目录扫源码会看不见它，
 * 从而把「继承来的声明」误判成「没声明」。判据必须认继承，否则会逼人复制三份代码
 * —— 那正是口径漂移的来源。
 *
 * @param {string} source 该渠道源码全文
 * @returns {boolean}
 */
/**
 * 声明里是否**真的**含 proactive-text-checked。
 *
 * 为什么不能直接 /proactive-text-checked/.test(source)（r18 实测踩到）：
 * 那是全文子串匹配，**注释里出现该字样就算声明**。实测把 wecom 的数组清空、
 * 只留一行 `// proactive-text-checked reserved for later`，旧写法仍然 pass 4 / fail 0，
 * 而这个渠道实际上已经完全不能主动投递了 —— 判据对「静默降级」恒绿，
 * 比没有判据更糟（它给人「已覆盖」的错觉）。
 *
 * 正确口径：只在 `capabilities: [...]` 的**数组字面量内容**里找该项。
 *
 * @param {string} source 该渠道源码全文
 * @returns {boolean}
 */
function declaresProactive(source) {
  const at = source.indexOf('describeDeliveryAccount');
  if (at < 0) return false;
  const capsMatch = source.slice(at).match(/capabilities:\s*\[([^\]]*)\]/);
  if (!capsMatch) return false;
  return /[~\x27"`]proactive-text-checked[~\x27"`]/.test(capsMatch[1]);
}
function inheritsTokenBotController(source) {
  return /extends\s+TokenBotController/.test(source);
}

/** 基类是否真的提供了声明（防止「继承了但基类没有」的假绿）。 */
async function baseClassDeclares() {
  const base = await readFile(resolve(CHANNELS, 'shared/token-bot-controller.mjs'), 'utf8');
  return /describeDeliveryAccount\s*\(/.test(base);
}
test('every channel that can send proactive text also declares its delivery account', async () => {
  const dirs = await channelDirectories();
  assert.ok(dirs.length >= 14, 'expected at least fourteen channels, got ' + dirs.length);
  const gaps = [];
  const baseHasDeclaration = await baseClassDeclares();
  for (const name of dirs) {
    const source = await channelSource(name);
    const canSend = /sendProactiveText\s*\(/.test(source);
    const declares = /describeDeliveryAccount\s*\(/.test(source)
      || (inheritsTokenBotController(source) && baseHasDeclaration);
    if (canSend && !declares) gaps.push(name + ': canSendProactive=true but no describeDeliveryAccount');
  }
  assert.deepEqual(gaps, [], 'channels with capability but no declaration: ' + gaps.join(' | '));
});

test('a declaration without the capability is also a gap', async () => {
  const dirs = await channelDirectories();
  const overclaimed = [];
  for (const name of dirs) {
    const source = await channelSource(name);
    const declares = /describeDeliveryAccount\s*\(/.test(source);
    const canSend = /sendProactiveText\s*\(/.test(source);
    const claims = declaresProactive(source);
    if (declares && claims && !canSend) overclaimed.push(name);
  }
  assert.deepEqual(overclaimed, [], 'declared proactive but no implementation: ' + overclaimed.join(' | '));
});

test('new declarations go through the shared helper; the legacy one is grandfathered', async () => {
  // 口径校正（r18）：feishu 的实现早于 shared helper 存在，它自己 createHash 算指纹。
  // 判据不能要求历史实现立刻重构 —— 那会让「加判据」变成「顺手改别人代码」，
  // 而且它当前行为是对的（指纹同样由身份字段派生）。
  // 这里的分界是：**除 feishu 外**，任何新声明都必须走 shared helper，否则口径会飘
  // （各渠道自行决定键序、trim 规则、字段选择 => 同一个账号可能算出不同指纹）。
  const LEGACY = new Set(['feishu']);
  const dirs = await channelDirectories();
  const freelancers = [];
  for (const name of dirs) {
    const source = await channelSource(name);
    if (!/describeDeliveryAccount\s*\(/.test(source)) continue;
    if (LEGACY.has(name)) continue;
    const usesHelper = /deliveryAccountFingerprint/.test(source) && /deliveryAccountView/.test(source);
    if (!usesHelper) freelancers.push(name);
  }
  assert.deepEqual(freelancers, [], 'new declarations must use shared helper: ' + freelancers.join(' | '));
  // 反向：legacy 集合不能偷偷扩张 —— 有人想新加一个绕开 helper 的渠道，就先来改这一行。
  assert.ok(LEGACY.has('feishu'), 'legacy set must stay explicit');
});
test('a capability that exists only in prose is not a declaration (r18 实测补丁)', async () => {
  // 这条是补 r18 自己的洞：先前的 `claims = /proactive-text-checked/.test(source)` 是
  // **全文子串匹配** —— 注释里出现该字样就算声明。实测把 wecom 的数组清空、
  // 只留 `// proactive-text-checked reserved for later`，旧口径仍然 pass 4 / fail 0，
  // 而渠道实际已经完全不能主动投递。判据对「静默降级」恒绿，比没判据更糟。
  //
  // 现在的口径：该渠道若有 describeDeliveryAccount，则 capabilities **数组字面量**里
  // 必须能直接读到 proactive-text-checked；只出现在注释里不算。
  const dirs = await channelDirectories();
  const proseOnly = [];
  for (const name of dirs) {
    const source = await channelSource(name);
    const at = source.indexOf('describeDeliveryAccount');
    if (at < 0) continue;
    const arrayMatch = source.slice(at).match(/capabilities:\s*\[([^\]]*)\]/);
    const inArray = arrayMatch ? arrayMatch[1].includes('proactive-text-checked') : false;
    const inProse = /proactive-text-checked/.test(source);
    // office 没有 sendProactiveText，显式豁免（注册表 withoutDeliveryService: true）。
    if (name === 'office') continue;
    if (inProse && !inArray) proseOnly.push(name);
  }
  assert.deepEqual(proseOnly, [], 'capability appears only in prose, not in the array: ' + proseOnly.join(' | '));
});
test('declared capability keys are split into read and informational, never illegal', async () => {
  // 口径校正（r18 实测）：delivery-service 只 hard-read 两个键，但 feishu 另外声明了
  // exclusive-text-consumer / reply-text-checked / history-text-checked /
  // thread-history-text-checked —— 全仓无人读取。这**不是错误**：它们记录适配器真实语义
  // （谁独占消费、谁支持回复正文核对），将来接上消费者就能用。判据不能把「无人读取」判红，
  // 那会逼人删掉有效信息。要判的是「拼错或凭空造的键」。
  const KNOWN_INFORMATIONAL = new Set([
    'exclusive-text-consumer',
    'reply-text-checked',
    'history-text-checked',
    'thread-history-text-checked',
  ]);
  const serviceSource = await readFile(resolve(import.meta.dirname, '../plugin-src/host/delivery-service.mjs'), 'utf8');
  const read = new Set();
  for (const m of serviceSource.matchAll(/capabilities\?\.includes\(.([a-z-]+).\)/g)) read.add(m[1]);
  assert.ok(read.has('proactive-text-checked'));
  assert.ok(read.has('proactive-receipt-checked'));

  const dirs = await channelDirectories();
  const illegal = [];
  for (const name of dirs) {
    const source = await channelSource(name);
    const at = source.indexOf('describeDeliveryAccount');
    if (at < 0) continue;
    const capsMatch = source.slice(at).match(/capabilities:\s*\[([^\]]*)\]/);
    if (!capsMatch) continue;
    for (const m of capsMatch[1].matchAll(/.([a-z-]+)./g)) {
      const key = m[1];
      if (!read.has(key) && !KNOWN_INFORMATIONAL.has(key)) illegal.push(name + ' -> ' + key);
    }
  }
  assert.deepEqual(illegal, [], 'unknown capability keys: ' + illegal.join(' | '));
  // 反向：feishu 仍在声明那四个信息键 —— 若被删，说明有人被「无人读取」逼着删信息。
  const feishuSource = await channelSource('feishu');
  assert.ok(/exclusive-text-consumer/.test(feishuSource), 'feishu informational keys must not be deleted');
});
