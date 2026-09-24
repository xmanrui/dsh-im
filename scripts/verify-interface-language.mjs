/**
 * Run the built plugin through an original DSH CLI and prove that bot messages
 * follow the DSH interface language (issue #185).
 *
 * Mirrors scripts/verify-lan-management.mjs: an isolated, empty home, the
 * unmodified CLI, and real HTTP against the public /api carrier. Nothing is
 * mocked — the assertions are on what the Host resolves from DSH's own
 * user-settings document.
 *
 * Set DSH_IM_TELEGRAM_TOKEN to additionally bind a real bot and assert the
 * command menu Telegram itself stores. That step is skipped without a token,
 * and it restores the bot's original menu when it finishes.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const harnessRoot = process.argv[2];
if (!harnessRoot || process.argv.includes('--help')) {
  console.log('Usage: node scripts/verify-interface-language.mjs /path/to/built/deepseek-harness');
  console.log('       DSH_IM_TELEGRAM_TOKEN=<token> node scripts/verify-interface-language.mjs ... (adds the live menu check)');
  process.exit(harnessRoot ? 0 : 1);
}
const pluginRoot = resolve(import.meta.dirname, '..');
await access(join(pluginRoot, 'lib/index.js'));

/**
 * Accept either a built Harness checkout or an installed @deepseek-ai/dsh
 * package, so this runs against a release as well as a working tree.
 */
async function resolveHarness(root) {
  const layouts = [
    { kind: 'checkout', cli: 'apps/cli/lib/bin.js', base: 'packages/bundle/base', webApp: 'packages/bundle/web-app' },
    { kind: 'package', cli: 'lib/bin.js', base: 'node_modules/@deepseek-ai/dsh-base', webApp: 'node_modules/@deepseek-ai/dsh-web-app' },
  ];
  for (const layout of layouts) {
    const paths = {
      kind: layout.kind,
      cli: resolve(root, layout.cli),
      base: resolve(root, layout.base),
      webApp: resolve(root, layout.webApp),
    };
    try {
      await Promise.all([access(paths.cli), access(paths.base), access(paths.webApp)]);
      return paths;
    } catch {
      // Try the next known layout.
    }
  }
  throw new Error(`no DSH CLI found under ${root}: expected apps/cli/lib/bin.js or lib/bin.js`);
}

const harness = await resolveHarness(harnessRoot);
const cli = harness.cli;
const botToken = process.env.DSH_IM_TELEGRAM_TOKEN;
let telegramMenu;
const directory = await mkdtemp(join(tmpdir(), 'dsh-im-language-test-'));
const home = join(directory, 'home');
const profile = join(home, 'profiles/web');
const settingsPath = join(home, 'settings.yaml');
const mirrorPath = join(home, 'integrations/dsh-im/interface-language.json');
const results = [];
let child;

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolveRequest, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1', port: url.port, path: `${url.pathname}${url.search}`,
      method, headers: { host: url.host, ...headers },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => resolveRequest({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('HTTP request timed out')));
    req.end(body);
  });
}

function start() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
    !/^DSH_/i.test(key) && !/(?:KEY|SECRET|TOKEN|PASSWORD|PROXY)/i.test(key)
  )));
  child = spawn(process.execPath, [cli, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: directory,
    env: { ...env, DSH_HOME: home, DSH_AGENTS_HOME: join(directory, '.agents'),
      DSH_TELEMETRY_DISABLED: '1', SSH_CONNECTION: '', SSH_TTY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolveStart, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error('DSH startup timed out')), 60_000);
    let settled = false;
    function finish(error, url) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(new Error(`${error.message}\n${output.replace(/([?&]token=)[^\s)]+/g, '$1<redacted>')}`));
      else resolveStart(new URL(url));
    }
    function append(chunk) {
      output = `${output}${chunk}`.slice(-100_000);
      const match = /dsh web: (http:\/\/[^\s]+)/.exec(output);
      if (match) finish(null, match[1]);
    }
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', error => finish(error));
    child.once('exit', code => finish(new Error(`DSH exited before readiness: ${code}`)));
  });
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise(resolveStop => child.once('exit', resolveStop));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try { await stopped; } finally { clearTimeout(timer); }
}

async function login(launchUrl) {
  const response = await request(launchUrl);
  assert.equal(response.status, 303, 'Harness must exchange its launch token for a browser cookie');
  const cookie = response.headers['set-cookie']?.map(value => value.split(';', 1)[0]).join('; ');
  assert.ok(cookie, 'Harness did not issue a browser cookie');
  const browser = { origin: launchUrl.origin, cookie };
  // HTTP readiness precedes asynchronous plugin activation, notably after
  // restart. Wait only for the route to appear; other failures stay fatal.
  await waitFor('the plugin language route becomes ready after HTTP startup', async () => {
    try {
      const result = await rpc(browser, 'dsh-im-language', 'settings.language.get');
      return result.ok === true;
    } catch (error) {
      if (error.code === 'ERR_ASSERTION' && error.actual === 404) return false;
      throw error;
    }
  });
  return browser;
}

async function rpc(browser, channel, method, payload = {}) {
  const response = await request(new URL(`/api/dsh-im/${channel}`, browser.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: browser.origin, cookie: browser.cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'language-test',
      method: `dsh-im/${channel}`, payload: { method, payload } }),
  });
  assert.equal(response.status, 200, `${channel}/${method} -> HTTP ${response.status}: ${response.body.slice(0, 300)}`);
  return JSON.parse(response.body).result;
}

/** Rewrite only the `locale` section, leaving the rest of the document alone. */
async function selectInterfaceLanguage(value) {
  let raw = '';
  try { raw = await readFile(settingsPath, 'utf8'); } catch { raw = ''; }
  const withoutLocale = raw.replace(/(^|\n)locale:\n(?:[ \t]+.*\n?)*/g, '$1').trimEnd();
  await writeFile(settingsPath, value === null
    ? `${withoutLocale}\n`
    : `${withoutLocale}\nlocale:\n  preference: ${value}\n`, 'utf8');
}

async function waitFor(describe, predicate, { attempts = 60, delayMs = 250 } = {}) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await predicate();
    if (last) return last;
    await new Promise(sleep => setTimeout(sleep, delayMs));
  }
  throw new Error(`${describe} never held (last: ${JSON.stringify(last)?.slice(0, 300)})`);
}

function record(check, detail) {
  results.push({ check, detail: detail ?? '', result: 'PASS' });
}

const HAN = /[\p{Script=Han}]/u;

async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const parsed = await response.json();
  assert.equal(parsed.ok, true, `telegram ${method} failed`);
  return parsed.result;
}

try {
  await mkdir(profile, { recursive: true });
  const packages = {
    '@deepseek-ai/dsh-base': harness.base,
    '@deepseek-ai/dsh-web-app': harness.webApp,
    '@xmanrui/dsh-im': pluginRoot,
  };
  for (const [name, path] of Object.entries(packages)) {
    const target = join(profile, 'node_modules', name);
    await mkdir(dirname(target), { recursive: true });
    await symlink(path, target, 'dir');
  }
  await writeFile(join(profile, 'cordis.yml'), '[]\n');
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-im-language-test', private: true,
    dependencies: Object.fromEntries(Object.entries(packages).map(([name, path]) => [name, `link:${path}`])),
    dsh: { profile: { bundles: Object.keys(packages) } },
  }));

  // A Chinese interface selection, exactly as DSH's Language row stores it.
  await selectInterfaceLanguage('zh');
  let browser = await login(await start());
  const language = (method, payload) => rpc(browser, 'dsh-im-language', method, payload);

  const initial = await language('settings.language.get');
  assert.equal(initial.ok, true, JSON.stringify(initial));
  assert.deepEqual(initial.value, { language: 'zh', tag: 'zh', source: 'settings', pinned: false },
    'the plugin must read DSH\'s own locale preference');
  record('DSH locale namespace is registered and read Host-side', JSON.stringify(initial.value));

  await selectInterfaceLanguage('en');
  const switched = await waitFor('the bot language follows DSH to English', async () => {
    const snapshot = await language('settings.language.get');
    return snapshot.value?.language === 'en' ? snapshot.value : null;
  });
  assert.deepEqual(switched, { language: 'en', tag: 'en', source: 'settings', pinned: false });
  record('switching DSH\'s interface language switches the bot language live', 'no restart');

  const mirrored = await language('settings.language.mirror', { locale: 'zh-CN' });
  assert.deepEqual(mirrored.value, { language: 'en', tag: 'en', source: 'settings', pinned: false },
    'the mirror must never outrank an explicit selection');
  record('an explicit DSH selection outranks the mirrored interface locale', 'settings > mirror');

  await selectInterfaceLanguage(null);
  const fallback = await waitFor('the mirror applies once the selection is cleared', async () => {
    const snapshot = await language('settings.language.get');
    return snapshot.value?.source === 'mirror' ? snapshot.value : null;
  });
  assert.deepEqual(fallback, { language: 'zh', tag: 'zh-CN', source: 'mirror', pinned: false });
  record('clearing the selection falls back to the mirrored interface locale', 'mirror > default');

  // The reported case: an English interface that DSH never stored, because it
  // came from the browser's language list rather than the Language row.
  const browserEnglish = await language('settings.language.mirror', { locale: 'en-GB' });
  assert.deepEqual(browserEnglish.value, { language: 'en', tag: 'en-GB', source: 'mirror', pinned: false });
  assert.deepEqual(JSON.parse(await readFile(mirrorPath, 'utf8')),
    { version: 1, interfaceLanguage: 'en-GB' });
  record('a browser-derived English interface reaches the Host and is persisted', 'issue #185 case');

  for (const [method, payload] of [
    ['settings.language.mirror', { locale: 'not a tag' }],
    ['settings.language.mirror', {}],
    ['settings.language.get', { locale: 'en' }],
    ['settings.language.unknown', {}],
  ]) {
    const refused = await language(method, payload);
    assert.equal(refused.ok, false, `${method} must be refused`);
    assert.equal(refused.error.code, 'bad-request');
  }
  record('the language route refuses malformed payloads', '4 cases');

  if (botToken) {
    telegramMenu = await telegram('getMyCommands');
    const bound = await rpc(browser, 'telegram', 'bot.bind-credentials', { token: botToken });
    assert.equal(bound.ok, true, 'the bot must bind');
    const botId = bound.value.bots.at(-1).botId;
    await waitFor('the bot connects', async () => {
      const status = await rpc(browser, 'telegram', 'connection.status');
      return status.value?.bots?.find(item => item.botId === botId)?.connected ? true : null;
    });
    const english = await waitFor('Telegram stores the English menu', async () => {
      const commands = await telegram('getMyCommands');
      const help = commands.find(item => item.command === 'help');
      return help && !HAN.test(help.description) ? commands : null;
    });
    record('Telegram stores the English command menu while DSH is English', `${english.length} commands`);

    await selectInterfaceLanguage('zh');
    const chinese = await waitFor('Telegram stores the Chinese menu after the switch', async () => {
      const commands = await telegram('getMyCommands');
      const help = commands.find(item => item.command === 'help');
      return help && HAN.test(help.description) ? commands : null;
    });
    assert.equal(chinese.length, english.length, 'the same catalog in another language');
    const still = await rpc(browser, 'telegram', 'connection.status');
    assert.equal(still.value.bots.find(item => item.botId === botId).connected, true,
      'the command menu must be re-sent without reconnecting the bot');
    record('switching language re-sends the Telegram menu with no reconnect', `${chinese.length} commands`);
    await selectInterfaceLanguage(null);
  }

  // A restart must keep answering in the mirrored language, before any browser
  // connects, and must resolve it before the first bot registers its menu.
  await stop();
  const restarted = await login(await start());
  browser = restarted;
  const afterRestart = await rpc(restarted, 'dsh-im-language', 'settings.language.get');
  assert.deepEqual(afterRestart.value, { language: 'en', tag: 'en-GB', source: 'mirror', pinned: false });
  record('the mirrored language survives a Host restart', 'resolved before channels start');

  // Back-compatibility: an operator pin keeps winning and ignores DSH entirely.
  await stop();
  await writeFile(join(profile, 'cordis.patch.yml'),
    '- id: xmanrui-dsh-im\n  config:\n    language: zh-CN\n');
  await selectInterfaceLanguage('en');
  const pinnedBrowser = await login(await start());
  const pinned = await rpc(pinnedBrowser, 'dsh-im-language', 'settings.language.get');
  assert.deepEqual(pinned.value, { language: 'zh', tag: 'zh-CN', source: 'config', pinned: true },
    'a configured language must ignore DSH\'s interface language');
  record('an operator-configured language still wins', 'existing setups unchanged');

  console.table(results);
  console.log(`Passed ${results.length} real HTTP checks against an unmodified DSH CLI (${harness.kind} layout).`);
  console.log(botToken
    ? 'The live Telegram menu was exercised and the bot\'s original menu was restored.'
    : 'Set DSH_IM_TELEGRAM_TOKEN to additionally assert the menu Telegram itself stores.');
  console.log('The temporary home contains no bot credentials and is removed after the server stops.');
} finally {
  await stop();
  if (botToken && telegramMenu !== undefined) {
    try {
      if (telegramMenu.length > 0) await telegram('setMyCommands', { commands: telegramMenu });
      else await telegram('deleteMyCommands');
    } catch {
      console.error('could not restore the bot\'s original command menu');
    }
  }
  await rm(directory, { recursive: true, force: true });
}
