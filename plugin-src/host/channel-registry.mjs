/**
 * The controllers of the channels this host has started, so an operator-level
 * action ("reconnect every bot") has something to iterate.
 *
 * A channel is started by its own apply() and the resulting object is not kept
 * anywhere else: without this registry the only way to reach a bot would be to
 * go through each channel's own RPC, one channel at a time, from the browser.
 */
const channels = new Map();

/** Called once per channel, right after its controller is assembled. */
export function registerChannelController(channel, controller) {
  if (typeof channel !== 'string' || !channel) return;
  if (!controller || typeof controller !== 'object') return;
  channels.set(channel, controller);
}

/** Every started channel with its controller, in start order. */
export function registeredChannels() {
  return [...channels.entries()];
}

/** Tests and profile reloads: drop what a previous run registered. */
export function forgetChannelControllers() {
  channels.clear();
}
