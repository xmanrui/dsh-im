import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TEXT_OVERRIDE_FIELDS,
  normalizeTextOverrides,
  toolProgressWithName,
  validateTextOverrides,
} from '../../../src/channels/shared/text-overrides.mjs';

test('text overrides accept the five known fields and trim blanks away', () => {
  const value = validateTextOverrides({
    cardInitial: '  正在思考  ',
    working: '',
    toolUsing: '正在使用 {name}',
    webSearching: undefined,
    accessDenied: '   ',
  });
  assert.deepEqual(value, {
    cardInitial: '正在思考',
    toolUsing: '正在使用 {name}',
  });
  assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(TEXT_OVERRIDE_FIELDS, [
    'cardInitial', 'working', 'toolUsing', 'webSearching', 'accessDenied',
  ]);
});

test('text overrides reject unknown fields and oversized values', () => {
  assert.throws(() => validateTextOverrides({ nope: 'x' }), /unknown text override field/u);
  assert.throws(() => validateTextOverrides({ working: 'x'.repeat(501) }), /longer than 500/u);
  assert.throws(() => validateTextOverrides([]), /must be an object/u);
  assert.deepEqual(validateTextOverrides(null), {});
});

test('normalizeTextOverrides never throws on a damaged document value', () => {
  assert.deepEqual(normalizeTextOverrides({ bogus: 1 }), {});
  assert.deepEqual(normalizeTextOverrides('nope'), {});
});

test('toolProgressWithName replaces the placeholder only when present', () => {
  assert.equal(toolProgressWithName('正在使用 {name}', 'bash'), '正在使用 bash');
  assert.equal(toolProgressWithName('处理中', 'bash'), '处理中');
});
