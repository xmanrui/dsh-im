import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PERSONA } from '../src/channels/shared/persona.mjs';
import { openSeededPersonaProvider, savePersonaFile } from '../src/channels/shared/persona-store.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-persona-seed-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('第一次打开就写下出厂人设：没配过也不当无名助手', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'persona.json');
    const provider = await openSeededPersonaProvider(path);
    assert.equal(provider.get().name, DEFAULT_PERSONA.name);
  });
});

test('已存在的卡绝不被覆盖：空卡就是空卡', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'persona.json');
    await savePersonaFile(path, { name: '阿黄' });
    const provider = await openSeededPersonaProvider(path);
    assert.equal(provider.get().name, '阿黄');
  });
});

test('写不进盘时报一次诊断，仍可继续回答', async () => {
  await withTempDir(async (dir) => {
    // A regular file where a directory must be makes both read and write fail.
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'x', 'utf8');
    const problems = [];
    const provider = await openSeededPersonaProvider(join(blocker, 'persona.json'), {
      onError: (text) => problems.push(text),
    });
    assert.equal(provider.get(), null);
    assert.equal(problems.length, 1);
  });
});
