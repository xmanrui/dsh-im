// Shared, per-room conversation record for the Matrix channel.
//
// A Matrix room is one shared context: every participant's messages belong to
// the same record, regardless of who is addressed. The channel bot replies only
// when it is mentioned, but it conditions on the whole room. This store keeps a
// bounded, durable timeline of human and bot messages per room so that:
//   - unmentioned chatter is not lost -- it is recorded and later injected as
//     context the next time the bot is addressed, and
//   - older messages remain searchable across days so a session can pull prior
//     room history on demand.
//
// The store owns only the record and its queries; the runtime decides what is
// recorded and when pending context is consumed, so the trigger boundary stays
// in the inbound pipeline.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_ROOM_HISTORY_LIMIT = 2_000;
export const MIN_ROOM_HISTORY_LIMIT = 20;
export const MAX_ROOM_HISTORY_LIMIT = 50_000;
export const MIN_ROOM_CONTEXT_LIMIT = 1;
export const MAX_ROOM_CONTEXT_LIMIT = 500;
export const MIN_ROOM_CONTEXT_CHARS = 200;
export const MAX_ROOM_CONTEXT_CHARS = 200_000;
const ENTRY_TEXT_CHARS = 4_000;
const INJECTED_EVENT_MAX = 1_000;

export function matrixRoomHistoryPathFor(botDir) {
  return `${botDir}/matrix-history.json`;
}

function boundedInteger(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  if (!Number.isSafeInteger(rounded)) return fallback;
  return Math.min(Math.max(rounded, min), max);
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function localPart(matrixId) {
  if (typeof matrixId !== 'string') return '';
  const at = matrixId.indexOf(':');
  const local = at >= 0 ? matrixId.slice(1, at) : matrixId.replace(/^@/, '');
  return local.trim();
}

// Start of the civil day that `nowMs` falls in, at the configured UTC offset.
// Returned as an absolute epoch-ms threshold so an entry's own origin_serverTs
// (ms) can be compared against it directly.
export function roomContextDayStartTs(nowMs, tzOffsetMinutes) {
  const now = Number.isSafeInteger(nowMs) ? nowMs : Date.now();
  const offset = Number.isSafeInteger(tzOffsetMinutes) ? tzOffsetMinutes : 0;
  const shifted = now + offset * 60_000;
  const dayStartShifted = Math.floor(shifted / 86_400_000) * 86_400_000;
  return dayStartShifted - offset * 60_000;
}

function toTimestamp(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.trunc(value);
  return Date.now();
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const eventId = cleanText(raw.eventId, 255);
  const text = cleanText(raw.text, ENTRY_TEXT_CHARS);
  if (!eventId) return null;
  if (!text && raw.fromBot !== true) return null;
  const kind = raw.kind === 'bot' || raw.fromBot === true ? 'bot'
    : raw.kind === 'command' ? 'command' : 'human';
  return {
    eventId,
    sender: cleanText(raw.sender, 512),
    name: cleanText(raw.name, 256) || localPart(raw.sender),
    text,
    ts: toTimestamp(raw.ts),
    kind,
    injected: raw.injected === true || kind !== 'human',
  };
}

/**
 * Durable, bounded, per-room message record. Entries are kept in arrival order
 * (the runtime feeds the sync timeline, which is chronological per room). Each
 * room is trimmed to `limit` most-recent entries and injected-event markers are
 * pruned against the live entries so growth stays bounded. Writes are serialized
 * through an in-memory queue with an atomic temp-file rename, mirroring the
 * Matrix sidecar.
 */
export class MatrixRoomHistoryStore {
  #path;
  #limit;
  #value = { rooms: Object.create(null) };
  #writeQueue = Promise.resolve();

  constructor(path, { limit = DEFAULT_ROOM_HISTORY_LIMIT } = {}) {
    if (!path) throw new TypeError('Matrix room history requires a file path');
    this.#path = path;
    this.#limit = boundedInteger(limit, MIN_ROOM_HISTORY_LIMIT, MAX_ROOM_HISTORY_LIMIT, DEFAULT_ROOM_HISTORY_LIMIT);
  }

  get limit() {
    return this.#limit;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8'));
      const rooms = Object.create(null);
      if (parsed && typeof parsed === 'object' && parsed.rooms && typeof parsed.rooms === 'object') {
        for (const [roomId, room] of Object.entries(parsed.rooms)) {
          if (!roomId || !room || typeof room !== 'object') continue;
          const entries = Array.isArray(room.entries)
            ? room.entries.map(normalizeEntry).filter(Boolean)
            : [];
          const injected = new Set((Array.isArray(room.injected) ? room.injected : [])
            .filter((id) => typeof id === 'string' && id));
          rooms[roomId] = { entries, injected };
        }
      }
      this.#value = { rooms };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return this;
  }

  #roomEntry(roomId) {
    let room = this.#value.rooms[roomId];
    if (!room) {
      room = { entries: [], injected: new Set() };
      this.#value.rooms[roomId] = room;
    }
    return room;
  }

  #persist() {
    const rooms = Object.create(null);
    for (const [roomId, room] of Object.entries(this.#value.rooms)) {
      if (room.entries.length === 0) continue;
      rooms[roomId] = {
        entries: room.entries,
        injected: [...room.injected].slice(-INJECTED_EVENT_MAX),
      };
    }
    const snapshot = JSON.stringify({ rooms }, null, 2);
    const operation = this.#writeQueue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporary = `${this.#path}.tmp`;
      await writeFile(temporary, `${snapshot}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.#path);
    });
    this.#writeQueue = operation.then(() => undefined, () => undefined);
    void operation.catch(() => undefined);
  }

  /**
   * Record one room message. The caller decides the kind ('human', 'command'
   * or 'bot'); non-human and explicitly injected entries are marked as already
   * consumed so they never surface as pending context. Duplicate event ids are
   * ignored to keep a replayed sync from double-counting an entry.
   */
  append({ roomId, eventId, sender, name, text, ts, kind = 'human', injected } = {}) {
    if (!roomId || typeof eventId !== 'string' || !eventId.trim()) return null;
    const entry = normalizeEntry({ eventId, sender, name, text, ts, kind, injected });
    if (!entry) return null;
    const room = this.#roomEntry(roomId);
    if (room.entries.some((existing) => existing.eventId === entry.eventId)) return null;
    room.entries.push(entry);
    if (entry.injected) room.injected.add(entry.eventId);
    if (room.entries.length > this.#limit) {
      const dropped = room.entries.splice(0, room.entries.length - this.#limit);
      for (const removed of dropped) room.injected.delete(removed.eventId);
    }
    this.#persist();
    return entry;
  }

  /**
   * Ambient human chatter that has not been injected yet, from the same civil
   * day (entries at or after `sinceTs`), in chronological order. Pure -- does not
   * mark anything -- so the runtime can inspect what would be injected.
   */
  pending({ roomId, sinceTs = 0, limit = MAX_ROOM_CONTEXT_LIMIT } = {}) {
    const room = this.#value.rooms[roomId];
    if (!room) return [];
    const cap = boundedInteger(limit, MIN_ROOM_CONTEXT_LIMIT, MAX_ROOM_CONTEXT_LIMIT, MAX_ROOM_CONTEXT_LIMIT);
    return room.entries
      .filter((entry) => entry.kind === 'human' && !room.injected.has(entry.eventId) && entry.ts > sinceTs)
      .slice(-cap);
  }

  /**
   * Select the pending same-day chatter to inject now and mark those entries as
   * consumed, bounded by both a count and a character budget (the most recent
   * entries are preferred so the freshest context wins when the budget binds).
   */
  consumePending({ roomId, sinceTs = 0, limit, maxChars, now = Date.now() } = {}) {
    const room = this.#value.rooms[roomId];
    if (!room) return [];
    const cap = boundedInteger(limit, MIN_ROOM_CONTEXT_LIMIT, MAX_ROOM_CONTEXT_LIMIT, 50);
    const charCap = boundedInteger(maxChars, MIN_ROOM_CONTEXT_CHARS, MAX_ROOM_CONTEXT_CHARS, 8_000);
    const dayStart = roomContextDayStartTs(now, 0);
    const floor = Math.max(Number.isSafeInteger(sinceTs) ? sinceTs : 0, dayStart);
    const candidates = room.entries
      .filter((entry) => entry.kind === 'human' && !room.injected.has(entry.eventId) && entry.ts > floor);
    const selected = [];
    let used = 0;
    for (let index = candidates.length - 1; index >= 0 && selected.length < cap; index -= 1) {
      const entry = candidates[index];
      const cost = entry.text.length + (entry.name ? entry.name.length + 2 : 1);
      if (selected.length > 0 && used + cost > charCap) break;
      selected.unshift(entry);
      used += cost;
    }
    for (const entry of selected) room.injected.add(entry.eventId);
    if (selected.length > 0) this.#persist();
    return selected;
  }

  /**
   * Search the recorded room history across the retained window. Substring match
   * against text and speaker display name (case-insensitive), with optional
   * inclusive time bounds and a recency-first limit. Used to surface older room
   * history a session can pull in after the current-day auto-context has expired.
   */
  search({ roomId, query = '', sender = null, from = null, to = null, limit = 20 } = {}) {
    const room = this.#value.rooms[roomId];
    if (!room) return [];
    const needle = cleanText(query, 512).toLowerCase();
    const wantSender = cleanText(sender, 512).toLowerCase();
    const cap = boundedInteger(limit, 1, MAX_ROOM_CONTEXT_LIMIT, 20);
    const matches = [];
    for (let index = room.entries.length - 1; index >= 0 && matches.length < cap; index -= 1) {
      const entry = room.entries[index];
      if (Number.isSafeInteger(from) && from > 0 && entry.ts < from) continue;
      if (Number.isSafeInteger(to) && to > 0 && entry.ts > to) continue;
      if (wantSender
        && entry.sender.toLowerCase() !== wantSender
        && localPart(entry.sender).toLowerCase() !== wantSender
        && entry.name.toLowerCase() !== wantSender) continue;
      if (needle) {
        const haystack = `${entry.text}\n${entry.name}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      matches.push(entry);
    }
    return matches;
  }

  /** Drop a room record entirely (used when a room is removed/reset). */
  clear(roomId) {
    if (!this.#value.rooms[roomId]) return false;
    delete this.#value.rooms[roomId];
    this.#persist();
    return true;
  }

  /** Await the serialized write queue so all queued changes reach disk. */
  async flush() {
    await this.#writeQueue;
  }

  async remove() {
    const operation = this.#writeQueue.then(async () => {
      const { unlink } = await import('node:fs/promises');
      await unlink(this.#path).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    });
    this.#writeQueue = operation.then(() => undefined, () => undefined);
    await operation;
  }
}

/**
 * Format pending entries as a context block prepended to the prompt. Entries are
 * attributed by display name so the model can tell participants apart; the block
 * states it is room chatter the bot was not directly addressed in.
 */
// Each line carries a clock stamp and a bracketed speaker, and the whole run sits between a labelled
// opening and a closing fence: a bare list of speaker-colon-text lines reads to the model as questions
// that are waiting to be answered one by one.
function roomContextStamp(ts, offsetMinutes) {
  const stamp = Number.isSafeInteger(ts) ? ts : 0;
  const offset = Number.isSafeInteger(offsetMinutes) ? offsetMinutes : 0;
  const shifted = new Date(stamp + offset * 60_000);
  const hours = String(shifted.getUTCHours()).padStart(2, '0');
  const minutes = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `[${hours}:${minutes}]`;
}

export function formatRoomContextBlock(entries, {
  header = '', instruction = '', begin = '', end = '', tzOffsetMinutes = 0,
} = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const lines = entries.map((entry) => {
    const speaker = entry.name || entry.sender || '?';
    return `${roomContextStamp(entry.ts, tzOffsetMinutes)} [${speaker}] ${entry.text}`;
  });
  const parts = [];
  if (header) parts.push(header);
  if (instruction) parts.push(instruction);
  if (begin) parts.push(begin);
  parts.push(...lines);
  if (end) parts.push(end);
  return parts.join('\n');
}
