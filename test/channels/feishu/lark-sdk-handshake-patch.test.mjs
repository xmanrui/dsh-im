import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import {
  larkSdkHandshakePatch,
  patchLarkSdkHandshakeSource,
} from '../../../plugin-src/host/lark-sdk-handshake-patch.mjs';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const testDirectory = dirname(fileURLToPath(import.meta.url));

test('Lark SDK patch applies every reviewed lifecycle fix to both vendor builds', async () => {
  const sdkRoot = dirname(require.resolve('@larksuiteoapi/node-sdk/package.json'));

  for (const flavor of ['es', 'lib']) {
    const sdkPath = resolve(sdkRoot, flavor, 'index.js');
    const source = await readFile(sdkPath, 'utf8');
    const patched = patchLarkSdkHandshakeSource(source, sdkPath);

    assert.match(patched, /this\.pendingWsInstance = null;/u);
    assert.match(patched, /this\.pendingWsInstance = wsInstance;/u);
    assert.match(patched, /this\.pendingWsInstance === wsInstance/u);
    assert.match(patched, /wsInstance\.removeAllListeners\(['"]open['"]\);/u);
    assert.match(patched, /pendingWsInstance\.terminate\(\);/u);
    assert.match(
      patched,
      /finally \{\s+if \(currentGeneration === this\.reconnectGeneration\) \{\s+this\.isConnecting = false;/u,
    );
    assert.match(
      patched,
      /if \(this\.terminalError\) \{\s+this\.isConnecting = false;[^]*?if \(this\.isConnecting \|\|[^]*?liveWsInstance\.readyState !== WebSocket\.CLOSED/u,
    );
    assert.match(patched, /currentGeneration !== this\.reconnectGeneration \|\| result\.cancelled/u);
    assert.match(patched, /wsInstance\.on\(['"]error['"]/u);
    assert.doesNotMatch(
      patched,
      /handshake timeout[^]*?wsInstance\.removeAllListeners\(\);[^]*?settleOnce\(false\);/u,
    );
  }
});

test('Lark SDK handshake patch fails closed when the reviewed vendor shape changes', () => {
  assert.throws(
    () => patchLarkSdkHandshakeSource('wsInstance.terminate();', 'changed-sdk.js'),
    /expected exactly one reviewed WSClient pending-socket state marker, found 0/u,
  );
});

test('patched real SDK survives handshake timeout and close without uncaught or zombie reconnects', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'dsh-lark-sdk-test-'));
  const outputPath = join(temporaryDirectory, 'scenario.mjs');

  try {
    await build({
      entryPoints: [resolve(testDirectory, 'fixtures/lark-sdk-close-during-handshake.mjs')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: ['node22'],
      mainFields: ['module', 'main'],
      plugins: [larkSdkHandshakePatch],
      outfile: outputPath,
      logLevel: 'silent',
      banner: {
        js: [
          "import { createRequire as __dshCreateRequire } from 'node:module';",
          "import { dirname as __dshDirname } from 'node:path';",
          "import { fileURLToPath as __dshFileURLToPath } from 'node:url';",
          'const require = __dshCreateRequire(import.meta.url);',
          'const __filename = __dshFileURLToPath(import.meta.url);',
          'const __dirname = __dshDirname(__filename);',
        ].join('\n'),
      },
    });

    const { stdout, stderr } = await execFileAsync(process.execPath, [outputPath], {
      timeout: 5_000,
    });

    assert.deepEqual(JSON.parse(stdout), {
      handshakeTimeoutPulls: 1,
      closeDuringHandshakePulls: 1,
      immediateRestart: {
        callbackCount: 0,
        endpointPulls: 2,
        stateBeforeFinalClose: 'connecting',
      },
      duplicateStart: {
        acceptedConnections: 1,
        activeSocketsAfterClose: 0,
        activeSocketsBeforeClose: 1,
        callbackCount: 0,
        endpointPulls: 1,
        stateBeforeClose: 'connecting',
      },
      connectedRepeatStart: {
        acceptedConnections: 1,
        activeSocketsAfterClose: 0,
        activeSocketsBeforeClose: 1,
        callbackCount: 1,
        endpointPulls: 1,
        stateBeforeClose: 'connected',
      },
      failedRestart: {
        callbackCountBeforeRestart: 1,
        endpointPulls: 2,
        stateAfterRestart: 'connecting',
      },
    });
    assert.equal(stderr, '');
  }
  finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
