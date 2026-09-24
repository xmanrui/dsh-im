import assert from 'node:assert/strict';
import { promptContentForMessage } from '../../src/channels/shared/image-prompt.mjs';
import { imageInputLimits } from '../../src/channels/shared/image-input-policy.mjs';

// Channel-only tests use lightweight Harness doubles. Consume the newly deferred
// sources here so their transport, ordering and error assertions remain useful.
// Real staging, compression and Host retries are covered by image-input tests.
export async function loadDeferredImages(content, options = {}) {
  if (!options.images?.length) return content;
  assert.ok(Array.isArray(content));
  assert.equal(content.some((part) => part.type === 'image'), false,
    'the bridge must leave model image preparation to HarnessClient');
  const limits = imageInputLimits();
  const loaded = await promptContentForMessage({ images: options.images }, {
    maxImageBytes: limits.maxDownloadBytes,
    maxImages: limits.maxImages,
    maxTotalImageBytes: limits.maxDownloadBytes * limits.maxImages,
    signal: options.signal,
  });
  return [...content, ...loaded.filter((part) => part.type === 'image')];
}
