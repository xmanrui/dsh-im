// Shared by the Host and settings UI; keep this module browser-compatible.
export const INBOUND_FILE_RETENTIONS = Object.freeze({
  turn: 'turn',
  forever: 'forever',
});

/** Normalize an inbound attachment retention value; returns null when invalid. */
export function normalizeInboundRetention(value) {
  if (value === undefined || value === null || value === '') return 'turn';
  return Object.values(INBOUND_FILE_RETENTIONS).includes(value) ? value : null;
}
