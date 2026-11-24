import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

// Rows composed by the Web profile of DSH 0.2.2-rc.5, read from the boot
// manifest the Host serves at `/` (`globalThis.__DSH_BOOT__.entries`). The
// client loader only waits for inject names that exist as rows, so an obsolete
// name costs ordering without ordering anything, and a renamed service package
// silently loses the wait it was meant to express. Re-derive this list from the
// running Host before changing it.
const EXPECTED_CLIENT_INJECT = Object.freeze([
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-workspace',
]);

// Packages that never appear as a Web client row on 0.2.2-rc.5: the runtime
// package stopped publishing after 0.1.1-rc.2, and ui-slots is the pure slot
// registry core without a client entry.
const RETIRED_CLIENT_INJECT = Object.freeze([
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-slots',
]);

test('client inject list names loadable DSH 0.2.2-rc.5 client rows', () => {
  assert.deepEqual(manifest.dsh.client.inject, [...EXPECTED_CLIENT_INJECT]);
  for (const retired of RETIRED_CLIENT_INJECT) {
    assert.ok(
      !manifest.dsh.client.inject.includes(retired),
      `${retired} is not a loadable client row and must not be injected`,
    );
  }
  assert.equal(new Set(manifest.dsh.client.inject).size, manifest.dsh.client.inject.length);
  assert.equal(manifest.dsh.client.platform, 'web');
});

test('the declared compatibility baseline is a released host this client targets', () => {
  const { compatibility } = manifest.dsh;
  assert.equal(compatibility.dsh, '0.2.2-rc.5');
  assert.equal(compatibility.dshReleases[compatibility.dsh], 'compatible');
  assert.deepEqual(compatibility.profiles, ['web']);
  for (const [release, state] of Object.entries(compatibility.dshReleases)) {
    assert.match(release, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
    assert.equal(state, 'compatible');
  }
});

test('the update panel documents the current compatibility baseline', async () => {
  const panel = await readFile(resolve(root, 'plugin-src/client/update-panel.js'), 'utf8');
  assert.match(panel, /dsh-im 5\.10\.0 起支持 DSH 0\.2\.2-rc\.5。/u);
  for (const file of ['plugin-src/client/i18n.js', 'plugin-src/client/i18n-ru.js']) {
    const source = await readFile(resolve(root, file), 'utf8');
    assert.match(
      source,
      /'dsh-im 5\.10\.0 起支持 DSH 0\.2\.2-rc\.5。'/u,
      `${file} must translate the compatibility hint`,
    );
  }
});
