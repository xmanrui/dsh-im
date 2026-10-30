import { AirumoLogoGlyph } from '../../channel-logos.js';
import { createTokenChannelSettings } from '../shared/token-channel.js';
import { AIRUMO_ENDPOINTS, airumoClientApi } from './api.js';
const channel = createTokenChannelSettings({
  channel: 'AIRumo',
  endpoints: AIRUMO_ENDPOINTS,
  api: airumoClientApi,
  LogoGlyph: AirumoLogoGlyph,
  installStyles: () => () => {},
  pageClass: 'dair-page',
  avatarClass: 'dair-avatar',
  connectionLabel: 'Bot API 长轮询',
  tokenPlaceholder: '填写 AIRumo 机器人设置中的专属 Token',
  emptyTitle: '接入 AIRumo 机器人',
  emptyDescription:
    '在 AIRumo 创建机器人，将专属 Token 填写到这里。可按需选择 Agent Preset；访问范围和群响应规则在 AIRumo 中配置。当前接口不支持主动提醒推送。',
  platformLabel: 'AIRumo',
  supportsAccessSettings: false,
  supportsContextEnhancement: false,
});
export const AirumoSettingsTab = channel.SettingsTab;
