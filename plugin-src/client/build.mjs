import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDirectory, '../..');
const outputPath = resolve(packageRoot, 'lib/client.js');
const loaderId = process.env.DSH_IM_CLIENT_ID ?? '@xmanrui/dsh-im';

// Platform seed modules: the DSH web shell materializes these into the browser
// module table before any plugin bundle runs, and `dsh.client.inject` records
// the same names in the boot graph. Keeping them external means the panel uses
// the kernel's own React and the kernel's own official primitives — one React
// instance, one copy of every official style, and identical markup on the
// 0.1.5-rc.1 baseline and on 0.1.7+.
//
// `@deepseek-ai/dsh-client-ui-primitives` is a seed word on BOTH kernels:
//   0.1.5-rc.2  `function by(){return{react:…,"@deepseek-ai/dsh-client-ui-primitives":Zg,…}}`
//   0.1.7-alpha.2 `function AS(){return{react:…,"@deepseek-ai/dsh-client-ui-primitives":Fj,…}}`
// so requiring it never consults the boot graph and never throws the
// "missed the module table" error. Nothing here may be bundled: a second
// physical copy of a DSH runtime package breaks module-local Symbol lookups.
const platformExternals = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
];

const result = await build({
  entryPoints: [resolve(sourceDirectory, 'index.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  external: platformExternals,
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
console.log(`Wrote ${outputPath}`);
