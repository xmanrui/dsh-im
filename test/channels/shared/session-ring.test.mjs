import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendSessionRing,
  createEmptySessionRing,
  dropSessionRingEntry,
  ensureSessionRingEntry,
  markSessionRingEntryUserTitled,
  navigateSessionRing,
  normalizeSessionRing,
  renameSessionRingEntry,
  sessionRingBackTarget,
  sessionRingEntryByNumber,
  sessionRingEntryBySessionId,
  sessionRingForwardTarget,
  stepSessionRingTo,
} from '../../../src/channels/shared/session-ring.mjs';

test('entry numbers start at 1, only grow, and are never reused after a drop', () => {
  const ring = createEmptySessionRing();
  const first = ensureSessionRingEntry(ring, 's1');
  const second = ensureSessionRingEntry(ring, 's2');
  const third = ensureSessionRingEntry(ring, 's3');
  assert.equal(first.created, true);
  assert.equal(first.entry.n, 1);
  assert.equal(second.entry.n, 2);
  assert.equal(third.entry.n, 3);
  assert.equal(ring.next, 4);

  // Re-binding an existing session refreshes it instead of allocating a number.
  const again = ensureSessionRingEntry(ring, 's2', { title: 'renamed' });
  assert.equal(again.created, false);
  assert.equal(again.entry.n, 2);
  assert.equal(ring.next, 4);

  // /drop leaves a hole: the number is gone and the next number is still fresh.
  assert.equal(dropSessionRingEntry(ring, 2), true);
  assert.equal(sessionRingEntryByNumber(ring, 2), null);
  const fourth = ensureSessionRingEntry(ring, 's4');
  assert.equal(fourth.entry.n, 4);
});

test('ensureSessionRingEntry records lastSeenAt and an optional title', () => {
  const ring = createEmptySessionRing();
  const { entry } = ensureSessionRingEntry(ring, 's1', { title: 'hello', now: 1000 });
  assert.equal(entry.title, 'hello');
  assert.equal(entry.lastSeenAt, 1000);

  const refreshed = ensureSessionRingEntry(ring, 's1', { now: 2000 }).entry;
  assert.equal(refreshed.lastSeenAt, 2000);
  assert.equal(refreshed.title, 'hello', 'a refresh without a title keeps the old one');
});

test('renameSessionRingEntry updates the title in place', () => {
  const ring = createEmptySessionRing();
  ensureSessionRingEntry(ring, 's1', { title: 'old' });
  const renamed = renameSessionRingEntry(ring, 1, 'new');
  assert.equal(renamed.title, 'new');
  assert.equal(sessionRingEntryByNumber(ring, 1).title, 'new');
  assert.equal(renameSessionRingEntry(ring, 99, 'x'), null);
});

test('navigateSessionRing pushes new entries and jumps existing ones with truncation', () => {
  const ring = createEmptySessionRing();
  for (const id of ['s1', 's2', 's3']) ensureSessionRingEntry(ring, id);

  navigateSessionRing(ring, 1);
  assert.deepEqual(ring.visits, [1]);
  assert.equal(ring.visitIndex, 0);

  navigateSessionRing(ring, 2);
  assert.deepEqual(ring.visits, [1, 2]);
  assert.equal(ring.visitIndex, 1);

  navigateSessionRing(ring, 3);
  assert.deepEqual(ring.visits, [1, 2, 3]);
  assert.equal(ring.visitIndex, 2);

  // Jumping back to 1 truncates the forward entries 2 and 3.
  navigateSessionRing(ring, 1);
  assert.deepEqual(ring.visits, [1]);
  assert.equal(ring.visitIndex, 0);
  assert.equal(sessionRingForwardTarget(ring), null);

  // A fresh push after a jump starts a new forward branch.
  navigateSessionRing(ring, 3);
  assert.deepEqual(ring.visits, [1, 3]);
  assert.equal(ring.visitIndex, 1);
});

test('back/forward targets and stepSessionRingTo walk the stack without truncating', () => {
  const ring = createEmptySessionRing();
  for (const id of ['s1', 's2', 's3']) ensureSessionRingEntry(ring, id);
  navigateSessionRing(ring, 1);
  navigateSessionRing(ring, 2);
  navigateSessionRing(ring, 3);

  assert.equal(sessionRingBackTarget(ring), 2);
  assert.equal(sessionRingForwardTarget(ring), null);

  stepSessionRingTo(ring, 2);
  assert.equal(ring.visitIndex, 1);
  assert.deepEqual(ring.visits, [1, 2, 3], 'a /prev step must not truncate forward entries');
  assert.equal(sessionRingBackTarget(ring), 1);
  assert.equal(sessionRingForwardTarget(ring), 3);

  stepSessionRingTo(ring, 1);
  assert.equal(ring.visitIndex, 0);
  assert.equal(sessionRingBackTarget(ring), null);
  assert.equal(sessionRingForwardTarget(ring), 2);
});

test('dropping an entry also retires it from the visit stack', () => {
  const ring = createEmptySessionRing();
  for (const id of ['s1', 's2', 's3']) ensureSessionRingEntry(ring, id);
  navigateSessionRing(ring, 1);
  navigateSessionRing(ring, 2);
  navigateSessionRing(ring, 3);
  stepSessionRingTo(ring, 2);

  dropSessionRingEntry(ring, 1);
  assert.deepEqual(ring.visits, [2, 3]);
  assert.equal(ring.visitIndex, 0, 'cursor shifts when the dropped entry was before it');
  assert.equal(sessionRingEntryBySessionId(ring, 's1'), null);
});

test('normalizeSessionRing rebuilds a malformed document defensively', () => {
  const ring = normalizeSessionRing({
    next: 7,
    entries: [
      { n: 3, sessionId: 's3', title: 'three', lastSeenAt: 300 },
      { n: 1, sessionId: 's1' },
      { n: 'bad', sessionId: 'x' },
      { n: 2, sessionId: 's2', lastSeenAt: 'not-a-number' },
    ],
    visits: [1, 3, 'bad', 1],
    visitIndex: 99,
  });
  assert.equal(ring.next, 7);
  assert.deepEqual(ring.entries.map((e) => e.n), [1, 2, 3], 'entries are ordered by number');
  assert.equal(ring.entries[2].title, 'three');
  assert.equal(ring.entries[2].lastSeenAt, 300);
  assert.equal(ring.entries[1].lastSeenAt, undefined, 'invalid timestamps are dropped');
  assert.deepEqual(ring.visits, [1, 3, 1]);
  assert.equal(ring.visitIndex, -1, 'an out-of-range cursor resets to -1');
});

test('normalizeSessionRing accepts empty and unknown input', () => {
  assert.deepEqual(normalizeSessionRing(null), createEmptySessionRing());
  assert.deepEqual(normalizeSessionRing('nope'), createEmptySessionRing());
  assert.deepEqual(normalizeSessionRing([1, 2]), createEmptySessionRing());
});

test('appendSessionRing appends a fallback jump without truncating forward entries', () => {
  const ring = createEmptySessionRing();
  for (const id of ['s1', 's2', 's3']) ensureSessionRingEntry(ring, id);
  navigateSessionRing(ring, 1);
  navigateSessionRing(ring, 2);
  assert.deepEqual(ring.visits, [1, 2]);
  assert.equal(ring.visitIndex, 1);

  // A fallback jump to 3 must keep 1 and 2 reachable.
  appendSessionRing(ring, 3);
  assert.deepEqual(ring.visits, [1, 2, 3]);
  assert.equal(ring.visitIndex, 2);
  assert.equal(sessionRingBackTarget(ring), 2, 'the way back is preserved');

  // A duplicate occurrence moves to the end rather than pushing twice.
  appendSessionRing(ring, 1);
  assert.deepEqual(ring.visits, [2, 3, 1]);
  assert.equal(ring.visitIndex, 2);
});

test('markSessionRingEntryUserTitled flags and normalize preserves it', () => {
  const ring = createEmptySessionRing();
  ensureSessionRingEntry(ring, 's1', { title: 'X' });
  const marked = markSessionRingEntryUserTitled(ring, 1);
  assert.equal(marked.userTitled, true);
  const reloaded = normalizeSessionRing(ring);
  assert.equal(reloaded.entries[0].userTitled, true);
  assert.equal(markSessionRingEntryUserTitled(ring, 99), null);
});
