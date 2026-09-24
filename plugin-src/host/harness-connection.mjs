import { modernHarnessApi } from './modern-harness-api.mjs';

function optionalService(ctx, name) {
  if (ctx && Object.hasOwn(ctx, name)) return ctx[name];
  return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
}

/** Connect to this Host directly unless an external Harness URL was configured. */
export function harnessConnection(ctx, config = {}) {
  if (config.harnessBaseUrl !== undefined) {
    return { baseUrl: new URL(config.harnessBaseUrl) };
  }
  const apiProxy = optionalService(ctx, 'apiProxy') ?? modernHarnessApi(ctx);
  return {
    apiProxy,
    // Cordis child contexts share one root; different Hosts must not share
    // ownership of pending questions and approvals.
    interactionScope: ctx.root ?? ctx,
  };
}
