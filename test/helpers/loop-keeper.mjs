import { after } from 'node:test';

/**
 * Keep this test file's event loop alive while its tests run.
 *
 * Several channel clients bound a call with `AbortSignal.timeout()` or an unref'd
 * delay, and Node does not ref those timers. A test that waits on nothing but that
 * deadline leaves the event loop empty, so `node:test` aborts it with "Promise
 * resolution is still pending but the event loop has already resolved" even though
 * the deadline would have fired, and the rest of the file is cancelled with it.
 *
 * One ref'd timer for the file's lifetime is enough to stop that, and it is cleared
 * as soon as the file's tests finish, so the process still exits on its own.
 */
export function keepEventLoopAlive(intervalMs = 1_000) {
  const timer = setInterval(() => {}, intervalMs);
  after(() => clearInterval(timer));
}
