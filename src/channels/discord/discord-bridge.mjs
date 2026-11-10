import { TextHarnessBridge, createTextBridgeStatus } from '../shared/text-harness-bridge.mjs';
import { DiscordApprovalCard } from './approval-card.mjs';

export const DISCORD_DESCRIPTOR = Object.freeze({
  key: 'discord',
  label: 'Discord',
  connectionLabel: ' Gateway 长连接',
  reactions: Object.freeze({ processing: '👀', success: '✅', error: '❌' }),
});

export class DiscordHarnessBridge extends TextHarnessBridge {
  constructor(options) {
    // Approval cards are on by default; `approvalCard: null` keeps the
    // plain-text approval flow for a caller that wants it (tests/tools).
    super({
      descriptor: DISCORD_DESCRIPTOR,
      ...options,
      approvalCard: options && Object.hasOwn(options, 'approvalCard')
        ? options.approvalCard
        : new DiscordApprovalCard({ logger: options?.logger }),
    });
  }
}

export { createTextBridgeStatus as createDiscordBridgeStatus };
