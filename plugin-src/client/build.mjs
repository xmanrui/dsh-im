import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import {
  channelSelectionArgument,
  describeSelection,
  parseChannelSelection,
} from '../host/channel-selection.mjs';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDirectory, '../..');
const outputPath = resolve(packageRoot, 'lib/client.js');
const loaderId = process.env.DSH_IM_CLIENT_ID ?? '@xmanrui/dsh-im';
// Same switch as the Host build: the page must not offer a tab for a channel the
// Host bundle does not carry.
const selection = parseChannelSelection(channelSelectionArgument(process.argv.slice(2)));

const result = await build({
  entryPoints: [resolve(sourceDirectory, 'index.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  external: ['react', 'react-dom'],
  define: {
    __DSH_IM_DISABLED_CHANNELS__: JSON.stringify(selection.disabled),
  },
  write: false,
  minify: process.env.NODE_ENV === 'production',
  legalComments: 'none',
});
const bundled = result.outputFiles?.[0]?.text;
if (!bundled) throw new Error('esbuild did not produce a client bundle');

const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(loaderId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled}
    return module.exports;
  }
});
`;
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, wrapped, 'utf8');
console.log(`Wrote ${outputPath} (${describeSelection(selection)})`);
