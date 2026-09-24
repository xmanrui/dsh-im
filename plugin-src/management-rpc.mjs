import { resolveRpcAuthority } from './host/rpc-authority.mjs';

function rpcEndpoint(channel) {
  if (!/^\/[A-Za-z0-9._~-]+$/.test(channel)) throw new TypeError('Invalid IM RPC channel');
  return `dsh-im${channel}`;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLoopbackAuthority(authority) {
  if (!authority) return false;
  try {
    const url = new URL(`http://${authority}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    const hostname = url.hostname.replace(/\.$/, '');
    return hostname === 'localhost' || hostname === '[::1]'
      || /^127\.\d+\.\d+\.\d+$/.test(hostname);
  } catch { return false; }
}

function isLoopbackRequest(request) {
  if (!isLoopbackAuthority(request.headers.get('host'))) return false;
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && isLoopbackAuthority(url.host);
  } catch { return false; }
}

function reply(rpcId, result) {
  // Older endpoint handlers omit details; Connection's client requires the field.
  const value = result.ok === false
    ? { ...result, error: { ...result.error, details: result.error.details ?? {} } } : result;
  return Response.json({ type: 'server-response', rpcId, result: value });
}

const routeRegistries = new WeakMap();

/** Register an IM channel through the public /api carrier shared by supported DSH releases. */
export function registerManagementRpc(ctx, channel, handler, { authority, methodPrefix } = {}) {
  const policy = resolveRpcAuthority(authority);
  const endpoint = rpcEndpoint(channel);
  if (methodPrefix !== undefined
    && (typeof methodPrefix !== 'string' || !methodPrefix)) {
    throw new TypeError('Management RPC methodPrefix must be a non-empty string');
  }
  if (typeof ctx?.connection?.fetch?.register !== 'function') {
    throw new TypeError('DSH Host Connection Fetch registry is required');
  }
  if (methodPrefix === undefined) {
    return ctx.connection.fetch.register({
      path: `/api/${endpoint}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        if (policy === 'loopback' && !isLoopbackRequest(request)) return new Response('forbidden', { status: 403 });
        if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
        if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 });
        }
        let message;
        try { message = await request.json(); }
        catch { return new Response('body is not JSON', { status: 400 }); }
        const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request';
        const call = message?.payload;
        if (!isRecord(message) || message.type !== 'client-request' || typeof message.rpcId !== 'string'
          || message.method !== endpoint || !isRecord(call) || typeof call.method !== 'string'
          || !Object.hasOwn(call, 'payload')) {
          return reply(rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'Invalid IM management request.' } });
        }
        try { return reply(rpcId, await handler(call.method, call.payload, request.signal)); }
        catch { return new Response('IM management handler failed', { status: 500 }); }
      },
    });
  }
  let endpoints = routeRegistries.get(ctx);
  if (!endpoints) {
    endpoints = new Map();
    routeRegistries.set(ctx, endpoints);
  }
  let route = endpoints.get(endpoint);
  if (!route) {
    route = { handlers: new Map(), disposer: null };
    route.disposer = ctx.connection.fetch.register({
      path: `/api/${endpoint}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
      // DSH applies browser authentication and Host/Origin trust before this handler.
        if (policy === 'loopback' && !isLoopbackRequest(request)) return new Response('forbidden', { status: 403 });
        if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
        if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 });
        }
        let message;
        try { message = await request.json(); }
        catch { return new Response('body is not JSON', { status: 400 }); }
        const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request';
        const call = message?.payload;
        if (!isRecord(message) || message.type !== 'client-request' || typeof message.rpcId !== 'string'
          || message.method !== endpoint || !isRecord(call) || typeof call.method !== 'string'
          || !Object.hasOwn(call, 'payload')) {
          return reply(rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'Invalid IM management request.' } });
        }
        const selected = [...route.handlers.values()].find((entry) => (
          !entry.methodPrefix || call.method.startsWith(entry.methodPrefix)
        ));
        if (!selected) {
          return reply(rpcId, { ok: false, error: { code: 'gateway/unknown-method', message: 'Unknown IM management method.' } });
        }
        try {
          return reply(rpcId, await selected.handler(call.method, call.payload, request.signal));
        } catch {
          return new Response('IM management handler failed', { status: 500 });
        }
      },
    });
    endpoints.set(endpoint, route);
  }
  const token = Symbol('management-rpc-handler');
  route.handlers.set(token, { handler, methodPrefix });
  return () => {
    if (route.handlers.get(token) !== undefined) route.handlers.delete(token);
    if (route.handlers.size > 0) return true;
    route.disposer?.();
    endpoints.delete(endpoint);
    if (endpoints.size === 0) routeRegistries.delete(ctx);
    return true;
  };
}

/** Keep channel UI callers unchanged while using DSH's native correlation and response validation. */
export function callManagementRpc(connection, channel, method, payload, signal) {
  return connection.rpc.call('/api', rpcEndpoint(channel), { method, payload }, signal);
}
