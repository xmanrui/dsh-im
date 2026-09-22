/**
 * 会话行为设置块：思考过程留痕开关（Telegram 专属）。
 *
 * 开启后，机器人把 agent 的推理与工具调用作为独立的 💭/🔧 消息实时发出来，
 * 最终答案单独成条；关闭则回到「占位符被最终答案覆盖」的原有单消息行为。
 */
import { h } from '../../i18n.js';

export function ThinkingTracesSettings({ account, busy, onSave }) {
  const checked = account.thinkingTraces !== false;
  return h('div', { className: 'dim-accountSettings' },
    h('h4', { className: 'dim-accountSettingsTitle' }, '会话行为'),
    h('label', { className: 'dim-accountSettingsRow' },
      h('span', { className: 'dim-accountSettingsText' },
        h('span', { className: 'dim-accountSettingsLabel' }, '思考过程留痕'),
        h('span', { className: 'dim-accountSettingsHelp' },
          '实时显示思考步骤与工具调用，最终答案单独成条')),
      h('input', {
        type: 'checkbox',
        className: 'dim-accountSettingsSwitch',
        checked,
        disabled: Boolean(busy),
        onChange: (event) => { onSave?.({ thinkingTraces: event.target.checked }); },
      })));
}
