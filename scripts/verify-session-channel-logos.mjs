// Real browser/React verification, with no running DSH Host or IM accounts.
// CHROME_PATH overrides the browser executable. An optional argument is the output directory.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const args = process.argv.slice(2);
const prepareOnly = args.includes('--prepare-only');
const outputArg = args.find((argument) => argument !== '--prepare-only');
const browser = process.env.CHROME_PATH ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].find(existsSync);
if (!browser && !prepareOnly) throw new Error('Set CHROME_PATH to a Chromium/Chrome executable.');
const output = outputArg ? resolve(outputArg) : await mkdtemp(join(tmpdir(), 'dsh-im-session-logos-'));
await mkdir(output, { recursive: true });
const built = await build({
  entryPoints: [resolve(import.meta.dirname, '../test/browser/session-channel-logos.fixture.js')],
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome100',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DSH-IM Session Logo Preview</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f8f9fb;color:#202329;font:14px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.preview{display:flex;min-height:720px}aside{width:350px;flex:none;padding:24px 12px;background:#f0f2f5;border-right:1px solid #e4e6eb}header{padding:0 12px 26px}header strong{display:block;font-size:17px;line-height:26px}small{display:block;color:#7a818e;font-size:11px}.workspace{padding:8px 12px;color:#6f7684;font-size:12px}
._sessionRow_dsh_104{height:32px;display:flex;align-items:center;gap:0;border-radius:8px;padding:0 8px;cursor:pointer;user-select:none;color:inherit}._sessionRow_dsh_104:hover,._sessionRow_dsh_104.selected{background:#e0e5ec}._title_dsh_170{flex:1;min-width:0;margin:0 6px 0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px}.status{width:16px;flex:none;color:#77a891;text-align:center}.time{font-size:10px;color:#8d95a1}button{font:inherit;cursor:pointer}aside button{border:0;background:none;color:#707a89;width:22px;height:24px}
main{flex:1;padding:55px 44px}.eyebrow{font-size:10px;font-weight:650;letter-spacing:.13em;color:#788292}h1{font-size:30px;line-height:40px;font-weight:650;margin:12px 0}main>p{color:#727c8a}.message{margin-top:35px;padding:18px 22px;border:1px solid #e3e7ed;border-radius:12px;background:#fff}.message strong{font-size:12px}.message p{color:#626d7c}h2{font-size:13px;font-weight:550;margin:26px 0 8px}._searchResultRow_dsh_25{display:flex;flex-direction:column;align-items:stretch;width:100%;border:1px solid #e3e7ed;border-radius:8px;padding:10px;background:white;text-align:left}._searchResultHeading_dsh_305{display:flex;min-width:0}._searchResultTitle_dsh_313{flex:1;min-width:0;font-size:14px;line-height:20px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.search small{margin-top:5px}.note{font-size:11px;margin-top:32px}#result{margin:0;padding:14px 24px;border-top:1px solid #e4e6eb;background:#eef6f1;color:#357759;font:10px/16px ui-monospace,monospace}body[data-result=failed] #result{color:#a22;background:#fee}
@media(prefers-color-scheme:dark){body{background:#1b1e23;color:#e4e7eb}aside{background:#22262d;border-color:#333941}._sessionRow_dsh_104:hover,._sessionRow_dsh_104.selected{background:#353d49}.message,._searchResultRow_dsh_25{background:#252a32;border-color:#39404b;color:inherit}.message p{color:#c1c8d1}#result{background:#23382e;color:#a2d0b2;border-color:#39404b}}
</style><body><div id="app"></div><pre id="result">Running browser checks…</pre>
<script>${built.outputFiles[0].text.replace(/<\/script/giu, '<\\/script')}</script></body></html>`;
const htmlPath = join(output, 'preview.html');
await writeFile(htmlPath, html
  .replace('._sessionRow_dsh_104{', '._dsh_sessionRow,._sessionRow_dsh_104{')
  .replaceAll('._sessionRow_dsh_104:hover,._sessionRow_dsh_104.selected{', '._dsh_sessionRow:hover,._dsh_sessionRow.selected,._sessionRow_dsh_104:hover,._sessionRow_dsh_104.selected{')
  .replace('._title_dsh_170{', '._dsh_title,._title_dsh_170{')
  .replace('._searchResultTitle_dsh_313{flex:1;', '._searchResultTitle_dsh_313{flex:0 auto;'));
if (prepareOnly) {
  console.log(`Prepared browser fixture: ${htmlPath}`);
  process.exit(0);
}
const profile = await mkdtemp(join(tmpdir(), 'dsh-im-logo-browser-'));
const screenshot = join(output, 'preview.png');
const { stdout, stderr } = await promisify(execFile)(browser, [
  '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1100,800', '--force-device-scale-factor=1', '--virtual-time-budget=8000',
  `--screenshot=${screenshot}`, '--dump-dom', pathToFileURL(htmlPath).href,
], { maxBuffer: 8 * 1024 * 1024, timeout: 30_000 }).finally(() => rm(profile, { recursive: true, force: true }));
await writeFile(join(output, 'browser.log'), stderr);
await writeFile(join(output, 'result.html'), stdout);
const result = stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/u)?.[1] ?? 'No browser result';
if (!stdout.includes('data-result="passed"')) throw new Error(result);
console.log(result);
console.log(`Preview: ${screenshot}`);
