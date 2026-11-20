/**
 * Resolve the application's root Cordis context without importing cordis.
 * Cordis 4.1 moved the root behind the `Context.root` symbol; a plain
 * `ctx.root` read now reaches the service resolver, which throws instead of
 * returning undefined. Older builds exposed a `root` accessor instead, and
 * bare test doubles have neither, so every access path stays best-effort.
 */
export function cordisRootContext(ctx) {
  const rootKey = Object.getPrototypeOf(ctx ?? {})?.constructor?.root;
  const root = typeof rootKey === 'symbol' ? ctx?.[rootKey] : undefined;
  if (root && ['object', 'function'].includes(typeof root)) return root;
  try {
    return ctx?.root ?? ctx;
  } catch {
    return ctx;
  }
}
