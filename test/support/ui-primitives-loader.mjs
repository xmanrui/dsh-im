/**
 * Registers the official-UI test double. Loaded through
 * `node --import ./test/support/ui-primitives-loader.mjs ...` (see the `test`
 * script in package.json) so that every client UI test — which imports the
 * client ESM sources directly — can resolve
 * `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * See `ui-primitives-stub.mjs` for why the real package cannot be loaded in
 * Node and what the double guarantees.
 */

import { register } from 'node:module';

register('./ui-primitives-hooks.mjs', import.meta.url);
