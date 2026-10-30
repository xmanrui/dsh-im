import {
  TokenBotConfigStore,
  deriveTokenBotIdentity,
  maskPlatformId,
} from '../shared/token-config-store.mjs';
export const AIRUMO_DESCRIPTOR = Object.freeze({
  key: 'airumo',
  label: 'AIRumo',
  connectionLabel: ' Bot API',
});
const identity = { botPrefix: 'airumo', tokenRefPrefix: 'DSH_AIRUMO_BOT_TOKEN' };
export const deriveAirumoBotIdentity = (id) => deriveTokenBotIdentity(id, identity);
export const maskAirumoBotId = (id) => maskPlatformId(id, 'AIRumo');
export class AirumoConfigStore extends TokenBotConfigStore {
  constructor(path) {
    super(path, { channel: 'AIRumo', ...identity });
  }
}
