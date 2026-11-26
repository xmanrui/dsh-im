/** Cordis exposes the Host root context under this registered symbol on new builds. */
const ROOT = Symbol.for('cordis.root');

/**
 * Resolve the Host's root context across Cordis versions.
 *
 * Newer Cordis keys the root context by `Symbol.for('cordis.root')` and rejects
 * the legacy `ctx.root` string property with `cannot get property "root"
 * without inject`. Older builds only expose `ctx.root`. Reading the symbol
 * first keeps both working; when neither is available the context itself is
 * the best scope a caller can use.
 */
export function hostRoot(ctx) {
  if (ctx == null) return ctx;
  const root = ctx[ROOT];
  if (root != null) return root;
  try {
    return ctx.root ?? ctx;
  } catch {
    return ctx;
  }
}
