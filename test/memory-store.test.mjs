import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MEMORY_DOCUMENT_VERSION, MemoryStore, renderMemoryBlock } from '../src/channels/shared/memory-store.mjs';

const SCOPE = 'weixin:bot_main:group_12345';
const T0 = Date.UTC(2026, 9, 30, 8, 0, 0);
const DAY = 86_400_000;

/**
 * 每个用例一个独立临时目录。清理必须「先关库、再删目录」：Windows 上 SQLite 还开着时
 * 删 memory.sqlite / -wal 会抛 EBUSY，而 node:test 的多个 t.after 按注册顺序执行，
 * 所以关库与删目录都塞进同一个 after 里，由这里按正确顺序收尾。
 */
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-store-'));
  const stores = [];
  /** 建一个绑定到本用例临时目录的 MemoryStore，并登记到清理列表。 */
  const open = (options = {}) => {
    const store = new MemoryStore(root, { logger: silentLogger, ...options });
    stores.push(store);
    return store;
  };
  t.after(async () => {
    for (const store of stores) {
      try { await store.close(); } catch { /* 已关闭的实例重复 close 无副作用 */ }
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, open };
}

/** 可推进的假时钟：索引值必须是毫秒整数，所以只做加法。 */
function fakeClock(start = T0) {
  let value = start;
  const now = () => value;
  now.advance = (ms) => { value += ms; return value; };
  return now;
}

/** 静音 logger：降级用例会触发一次 warn，不该污染测试输出。 */
const silentLogger = { warn() {}, error() {}, log() {} };

/** 直接读库文件做断言，用于验证「历史行还在、只是被封口」这类内部状态。 */
function readRows(root, sql, ...params) {
  const db = new DatabaseSync(join(root, 'memory.sqlite'));
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

test('remember 写入后 recall 能读回同一事实（含 score 与全部字段）', async (t) => {
  const { open } = await setup(t);
  const store = open({ now: fakeClock() });
  await store.ready();
  // 本机 SQLite 带 FTS5，这里顺带把「FTS 真的装上了」钉住。
  assert.equal(store.ftsAvailable, true);
  // 公开时钟就是注入的那个：recall 的 now 默认值取自它。
  assert.equal(store.now(), T0);

  const fact = await store.remember({
    scope: SCOPE, subject: '老大', predicate: '宠物', object: '狗叫豆豆',
    sourceMessageId: 'msg-1', confidence: 0.8,
  });
  // 返回对象是写入意图的快照：新行没有失效标记，时间戳等于注入的时钟。
  assert.match(fact.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(
    { ...fact, id: 'x' },
    {
      id: 'x', scope: SCOPE, subject: '老大', predicate: '宠物', object: '狗叫豆豆',
      validFrom: T0, validTo: null, supersededBy: null, sourceMessageId: 'msg-1', confidence: 0.8,
    },
  );

  // 4 个汉字能被 trigram 索引，走的是 FTS 路径。
  const hits = await store.recall({ scope: SCOPE, query: '狗叫豆豆' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, fact.id);
  assert.equal(hits[0].object, '狗叫豆豆');
  assert.ok(hits[0].score > 0, 'score 必须为正数');

  // 查不到的词返回空数组，不是 null。
  assert.deepEqual(await store.recall({ scope: SCOPE, query: '完全无关的词' }), []);
  // 非字符串 query 不炸，直接当空查询处理。
  assert.deepEqual(await store.recall({ scope: SCOPE, query: null }), []);
});

test('两个汉字的短词在 FTS 下查不到时自动退回 LIKE', async (t) => {
  const { open } = await setup(t);
  const store = open({ now: fakeClock() });
  await store.remember({ scope: SCOPE, subject: '老大', predicate: '宠物', object: '老大的狗叫豆豆' });

  // trigram 分词器索引不了 2 个汉字，FTS 返回空 -> 必须由 LIKE 兜住，否则记忆就丢了。
  const hits = await store.recall({ scope: SCOPE, query: '豆豆' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].object, '老大的狗叫豆豆');
});

test('supersede：旧事实查不到、新事实查得到，但旧行仍留在库里', async (t) => {
  const { root, open } = await setup(t);
  const clock = fakeClock();
  const store = open({ now: clock });
  await store.ready();

  const oldFact = await store.remember({ scope: SCOPE, subject: '老大', predicate: '宠物', object: '养了一只狗叫豆豆' });
  clock.advance(DAY);
  const newFact = await store.remember({ scope: SCOPE, subject: '老大', predicate: '宠物', object: '改养了一只猫叫雪球' });

  // 召回只取 valid_to IS NULL：旧对象在新事实产生后就再也查不到。
  assert.deepEqual(await store.recall({ scope: SCOPE, query: '豆豆' }), []);
  const current = await store.recall({ scope: SCOPE, query: '雪球' });
  assert.equal(current.length, 1);
  assert.equal(current[0].id, newFact.id);

  const stats = await store.stats(SCOPE);
  assert.deepEqual(stats, { facts: 2, activeFacts: 1, slots: 0 });
  await store.close();

  // 直接读库验证 Zep 语义：旧行没被删，只是被封口并记下被谁取代。
  const rows = readRows(root, 'SELECT * FROM facts ORDER BY valid_from');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, oldFact.id);
  assert.equal(rows[0].valid_to, newFact.validFrom);
  assert.equal(rows[0].superseded_by, newFact.id);
  assert.equal(rows[1].valid_to, null);
  assert.equal(rows[1].superseded_by, null);
});

test('时间衰减让同样相关的老事实排在后面', async (t) => {
  const { open } = await setup(t);
  const clock = fakeClock();
  const store = open({ now: clock });

  // 两条事实内容相同、主语不同，避免触发 supersede，两者都保持有效。
  const stale = await store.remember({ scope: SCOPE, subject: '老大', predicate: '偏好', object: '喜欢喝冰美式咖啡' });
  clock.advance(60 * DAY);
  const fresh = await store.remember({ scope: SCOPE, subject: '老二', predicate: '偏好', object: '喜欢喝冰美式咖啡' });

  // 用「新事实诞生那天」作为打分时刻：老事实 60 天前，衰减前要排在后面。
  const hits = await store.recall({ scope: SCOPE, query: '冰美式咖啡', now: clock() });
  assert.deepEqual(hits.map((hit) => hit.id), [fresh.id, stale.id]);
  assert.ok(hits[0].score > hits[1].score, '新事实分数必须高于老事实');
  // 衰减是指数而非硬截断：老事实仍然被召回，不会因为旧就消失。
  assert.ok(hits[1].score > 0);
});

test('slots：未过期可读、TTL 到期后消失、同名覆盖取新值', async (t) => {
  const { open } = await setup(t);
  const clock = fakeClock();
  const store = open({ now: clock });

  await store.setSlot(SCOPE, 'tone', '说话损一点', { ttlMs: 1000 });
  await store.setSlot(SCOPE, 'group_vibe', '群友都在聊显卡');

  // TTL 未到：两个槽位都在，值和时间戳都能读回。
  assert.deepEqual(await store.slots(SCOPE), {
    group_vibe: { value: '群友都在聊显卡', updatedAt: T0 },
    tone: { value: '说话损一点', updatedAt: T0 },
  });

  // 时钟推进 2 秒后，只带 TTL 的那个槽位过期，永不失效的仍在。
  clock.advance(2000);
  assert.deepEqual(await store.slots(SCOPE), {
    group_vibe: { value: '群友都在聊显卡', updatedAt: T0 },
  });
  assert.equal((await store.stats(SCOPE)).slots, 1);

  // 同名再写：值被替换，时间戳更新，且新的 TTL 从新写入时刻重新起算。
  clock.advance(1000);
  await store.setSlot(SCOPE, 'group_vibe', '换话题了：聊考研', { ttlMs: 5000 });
  const slots = await store.slots(SCOPE);
  assert.deepEqual(slots.group_vibe, { value: '换话题了：聊考研', updatedAt: clock() });

  // 空值不接受（槽位有值才叫槽位）。
  await assert.rejects(store.setSlot(SCOPE, 'tone', '   '), (error) => error.code === 'memory-slot-invalid');
});

test('renderMemoryBlock：空输入返回空串，非空按整行拼接与截断', async (t) => {
  const { open } = await setup(t);
  const store = open({ now: fakeClock() });

  // 全空（无事实、无槽位）返回空串，调用方可以直接拼进 prompt。
  assert.equal(renderMemoryBlock([], {}), '');
  assert.equal(renderMemoryBlock(null, null), '');
  assert.equal(renderMemoryBlock([{ object: '   ' }], { a: { value: '' } }), '');

  await store.remember({ scope: SCOPE, subject: '老大', predicate: '宠物', object: '狗叫豆豆' });
  await store.setSlot(SCOPE, 'group_vibe', '群友喜欢聊显卡');
  const facts = await store.recall({ scope: SCOPE, query: '狗叫豆豆' });
  const slots = await store.slots(SCOPE);

  const block = renderMemoryBlock(facts, slots);
  assert.equal(block, [
    '## 你记得的事',
    '- 狗叫豆豆（2026-10-30 记）',
    '## 你对这个群的印象',
    '- 群友喜欢聊显卡',
  ].join('\n'));

  // 超长时按整行截断：上限正好等于首个标题行的 8 个字符，只输出标题，不留半行。
  assert.equal('## 你记得的事'.length, 8);
  assert.equal(renderMemoryBlock(facts, slots, { maxChars: 8 }), '## 你记得的事');
  // 上限比标题行还短就什么都不输出，绝不吐出半句。
  assert.equal(renderMemoryBlock(facts, slots, { maxChars: 7 }), '');
  assert.equal(renderMemoryBlock(facts, slots, { maxChars: 2 }), '');
  // 只留得下「标题 + 第一条事实」的上限：截断点是整行，不是字符。
  const twoLines = renderMemoryBlock(facts, slots, { maxChars: 30 });
  assert.equal(twoLines, '## 你记得的事\n- 狗叫豆豆（2026-10-30 记）');
  assert.ok(twoLines.length <= 30);
});

test('非法 scope / 非法槽位名被拒绝，错误带 code', async (t) => {
  const { open } = await setup(t);
  const store = open({ now: fakeClock() });

  // 空白、引号、通配符、中文、超长都进不了库；每一条读路径也必须一起挡住。
  const invalidScopes = ['', 'has space', "quote'", 'star*', '中文scope', 'x'.repeat(257)];
  for (const scope of invalidScopes) {
    await assert.rejects(
      store.remember({ scope, subject: 'a', predicate: 'b', object: 'c' }),
      (error) => error.code === 'memory-scope-invalid',
    );
    await assert.rejects(store.recall({ scope, query: 'x' }), (error) => error.code === 'memory-scope-invalid');
    await assert.rejects(store.slots(scope), (error) => error.code === 'memory-scope-invalid');
    await assert.rejects(store.setSlot(scope, 'a', 'b'), (error) => error.code === 'memory-scope-invalid');
    await assert.rejects(store.stats(scope), (error) => error.code === 'memory-scope-invalid');
    await assert.rejects(store.prune({ scope }), (error) => error.code === 'memory-scope-invalid');
  }

  // 合法 scope 的边界值仍然可用（256 个字符正好卡在上限上）。
  await store.remember({ scope: 'a'.repeat(256), subject: 's', predicate: 'p', object: 'o' });
  assert.equal((await store.stats('a'.repeat(256))).facts, 1);

  // 槽位名同样白名单，并挡掉会污染对象原型的保留名。
  for (const name of ['has space', '__proto__', 'constructor', '']) {
    await assert.rejects(store.setSlot(SCOPE, name, 'v'), (error) => error.code === 'memory-slot-invalid');
  }
  // 缺字段的事实也拒绝，不会写进一条空事实。
  await assert.rejects(store.remember({ scope: SCOPE, subject: '   ', predicate: 'p', object: 'o' }),
    (error) => error.code === 'memory-fact-invalid');
});

test('写缓冲：阈值以下不落盘，但任何读操作前都会先 flush', async (t) => {
  const { root, open } = await setup(t);
  const store = open({ now: fakeClock(), flushThreshold: 16 });

  // 3 条远低于阈值 16：此时数据还在内存缓冲里，磁盘上一条都没有。
  for (const name of ['豆豆', '雪球', '煤球']) {
    await store.remember({ scope: SCOPE, subject: '老大', predicate: '宠物', object: '狗叫' + name });
  }
  assert.equal(readRows(root, 'SELECT id FROM facts').length, 0, '阈值未到不该写库');

  // recall 之前先 flush，所以缓冲里的数据读得到。
  const hits = await store.recall({ scope: SCOPE, query: '煤球' });
  assert.equal(hits.length, 1);
  assert.equal(readRows(root, 'SELECT id FROM facts').length, 3, '读之前必须把缓冲落盘');
});

test('close 会 flush 缓冲，之后再用抛 memory-store-closed', async (t) => {
  const { root, open } = await setup(t);
  const store = open({ now: fakeClock(), flushThreshold: 16 });
  await store.remember({ scope: SCOPE, subject: '老大', predicate: '宠物', object: '狗叫豆豆' });
  await store.setSlot(SCOPE, 'tone', '客气点');
  await store.close();
  // 重复 close 无副作用。
  await store.close();

  // close 之后的写操作一律拒绝，不会静默丢数据。
  await assert.rejects(store.remember({ scope: SCOPE, subject: 'a', predicate: 'b', object: 'c' }),
    (error) => error.code === 'memory-store-closed');

  // 缓冲确实落盘了：重新打开一个新实例能读回刚才那条事实与槽位。
  const reopened = open({ now: fakeClock() });
  assert.equal((await reopened.recall({ scope: SCOPE, query: '狗叫豆豆' })).length, 1);
  assert.deepEqual(await reopened.slots(SCOPE), { tone: { value: '客气点', updatedAt: T0 } });
  // schema 版本写在 user_version 里。
  const version = readRows(root, 'PRAGMA user_version')[0].user_version;
  assert.equal(version & 0x3fff_ffff, MEMORY_DOCUMENT_VERSION);
});

test('forget 硬删一条，prune 只清过期已失效的历史', async (t) => {
  const { root, open } = await setup(t);
  const clock = fakeClock();
  const store = open({ now: clock });

  const keeper = await store.remember({ scope: SCOPE, subject: '老二', predicate: '宠物', object: '养了只仓鼠叫团子' });
  const doomed = await store.remember({ scope: SCOPE, subject: '老三', predicate: '宠物', object: '养了只乌龟叫慢慢' });
  assert.equal(await store.forget(SCOPE, doomed.id), true);
  // 删第二次返回 false，不装成功。
  assert.equal(await store.forget(SCOPE, doomed.id), false);
  // 跨 scope 删不到别人的数据。
  assert.equal(await store.forget('weixin:bot_main:other', keeper.id), false);
  assert.equal((await store.stats(SCOPE)).facts, 1);

  // 造一条已失效的历史行：同一三元组写两次，旧行被 supersede（此时库里共 3 行）。
  const superseded = await store.remember({ scope: SCOPE, subject: '老大', predicate: '宠物', object: '早先养过金鱼' });
  clock.advance(DAY);
  const current = await store.remember({ scope: SCOPE, subject: '老大', predicate: '宠物', object: '现在养狗了' });
  assert.deepEqual(await store.stats(SCOPE), { facts: 3, activeFacts: 2, slots: 0 });

  // 才过 1 天，未超 90 天保留期：一条都不删（含已失效的那行）。
  assert.equal(await store.prune({ scope: SCOPE, maxAgeDays: 90 }), 0);
  clock.advance(100 * DAY);
  // 超过 90 天后，已失效的旧行被清掉，仍然有效的两条事实一条不动。
  assert.equal(await store.prune({ scope: SCOPE, maxAgeDays: 90 }), 1);
  const after = readRows(root, 'SELECT id FROM facts').map((row) => row.id);
  assert.deepEqual(after.sort(), [keeper.id, current.id].sort());
  assert.equal(after.includes(superseded.id), false);
});

test('FTS5 不可用时降级为 LIKE，且降级标记在重开库后保留', async (t) => {
  const { root, open } = await setup(t);
  // 注入方式：预先在库文件里放一张同名的普通表 facts_fts。
  // 这样 CREATE VIRTUAL TABLE IF NOT EXISTS 会静默「成功」，而随后的 MATCH 探测必然报
  // "no such column: facts_fts" —— 等价于本机没有 FTS5 时的失败路径，且完全确定、无需跳过用例。
  const seed = new DatabaseSync(join(root, 'memory.sqlite'));
  seed.exec('CREATE TABLE facts_fts (placeholder TEXT)');
  seed.close();

  const store = open({ now: fakeClock() });
  await store.ready();
  assert.equal(store.ftsAvailable, false, '探测失败必须置 ftsAvailable=false');

  // 降级后读写照常：写入不炸，召回走 LIKE。
  const fact = await store.remember({ scope: SCOPE, subject: '老大', predicate: '宠物', object: '老大的狗叫豆豆' });
  const hits = await store.recall({ scope: SCOPE, query: '豆豆' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, fact.id);
  // LIKE 路径也必须只返回当前事实：supersede 之后旧对象查不到。
  await store.remember({ scope: SCOPE, subject: '老大', predicate: '宠物', object: '改养猫叫雪球了' });
  assert.deepEqual(await store.recall({ scope: SCOPE, query: '豆豆' }), []);
  assert.equal((await store.recall({ scope: SCOPE, query: '雪球' })).length, 1);
  // LIKE 的通配符必须被转义：% 当字面量查，否则一次 % 就把全表捞出来。
  assert.deepEqual(await store.recall({ scope: SCOPE, query: '%' }), []);
  await store.close();

  // 降级标记写进 user_version 高位：重开库时不再重新探测 FTS。
  assert.notEqual(readRows(root, 'PRAGMA user_version')[0].user_version & 0x4000_0000, 0);
  const reopened = open({ now: fakeClock() });
  assert.equal(reopened.ftsAvailable, false);
  assert.equal((await reopened.recall({ scope: SCOPE, query: '雪球' })).length, 1);
});

test('scope 之间互相隔离，数据持久化在 root/memory.sqlite', async (t) => {
  const { open } = await setup(t);
  const first = open({ now: fakeClock() });
  await first.remember({ scope: 'weixin:botA:group_1', subject: '老大', predicate: '宠物', object: '狗叫豆豆' });
  await first.remember({ scope: 'weixin:botB:group_1', subject: '老大', predicate: '宠物', object: '猫叫雪球' });
  await first.close();

  const second = open({ now: fakeClock() });
  // 同一个库文件、两个 scope 各读各的，谁也看不到谁。
  assert.deepEqual((await second.recall({ scope: 'weixin:botA:group_1', query: '豆豆' })).map((hit) => hit.object), ['狗叫豆豆']);
  assert.deepEqual((await second.recall({ scope: 'weixin:botB:group_1', query: '雪球' })).map((hit) => hit.object), ['猫叫雪球']);
  assert.deepEqual(await second.recall({ scope: 'weixin:botA:group_1', query: '雪球' }), []);
});