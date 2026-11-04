import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import {
  channelSelectionArgument,
  describeSelection,
  disabledChannelStubs,
  parseChannelSelection,
} from './channel-selection.mjs';
import { larkSdkHandshakePatch } from './lark-sdk-handshake-patch.mjs';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDirectory, '../..');
const outputPath = resolve(packageRoot, 'lib/index.js');
// `--channels=feishu` or DSH_IM_CHANNELS=feishu builds a Host bundle with only
// those channels; unset keeps every channel (what the npm package ships).
const selection = parseChannelSelection(channelSelectionArgument(process.argv.slice(2)));
const externalRuntimePackages = [
  '@tencent-connect/qqbot-connector',
  '@tencent-connect/qqbot-nodejs',
  '@wecom/aibot-node-sdk',
  'dingtalk-stream',
  'imapflow',
  'mailparser',
  'nodemailer',
  'qrcode',
  'sharp',
  'undici',
];
const external = externalRuntimePackages.flatMap((name) => [name, `${name}/*`]);

await mkdir(dirname(outputPath), { recursive: true });
await build({
  entryPoints: [resolve(sourceDirectory, 'index.mjs')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  mainFields: ['module', 'main'],
  external,
  plugins: [larkSdkHandshakePatch, ...(selection.disabled.length ? [disabledChannelStubs(selection.disabled)] : [])],
  define: {
    __DSH_IM_DISABLED_CHANNELS__: JSON.stringify(selection.disabled),
  },
  outfile: outputPath,
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
  sourcemap: false,
  minify: true,
  legalComments: 'eof',
});

console.log(`Wrote ${outputPath} (${describeSelection(selection)})`);
