export const TELEGRAM_STYLE_ID = 'xmanrui-dsh-im-telegram-settings';

const CSS = String.raw`
.dtg-page.dim-channelPage { --ddt-accent: #229ed9; --ddt-accent-deep: #1687bd; --ddt-accent-wash: #eaf7fd; }
.dtg-avatar.dim-botAvatar { color: #fff; background: #229ed9; }
.dtg-avatar svg { display: block; }
`;

export function installTelegramStyles() {
  if (typeof document === 'undefined') return () => {};
  const existing = document.querySelector(`style[data-plugin-css="${TELEGRAM_STYLE_ID}"]`);
  if (existing) return () => {};
  const style = document.createElement('style');
  style.dataset.plugin = '@xmanrui/dsh-im';
  style.dataset.pluginCss = TELEGRAM_STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => style.remove();
}
