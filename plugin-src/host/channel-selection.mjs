/**
 * Build-time channel selection.
 *
 * The published package ships every channel in one Host bundle. `DSH_IM_CHANNELS`
 * (or `--channels=`) narrows that to a list, which is what a Feishu-only or
 * Telegram-only deployment actually loads: the build stubs every channel module
 * it was not asked for and the Host array drops the same keys, so esbuild never
 * walks the dropped channel's own import graph.
 *
 * An unset, empty or `all` value keeps the current behaviour — every channel.
 */

/** Host channel keys and the directory each one lives in. */
export const CHANNELS = Object.freeze([
  { key: 'feishu', dir: 'feishu' },
  { key: 'weixin', dir: 'weixin' },
  { key: 'dingtalk', dir: 'dingtalk' },
  { key: 'wecom', dir: 'wecom' },
  // The Host key is camel-cased; its directory is not.
  { key: 'wecomApp', dir: 'wecom-app' },
  { key: 'qq', dir: 'qq' },
  { key: 'slack', dir: 'slack' },
  { key: 'telegram', dir: 'telegram' },
  { key: 'discord', dir: 'discord' },
  { key: 'whatsapp', dir: 'whatsapp' },
  { key: 'imessage', dir: 'imessage' },
  { key: 'email', dir: 'email' },
  { key: 'matrix', dir: 'matrix' },
  { key: 'office', dir: 'office' },
]);

export const CHANNEL_KEYS = Object.freeze(CHANNELS.map((channel) => channel.key));

/** Locate one channel by its Host key or by its directory name. */
export function findChannel(token) {
  return CHANNELS.find((channel) => channel.key === token || channel.dir === token) ?? null;
}

/**
 * Resolve one selection string into the channels to keep and the ones to stub.
 *
 * Accepts commas, spaces and both spellings (`wecomApp` / `wecom-app`), so a
 * shell that cannot carry a comma-separated env var still has a way in.
 * An unknown name is an error: silently shipping a bundle without the channel
 * the caller asked for is worse than failing the build.
 */
export function parseChannelSelection(raw) {
  const tokens = typeof raw === 'string'
    ? raw.split(/[,\s]+/u).map((token) => token.trim()).filter(Boolean)
    : [];
  if (tokens.length === 0 || tokens.includes('all')) {
    return { selected: [...CHANNEL_KEYS], disabled: [] };
  }
  const unknown = tokens.filter((token) => !findChannel(token));
  if (unknown.length > 0) {
    throw new Error(
      `DSH_IM_CHANNELS: unknown channel(s) ${unknown.join(', ')}; known: ${CHANNEL_KEYS.join(', ')}`,
    );
  }
  const wanted = new Set(tokens.map((token) => findChannel(token).key));
  return {
    selected: CHANNEL_KEYS.filter((key) => wanted.has(key)),
    disabled: CHANNEL_KEYS.filter((key) => !wanted.has(key)),
  };
}

/** `--channels=a,b` on the command line, else `DSH_IM_CHANNELS`. */
export function channelSelectionArgument(argv = [], env = process.env) {
  const flag = argv.find((arg) => arg.startsWith('--channels='));
  return flag === undefined ? env.DSH_IM_CHANNELS : flag.slice('--channels='.length);
}

/**
 * esbuild plugin that replaces a dropped channel's entry module with a no-op.
 *
 * Only the entry (`channels/<dir>/index.mjs`) is matched: every other module of
 * a dropped channel is reachable through it alone, so stubbing the entry is
 * enough to keep the whole subtree out of the bundle.
 */
export function disabledChannelStubs(disabledKeys) {
  const dirs = new Set(
    disabledKeys
      .map((key) => CHANNELS.find((channel) => channel.key === key)?.dir)
      .filter(Boolean),
  );
  // esbuild compiles these filters as Go regexps: no `u` flag, no lookarounds.
  const entryFilter = /^\.\/channels\/([a-z-]+)\/index\.mjs$/;
  return {
    name: 'dsh-im-disabled-channel-stubs',
    setup(build) {
      build.onResolve({ filter: entryFilter }, (args) => {
        const match = args.path.match(entryFilter);
        if (!match || !dirs.has(match[1])) return null;
        return { path: args.path, namespace: 'dsh-im-disabled-channel' };
      });
      build.onLoad({ filter: /.*/, namespace: 'dsh-im-disabled-channel' }, () => ({
        contents: [
          'export const name = "disabled-channel";',
          'export const inject = [];',
          'export async function apply() {}',
          'export function createImHostPlugin() { return { name, inject, apply }; }',
          '',
        ].join('\n'),
        loader: 'js',
      }));
    },
  };
}

/** One line per build, so CI logs say which channels went in. */
export function describeSelection({ selected, disabled }) {
  return disabled.length === 0
    ? `channels: all ${selected.length}`
    : `channels: ${selected.join(', ')} (stubbed: ${disabled.length})`;
}
