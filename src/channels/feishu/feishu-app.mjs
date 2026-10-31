import HttpsProxyAgent from 'https-proxy-agent';

function endpointFor(domain, path) {
  const origin = domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  return new URL(path, origin);
}

function requestProxyAgent(domain, env = process.env) {
  const host = domain === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn';
  // Evaluate NO_PROXY for every request: callers and tests may change the
  // environment after the SDK has already been imported.
  const exclusions = [env.no_proxy, env.NO_PROXY]
    .filter((value) => typeof value === 'string' && value.trim())
    .flatMap((value) => value.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  const excluded = exclusions.some((entry) => {
    if (entry === '*') return true;
    const bare = entry.startsWith('.') ? entry.slice(1) : entry;
    return bare && (host === bare || host.endsWith(`.${bare}`));
  });
  if (excluded) return undefined;
  // Axios does not create a proxy agent from the process environment itself.
  // Prefer lowercase to match Node conventions, then accept either spelling.
  for (const key of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']) {
    const value = env[key];
    if (typeof value === 'string' && value.trim()) return new HttpsProxyAgent(value.trim());
  }
  return undefined;
}

function withRequestProxy(options, domain) {
  const agent = requestProxyAgent(domain);
  // Disable Axios' own proxy merge so the explicitly constructed agent is the
  // only proxy path; without an agent, preserve the caller's original options.
  return agent ? { ...options, agent, httpsAgent: agent, proxy: false } : options;
}

function jsonResponse(body, operation) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`${operation} returned a non-JSON response`);
  }
  if (body.code !== 0) {
    throw new Error(`${operation} failed: ${body.msg || `code ${body.code}`}`);
  }
  return body;
}

/** Validate freshly provisioned credentials and read the bot identity. */
export async function verifyFeishuApp({
  appId,
  appSecret,
  domain = 'feishu',
  httpInstance,
  timeoutMs = 15000,
}) {
  if (!appId || !appSecret) throw new Error('Feishu credentials are incomplete');
  if (!httpInstance || typeof httpInstance.request !== 'function') {
    throw new TypeError('Feishu verification requires an HTTP instance');
  }
  const tokenBody = jsonResponse(await httpInstance.request(withRequestProxy({
    method: 'POST',
    url: endpointFor(domain, '/open-apis/auth/v3/tenant_access_token/internal').href,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    data: { app_id: appId, app_secret: appSecret },
    signal: AbortSignal.timeout(timeoutMs),
    timeout: timeoutMs,
  }, domain)), 'Feishu authentication');
  if (!tokenBody.tenant_access_token) {
    throw new Error('Feishu authentication returned no tenant access token');
  }

  const botBody = jsonResponse(await httpInstance.request(withRequestProxy({
    method: 'GET',
    url: endpointFor(domain, '/open-apis/bot/v3/info/').href,
    headers: { authorization: `Bearer ${tokenBody.tenant_access_token}` },
    signal: AbortSignal.timeout(timeoutMs),
    timeout: timeoutMs,
  }, domain)), 'Feishu bot verification');
  const bot = botBody.bot ?? {};
  return Object.freeze({
    appId,
    name: bot.app_name ?? bot.bot_name ?? null,
    openId: bot.open_id ?? null,
    activated: bot.activate_status ?? null,
  });
}
