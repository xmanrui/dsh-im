const BADGE_LABEL = '滑动变祖器';
const BADGE_VALUES = Object.freeze(['今天是梁子', '今天是梁圣']);

function secureRandom() {
  const sample = new Uint32Array(1);
  crypto.getRandomValues(sample);
  return sample[0] / 0x1_0000_0000;
}

export function pickBadgeValue(random = secureRandom) {
  const sample = random();

  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError('Random samples must be finite numbers from 0 (inclusive) to 1 (exclusive).');
  }

  return BADGE_VALUES[Math.floor(sample * BADGE_VALUES.length)];
}

export function renderBadge(value) {
  if (!BADGE_VALUES.includes(value)) {
    throw new RangeError(`Unsupported badge value: ${value}`);
  }

  const accessibleLabel = `${BADGE_LABEL}: ${value}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="130" height="20" role="img" aria-label="${accessibleLabel}"><title>${accessibleLabel}</title><filter id="blur"><feGaussianBlur stdDeviation="16"/></filter><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="130" height="20" rx="3"/></clipPath><g clip-path="url(#r)"><rect width="65" height="20" fill="#555"/><rect x="65" width="65" height="20" fill="#f39c12"/><rect width="130" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110"><g transform="scale(.1)"><g aria-hidden="true" fill="#010101"><text x="335" y="150" fill-opacity=".8" filter="url(#blur)" textLength="550">${BADGE_LABEL}</text><text x="335" y="150" fill-opacity=".3" textLength="550">${BADGE_LABEL}</text></g><text x="335" y="140" textLength="550">${BADGE_LABEL}</text></g><g transform="scale(.1)"><g aria-hidden="true" fill="#010101"><text x="965" y="150" fill-opacity=".8" filter="url(#blur)" textLength="550">${value}</text><text x="965" y="150" fill-opacity=".3" textLength="550">${value}</text></g><text x="965" y="140" textLength="550">${value}</text></g></g></svg>`;
}

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
  'Content-Type': 'image/svg+xml; charset=utf-8',
  Expires: '0',
  Pragma: 'no-cache',
  'Surrogate-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function createBadgeResponse(method = 'GET') {
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: {
        ...NO_CACHE_HEADERS,
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  }

  const body = method === 'HEAD' ? null : renderBadge(pickBadgeValue());
  return new Response(body, { headers: NO_CACHE_HEADERS });
}

export default {
  fetch(request) {
    return createBadgeResponse(request.method);
  },
};
