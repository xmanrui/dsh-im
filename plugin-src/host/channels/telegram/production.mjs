import { TelegramConfigStore } from '../../../../src/channels/telegram/config-store.mjs';
import { TelegramHarnessClient } from '../../../../src/channels/telegram/harness-client.mjs';
import { TelegramController } from '../../../../src/channels/telegram/telegram-controller.mjs';
import { TelegramRuntime } from '../../../../src/channels/telegram/telegram-runtime.mjs';
import { TelegramStateStore } from '../../../../src/channels/telegram/state-store.mjs';
import { createTokenProductionController } from '../shared/production.mjs';

export { normalizeTelegramAllowedUsers } from '../../../../src/channels/telegram/config-store.mjs';

export function createProductionController(ctx, config = {}, internals = {}) {
  return createTokenProductionController(ctx, config, internals, {
    channel: 'telegram',
    ConfigStore: TelegramConfigStore,
    StateStore: TelegramStateStore,
    HarnessClient: TelegramHarnessClient,
    Controller: TelegramController,
    Runtime: TelegramRuntime,
  });
}
