import assert from 'node:assert/strict';
import test from 'node:test';

import { MEMORY_KINDS, extractMemoryCandidates, renderCandidate } from '../src/channels/shared/memory-extract.mjs';

/**
 * Widening what counts as a memory is how a system starts inventing them, so
 * every new rule is pinned twice: once for what it must catch, once for what it
 * must ignore. The second half is what protects the bot from confidently
 * repeating something nobody said.
 */
const ANON = 'uia-unverified:row';

function objectsOf(text) {
  return extractMemoryCandidates(text, { speaker: ANON }).map((candidate) => renderCandidate(candidate));
}

test('拥有物：养了 / 有，带不带量词都认得', () => {
  assert.deepEqual(objectsOf('我养了只橘猫'), ['群里有人有橘猫']);
  assert.deepEqual(objectsOf('我有一台咖啡机'), ['群里有人有咖啡机']);
  assert.deepEqual(objectsOf('我养着一缸鱼'), ['群里有人有一缸鱼']);
});

test('近况：最近在 / 最近一直在', () => {
  assert.deepEqual(objectsOf('我最近在学吉他'), ['群里有人最近在学吉他']);
  assert.deepEqual(objectsOf('我最近一直在跑步'), ['群里有人最近在跑步']);
});

test('半句话不抽：只有动词没有宾语时什么都不记', () => {
  assert.deepEqual(objectsOf('我有'), []);
  assert.deepEqual(objectsOf('我最近'), []);
  assert.deepEqual(objectsOf('我养了'), []);
});

test('闲聊不抽：不锚定在我身上的句子一条都不记', () => {
  assert.deepEqual(objectsOf('今天天气不错'), []);
  assert.deepEqual(objectsOf('这个功能挺好用的'), []);
  assert.deepEqual(objectsOf('他养了只猫'), []);
});

test('新增的两种 kind 已登记，store 与渲染不会拿到未声明的类型', () => {
  assert.ok(MEMORY_KINDS.includes('possession'));
  assert.ok(MEMORY_KINDS.includes('activity'));
  assert.equal(new Set(MEMORY_KINDS).size, MEMORY_KINDS.length, 'kind 不得重复');
});

test('有名有姓时仍用「名字：原文」，新规则也不例外', () => {
  const named = extractMemoryCandidates('我最近在学吉他', { speaker: '小李' }).map((c) => renderCandidate(c));
  assert.deepEqual(named, ['小李：学吉他']);
});

test('显式记住是唯一指令：同一句里不再叠出半截的其它事实', () => {
  // 实测拦下的真缺陷：让记住 + 我有 同时命中时，note 是对的，
  // 但 possession 把「例会」当成「我有的东西」，还各自占一行记忆。
  const rows = extractMemoryCandidates('记住 周三下午我有例会', { speaker: ANON });
  assert.deepEqual(rows.map((c) => c.kind), ['note']);
  assert.deepEqual(rows.map((c) => renderCandidate(c)), ['有人让你记住：周三下午我有例会']);
});

test('没有显式记住时，正常句子仍可给出多条不同类型的事实', () => {
  const rows = extractMemoryCandidates('我叫小李，我最近在学吉他', { speaker: ANON });
  assert.deepEqual(rows.map((c) => c.kind).sort(), ['activity', 'identity']);
});

test('单个汉字也是完整的宾语：中文里「茶」「猫」就是东西本身', () => {
  // 实测：两字的捕获下限把最自然的说法整条丢掉（我喜欢茶 / 我养猫 / 我怕冷）。
  assert.deepEqual(objectsOf('我喜欢茶'), ['群里有人喜欢茶']);
  assert.deepEqual(objectsOf('我养猫'), ['群里有人有猫']);
  assert.deepEqual(objectsOf('我有猫'), ['群里有人有猫']);
});

test('放宽字数后仍然一句闲聊都不多抽', () => {
  assert.deepEqual(objectsOf('今天天气不错'), []);
  assert.deepEqual(objectsOf('这个功能挺好用的'), []);
  assert.deepEqual(objectsOf('他养了只猫'), []);
  assert.deepEqual(objectsOf('她说她怕冷'), []);
  // 只有动词没有宾语，什么都不记。
  assert.deepEqual(objectsOf('我喜欢'), []);
  assert.deepEqual(objectsOf('我有'), []);
});

test('命令与它的参数都不算陈述：operator 说的话不能被记成群友的喜好', () => {
  // 实测：`/steer 我喜欢咖啡` 曾被抽成「群里有人喜欢咖啡」——把指令当成了事实。
  assert.deepEqual(objectsOf('/steer 我喜欢咖啡'), []);
  assert.deepEqual(objectsOf('/dsh 我喜欢咖啡'), []);
  assert.deepEqual(objectsOf('/remember 我养猫'), []);
});

test('地址与路径不进记忆：它们是噪音，还会被原样复述出来', () => {
  assert.deepEqual(objectsOf('看这个 https://example.com/doc 挺有用'), []);
  assert.deepEqual(objectsOf('文件在 D:\\work\\a.txt 里'), []);
  // 删掉地址，句子的其余部分仍然成立。
  assert.deepEqual(objectsOf('我喜欢看 https://a.com 的教程'), ['群里有人喜欢看的教程']);
});

test('删掉地址后不留多余空格与悬空助词', () => {
  const [only] = extractMemoryCandidates('我喜欢看 https://a.com 的教程', { speaker: ANON });
  assert.equal(renderCandidate(only), '群里有人喜欢看的教程');
  assert.equal(/\s{2,}/u.test(only.object), false);
});
