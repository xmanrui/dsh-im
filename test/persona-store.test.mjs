import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PERSONA } from '../src/channels/shared/persona.mjs';
import { loadPersonaFile, openPersonaProvider, savePersonaFile } from '../src/channels/shared/persona-store.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-persona-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('缺失文件不是错误，只是「没配人设」', async () => {
  await withTempDir(async (dir) => {
    assert.equal(await loadPersonaFile(join(dir, 'persona.json')), null);
  });
});

test('保存后能读回，且落盘是 version + persona 信封', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'persona.json');
    await savePersonaFile(path, { ...DEFAULT_PERSONA, name: '阿黄' });
    const raw = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.persona.name, '阿黄');
    const loaded = await loadPersonaFile(path);
    assert.equal(loaded.persona.name, '阿黄');
  });
});

test('坏 JSON 不抛错，报一次诊断后按无人设处理', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'persona.json');
    await writeFile(path, '{not json', 'utf8');
    const problems = [];
    const loaded = await loadPersonaFile(path, { onError: (text) => problems.push(text) });
    assert.equal(loaded, null);
    assert.equal(problems.length, 1);
  });
});

test('保存会拒绝非法人设，且不留下半截文件', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'persona.json');
    await assert.rejects(() => savePersonaFile(path, { name: 'a', bogus: 1 }), (error) => error.code === 'persona-invalid');
    assert.equal(await loadPersonaFile(path), null);
  });
});

test('provider 读一次就缓存，save 立刻让下一条回复用上新卡', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'persona.json');
    const provider = await openPersonaProvider(path);
    assert.equal(provider.get(), null);
    await provider.save({ name: '阿黄' });
    assert.equal(provider.get().name, '阿黄');
    // Another writer changes the file; refresh is what makes it visible.
    await savePersonaFile(path, { name: '阿黄2' });
    assert.equal(provider.get().name, '阿黄');
    await provider.refresh();
    assert.equal(provider.get().name, '阿黄2');
  });
});

test('文件被删后 refresh 关掉人设，不留旧卡', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'persona.json');
    await savePersonaFile(path, { name: '阿黄' });
    const provider = await openPersonaProvider(path);
    assert.equal(provider.get().name, '阿黄');
    await rm(path);
    await provider.refresh();
    assert.equal(provider.get(), null);
  });
});
