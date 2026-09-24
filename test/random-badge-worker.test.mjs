import assert from 'node:assert/strict';
import test from 'node:test';

import worker, {
  createBadgeResponse,
  pickBadgeValue,
  renderBadge,
} from '../worker/random-badge.mjs';

test('random badge selects both supported values at the sample boundary', () => {
  assert.equal(pickBadgeValue(() => 0), '今天是梁子');
  assert.equal(pickBadgeValue(() => 0.499999), '今天是梁子');
  assert.equal(pickBadgeValue(() => 0.5), '今天是梁圣');
  assert.equal(pickBadgeValue(() => 0.999999), '今天是梁圣');
});

test('random badge rejects invalid random samples and badge values', () => {
  assert.throws(() => pickBadgeValue(() => -0.1), RangeError);
  assert.throws(() => pickBadgeValue(() => 1), RangeError);
  assert.throws(() => renderBadge('今天是别人'), RangeError);
});

test('random badge reproduces the Shields layout for either value', () => {
  for (const value of ['今天是梁子', '今天是梁圣']) {
    const svg = renderBadge(value);

    assert.match(svg, /width="130" height="20"/);
    assert.match(svg, /<rect width="65" height="20" fill="#555"\/>/);
    assert.match(svg, /<rect x="65" width="65" height="20" fill="#f39c12"\/>/);
    assert.match(svg, new RegExp(`<title>滑动变祖器: ${value}</title>`));
  }
});

test('worker returns a fresh SVG and explicitly disables every cache layer', async () => {
  const response = await worker.fetch(new Request('https://badge.example/'));
  const svg = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, max-age=0');
  assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
  assert.equal(response.headers.get('cloudflare-cdn-cache-control'), 'no-store');
  assert.equal(response.headers.get('surrogate-control'), 'no-store');
  assert.match(svg, /今天是梁(?:子|圣)/);
});

test('worker supports HEAD and rejects state-changing methods', async () => {
  const headResponse = createBadgeResponse('HEAD');
  const postResponse = createBadgeResponse('POST');

  assert.equal(headResponse.status, 200);
  assert.equal(await headResponse.text(), '');
  assert.equal(postResponse.status, 405);
  assert.equal(postResponse.headers.get('allow'), 'GET, HEAD');
});
