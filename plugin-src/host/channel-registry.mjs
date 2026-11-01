import { apply as applyDingtalk } from './channels/dingtalk/index.mjs';
import { apply as applyDiscord } from './channels/discord/index.mjs';
import { apply as applyEmail } from './channels/email/index.mjs';
import { apply as applyFeishu } from './channels/feishu/index.mjs';
import { apply as applyIMessage } from './channels/imessage/index.mjs';
import { apply as applyMatrix } from './channels/matrix/index.mjs';
import { apply as applyOffice } from './channels/office/index.mjs';
import { apply as applyQq } from './channels/qq/index.mjs';
import { apply as applySlack } from './channels/slack/index.mjs';
import { apply as applyTelegram } from './channels/telegram/index.mjs';
import { apply as applyWecom } from './channels/wecom/index.mjs';
import { apply as applyWecomApp } from './channels/wecom-app/index.mjs';
import { apply as applyWeixin } from './channels/weixin/index.mjs';
import { apply as applyWhatsapp } from './channels/whatsapp/index.mjs';

/**
 * Single registration source for every host-side channel.
 *
 * Why this exists: adding a channel used to mean editing three places in
 * `plugin-src/host/index.mjs` (an import line, an `internals` fallback line,
 * and one entry in the `channels` array), and the config-key vs delivery-key
 * quirk (`wecomApp` in cordis config, `wecom-app` in the delivery service) was
 * a bare string comparison in the middle of `apply()`. With fourteen entries,
 * forgetting any of the three produced a channel that silently never started,
 * or worse, started with the wrong config slice.
 *
 * The registry collapses all three into one entry per channel. `index.mjs` now
 * only iterates this list, and `test/channel-registry.test.mjs` fails when a
 * directory under `channels/` exists without an entry (or vice versa) — that
 * pairing test is what makes "add a channel = add one entry" true rather than
 * aspirational.
 *
 * Field contract:
 * - `configKey`: the slice name in plugin config (cordis `config[name]`);
 * - `applyName`: the override key tests pass through `createImHostPlugin(internals)`;
 * - `apply`: the production activation function;
 * - `deliveryKey` (optional): the channel name used by the delivery service when
 *   it differs from `configKey` (only `wecomApp` -> `wecom-app` today);
 * - `withoutDeliveryService` (optional): the connector does not take a shared
 *   delivery service (`office` only);
 * - `capabilities` (REQUIRED): what this channel can actually send/receive, keyed
 *   exactly like `CAPABILITIES` in `scripts/channel-capability-matrix.mjs`.
 *
 * Why capabilities live *inside* each entry instead of a second module: the
 * upstream project this idea came from keeps them in a separate registry
 * (`bridgemap.UserTypingSupport`) and reconciles nothing — a protocol that
 * implements typing but forgets to register it stays unreachable in silence
 * (harmony: `EventUserTyping` implemented, never listed). A second table is only
 * safe if something compares it against the implementation. Here that comparison
 * is the gate: `node scripts/channel-capability-matrix.mjs --check` fails on drift
 * in BOTH directions — evidence the declaration denies, and a declaration the code
 * no longer backs. That is what makes this field a contract, not documentation.
 */
export const HOST_CHANNELS = Object.freeze([
  { configKey: 'feishu', applyName: 'applyFeishu', apply: applyFeishu, capabilities: Object.freeze(['text', 'image', 'file', 'voice', 'quote', 'group', 'stream', 'card']) },
  { configKey: 'weixin', applyName: 'applyWeixin', apply: applyWeixin, capabilities: Object.freeze(['text', 'image', 'file', 'group']) },
  { configKey: 'dingtalk', applyName: 'applyDingtalk', apply: applyDingtalk, capabilities: Object.freeze(['text', 'image', 'file', 'group', 'markdown']) },
  { configKey: 'wecom', applyName: 'applyWecom', apply: applyWecom, capabilities: Object.freeze(['text', 'image', 'quote', 'group']) },
  { configKey: 'wecomApp', applyName: 'applyWecomApp', apply: applyWecomApp, deliveryKey: 'wecom-app', capabilities: Object.freeze(['text', 'image', 'group']) },
  { configKey: 'qq', applyName: 'applyQq', apply: applyQq, capabilities: Object.freeze(['text', 'image', 'file', 'group']) },
  { configKey: 'slack', applyName: 'applySlack', apply: applySlack, capabilities: Object.freeze(['text', 'file', 'group', 'stream']) },
  { configKey: 'telegram', applyName: 'applyTelegram', apply: applyTelegram, capabilities: Object.freeze(['text', 'image', 'file', 'voice', 'quote', 'group', 'stream', 'card']) },
  { configKey: 'discord', applyName: 'applyDiscord', apply: applyDiscord, capabilities: Object.freeze(['text', 'file', 'quote', 'stream']) },
  { configKey: 'whatsapp', applyName: 'applyWhatsapp', apply: applyWhatsapp, capabilities: Object.freeze(['text', 'image', 'file', 'markdown']) },
  { configKey: 'imessage', applyName: 'applyIMessage', apply: applyIMessage, capabilities: Object.freeze(['text']) },
  { configKey: 'email', applyName: 'applyEmail', apply: applyEmail, capabilities: Object.freeze(['text', 'image', 'file']) },
  { configKey: 'matrix', applyName: 'applyMatrix', apply: applyMatrix, capabilities: Object.freeze(['text', 'image', 'group', 'markdown']) },
  { configKey: 'office', applyName: 'applyOffice', apply: applyOffice, withoutDeliveryService: true, capabilities: Object.freeze([]) },
]);

/** The delivery-service name for one registry entry (`wecomApp` -> `wecom-app`). */
export function deliveryKeyOf(entry) {
  return entry.deliveryKey ?? entry.configKey;
}
