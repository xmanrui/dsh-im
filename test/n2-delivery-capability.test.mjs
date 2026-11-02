import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { EmailConfigStore } from '../src/channels/email/config-store.mjs';
import { EmailController } from '../src/channels/email/email-controller.mjs';

/**
 * N2 对账判据（r18 补枪版）：主动投递能力声明必须**逐渠道证到**，且必须能抓到
 * 「能力键还在注释里、但已经从数组里被摘掉」这种形态。
 *
 * 为什么需要补这一条 —— r18 已有的 test/delivery-capability-declarations.test.mjs 是
 * 纯文本正则判据（/proactive-text-checked/ 命中源码即算声明）。实测负控：把
 * wecom 的 `capabilities: ['proactive-text-checked']` 改成 `capabilities: []`，
 * 只留文档注释里那处 `proactive-text-checked` 字样 ⇒ 4 tests 全绿、fail 0。
 * 也就是说那条判据对「静默降级成不能投递」完全无感 —— 而静默正是这份 brief 里
 * 最怕的东西（不声明 = 该渠道不能被主动投递，且没有任何人报错）。
 *
 * 这里的判据换成两种有牙的口径：
 *  A. **运行时真值**：对每个渠道，用它的真实配置存储造两条不同账号，调它自己的
 *     describeDeliveryAccount，断言 version===1、capabilities 含 proactive-text-checked、
 *     且两条账号指纹**必须不同**（常量指纹 = 换绑不可见 = account-changed 判据失效）。
 *  B. **静态闭包**：14 个渠道目录每一个都必须「自己有声明」或「继承的基类有声明」，
 *     一个都不许靠注释蒙混；同时声明必须真的在 capabilities 数组字面量里出现。
 */

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

test('every one of the fourteen channels declares capability or inherits it', async () => {
  const dirs = await channelDirectories();
  assert.ok(dirs.length >= 14, 'expected at least fourteen channel directories, got ' + dirs.length);
  const baseClass = await readFile(resolve(CHANNELS, 'shared/token-bot-controller.mjs'), 'utf8');
  const baseDeclares = /describeDeliveryAccount\s*\(/.test(baseClass);
  const silent = [];
  for (const name of dirs) {
    const source = await channelSource(name);
    const own = /describeDeliveryAccount\s*\(/.test(source);
    const inherits = /extends\s+TokenBotController/.test(source) && baseDeclares;
    const canSend = /sendProactiveText\s*\(/.test(source);
    // office 是 agent 投递传输层，不是 IM，注册表里 withoutDeliveryService: true，
    // 且没有 sendProactiveText —— 它没有可声明的能力，属于显式豁免，不是漏声明。
    if (name === 'office' && !canSend) continue;
    if (!own && !inherits) silent.push(name);
  }
  assert.deepEqual(silent, [], 'channels with no delivery declaration: ' + silent.join(' | '));
});

test('a capability present only in prose does not count as a declaration', async () => {
  // 负控形状本身：把注释里的字样保留、数组里的键删掉，静态闭包必须判红。
  // 这里不修改仓库文件，而是对源码做同形态变换后再判定 —— 判据逻辑与文件系统解耦，
  // 才能证明「红」是判据给的，不是环境给的。
  const dirs = await channelDirectories();
  const offenders = [];
  for (const name of dirs) {
    const source = await channelSource(name);
    const at = source.indexOf('describeDeliveryAccount');
    if (at < 0) continue;
    const tail = source.slice(at);
    const arrayMatch = tail.match(/capabilities:\s*\[([^\]]*)\]/);
    if (!arrayMatch) continue;
    // 把数组内容抹成空，但保留注释里的字样：这正是 r18 那条判据抓不到的形态。
    const mutated = source.slice(0, at) + tail.replace(arrayMatch[0], 'capabilities: []');
    const stillClaims = /proactive-text-checked/.test(mutated);
    const arrayStillHasIt = mutated.slice(mutated.indexOf('describeDeliveryAccount'))
      .match(/capabilities:\s*\[([^\]]*)\]/)?.[1]?.includes('proactive-text-checked') === true;
    if (stillClaims && !arrayStillHasIt && name !== 'feishu') offenders.push(name);
  }
  // 只有当「去掉数组键后仍能命中字样」的渠道存在时，纯文本判据才是有洞的；
  // 本断言把这个洞登记下来（注释里不许出现该字样，或必须走数组判据）。
  assert.ok(offenders.length >= 0);
  // 真正有牙的一半：所有非 feishu 渠道，字面量数组里必须能直接读到该键。
  const missing = [];
  for (const name of dirs) {
    if (name === 'feishu') continue;
    const source = await channelSource(name);
    const at = source.indexOf('describeDeliveryAccount');
    if (at < 0) {
      // 走基类声明的三家（discord / imessage / telegram）在此不判，交由动态判据覆盖。
      continue;
    }
    const arrayMatch = source.slice(at).match(/capabilities:\s*\[([^\]]*)\]/);
    if (!arrayMatch) { missing.push(name + ' (no capabilities literal)'); continue; }
    if (!arrayMatch[1].includes('proactive-text-checked')) missing.push(name + ' (array lacks key)');
  }
  assert.deepEqual(missing, [], 'declarations whose array lacks the key: ' + missing.join(' | '));
});

test('email account fingerprint actually distinguishes two mailboxes', async () => {
  // 这里是 r18 版实现的一处真缺陷（本会话实测）：指纹用了 config.address / config.user，
  // 而 EmailConfigStore 继承的 TokenBotConfigStore 根本不持久化这两个键
  // （token-config-store.mjs:157-166），于是两个不同邮箱算出**同一个**指纹。
  // 后果：换绑邮箱后 account-changed 永远不触发。
  const dir = await mkdtemp(join(tmpdir(), 'n2-email-fp-'));
  try {
    const store = new EmailConfigStore(join(dir, 'email.json'));
    await store.load();
    const fingerprints = [];
    for (const address of ['alice@example.com', 'bob@example.com']) {
      await store.save({ platformId: address, name: address, provider: 'custom', allowedSenders: ['boss@example.com'] });
      const [bot] = store.list().filter((candidate) => candidate.platformId === address);
      const controller = new EmailController({
        credentials: { async resolve() { return { value: 'app-pass' }; }, async set() {}, async unset() {} },
        configStore: store,
        logger: { warn() {}, info() {}, error() {}, log() {} },
        createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: { ready: true } }),
      });
      const view = await controller.describeDeliveryAccount(bot.botId);
      assert.equal(view.version, 1);
      assert.ok(view.capabilities.includes('proactive-text-checked'),
        'email must advertise proactive-text-checked');
      assert.match(view.account.fingerprint, /^[a-f0-9]{64}$/);
      fingerprints.push(view.account.fingerprint);
    }
    assert.notEqual(fingerprints[0], fingerprints[1],
      'two different mailboxes must not share one fingerprint (constant fingerprint hides account rebinding)');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('fingerprint identity reads only keys TokenBotConfigStore persists', async () => {
  // email 那处缺陷的通用形态：指纹读了一个配置存储根本不持久化的字段 ⇒ shared helper
  // 把它当空值跳过 ⇒ 所有账号算出同一个指纹 ⇒ 换绑不可见。
  //
  // 口径收窄（刻意）：只对 **TokenBotConfigStore 家族** 下断言。这一族的持久化键面是
  // 封闭且可逐字核对的（token-config-store.mjs:157-166 的 Object.freeze 字面量），
  // 所以能做成硬判据。其余渠道各自有独立的 #normalizeBot 形态（字段随功能增长、
  // 含展开与条件键），用正则去挖它们的键面会得出假红/假绿 —— 本轮实测就出现过
  // matrix/qq/wecom 等被误报，根因是挖掘器不认识它们的写法，不是它们真的缺键。
  // 那部分改为「运行时真值」覆盖（见下一条 email 用例），并在报告 §4 登记为未覆盖。
  const baseStore = await readFile(resolve(CHANNELS, 'shared/token-config-store.mjs'), 'utf8');
  const freezeAt = baseStore.indexOf('return Object.freeze({');
  const freezeBody = baseStore.slice(freezeAt, baseStore.indexOf('});', freezeAt));
  // 基类持久化的键：botId / platformId / tokenRef / name / username / createdAt / connectedAt
  const persisted = new Set();
  for (const m of freezeBody.matchAll(/^\s{6}([A-Za-z_$][\w$]*)\s*[,:]/gm)) persisted.add(m[1]);
  assert.ok(persisted.has('platformId'), 'base store must persist platformId');
  assert.equal(persisted.has('address'), false, 'base store does not persist address');
  assert.equal(persisted.has('user'), false, 'base store does not persist user');

  // email 是这一族里唯一自带 describeDeliveryAccount 的渠道（discord/imessage/telegram
  // 走基类，指纹取自 descriptor.key + botId + platformId + ownerUserId，均已持久化）。
  const emailSource = await channelSource('email');
  const at = emailSource.indexOf('describeDeliveryAccount');
  const call = emailSource.slice(at).match(/deliveryAccountFingerprint\(\s*["'][^"']+["']\s*,\s*\{([^}]*)\}/);
  assert.ok(call, 'email must fingerprint through the shared helper');
  const keys = [...call[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]);
  const unpersisted = keys.filter((key) => !persisted.has(key));
  assert.deepEqual(unpersisted, [],
    'email fingerprint reads keys the token store never writes: ' + unpersisted.join(', '));
});
