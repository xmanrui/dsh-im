// Exercise the actual settings card in Chromium without a running Host or IM account.
// Usage: node scripts/verify-model-setting.mjs [output-directory]
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const browser = process.env.CHROME_PATH ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].find(existsSync);
if (!browser) throw new Error('Set CHROME_PATH to a Chromium/Chrome executable.');
const output = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), 'dsh-im-model-ui-'));
await mkdir(output, { recursive: true });
const built = await build({
  entryPoints: [resolve(import.meta.dirname, '../test/browser/model-setting.fixture.js')],
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome100',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const htmlPath = join(output, 'preview.html');
const scriptOpen = '<scr' + 'ipt>';
const scriptClose = '</scr' + 'ipt>';
const scriptBody = built.outputFiles[0].text.replace(/<\/script/giu, '<\\/script');
await writeFile(htmlPath, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>DSH-IM Model Settings</title>
<style>
body{margin:0;padding:24px;background:#fff;color:#1f2329;font:14px/20px -apple-system,BlinkMacSystemFont,sans-serif}#app{max-width:760px;margin:auto}#result{max-width:760px;margin:18px auto;font:11px/17px monospace;white-space:pre-wrap;color:#687380}
@media(max-width:600px){body{padding:12px}}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--dsw-alias-bg-layer-1:#202125;--dsw-alias-bg-layer-3:#282a30;--dsw-specific-menu:#282a30;--dsw-alias-bg-module-platform:#25272c;--dsw-alias-label-primary:#e9ebef;--dsw-alias-label-secondary:#b1b5bf;--dsw-alias-label-tertiary:#9a9faa;--dsw-alias-border-l1:#34363c;--dsw-alias-border-l2:#41434c;--dsw-alias-border-l3:#7b9ff9;--dsw-alias-interactive-bg-hover:#353842}body{background:#202125;color:#e9ebef}}
</style><body><div id="app"></div><pre id="result">Running browser checks…</pre>${scriptOpen}${scriptBody}${scriptClose}</body></html>`);
for (const [name, size, extra, query] of [
  ['desktop', '1100,1100', [], ''],
  ['mobile', '390,1250', [], '?mobile'],
  ['dark-en', '1100,1100', ['--force-dark-mode'], '?en'],
]) {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-im-model-browser-'));
  const { stdout, stderr } = await promisify(execFile)(browser, [
    '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    `--window-size=${size}`, '--force-device-scale-factor=1', '--virtual-time-budget=8000',
    ...extra, `--screenshot=${join(output, `${name}.png`)}`, '--dump-dom', pathToFileURL(htmlPath).href + query,
  ], { maxBuffer: 8 * 1024 * 1024, timeout: 15_000, killSignal: 'SIGKILL' }).catch((error) => {
    // Some desktop Chromium builds finish dump-dom and the screenshot but
    // hang during shutdown. Only accept a fully returned fixture result.
    if (error.killed && /<body\b[^>]*\bdata-result="(?:passed|failed)"/u.test(error.stdout ?? '')) return error;
    throw error;
  }).finally(() => rm(profile, { recursive: true, force: true }));
  await writeFile(join(output, `${name}.html`), stdout);
  await writeFile(join(output, `${name}.log`), stderr);
  const result = stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/u)?.[1] ?? 'No browser result';
  if (!stdout.includes('data-result="passed"')) throw new Error(`${name}: ${result}`);
  console.log(`${name}: ${result}`);
}
console.log(`Previews: ${output}`);
