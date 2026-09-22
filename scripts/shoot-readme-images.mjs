#!/usr/bin/env node
/**
 * Re-shoot the README facade images (docs/images/imbot.png and imbot_en.png).
 *
 * Last successful run: 2026-09-23 (the "en" pass), against DSH 0.1.7-alpha.2 -
 * server on :3080, profile "web", this repository symlinked into that profile.
 * If any of those has moved, re-read docs/images/AGENTS.md and rewrite this
 * script rather than patching its selectors: the criteria live there, this file
 * is only the implementation, and a stale selector fails silently.
 *
 * The framing, privacy, language-order and acceptance criteria are in
 * docs/images/AGENTS.md and docs/images/README.md. Read them before running.
 *
 * Usage:
 *   node scripts/shoot-readme-images.mjs en [--out docs/images/imbot_en.png]
 *   node scripts/shoot-readme-images.mjs zh [--out docs/images/imbot.png]
 *
 * Options:
 *   --url <origin>   harness origin, default http://127.0.0.1:3080
 *   --cli <path>     Tabbit launcher; defaults to the Windows install location
 *   --task <name>    Tabbit task name, default im-readme-shots
 *   --out <path>     where to write the PNG (absolute, or relative to this repo)
 *
 * LANGUAGE IS A PRECONDITION, NOT A SIDE EFFECT. The script asserts that the
 * interface is already in the language you asked for and exits if it is not.
 * Switching it here was tried and removed: the switch is a global setting that a
 * failed run could leave flipped, and it changes every open tab of the
 * maintainer's browser. Switch it in Settings -> General -> Language, shoot, then
 * switch back - the order AGENTS.md step 6 prescribes.
 *
 * What the script does encode, and why each step is here rather than left to a human:
 *   - the sidebar is collapsed before the shutter and the collapse is polled to a
 *     stable width: the sidebar lists real session titles, and the collapse is
 *     animated, so a fixed wait catches a mid-animation frame;
 *   - the viewport is never resized, so the PNG stays 2449x1223 at dpr 1.65;
 *   - the page is scrolled by exactly (title.top - 8) - the tightest framing that
 *     keeps the plugin title in frame. With the thirteenth rail entry the rail's
 *     last row is clipped by about 19px at this viewport; that is a measured
 *     trade-off, not an oversight.
 */
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const lang = process.argv[2];
if (lang !== 'en' && lang !== 'zh') {
  console.error('usage: node scripts/shoot-readme-images.mjs <en|zh> [--out <png>]');
  process.exit(2);
}
const url = arg('url', 'http://127.0.0.1:3080');
const cli = arg('cli', join(process.env.LOCALAPPDATA ?? '', 'Tabbit', 'LocalAgent', 'bin', 'tabbit-cli.exe'));
const task = arg('task', 'im-readme-shots');
const out = arg('out', lang === 'en' ? 'docs/images/imbot_en.png' : 'docs/images/imbot.png');
const outPath = isAbsolute(out) ? out : join(ROOT, out);

const TAB = lang === 'zh' ? '飞书' : 'Feishu';
const EXPECTED = lang === 'zh' ? 'zh' : 'en';

// Submitted through the launcher's stdin so PowerShell never rewrites the program.
const program = `
const tab = await context.newPage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const navLabels = () => tab.locator('button[aria-label]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')).filter(Boolean));
async function collapseSidebar() {
  const label = (await navLabels()).find((l) => /collapse sidebar|收起侧/i.test(l || ''));
  if (!label) throw new Error('no collapse-sidebar control: is this still the harness shell?');
  await tab.locator('button[aria-label="' + label + '"]').first().click();
  const width = () => tab.evaluate(() => {
    const nav = document.querySelector('nav[aria-label]');
    let el = nav ? nav.parentElement : null;
    while (el && el !== document.body) {
      const w = el.getBoundingClientRect().width;
      if (w > 20 && w < 420) return Math.round(w * 100) / 100;
      el = el.parentElement;
    }
    return null;
  });
  let prev = null, samples = 0;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    await sleep(120);
    const w = await width();
    samples += 1;
    if (w !== null && prev !== null && Math.abs(w - prev) < 0.01) return { samples, width: w };
    prev = w;
  }
  throw new Error('the sidebar never reached a stable width; do not shoot a mid-animation frame');
}
let result = null, error = null;
try {
  await tab.goto(${JSON.stringify(url)} + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await tab.waitForTimeout(2500);
  const interfaceLang = await tab.evaluate(() => document.documentElement.lang);
  if (!new RegExp('^' + ${JSON.stringify(EXPECTED)}).test(interfaceLang)) {
    throw new Error('the interface is in "' + interfaceLang + '" but the ' + ${JSON.stringify(EXPECTED)} + ' pass needs it switched first (Settings -> General -> Language), then switched back afterwards');
  }
  await tab.getByRole('button', { name: /^(Plugins|中文)$/ }).first().click({ timeout: 15000 });
  await tab.waitForTimeout(2500);
  await tab.getByRole('button', { name: /View @xmanrui\\/dsh-im|查看 @xmanrui\\/dsh-im/ }).click({ timeout: 15000 });
  await tab.waitForTimeout(2500);
  await tab.locator('.dim-rail').waitFor({ state: 'visible', timeout: 15000 });
  await tab.locator('.dim-rail [role="tab"]', { hasText: ${JSON.stringify(TAB)} }).first().click();
  await tab.waitForTimeout(1500);
  const toggle = tab.locator('.dim-accountSettingsToggle').first();
  if ((await toggle.count()) && (await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click();
    await tab.waitForTimeout(900);
  }
  await tab.mouse.move(20, 700);
  await tab.waitForTimeout(300);
  // Tightest framing that keeps the plugin title in frame.
  const need = await tab.evaluate(() => {
    const h1 = [...document.querySelectorAll('h1, h2, h3')].find((e) => /dsh-im|^im\\b/i.test(e.textContent.trim()));
    return Math.max(0, Math.round(h1.getBoundingClientRect().top - 8));
  });
  await tab.evaluate((n) => {
    let el = document.querySelector('.dim-page');
    while (el && el !== document.body) {
      const cs = getComputedStyle(el);
      if (/auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4) { el.scrollTop += n; return; }
      el = el.parentElement;
    }
  }, need);
  await tab.waitForTimeout(700);
  const sidebar = await collapseSidebar();
  const shot = await tab.screenshot();
  const geo = await tab.evaluate(() => {
    const h1 = [...document.querySelectorAll('h1, h2, h3')].find((e) => /dsh-im|^im\\b/i.test(e.textContent.trim()));
    const rail = document.querySelector('.dim-rail').getBoundingClientRect();
    return {
      h1Top: Math.round(h1.getBoundingClientRect().top),
      railTop: Math.round(rail.top), railBottom: Math.round(rail.bottom),
      viewportH: innerHeight, tabs: document.querySelectorAll('.dim-rail [role="tab"]').length,
      lang: document.documentElement.lang,
    };
  });
  result = { path: shot.path, width: shot.width, height: shot.height, geo, sidebar };
} catch (e) {
  error = String(e).slice(0, 500);
} finally {
  await tab.close();
}
return { result, error };
`;

const work = mkdtempSync(join(tmpdir(), 'dsh-im-shots-'));
const programFile = join(work, 'program.js');
writeFileSync(programFile, program, 'utf8');

let stdout;
try {
  // The request id is unique per run: the launcher returns the receipt it already
  // holds for a repeated id instead of running the program again, which reads as a
  // mysterious repeat of an earlier failure.
  // execSync runs through cmd.exe on Windows, which is what the redirect needs;
  // execFileSync re-quotes the arguments and cmd rejects the line.
  stdout = execSync('"' + cli + '" nodejs --task ' + task + ' --request-id shoot-' + lang + '-' + Date.now() +
    ' --timeout-ms 175000 < "' + programFile + '"', {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  writeFileSync(join(ROOT, '.shoot-program-debug.js'), program, 'utf8');
  throw e;
} finally {
  rmSync(work, { recursive: true, force: true });
}

const jsonLine = stdout.split(/\r?\n/).find((l) => l.trim().startsWith('{'));
if (!jsonLine) throw new Error('the launcher returned no JSON: ' + stdout.slice(0, 400));
const response = JSON.parse(jsonLine);
if (response.status !== 'succeeded') throw new Error('shoot failed: ' + JSON.stringify(response).slice(0, 800));
const { result, error } = response.result.value;
if (error) throw new Error(error);

const artifact = result.path;
if (!artifact || !existsSync(artifact)) throw new Error('artifact missing: ' + artifact);
copyFileSync(artifact, outPath);
console.log('wrote ' + outPath + '  ' + result.width + 'x' + result.height +
  '  rail ' + result.geo.railTop + '..' + result.geo.railBottom + ' of ' + result.geo.viewportH +
  '  tabs ' + result.geo.tabs + '  lang ' + result.geo.lang + '  sidebar ' + JSON.stringify(result.sidebar));
if (result.width !== 2449 || result.height !== 1223) {
  console.warn('WARNING: expected 2449x1223 at the natural viewport; the viewport or dpr changed.');
}
if (result.geo.h1Top > 40) {
  console.warn('WARNING: the plugin title sits at y=' + result.geo.h1Top + '; check the framing before committing.');
}
