import { TokenBotController } from '../shared/token-bot-controller.mjs';
import { inspectAirumoToken } from './api.mjs';
import { AIRUMO_DESCRIPTOR, deriveAirumoBotIdentity, maskAirumoBotId } from './config-store.mjs';
export class AirumoController extends TokenBotController {
  constructor(options) {
    super({
      ...options,
      descriptor: AIRUMO_DESCRIPTOR,
      inspectToken: options.inspectToken ?? inspectAirumoToken,
      deriveIdentity: deriveAirumoBotIdentity,
      maskPlatformId: maskAirumoBotId,
    });
  }
}
