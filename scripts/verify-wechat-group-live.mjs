// Live gate for the WeChat group bridge. Read-only; never drives the UI.
//
// Why this rewrite exists: the first version matched CommandLine across ALL
// processes, so the verification command's OWN powershell.exe (whose command
// line contains the adapter name) matched and produced a fake PASS while no
// adapter child existed. It also scanned only a log tail and missed that the
// 153-byte storm had already stopped. Both holes are closed: filter on the
// interpreter process names only, and require the resolved adapter path to sit
// inside the package rather than at the stale bare <drive>:/scripts root.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const LOG = 'C:/Users/37533/AppData/Roaming/DSH Desktop/logs/host/dsh-2026-11-01.2.log';
const CONFIG = 'C:/Users/37533/.dsh/integrations/dsh-weixin/accounts/wx_c087f36721de6f68e06924cf/group-chats.json';

const failures = [];
const notes = [];

// 1. A real interpreter process must be running the adapter, from the package.
const helper = join(here, 'adapter-procs.ps1');
const out = execFileSync('powershell',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper],
  { encoding: 'utf8', timeout: 60000 });
const cmds = out.split('\n').map((line) => line.trim()).filter(Boolean);

if (cmds.length === 0) {
  failures.push('no live adapter interpreter process (py/python/pythonw running the adapter)');
} else {
  const hits = [];
  for (const line of cmds) {
    const match = line.match(/-B\s+([^\s]+wechat_group_uia\.py)/);
    if (match) hits.push(match[1]);
  }
  const script = hits[0] ?? null;
  if (!script) {
    failures.push('could not read the -B adapter path from the live process');
  } else if (/^[A-Za-z]:[\\/]+scripts[\\/]/i.test(script)) {
    // The exact stale shape the bug produced: <drive>:/scripts/....py
    failures.push('adapter still resolves to the stale bare root: ' + script);
  } else if (!existsSync(script)) {
    failures.push('resolved adapter script does not exist: ' + script);
  } else if (!script.includes(root.split(/[\\/]/).pop())) {
    failures.push('adapter path is outside the package tree: ' + script);
  } else {
    notes.push('adapter script verified (exists, inside package): ' + script);
  }
}

// 2. The 153-byte startup death must not be the recent story.
if (!existsSync(LOG)) {
  failures.push('no Host log at ' + LOG);
} else {
  const sizeMb = Math.round(statSync(LOG).size / 1048576);
  const lines = readFileSync(LOG, 'utf8').split('\n');
  const tail = lines.slice(-2000).join('\n');
  if (tail.includes('group adapter stderr (153 bytes)')) {
    failures.push('153-byte adapter stderr is still being emitted (last 2000 lines)');
  } else {
    notes.push('no 153-byte stderr in last 2000 lines (log ' + sizeMb + 'MB)');
  }
}

// 3. The group must still be opted in, or silence is expected by design.
if (!existsSync(CONFIG)) {
  failures.push('group-chats.json missing');
} else {
  const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
  if (config.allowUnverifiedRead !== true) failures.push('allowUnverifiedRead off');
  if (config.allowSend !== true) failures.push('allowSend off');
  const group = (config.groups ?? [])[0];
  if (!group) failures.push('no configured group');
  else if (group.allowUnverifiedTrigger !== true) failures.push('allowUnverifiedTrigger off');
  else notes.push('group id=' + group.id + ' title=' + group.title + ' prefix=' + group.commandPrefix);
}

for (const note of notes) process.stdout.write('OK   ' + note + '\n');
for (const failure of failures) process.stdout.write('FAIL ' + failure + '\n');
process.stdout.write(failures.length === 0 ? 'PASS\n' : 'FAILED\n');
process.exit(failures.length === 0 ? 0 : 1);
