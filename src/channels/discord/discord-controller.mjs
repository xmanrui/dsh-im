import { TokenBotController } from '../shared/token-bot-controller.mjs';
import { deriveDiscordBotIdentity, maskDiscordBotId } from './config-store.mjs';
import { inspectDiscordToken } from './discord-api.mjs';
import { DISCORD_DESCRIPTOR } from './discord-bridge.mjs';

export class DiscordController extends TokenBotController {
  constructor(options) {
    super({
      ...options,
      descriptor: DISCORD_DESCRIPTOR,
      inspectToken: options.inspectToken ?? inspectDiscordToken,
      deriveIdentity: deriveDiscordBotIdentity,
      maskPlatformId: maskDiscordBotId,
    });
  }
}
