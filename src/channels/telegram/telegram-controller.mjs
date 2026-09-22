import { TokenBotController } from '../shared/token-bot-controller.mjs';
import {
  deriveTelegramBotIdentity,
  maskTelegramBotId,
  normalizeTelegramAccessPolicy,
} from './config-store.mjs';
import { inspectTelegramToken } from './telegram-api.mjs';
import { TELEGRAM_DESCRIPTOR } from './telegram-bridge.mjs';

export class TelegramController extends TokenBotController {
  #configStore;

  constructor(options) {
    super({
      ...options,
      descriptor: TELEGRAM_DESCRIPTOR,
      inspectToken: options.inspectToken ?? inspectTelegramToken,
      deriveIdentity: deriveTelegramBotIdentity,
      maskPlatformId: maskTelegramBotId,
    });
    this.#configStore = options.configStore;
  }

  status() {
    const snapshot = super.status();
    return {
      ...snapshot,
      bots: snapshot.bots.map((bot) => {
        const config = this.#configStore.get(bot.botId);
        const accessPolicy = normalizeTelegramAccessPolicy(config ?? {});
        return {
          ...bot,
          accessPolicy,
          // Default ON; only an explicit false in the config opts out.
          thinkingTraces: config?.thinkingTraces !== false,
        };
      }),
    };
  }

  async setAccessPolicy(botId, value) {
    const accessPolicy = normalizeTelegramAccessPolicy(value);
    return this.updateBotConfig(botId, (config) => ({ ...config, ...accessPolicy }));
  }

  async setThinkingTraces(botId, value) {
    return this.updateBotConfig(botId, (config) => ({
      ...config,
      thinkingTraces: value === true,
    }));
  }
}
