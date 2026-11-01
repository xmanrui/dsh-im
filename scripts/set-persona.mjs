#!/usr/bin/env node
// Edit one bot's character card from the command line.
//
// The card is a JSON file per account, which means an operator can already edit
// it by hand -- and eventually will, from the settings page. Until that page
// exists, this is the safe way to do it: it validates before writing, prints the
// rendered result so the operator sees what the model will actually read, and
// refuses to guess which account is meant when several exist.
//
// Usage:
//   node scripts/set-persona.mjs --list
//   node scripts/set-persona.mjs --bot wx_abc --show
//   node scripts/set-persona.mjs --bot wx_abc --set personality="嘴贫但心不坏"
//   node scripts/set-persona.mjs --bot wx_abc --reset

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readdir } from 'node:fs/promises';

import { DEFAULT_PERSONA, renderPersonaGuidance } from '../src/channels/shared/persona.mjs';
import { loadPersonaFile, savePersonaFile } from '../src/channels/shared/persona-store.mjs';

/** Where the weixin channel keeps its accounts, matching its own pluginPaths. */
function accountsRoot(env = process.env) {
  const dshHome = resolve(env.DSH_HOME ?? join(homedir(), '.dsh'));
  return resolve(env.DSH_WEIXIN_DATA_DIR ?? join(dshHome, 'integrations', 'dsh-weixin', 'accounts'));
}

/** Every account directory that has a config (i.e. is a real bot). */
async function listBots(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

/** Parse `--key value` and `--key=value` into one object; unknown flags fail. */
function parseArgs(argv) {
  const known = new Set(['list', 'show', 'reset']);
  const valued = new Set(['bot', 'set']);
  const args = { set: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`无法识别的参数：${token}`);
    const [rawKey, inline] = token.slice(2).split('=', 2);
    if (known.has(rawKey)) { args[rawKey] = true; continue; }
    if (!valued.has(rawKey)) throw new Error(`无法识别的开关：--${rawKey}`);
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`--${rawKey} 需要一个值`);
    if (rawKey === 'bot') args.bot = value;
    else {
      // `--set field=value`; a bare `--set` would silently write nothing.
      const split = value.indexOf('=');
      if (split <= 0) throw new Error('--set 的格式是 字段=值');
      args.set[value.slice(0, split)] = value.slice(split + 1);
    }
  }
  return args;
}

/** Print one card and the exact text the model will read. */
function show(botId, persona) {
  console.log(`# ${botId}`);
  console.log(JSON.stringify(persona, null, 2));
  console.log('\n--- 模型实际读到的提示 ---\n');
  console.log(renderPersonaGuidance(persona));
}

async function main(argv) {
  const args = parseArgs(argv);
  const root = accountsRoot();
  const bots = await listBots(root);
  if (args.list) {
    if (bots.length === 0) {
      console.log(`没有账号目录：${root}`);
      return 0;
    }
    for (const botId of bots) {
      const loaded = await loadPersonaFile(join(root, botId, 'persona.json'));
      console.log(`${botId}\t${loaded ? loaded.persona.name : '(未配置，出厂人设生效)'}`);
    }
    return 0;
  }
  if (!args.bot) throw new Error('请用 --bot <id> 指定账号，或用 --list 查看');
  if (bots.length > 0 && !bots.includes(args.bot)) {
    throw new Error(`没有这个账号：${args.bot}（现有：${bots.join(', ')}）`);
  }
  const path = join(root, args.bot, 'persona.json');
  const loaded = await loadPersonaFile(path);
  const current = loaded?.persona ?? DEFAULT_PERSONA;
  if (args.reset) {
    await savePersonaFile(path, DEFAULT_PERSONA);
    show(args.bot, DEFAULT_PERSONA);
    return 0;
  }
  if (Object.keys(args.set).length === 0) {
    show(args.bot, current);
    return 0;
  }
  // Merge only the named fields onto the current card: one edit must not wipe
  // everything the operator wrote before. Validation happens in savePersonaFile,
  // so a typo in a field name fails loudly instead of writing a stray key.
  const next = { ...current, ...args.set };
  const saved = await savePersonaFile(path, next);
  show(args.bot, saved);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  },
);
