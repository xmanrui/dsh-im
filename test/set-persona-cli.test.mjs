import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * The persona CLI is the only supported way to edit a card until the settings
 * page exists, so its refusal paths matter as much as its writes: a script that
 * silently writes a stray field would corrupt a card nobody can see.
 */
function withRoot(dir) {
  const root = join(dir, 'accounts');
  return { root, env: { ...process.env, DSH_WEIXIN_DATA_DIR: root } };
}

function run(env, ...args) {
  return execFileSync(process.execPath, ['scripts/set-persona.mjs', ...args], {
    env, encoding: 'utf8', cwd: process.cwd(),
  });
}

test('list shows an unconfigured bot as taking the shipped card', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-'));
  try {
    const { root, env } = withRoot(dir);
    await mkdir(join(root, 'wx_a'), { recursive: true });
    assert.match(run(env, '--list'), /wx_a\t\(未配置/u);
    await rm(dir, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('one --set merges onto the current card instead of replacing it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-'));
  try {
    const { root, env } = withRoot(dir);
    await mkdir(join(root, 'wx_a'), { recursive: true });
    run(env, '--bot', 'wx_a', '--set', 'personality=嘴贫但心不坏');
    const output = run(env, '--bot', 'wx_a', '--show');
    // The shipped name survives an edit that never mentioned it.
    assert.match(output, /"name": "大肥鱼"/u);
    assert.match(output, /"personality": "嘴贫但心不坏"/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unknown field fails loudly and writes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-'));
  try {
    const { root, env } = withRoot(dir);
    await mkdir(join(root, 'wx_a'), { recursive: true });
    assert.throws(() => run(env, '--bot', 'wx_a', '--set', 'nope=1'), /不认识的人设字段/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unknown bot is refused rather than creating a stray account', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-'));
  try {
    const { root, env } = withRoot(dir);
    await mkdir(join(root, 'wx_a'), { recursive: true });
    assert.throws(() => run(env, '--bot', 'wx_missing', '--show'), /没有这个账号/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a value without an equals sign is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-'));
  try {
    const { root, env } = withRoot(dir);
    await mkdir(join(root, 'wx_a'), { recursive: true });
    assert.throws(() => run(env, '--bot', 'wx_a', '--set', 'personality'), /格式是 字段=值/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
