import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inspectPersonaFile, openSeededPersonaProvider, savePersonaFile } from '../src/channels/shared/persona-store.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-seed-guard-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

//
// 「读不出来」和「本来就没有」是两件事，只有后者可以被写。
// 实测过的数据丢失：运营手改 `persona.json` 写了个尾逗号，播种逻辑把它当「没配」，
// 直接拿出厂卡覆盖 —— 用户唯一的自定义当场没了。
//
test('文件不存在：这是「没配」，写下出厂卡', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'persona.json');
    const provider = await openSeededPersonaProvider(path);
    assert.equal(provider.get().name, '大肥鱼');
    assert.match(await readFile(path, 'utf8'), /大肥鱼/u);
  });
});

test('坏 JSON：不覆盖，文件逐字保留，本次按无人设处理', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'persona.json');
    const broken = '{"version":1,"persona":{"name":"阿黄",}}';
    await writeFile(path, broken, 'utf8');
    const problems = [];
    const provider = await openSeededPersonaProvider(path, { onError: (t) => problems.push(t) });
    assert.equal(provider.get(), null);
    assert.equal(await readFile(path, 'utf8'), broken, '坏文件一个字都不许动');
    assert.equal(problems.length, 1);
  });
});

test('顶层不是对象：同样不覆盖', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'persona.json');
    await writeFile(path, '[1,2,3]', 'utf8');
    const provider = await openSeededPersonaProvider(path, { onError: () => {} });
    assert.equal(provider.get(), null);
    assert.equal(await readFile(path, 'utf8'), '[1,2,3]');
  });
});

test('读路径失败（路径是目录）也当成「存在但不可用」，不去写它', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'persona.json');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path);
    const state = await inspectPersonaFile(path, { onError: () => {} });
    assert.equal(state.present, true);
    assert.equal(state.damaged, true);
    assert.equal(state.persona, null);
  });
});

test('inspectPersonaFile 对好卡给出 present 且不 damaged', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'persona.json');
    await savePersonaFile(path, { name: '阿黄' });
    const state = await inspectPersonaFile(path, { onError: () => {} });
    assert.equal(state.present, true);
    assert.equal(state.damaged, false);
    assert.equal(state.persona.name, '阿黄');
  });
});
