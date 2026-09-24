/**
 * Node module hooks that redirect the browser-only official UI seed module to
 * the test double in `./ui-primitives-stub.mjs`.
 *
 * Only the bare specifier `@deepseek-ai/dsh-client-ui-primitives` is
 * intercepted; every other resolution goes through Node unchanged.
 */

const PRIMITIVES_SPECIFIER = '@deepseek-ai/dsh-client-ui-primitives';
const STUB_URL = new URL('./ui-primitives-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === PRIMITIVES_SPECIFIER) {
    return { url: STUB_URL, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
