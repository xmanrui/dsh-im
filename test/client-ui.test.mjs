import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import { transform } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer from 'react-test-renderer';

import {
  apply as applyClient,
  IM_PLUGIN_VERSION,
  IMSettingsTab,
  inject as clientInject,
} from '../plugin-src/client/index.js';
import { CredentialBindingPanel } from '../plugin-src/client/credential-binding.js';
import { ChannelListHeading } from '../plugin-src/client/channel-card-meta.js';
import { installImStyles } from '../plugin-src/client/styles.js';
import { FEISHU_ENDPOINTS } from '../plugin-src/client/channels/feishu/api.js';
import { DINGTALK_ENDPOINTS } from '../plugin-src/client/channels/dingtalk/api.js';
import {
  AccountCard as DingtalkAccountCard,
  DingtalkSettingsTab,
} from '../plugin-src/client/channels/dingtalk/index.js';
import {
  BotCard as FeishuBotCard,
  FeishuSettingsTab,
} from '../plugin-src/client/channels/feishu/index.js';
import {
  AccountCard as WeixinAccountCard,
  WeixinSettingsTab,
} from '../plugin-src/client/channels/weixin/index.js';
import {
  AccountCard as WecomAccountCard,
  WecomSettingsTab,
} from '../plugin-src/client/channels/wecom/index.js';
import { WecomAppSettingsTab } from '../plugin-src/client/channels/wecom-app/index.js';
import {
  AccountCard as QqAccountCard,
  QqSettingsTab,
} from '../plugin-src/client/channels/qq/index.js';
import {
  SlackAccountCard,
  SlackSettingsTab,
} from '../plugin-src/client/channels/slack/index.js';
import {
  TelegramAccountCard,
  TelegramSettingsTab,
} from '../plugin-src/client/channels/telegram/index.js';
import {
  DiscordAccountCard,
  DiscordSettingsTab,
} from '../plugin-src/client/channels/discord/index.js';
import {
  WhatsappAccountCard,
  WhatsappSettingsTab,
} from '../plugin-src/client/channels/whatsapp/index.js';
import {
  IMessageAccountCard,
  IMessageSettingsTab,
} from '../plugin-src/client/channels/imessage/index.js';
import {
  en,
  IM_LOCALE_NAMESPACE,
  localizeText,
  setImTranslator,
  zh,
} from '../plugin-src/client/i18n.js';
import {
  GLOBAL_SETTINGS_RPC_CHANNEL,
  GlobalSettingsPanel,
} from '../plugin-src/client/global-settings.js';
import {
  HOST_LANGUAGE_ENDPOINTS,
  HOST_LANGUAGE_RPC_CHANNEL,
} from '../plugin-src/client/interface-language.js';

const STYLES_URL = new URL('../plugin-src/client/styles.js', import.meta.url);
const FEISHU_STYLES_URL = new URL(
  '../plugin-src/client/channels/feishu/styles.js',
  import.meta.url,
);
const WEIXIN_STYLES_URL = new URL(
  '../plugin-src/client/channels/weixin/styles.js',
  import.meta.url,
);
const DINGTALK_STYLES_URL = new URL(
  '../plugin-src/client/channels/dingtalk/styles.js',
  import.meta.url,
);
const WECOM_STYLES_URL = new URL(
  '../plugin-src/client/channels/wecom/styles.js',
  import.meta.url,
);
const FEISHU_SOURCE_URL = new URL(
  '../plugin-src/client/channels/feishu/index.js',
  import.meta.url,
);
const WEIXIN_SOURCE_URL = new URL(
  '../plugin-src/client/channels/weixin/index.js',
  import.meta.url,
);
const CLIENT_BUNDLE_URL = new URL('../lib/client.js', import.meta.url);
const CLIENT_SOURCE_DIRECTORY_URL = new URL('../plugin-src/client/', import.meta.url);
const DINGTALK_CLIENT_SOURCE_URL = new URL(
  '../plugin-src/client/channels/dingtalk/index.js',
  import.meta.url,
);
const WECOM_SOURCE_URL = new URL(
  '../plugin-src/client/channels/wecom/index.js',
  import.meta.url,
);
const QQ_SOURCE_URL = new URL(
  '../plugin-src/client/channels/qq/index.js',
  import.meta.url,
);

const { act, create } = TestRenderer;

async function flushMicrotasks() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

// Drains every pending microtask and timer callback, like the Feishu channel
// tests use, so multi-hop save chains settle before assertions.
const flushTasks = () => new Promise((resolve) => setImmediate(resolve));

function nodeText(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node) return '';
  const children = Array.isArray(node) ? node : node.children;
  return Array.isArray(children) ? children.map(nodeText).join('') : nodeText(children);
}

function findButton(renderer, label) {
  const button = renderer.root.findAllByType('button')
    .find((candidate) => nodeText(candidate) === label);
  assert.ok(button, `missing button: ${label}`);
  return button;
}

test('removing the first account preserves collapse styles and toggling for remaining accounts', () => {
  const previousDocument = globalThis.document;
  const styles = new Set();
  globalThis.document = {
    querySelector: (selector) => [...styles].find((style) =>
      selector === `style[data-plugin-css="${style.dataset.pluginCss}"]`) ?? null,
    createElement: () => {
      const style = { dataset: {}, textContent: '', remove: () => styles.delete(style) };
      return style;
    },
    head: { appendChild: (style) => styles.add(style) },
  };
  const cards = (ids) => React.createElement(React.Fragment, null, ids.map((botId) =>
    React.createElement(QqAccountCard, {
      key: botId,
      account: {
        botId, connected: true, state: 'connected',
        bot: { name: botId, appIdMasked: '123••456' },
        health: { summary: 'Connected', lastCheckedAt: null },
      },
    })));
  const collapseStyles = () => [...styles].find((style) =>
    style.textContent.includes('.dim-collapsibleAccount:not(.is-open)'));
  let renderer;
  let disposeStyles;
  try {
    disposeStyles = installImStyles();
    act(() => { renderer = create(cards(['first', 'second'])); });
    const stylesheet = collapseStyles();
    assert.ok(stylesheet);

    act(() => renderer.update(cards(['second'])));
    assert.equal(collapseStyles(), stylesheet, 'remaining cards still need the shared collapse CSS');
    const header = () => renderer.root.findByProps({ className: 'dim-collapsibleHead' });
    const toggle = () => renderer.root.findByProps({ className: 'dim-accountSettingsToggle' });
    assert.equal(toggle().props['aria-expanded'], 'false');
    act(() => header().props.onClick());
    assert.equal(toggle().props['aria-expanded'], 'true');
    act(() => toggle().props.onClick({ stopPropagation() {} }));
    assert.equal(toggle().props['aria-expanded'], 'false');

    act(() => renderer.unmount());
    disposeStyles();
    assert.equal(styles.size, 0, 'disposing the settings styles still cleans up the document');
  } finally {
    act(() => renderer?.unmount());
    disposeStyles?.();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('IM settings renders twelve IM channels plus the AI Office connector', async () => {
  const { default: packageMetadata } = await import('../package.json', {
    with: { type: 'json' },
  });
  const { version: packageVersion } = packageMetadata;
  const styles = await readFile(STYLES_URL, 'utf8');
  const markup = renderToStaticMarkup(React.createElement(IMSettingsTab, {
    feishuRpcCall: async () => ({ ok: true, value: {} }),
    weixinRpcCall: async () => ({ ok: true, value: {} }),
    dingtalkRpcCall: async () => ({ ok: true, value: {} }),
    wecomRpcCall: async () => ({ ok: true, value: {} }),
    wecomAppRpcCall: async () => ({ ok: true, value: {} }),
    qqRpcCall: async () => ({ ok: true, value: {} }),
    slackRpcCall: async () => ({ ok: true, value: {} }),
    telegramRpcCall: async () => ({ ok: true, value: {} }),
    discordRpcCall: async () => ({ ok: true, value: {} }),
    whatsappRpcCall: async () => ({ ok: true, value: {} }),
    imessageRpcCall: async () => ({ ok: true, value: {} }),
    emailRpcCall: async () => ({ ok: true, value: {} }),
    officeRpcCall: async () => ({ ok: true, value: {} }),
  }));

  assert.match(markup, /IM机器人/);
  assert.match(markup, /让 DeepSeek Harness 触手可及/);
  assert.match(markup, /class="dim-brand"/);
  assert.equal(IM_PLUGIN_VERSION, packageVersion);
  assert.match(markup, new RegExp(
    `<div class="dim-brandHeading"><strong class="dim-brandName">DSH-IM<\\/strong><span class="dim-brandVersion">v${packageVersion.replaceAll('.', '\\.')}<\\/span><\\/div>`,
  ));
  assert.doesNotMatch(markup, /dim-versionTooltip|当前版本/);
  assert.doesNotMatch(markup, /dim-brandLogo|<img/);
  assert.match(markup, /href="https:\/\/github\.com\/xmanrui\/dsh-im"/);
  assert.match(markup, /target="_blank"/);
  assert.match(markup, /rel="noopener noreferrer"/);
  assert.match(markup, /aria-label="dsh-im GitHub"/);
  assert.match(markup, /dim-updateTrigger[^>]*aria-label="检查更新"[^>]*aria-haspopup="dialog"[^>]*><svg/);
  assert.match(markup, /class="dim-updateTooltip" role="tooltip">检查更新<\/span>/);
  assert.ok(markup.indexOf('dim-updateTrigger') < markup.indexOf('dim-githubAction'));
  assert.ok(markup.indexOf('dim-githubAction') < markup.indexOf('dim-generalSettingsAction'));
  assert.match(markup, /aria-describedby="[^"]+"/);
  assert.match(markup, /role="tooltip"[^>]*>帮助与反馈 · 前往 GitHub</);
  assert.match(markup, /id="dim-general-settings-trigger"/);
  assert.match(markup, /aria-label="通用设置"/);
  assert.doesNotMatch(markup, /aria-current="page"/);
  assert.match(markup, /role="tooltip"[^>]*>通用设置<\/span>/);
  const settingsButtonMarkup = markup.match(
    /<button[^>]*id="dim-general-settings-trigger"[^>]*>(.*?)<\/button>/,
  )?.[1] ?? '';
  assert.match(settingsButtonMarkup, /data-im-icon="global-settings"/);
  assert.doesNotMatch(settingsButtonMarkup, /通用设置/);
  assert.match(styles, /\.dim-title \{[^}]*margin: 0 0 18px;/);
  assert.match(styles, /\.dim-title p \{[^}]*color: var\(--dsw-alias-label-secondary, #646a73\);[^}]*font-size: 12px;[^}]*font-weight: 500;/);
  assert.match(styles, /\.dim-brand \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*align-items: flex-start;[^}]*gap: 1px;/);
  assert.match(styles, /\.dim-brandHeading \{[^}]*display: flex;[^}]*align-items: baseline;[^}]*gap: 8px;[^}]*white-space: nowrap;/);
  assert.match(styles, /\.dim-brandName \{[^}]*font-size: 20px;[^}]*font-weight: 800;[^}]*letter-spacing: \.04em;/);
  assert.match(styles, /\.dim-brandVersion \{[^}]*color: var\(--dsw-alias-label-tertiary, #8f959e\);[^}]*font: 500 10px\/16px[^}]*letter-spacing: 0;/);
  assert.doesNotMatch(styles, /dim-versionTooltip|\.dim-brand:focus-visible/);
  assert.doesNotMatch(styles, /\.dim-brandLogo/);
  assert.match(styles, /\.dim-githubLink \{[^}]*border: 1px solid var\(--dsw-alias-border-l2, #dfe1e5\);[^}]*text-decoration: none;/);
  assert.match(styles, /\.dim-githubTooltip \{[^}]*top: calc\(100% \+ 8px\);[^}]*transform: translateY\(-3px\);/);
  assert.match(styles, /\.dim-githubAction:hover \.dim-githubTooltip, \.dim-githubAction:focus-within \.dim-githubTooltip \{[^}]*opacity: 1;[^}]*visibility: visible;/);
  assert.match(styles, /\.dim-generalSettingsButton \{[^}]*width: 30px;[^}]*height: 30px;[^}]*display: grid;[^}]*border: 1px solid var\(--dsw-alias-border-l2, #dfe1e5\);/);
  assert.match(styles, /\.dim-generalSettingsTooltip \{[^}]*top: calc\(100% \+ 8px\);[^}]*transform: translateY\(-3px\);/);
  assert.match(styles, /\.dim-generalSettingsAction:hover \.dim-generalSettingsTooltip, \.dim-generalSettingsButton:focus-visible \+ \.dim-generalSettingsTooltip \{[^}]*opacity: 1;[^}]*visibility: visible;/);
  assert.match(styles, /\.dim-generalSettingsButton\[aria-current="page"\] \+ \.dim-generalSettingsTooltip \{[^}]*opacity: 0;[^}]*visibility: hidden;/);
  assert.doesNotMatch(styles, /\.dim-generalSettingsAction:focus-within \.dim-generalSettingsTooltip/);
  assert.match(styles, /\.dim-globalTtlTooltip \{[^}]*position: absolute;[^}]*opacity: 0;[^}]*visibility: hidden;/);
  assert.match(styles, /\.dim-globalTtlHelp:hover \.dim-globalTtlTooltip, \.dim-globalTtlHelpButton:focus-visible \+ \.dim-globalTtlTooltip \{[^}]*opacity: 1;[^}]*visibility: visible;/);
  assert.doesNotMatch(styles, /\.dim-globalTtlHelp:focus-within \.dim-globalTtlTooltip/);
  assert.match(styles, /\.dim-globalSweepAction \{[^}]*position: relative;[^}]*margin-left: auto;/);
  assert.match(styles, /\.dim-globalSweepConfirm \{[^}]*position: absolute;[^}]*top: calc\(100% \+ 8px\);[^}]*right: 0;/);
  assert.doesNotMatch(markup, /\d+ 个渠道|dim-channelCount/);
  assert.match(markup, />微信</);
  assert.match(markup, />飞书</);
  assert.match(markup, />钉钉</);
  assert.match(markup, />企业微信</);
  assert.match(markup, />企业微信应用</);
  assert.match(markup, />QQ</);
  assert.match(markup, />Slack</);
  assert.match(markup, />Telegram</);
  assert.match(markup, />Discord</);
  assert.match(markup, />WhatsApp</);
  assert.match(markup, />iMessage</);
  assert.match(markup, />Matrix</);
  assert.match(markup, />AI Office<\/strong><small class="dim-channelNote">（实验功能）<\/small>/);
  assert.match(markup, /dim-logoWeixin/);
  assert.match(markup, /dim-logoFeishu/);
  assert.match(markup, /dim-logoDingtalk/);
  assert.match(markup, /dim-logoWecom/);
  assert.match(markup, /dim-logoQq/);
  assert.match(markup, /dim-logoSlack/);
  assert.match(markup, /dim-logoTelegram/);
  assert.match(markup, /dim-logoDiscord/);
  assert.match(markup, /dim-logoWhatsapp/);
  assert.match(markup, /dim-logoIMessage/);
  assert.match(markup, /dim-logoMatrix/);
  assert.match(markup, /dim-logoOffice/);
  assert.match(styles, /\.dim-logoFeishu svg \{ width: 28px; height: 28px; \}/);
  // This render's `emailRpcCall` never reports the channel as
  // enabled, so the mailbox entry point is omitted: twelve IM channels plus the
  // AI Office connector. The email tab is covered separately below.
  assert.equal((markup.match(/role="tab"/g) ?? []).length, 13);
  assert.equal((markup.match(/aria-selected="true"/g) ?? []).length, 1);
  assert.doesNotMatch(markup, /role="switch"|type="checkbox"/);
  assert.doesNotMatch(markup, /dim-chevron|扫码绑定<\/small>|扫码接入<\/small>/);
  assert.doesNotMatch(markup, />INSTANT MESSAGING<|>Channel<|>微信设置</);
});

test('the general settings gear sits to the right of GitHub and outside the channel rail', () => {
  const markup = renderToStaticMarkup(React.createElement(IMSettingsTab, {
    globalSettingsRpcCall: async () => ({ ok: true, value: { ttlHours: 0 } }),
    weixinRpcCall: async () => ({ ok: true, value: {} }),
  }));

  assert.match(markup, /id="dim-general-settings-trigger"/);
  assert.match(markup, /aria-controls="dim-panel-global-settings"/);
  assert.match(markup, /class="dim-generalSettingsAction"/);
  assert.match(markup, /data-im-icon="global-settings"/);
  assert.ok(markup.indexOf('dim-githubAction') < markup.indexOf('dim-generalSettingsAction'));
  assert.ok(markup.indexOf('dim-generalSettingsAction') < markup.indexOf('dim-layout'));
  assert.doesNotMatch(markup, /id="dim-tab-global-settings"/);
  assert.doesNotMatch(markup, /dim-channelGlobal|dim-logoGlobal/);
  assert.match(markup, /aria-label="IM 设置导航"/);
  // The general panel only mounts once its header action is selected; the
  // action must not steal the initial selection from the first channel.
  assert.doesNotMatch(markup, /id="dim-panel-global-settings"/);
});

test('the general settings page uses an Attachments tab with contextual help and an explicit save button', () => {
  const markup = renderToStaticMarkup(React.createElement(GlobalSettingsPanel, {
    rpcCall: async () => ({ ok: true, value: { ttlHours: 24 } }),
  }));

  assert.match(markup, /aria-label="通用设置"/);
  assert.match(markup, /<h2>通用设置<\/h2>/);
  assert.match(markup, /role="tablist" aria-label="通用设置分类"/);
  assert.match(markup, /id="dim-general-settings-tab-attachments"[^>]*role="tab"[^>]*aria-selected="true"[^>]*>附件<\/button>/);
  assert.match(markup, /id="dim-general-settings-panel-attachments"[^>]*role="tabpanel"[^>]*aria-labelledby="dim-general-settings-tab-attachments"/);
  assert.equal((markup.match(/role="tab"/g) ?? []).length, 1);
  // No label wrapper: the input takes its accessible name from the heading.
  assert.doesNotMatch(markup, /<label[^>]*>[^<]*<input[^>]*id="dim-globalTtlInput"/);
  assert.match(markup, /<input[^>]*aria-labelledby="dim-globalTtlTitle"/);
  assert.match(markup, /aria-label="查看附件保留时长说明"/);
  assert.match(markup, /class="dim-globalTtlTooltip" role="tooltip"/);
  assert.match(markup, /<code>1~8760<\/code>/);
  assert.match(markup, /正在读取通用设置…/);
  // Field actions share one row; the heading stays dedicated to its label and help.
  const ttlFormMarkup = markup.match(/<form class="dim-globalTtlRow"[^]*?<\/form>/)?.[0] ?? '';
  assert.doesNotMatch(markup, /dim-globalHeadActions/);
  assert.match(ttlFormMarkup, />清理过期附件<\/button>/);
  assert.ok(ttlFormMarkup.indexOf('保存') < ttlFormMarkup.indexOf('清理过期附件'));
  assert.match(ttlFormMarkup, /aria-haspopup="dialog"/);
  assert.match(ttlFormMarkup, /aria-expanded="false"/);
  assert.doesNotMatch(ttlFormMarkup, /role="alertdialog"|>确认清理<\/button>/);
  assert.match(markup, /<button[^>]*type="submit"[^>]*disabled=""[^>]*data-kind="primary"[^>]*>保存<\/button>/);
});

test('the sweep action opens a separate confirmation popover and supports cancel', async () => {
  const calls = [];
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === 'settings.inbound-ttl.get') return { ok: true, value: { ttlHours: 24 } };
    if (endpoint === 'settings.inbound-ttl.sweep') {
      return { ok: true, value: { deletedDirectories: 2, sweptWorkspaces: 5 } };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(GlobalSettingsPanel, { rpcCall }));
    await flushMicrotasks();
  });

  await act(async () => {
    findButton(renderer, '清理过期附件').props.onClick();
  });
  const trigger = findButton(renderer, '清理过期附件');
  const confirmButton = findButton(renderer, '确认清理');
  const confirmDialog = renderer.root.findByProps({ role: 'alertdialog' });
  assert.equal(nodeText(trigger), '清理过期附件');
  assert.equal(trigger.props['aria-expanded'], true);
  assert.equal(confirmButton.props['data-kind'], 'danger');
  assert.equal(confirmDialog.props['aria-label'], '确认清理过期附件');
  assert.match(nodeText(confirmDialog), /确认清理当前已过期的附件？取消确认清理/);

  // Cancel closes the popover without running the sweep.
  await act(async () => {
    findButton(renderer, '取消').props.onClick();
  });
  assert.equal(renderer.root.findAllByProps({ role: 'alertdialog' }).length, 0);
  assert.equal(findButton(renderer, '清理过期附件').props['aria-expanded'], false);
  assert.equal(calls.filter((call) => call.endpoint === 'settings.inbound-ttl.sweep').length, 0);

  await act(async () => {
    findButton(renderer, '清理过期附件').props.onClick();
  });

  // Confirming still runs the sweep RPC, silently and without result text.
  await act(async () => {
    findButton(renderer, '确认清理').props.onClick();
    await flushMicrotasks();
  });
  assert.equal(calls.filter((call) => call.endpoint === 'settings.inbound-ttl.sweep').length, 1);
  assert.deepEqual(
    renderer.root.findAllByProps({ className: 'dim-globalFeedback' }),
    [],
  );
  assert.ok(findButton(renderer, '清理过期附件'));
  act(() => renderer.unmount());
});

test('the TTL input saves explicitly, preserves invalid text for correction, and disables save when unchanged', async () => {
  const calls = [];
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === 'settings.inbound-ttl.get') return { ok: true, value: { ttlHours: 24 } };
    if (endpoint === 'settings.inbound-ttl.set') {
      return { ok: true, value: { ttlHours: payload.ttlHours } };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(GlobalSettingsPanel, { rpcCall }));
    await flushMicrotasks();
  });
  const input = () => renderer.root.findByProps({ id: 'dim-globalTtlInput' });
  const form = () => renderer.root.findAllByType('form').find((form) => form.props.className === 'dim-globalTtlRow');
  const saveButton = () => findButton(renderer, '保存');
  const inlineNote = () => renderer.root.findAllByProps({ className: 'dim-globalInline' })
    .at(-1);
  assert.equal(input().props.value, '24');
  assert.equal(input().props.disabled, false);
  assert.equal(saveButton().props.disabled, true);

  // A valid changed value is not persisted until the user explicitly saves.
  await act(async () => {
    input().props.onChange({ target: { value: '48' } });
  });
  await act(async () => {
    input().props.onBlur();
  });
  assert.equal(calls.filter((call) => call.endpoint === 'settings.inbound-ttl.set').length, 0);
  assert.equal(saveButton().props.disabled, false);
  await act(async () => {
    form().props.onSubmit({ preventDefault() {} });
    await flushMicrotasks();
  });
  assert.deepEqual(calls.at(-1), { endpoint: 'settings.inbound-ttl.set', payload: { ttlHours: 48 } });
  assert.equal(input().props.value, '48');
  assert.equal(nodeText(inlineNote()), '已保存');
  assert.equal(saveButton().props.disabled, true);

  // Invalid input stays available for correction and cannot be submitted.
  await act(async () => {
    input().props.onChange({ target: { value: 'abc' } });
  });
  await act(async () => {
    input().props.onBlur();
    await flushMicrotasks();
  });
  assert.equal(calls.filter((call) => call.endpoint === 'settings.inbound-ttl.set').length, 1);
  assert.equal(input().props.value, 'abc');
  assert.equal(input().props['aria-invalid'], 'true');
  assert.equal(saveButton().props.disabled, true);
  assert.equal(nodeText(inlineNote()), '请输入 -1、0 或 1~8760 之间的整数。');

  // Restoring the saved value clears the error and keeps Save disabled.
  await act(async () => {
    input().props.onChange({ target: { value: '48' } });
  });
  await act(async () => {
    input().props.onBlur();
    await flushMicrotasks();
  });
  assert.equal(calls.filter((call) => call.endpoint === 'settings.inbound-ttl.set').length, 1);
  assert.equal(input().props['aria-invalid'], undefined);
  assert.equal(saveButton().props.disabled, true);
  act(() => renderer.unmount());
});

test('a failed explicit save keeps the input enabled with the error inline', async () => {
  const rpcCall = async (endpoint) => {
    if (endpoint === 'settings.inbound-ttl.get') return { ok: true, value: { ttlHours: 24 } };
    if (endpoint === 'settings.inbound-ttl.set') {
      return { ok: false, error: { code: 'store-unavailable', message: '无法写入设置存储。' } };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(GlobalSettingsPanel, { rpcCall }));
    await flushMicrotasks();
  });
  const input = () => renderer.root.findByProps({ id: 'dim-globalTtlInput' });
  const form = () => renderer.root.findAllByType('form').find((form) => form.props.className === 'dim-globalTtlRow');

  await act(async () => {
    input().props.onChange({ target: { value: '72' } });
  });
  await act(async () => {
    form().props.onSubmit({ preventDefault() {} });
    await flushMicrotasks();
  });
  assert.equal(input().props.disabled, false);
  assert.equal(input().props.value, '72');
  const note = renderer.root.findAllByProps({ className: 'dim-globalInline' }).at(-1);
  assert.equal(nodeText(note), '无法写入设置存储。');
  assert.equal(note.props.role, 'alert');
  act(() => renderer.unmount());
});

test('all channel styles use the current Harness theme tokens', async () => {
  const styles = (await Promise.all([
    readFile(STYLES_URL, 'utf8'),
    readFile(FEISHU_STYLES_URL, 'utf8'),
    readFile(WEIXIN_STYLES_URL, 'utf8'),
    readFile(DINGTALK_STYLES_URL, 'utf8'),
    readFile(WECOM_STYLES_URL, 'utf8'),
  ])).join('\n');

  assert.doesNotMatch(
    styles,
    /--dsw-alias-(?:bg-body|line-border|line-divider|fill-secondary|fill-tertiary|state-warning-primary)/,
  );
  assert.match(styles, /--dsw-alias-bg-layer-1/);
  assert.match(styles, /--dsw-alias-bg-module-platform/);
  assert.match(styles, /--dsw-alias-interactive-bg-hover/);
  assert.match(styles, /--dsw-alias-border-l1/);
  assert.match(styles, /--dsw-alias-border-l2/);
  assert.match(styles, /--dim-blue: var\(--dsw-alias-state-business-primary, #3370ff\)/);
  assert.match(
    styles,
    /\.dim-channel\[aria-selected="true"\][^}]*var\(--dsw-alias-bg-layer-3/,
  );
  assert.match(
    styles,
    /\.dim-panel \.dim-qrExpired[^}]*--dsw-static-neutral-bluish-1000/,
  );
});

test('shared QR cards stay square and stack within the narrow combined-channel panel', async () => {
  const styles = await readFile(STYLES_URL, 'utf8');
  assert.match(styles, /\.dim-panel \{ min-width: 0; container-type: inline-size; \}/);
  assert.match(styles, /\.dim-panel \.dim-qrFrame \{[^}]*width: min\(270px, 100%\);[^}]*height: auto;[^}]*aspect-ratio: 1;/);
  assert.match(
    styles,
    /@container \(max-width: 680px\)[\s\S]*\.dim-panel \.ddt-qrLayout \{ grid-template-columns: minmax\(0, 1fr\); justify-items: center;/,
  );
  assert.match(styles, /\.dim-panel \.ddt-qrFrame, \.dim-panel \.ddt-countdown \{ width: min\(270px, 100%\); \}/);
  assert.match(styles, /\.dim-panel \.ddt-qrColumn \{ width: 100%; min-width: 0; \}/);
  assert.match(styles, /\.dim-panel \.ddt-qrCopy \{ width: 100%; min-width: 0; overflow-wrap: anywhere; \}/);
});

test('Feishu bot cards place the application identifier under the bot name', async () => {
  const styles = await readFile(FEISHU_STYLES_URL, 'utf8');
  const markup = renderToStaticMarkup(React.createElement(FeishuBotCard, {
    connection: {
      botId: 'bot-feishu-card',
      state: 'connected',
      connected: true,
      bot: {
        name: '今天是牢梁',
        appIdMasked: 'cli_aaf4••••1234',
        domain: 'feishu',
        avatarUrl: 'https://example.com/custom-bot-avatar.png',
      },
      health: {
        summary: '长连接运行正常',
        lastCheckedAt: '2026-08-15T07:30:49.000Z',
      },
    },
    onReconnect() {},
    onRequestRemove() {},
    onConfirmRemove() {},
    onCancelRemove() {},
  }));

  assert.match(markup, /<div class="dim-aliasName"><h3[^>]*>今天是牢梁<\/h3>[^]*?<\/div><p[^>]*>cli_aaf4••••1234<\/p>/);
  assert.match(markup, /data-im-channel-logo="feishu"/);
  assert.match(markup, /class="bxf-card bxf-botCard dim-botCard"/);
  assert.match(markup, /class="bxf-healthPill dim-botHealth"/);
  assert.match(markup, /<button[^>]*aria-label="检查连接今天是牢梁"[^>]*><span>检查连接<\/span><\/button>/);
  assert.match(markup, /class="bxf-repairAction"[^]*role="tooltip"/);
  assert.match(markup, /card\.action\.trigger[^]*im:message:readonly[^]*im:resource/);
  assert.match(markup, /class="bxf-connectedFooter dim-cardFooter"/);
  assert.doesNotMatch(markup, /dim-cardSummary|长连接运行正常/);
  assert.equal((markup.match(/dim-cardAction(?: |")/g) ?? []).length, 3);
  assert.doesNotMatch(markup, /连接状态：|bxf-divider/);
  assert.doesNotMatch(markup, /custom-bot-avatar/);
  assert.match(markup, /class="dim-botHealthGroup"[^]*class="dim-lastChecked"><span>最近检查<\/span>/);
  assert.doesNotMatch(markup, /消息通道|dim-botMetric/);
  assert.match(markup, /class="dim-presetSelect"/);
  assert.doesNotMatch(markup, />应用标识<|>飞书机器人</);
  assert.doesNotMatch(styles, /\.bxf-statusGrid|\.bxf-metric/);
  assert.match(styles, /\.bxf-repairAction:hover \.bxf-repairTooltip,[^]*\.bxf-repairAction:focus-within \.bxf-repairTooltip \{[^}]*visibility: visible;/);
});

test('Feishu keeps its heading controls on one row without a plus icon', async () => {
  const styles = await readFile(FEISHU_STYLES_URL, 'utf8');
  const markup = renderToStaticMarkup(React.createElement(FeishuSettingsTab, {
    rpcCall: async () => ({ ok: true, value: {} }),
  }));

  assert.match(markup, /aria-label="扫码接入飞书机器人"/);
  assert.match(markup, /class="dim-actionIcon"[^]*<span>扫码接入机器人<\/span>/);
  assert.doesNotMatch(markup, />添加机器人</);
  assert.match(styles, /\.bxf-headingTools \{[^}]*justify-content: space-between;[^}]*flex-wrap: nowrap;/);
  assert.match(styles, /@container \(max-width: 620px\)[^]*\.bxf-headingTools \{ gap: 6px; \}/);
  assert.doesNotMatch(styles, /\.bxf-headingTools \.bxf-button \{ margin-left: auto; \}/);
});

test('Feishu bot settings render one step-push select with four presentations', async (t) => {
  const previousWindow = globalThis.window;
  let nextTimer = 0;
  const frames = new Map();
  globalThis.window = {
    setInterval() { return ++nextTimer; },
    clearInterval() {},
    setTimeout() { return ++nextTimer; },
    clearTimeout() {},
    requestAnimationFrame(callback) {
      const id = ++nextTimer;
      frames.set(id, callback);
      queueMicrotask(() => {
        const pending = frames.get(id);
        if (!pending) return;
        frames.delete(id);
        pending();
      });
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });

  let stepPush = false;
  let stepPushMode = 'post';
  const calls = [];
  const snapshot = () => ({
    schemaVersion: 2,
    revision: calls.length + 1,
    state: 'connected',
    bots: [{
      botId: 'bot_step_push',
      state: 'connected',
      connected: true,
      groupResponseMode: 'mention',
      groupTopicReply: false,
      stepPush,
      stepPushMode,
      bot: { name: '分步直推机器人', appIdMasked: 'cli_step••••push' },
      health: { status: 'healthy', summary: '长连接运行正常' },
    }],
  });
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === FEISHU_ENDPOINTS.status) return { ok: true, value: snapshot() };
    if (endpoint === FEISHU_ENDPOINTS.setStepPush) {
      stepPush = payload.stepPush;
      return { ok: true, value: snapshot() };
    }
    if (endpoint === FEISHU_ENDPOINTS.setStepPushMode) {
      stepPushMode = payload.stepPushMode;
      return { ok: true, value: snapshot() };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(FeishuSettingsTab, { rpcCall }));
    await flushTasks();
  });

  // Rendering: one select with the three presentations, defaulting to off.
  const stepPushSelect = () => renderer.root.findByProps({ 'aria-label': '任务过程展示' });
  assert.equal(stepPushSelect().type, 'select');
  assert.equal(stepPushSelect().props.value, 'off');
  assert.ok(renderer.root.findAllByType('h3')
    .some((heading) => nodeText(heading) === '任务过程展示'));
  assert.deepEqual(
    stepPushSelect().findAllByType('option').map((option) => option.props.value),
    ['off', 'live_cot', 'streaming_card', 'post'],
  );
  const helpNodes = renderer.root.findAll(
    (node) => node.props?.className === 'dim-feishuGroupHelp',
  );
  assert.equal(helpNodes.length, 1);
  assert.match(nodeText(helpNodes[0]), /只回复最终结果/);

  // off -> streaming_card: the flag write must land before the mode write so
  // the runtime never sees a mode without step push enabled.
  await act(async () => {
    stepPushSelect().props.onChange({ target: { value: 'streaming_card' } });
    await flushTasks();
  });
  const flagIndex = calls.findIndex(({ endpoint, payload }) => (
    endpoint === FEISHU_ENDPOINTS.setStepPush
      && payload.botId === 'bot_step_push'
      && payload.stepPush === true
  ));
  const modeIndex = calls.findIndex(({ endpoint, payload }) => (
    endpoint === FEISHU_ENDPOINTS.setStepPushMode
      && payload.botId === 'bot_step_push'
      && payload.stepPushMode === 'streaming_card'
  ));
  assert.ok(flagIndex >= 0, 'the enable flag is saved');
  assert.ok(modeIndex >= 0, 'the presentation mode is saved');
  assert.ok(flagIndex < modeIndex, 'the flag must be saved before the mode');
  assert.equal(stepPushSelect().props.value, 'streaming_card');

  // streaming_card -> live_cot: only the mode endpoint is called.
  const afterEnable = calls.length;
  await act(async () => {
    stepPushSelect().props.onChange({ target: { value: 'live_cot' } });
    await flushTasks();
  });
  const liveCalls = calls.slice(afterEnable);
  assert.equal(liveCalls.filter(({ endpoint, payload }) => (
    endpoint === FEISHU_ENDPOINTS.setStepPushMode && payload.stepPushMode === 'live_cot'
  )).length, 1);
  assert.equal(liveCalls.filter(({ endpoint }) => endpoint === FEISHU_ENDPOINTS.setStepPush).length, 0);
  assert.equal(stepPushSelect().props.value, 'live_cot');

  // live_cot -> post: only the mode endpoint is called.
  const afterLive = calls.length;
  await act(async () => {
    stepPushSelect().props.onChange({ target: { value: 'post' } });
    await flushTasks();
  });
  const postCalls = calls.slice(afterLive);
  assert.equal(postCalls.filter(({ endpoint }) => endpoint === FEISHU_ENDPOINTS.setStepPushMode).length, 1);
  assert.equal(postCalls.filter(({ endpoint }) => endpoint === FEISHU_ENDPOINTS.setStepPush).length, 0);
  assert.equal(stepPushSelect().props.value, 'post');

  // post -> off: only the flag endpoint is called, with false.
  const afterPost = calls.length;
  await act(async () => {
    stepPushSelect().props.onChange({ target: { value: 'off' } });
    await flushTasks();
  });
  const offCalls = calls.slice(afterPost);
  assert.equal(offCalls.filter(({ endpoint, payload }) => (
    endpoint === FEISHU_ENDPOINTS.setStepPush && payload.stepPush === false
  )).length, 1);
  assert.equal(offCalls.filter(({ endpoint }) => endpoint === FEISHU_ENDPOINTS.setStepPushMode).length, 0);
  assert.equal(stepPushSelect().props.value, 'off');
  await act(async () => renderer.unmount());
});

test('credential binding is a distinct secondary action beside QR binding in four channels', async () => {
  const settings = [
    ['飞书', FeishuSettingsTab],
    ['QQ', QqSettingsTab],
    ['钉钉', DingtalkSettingsTab],
    ['企业微信', WecomSettingsTab],
  ];
  for (const [channel, Component] of settings) {
    const markup = renderToStaticMarkup(React.createElement(Component, {
      rpcCall: async () => ({ ok: true, value: {} }),
    }));
    const scanIndex = markup.indexOf('dim-scanButton');
    const credentialIndex = markup.indexOf('dim-credentialButton');
    assert.ok(scanIndex >= 0, `${channel} should render a QR button`);
    assert.ok(credentialIndex > scanIndex, `${channel} should place credential binding after QR binding`);
    assert.match(markup, /data-kind="credential"/);
    const credentialMarkup = markup.slice(credentialIndex, markup.indexOf('</button>', credentialIndex));
    assert.match(credentialMarkup, /dim-actionIcon/);
    assert.match(credentialMarkup, /手动接入/);
  }

  const styles = await readFile(STYLES_URL, 'utf8');
  assert.match(styles, /\.dim-panel \.dim-bindActions \{[^}]*flex-wrap: nowrap;/);
  assert.match(styles, /\.dim-panel \.dim-credentialButton \{[^}]*border: 1px solid #86909c;[^}]*background: var\(--dsw-alias-bg-layer-1, #fff\)/);
  assert.match(styles, /\.dim-panel \.dim-actionIcon \{[^}]*flex: 0 0 15px;/);
  assert.doesNotMatch(styles, /\.dim-panel \.dim-credentialPanel \{[^}]*border-left:/);
});

test('Feishu manual binding selects Lark, clears credentials on platform changes and locks in-flight requests', async (t) => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    setInterval: () => 1, clearInterval() {},
    setTimeout: () => 1, clearTimeout() {},
    requestAnimationFrame(callback) { queueMicrotask(callback); return 1; },
    cancelAnimationFrame() {},
  };
  let renderer;
  t.after(async () => {
    if (renderer) await act(async () => renderer.unmount());
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const snapshot = { schemaVersion: 2, revision: 1, state: 'idle', bots: [] };
  const bindings = [];
  let finishBinding;
  const rpcCall = async (endpoint, payload) => {
    if (endpoint === FEISHU_ENDPOINTS.status) return { ok: true, value: snapshot };
    assert.equal(endpoint, FEISHU_ENDPOINTS.bindCredentials);
    bindings.push(payload);
    if (payload.domain === 'feishu') throw new Error('Test binding rejected');
    return new Promise((resolve) => { finishBinding = resolve; });
  };
  await act(async () => {
    renderer = create(React.createElement(FeishuSettingsTab, { rpcCall }));
    await flushTasks();
  });
  await act(async () => findButton(renderer, '手动接入').props.onClick());
  const platform = () => renderer.root.findByProps({ 'aria-label': '应用平台' });
  const inputs = () => renderer.root.findAllByType('input');
  const fill = async () => act(async () => {
    inputs()[0].props.onChange({ target: { value: ' cli_test ' } });
    inputs()[1].props.onChange({ target: { value: ' test-secret ' } });
  });
  const submit = async () => act(async () => {
    renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
    await flushTasks();
  });
  assert.equal(platform().props.value, 'feishu');
  assert.deepEqual(platform().findAllByType('option').map((node) => node.props.value), ['feishu', 'lark']);
  await fill();
  await submit();
  assert.deepEqual(bindings[0], { appId: 'cli_test', appSecret: 'test-secret', domain: 'feishu' });
  assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 1);
  await act(async () => platform().props.onChange({ target: { value: 'lark' } }));
  assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0);
  assert.ok(inputs().every((node) => node.props.value === ''), 'never reuse secrets across platforms');
  assert.match(inputs()[0].props.placeholder, /Lark/);
  assert.equal(inputs()[1].props.type, 'password');
  await fill();
  await submit();
  assert.deepEqual(bindings[1], { appId: 'cli_test', appSecret: 'test-secret', domain: 'lark' });
  assert.equal(platform().props.disabled, true);
  assert.ok(inputs().every((node) => node.props.disabled));
  assert.equal(findButton(renderer, '取消').props.disabled, true);
  await submit();
  assert.equal(bindings.length, 2, 'busy form cannot submit twice');
  await act(async () => {
    finishBinding({ ok: true, value: snapshot });
    await flushTasks();
  });
  assert.equal(renderer.root.findAllByType('form').length, 0);
  assert.match(nodeText(renderer.root), /Lark 机器人凭据已绑定/);
  assert.equal(en['应用平台'], 'App platform');
});

test('credential form stays compact while using a protected password input', () => {
  const markup = renderToStaticMarkup(React.createElement(CredentialBindingPanel, {
    channel: '企业微信',
    identityLabel: 'Bot ID',
    identityPlaceholder: '填写 Bot ID',
    secretLabel: 'Secret',
    secretPlaceholder: '填写 Secret',
    onSubmit() {},
    onCancel() {},
  }));
  assert.match(markup, />Bot ID</);
  assert.match(markup, /type="password"/);
  assert.match(markup, /autoComplete="new-password"/i);
  assert.match(markup, />手动接入企业微信机器人</);
  assert.doesNotMatch(markup, /已有机器人应用|Harness 会校验凭据|可见范围|受保护的凭据存储/);
  assert.doesNotMatch(markup, /value="[^"]+"/);
});

test('scan actions align left while online totals align right in every channel', async () => {
  const [imStyles, feishuStyles, weixinStyles, dingtalkStyles, wecomStyles, feishuSource, weixinSource, dingtalkSource, wecomSource] = await Promise.all([
    readFile(STYLES_URL, 'utf8'),
    readFile(FEISHU_STYLES_URL, 'utf8'),
    readFile(WEIXIN_STYLES_URL, 'utf8'),
    readFile(DINGTALK_STYLES_URL, 'utf8'),
    readFile(WECOM_STYLES_URL, 'utf8'),
    readFile(FEISHU_SOURCE_URL, 'utf8'),
    readFile(WEIXIN_SOURCE_URL, 'utf8'),
    readFile(DINGTALK_CLIENT_SOURCE_URL, 'utf8'),
    readFile(WECOM_SOURCE_URL, 'utf8'),
  ]);

  assert.match(imStyles, /\.dim-panel \.bxf-headingTools, \.dim-panel \.dxw-tools, \.dim-panel \.ddt-tools \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\) max-content;[^}]*justify-content: stretch;/);
  assert.match(imStyles, /\.dim-panel \.dim-bindActions > button \{[^}]*min-width: 0;/);
  assert.match(imStyles, /\.dim-panel \.bxf-headingTools \.dim-scanButton,[^}]*justify-self: start;/);
  assert.match(imStyles, /\.dim-panel \.bxf-headingTools \.dim-onlineBadge,[^}]*justify-self: end;/);
  assert.match(feishuStyles, /\.bxf-headingTools \{[^}]*justify-content: space-between;/);
  assert.match(weixinStyles, /\.dxw-tools \{[^}]*justify-content: space-between;/);
  assert.match(dingtalkStyles, /\.ddt-tools \{[^}]*justify-content: space-between;/);
  assert.match(wecomStyles, /\.dwecom-page/);

  const headingSource = (source) => source.slice(
    source.indexOf('function Heading'),
    source.indexOf('function LoadingView'),
  );
  const feishuHeading = headingSource(feishuSource);
  const weixinHeading = headingSource(weixinSource);
  const dingtalkHeading = headingSource(dingtalkSource);
  const wecomHeading = headingSource(wecomSource);
  assert.ok(feishuHeading.indexOf('扫码接入机器人') < feishuHeading.indexOf('bxf-totalBadge'));
  assert.ok(weixinHeading.indexOf('扫码接入机器人') < weixinHeading.indexOf('dxw-badge'));
  assert.ok(dingtalkHeading.indexOf('扫码接入机器人') < dingtalkHeading.indexOf('ddt-badge'));
  assert.ok(wecomHeading.indexOf('扫码接入机器人') < wecomHeading.indexOf('ddt-badge'));

  for (const heading of [feishuHeading, weixinHeading, dingtalkHeading, wecomHeading]) {
    assert.match(heading, /dim-scanButton/);
    assert.match(heading, /dim-onlineBadge/);
  }
  assert.doesNotMatch(weixinHeading, /dxw-dot/);
  assert.doesNotMatch(dingtalkHeading, /ddt-dot/);
  assert.match(imStyles, /\.dim-panel \.bxf-headingTools \.dim-scanButton,[^}]*border: 1px solid #1677ff;[^}]*border-radius: 8px;[^}]*background: #1677ff;[^}]*box-shadow: none;/);
  assert.match(imStyles, /\.dim-panel \.bxf-headingTools \.dim-onlineBadge,[^}]*border-radius: 999px;[^}]*background: var\(--dsw-alias-bg-module-platform, #f2f3f5\);[^}]*font-size: 12px;/);
});

test('channel headings omit the redundant local credential badge', () => {
  const components = [FeishuSettingsTab, WeixinSettingsTab, DingtalkSettingsTab, WecomSettingsTab];

  for (const Component of components) {
    const markup = renderToStaticMarkup(React.createElement(Component, {
      rpcCall: async () => ({ ok: true, value: {} }),
    }));
    assert.doesNotMatch(markup, /凭据仅保存在本机/);
  }
});

test('bot list headings omit the total already shown by the online badge', async () => {
  const sources = await Promise.all([
    FEISHU_SOURCE_URL,
    WEIXIN_SOURCE_URL,
    DINGTALK_CLIENT_SOURCE_URL,
    WECOM_SOURCE_URL,
    QQ_SOURCE_URL,
  ].map((url) => readFile(url, 'utf8')));

  for (const source of sources) {
    assert.doesNotMatch(source, /length} 个/);
    assert.match(source, /ChannelListHeading/);
  }
});

test('channel connection details live in an accessible heading tooltip', async () => {
  const styles = await readFile(STYLES_URL, 'utf8');
  const markup = renderToStaticMarkup(React.createElement(ChannelListHeading, {
    className: 'dxw-listHeading',
    title: '已接入的微信账号',
    connectionLabel: 'iLink 长轮询',
  }));

  assert.match(markup, /<h3>已接入的微信账号<\/h3>/);
  assert.match(markup, /aria-label="查看消息通道说明"/);
  assert.match(markup, /role="tooltip"><span>消息通道<\/span><strong>iLink 长轮询<\/strong>/);
  assert.match(styles, /\.dim-panel \.dim-channelHelp:hover \.dim-channelTooltip, \.dim-panel \.dim-channelHelp:focus-within \.dim-channelTooltip \{[^}]*opacity: 1;[^}]*visibility: visible;/);
});

test('all channel settings states use the DingTalk page treatment', async () => {
  const [styles, feishuSource, weixinSource, dingtalkSource, wecomSource] = await Promise.all([
    readFile(STYLES_URL, 'utf8'),
    readFile(FEISHU_SOURCE_URL, 'utf8'),
    readFile(WEIXIN_SOURCE_URL, 'utf8'),
    readFile(DINGTALK_CLIENT_SOURCE_URL, 'utf8'),
    readFile(WECOM_SOURCE_URL, 'utf8'),
  ]);

  for (const Component of [FeishuSettingsTab, WeixinSettingsTab, DingtalkSettingsTab, WecomSettingsTab]) {
    const markup = renderToStaticMarkup(React.createElement(Component, {
      rpcCall: async () => ({ ok: true, value: {} }),
    }));
    assert.match(markup, /dim-channelPage/);
    assert.match(markup, /dim-surfaceCard dim-loadingView/);
    assert.match(markup, /dim-spinner/);
  }

  for (const source of [feishuSource, weixinSource, dingtalkSource, wecomSource]) {
    for (const className of [
      'dim-channelPage',
      'dim-surfaceCard',
      'dim-loadingView',
      'dim-emptyView',
      'dim-qrLayout',
      'dim-inlineError',
      'dim-confirm',
    ]) {
      assert.match(source, new RegExp(className));
    }
  }

  assert.match(styles, /\.dim-panel \.dim-channelPage \{[^}]*flex-direction: column;[^}]*gap: 12px;/);
  assert.match(styles, /\.dim-panel \.dim-listHeading \{[^}]*margin: 0 0 6px;/);
  assert.match(styles, /\.dim-panel \.dim-botList \{[^}]*gap: 8px;/);
  assert.match(styles, /\.dim-panel \.dim-surfaceCard \{[^}]*border-radius: 14px;[^}]*box-shadow: 0 1px 2px/);
  assert.match(styles, /\.dim-panel \.dim-loadingView \{[^}]*padding: 38px;[^}]*text-align: center;/);
  assert.match(styles, /\.dim-panel \.dim-emptyView \{[^}]*grid-template-columns: minmax\(0, 1fr\) 180px;[^}]*gap: 30px;/);
  assert.match(styles, /\.dim-panel \.dim-qrLayout \{[^}]*grid-template-columns: 300px minmax\(0, 1fr\);[^}]*gap: 34px;[^}]*align-items: start;/);
  assert.match(styles, /\.dim-panel \.dim-viewActions \.bxf-button,[^}]*min-height: 34px;[^}]*border-radius: 8px;[^}]*font-size: 13px;/);
  assert.match(styles, /\.dim-panel \.dim-inlineError \{[^}]*padding: 22px;[^}]*background:/);
  assert.match(styles, /\.dim-panel \.dim-confirm \{[^}]*padding: 18px 24px;[^}]*border-top: 1px solid/);
});

test('bot cards reuse the same channel brand logos as the channel rail', () => {
  const railMarkup = renderToStaticMarkup(React.createElement(IMSettingsTab, {
    feishuRpcCall: async () => ({ ok: true, value: {} }),
    weixinRpcCall: async () => ({ ok: true, value: {} }),
    dingtalkRpcCall: async () => ({ ok: true, value: {} }),
    wecomRpcCall: async () => ({ ok: true, value: {} }),
  }));
  const accountMarkup = renderToStaticMarkup(React.createElement(WeixinAccountCard, {
    account: {
      botId: 'bot-weixin-card',
      state: 'connected',
      connected: true,
      bot: { name: '微信机器人', accountIdMasked: 'wxid••••1234' },
      stats: { messagesReceived: 2, messagesReplied: 2 },
      health: { summary: '长轮询运行正常', lastCheckedAt: '2026-08-15T07:30:49.000Z' },
    },
    onReconnect() {},
    onRequestRemove() {},
    onConfirmRemove() {},
    onCancelRemove() {},
  }));

  assert.match(railMarkup, /data-im-channel-logo="weixin"/);
  assert.match(railMarkup, /data-im-channel-logo="feishu"/);
  assert.match(railMarkup, /data-im-channel-logo="wecom"/);
  assert.match(accountMarkup, /class="dxw-card dim-botCard"/);
  assert.match(accountMarkup, /class="dxw-avatar dim-botAvatar"[^]*data-im-channel-logo="weixin"/);
  assert.match(accountMarkup, /class="dxw-health dim-botHealth"/);
  assert.match(accountMarkup, /class="dxw-accountFooter dim-cardFooter"/);
  assert.match(accountMarkup, /class="dim-presetSelect"/);
  assert.doesNotMatch(accountMarkup, /dim-cardSummary|微信消息长轮询运行正常/);
  assert.equal((accountMarkup.match(/dim-cardAction(?: |")/g) ?? []).length, 2);
  assert.match(accountMarkup, /class="dim-botHealthGroup"[^]*class="dim-lastChecked"><span>最近检查<\/span>/);
  assert.doesNotMatch(accountMarkup, /消息通道|dim-botMetric/);
  assert.doesNotMatch(accountMarkup, /收到 \/ 回复/);
});

test('Enterprise WeChat cards reuse the rail logo and compact action treatment', () => {
  const markup = renderToStaticMarkup(React.createElement(WecomAccountCard, {
    account: {
      botId: 'wecom-card', state: 'connected', connected: true,
      bot: { name: '企业微信机器人', appIdMasked: 'bot••••001' },
      health: { summary: '企业微信 WebSocket 长连接运行正常', lastCheckedAt: Date.now() },
    },
    onReconnect() {}, onRequestRemove() {}, onConfirmRemove() {}, onCancelRemove() {},
  }));
  assert.match(markup, /data-im-channel-logo="wecom"/);
  assert.equal((markup.match(/dim-cardAction(?: |")/g) ?? []).length, 2);
  assert.match(markup, /class="dim-lastChecked"><span>最近检查<\/span>/);
  assert.doesNotMatch(markup, /消息通道|dim-botMetric/);
});

test('DingTalk bot cards omit the redundant received and replied metric', () => {
  const markup = renderToStaticMarkup(React.createElement(DingtalkAccountCard, {
    account: {
      botId: 'bot-dingtalk-card',
      state: 'connected',
      connected: true,
      bot: { name: '钉钉机器人', clientIdMasked: 'ding••••oioy' },
      stats: { messagesReceived: 2, messagesReplied: 2 },
      health: { summary: 'Stream 长连接运行正常', lastCheckedAt: '2026-08-15T07:30:49.000Z' },
    },
    onReconnect() {},
    onRequestRemove() {},
    onConfirmRemove() {},
    onCancelRemove() {},
  }));

  assert.match(markup, /class="ddt-card dim-botCard"/);
  assert.match(markup, /class="ddt-health dim-botHealth"/);
  assert.match(markup, /class="dim-lastChecked"><span>最近检查<\/span>/);
  assert.match(markup, /class="ddt-accountFooter dim-cardFooter"/);
  assert.doesNotMatch(markup, /dim-cardSummary|Stream 长连接运行正常/);
  assert.equal((markup.match(/dim-cardAction(?: |")/g) ?? []).length, 2);
  assert.doesNotMatch(markup, /消息通道|dim-botMetric/);
  assert.doesNotMatch(markup, /收到 \/ 回复/);
});

test('DingTalk connection failures show actionable guidance and a log reference', () => {
  const markup = renderToStaticMarkup(React.createElement(DingtalkAccountCard, {
    account: {
      botId: 'bot-dingtalk-failed',
      state: 'error',
      connected: false,
      bot: { name: '钉钉机器人', clientIdMasked: 'ding••••fail' },
      health: { summary: '连接失败', lastCheckedAt: null },
      error: {
        code: 'stream-proxy-dependency-incompatible',
        message: '钉钉 Stream 连接失败：检测到代理依赖 agent-base 6.0.0。',
        hint: '请将 agent-base@6 固定为 6.0.2 后重新安装依赖。',
        referenceId: 'DT-CONN-DEADBEEF',
      },
    },
    onReconnect() {},
    onRequestRemove() {},
    onConfirmRemove() {},
    onCancelRemove() {},
  }));

  assert.match(markup, /agent-base 6\.0\.0/);
  assert.match(markup, /agent-base@6 固定为 6\.0\.2/);
  assert.match(markup, /stream-proxy-dependency-incompatible/);
  assert.match(markup, /DT-CONN-DEADBEEF/);
  assert.match(markup, /data-connection-diagnostic="true"/);
});

test('all IM channel cards keep localized actions visible above full-width feedback', async () => {
  const [imStyles, feishuStyles, weixinStyles, dingtalkStyles] = await Promise.all([
    readFile(STYLES_URL, 'utf8'),
    readFile(FEISHU_STYLES_URL, 'utf8'),
    readFile(WEIXIN_STYLES_URL, 'utf8'),
    readFile(DINGTALK_STYLES_URL, 'utf8'),
  ]);

  assert.match(feishuStyles, /\.bxf-botActions \{[^}]*width: 100%;[^}]*flex-wrap: wrap;/);
  assert.match(weixinStyles, /\.dxw-accountFooter \.dxw-actions \{[^}]*flex-wrap: nowrap;/);
  assert.match(dingtalkStyles, /\.ddt-accountFooter \.ddt-actions \{[^}]*flex-wrap: nowrap;/);
  assert.match(imStyles, /\.dim-panel \.dim-cardFooter \{[^}]*gap: 12px;[^}]*padding-top: 6px;[^}]*border-top: 1px solid/);
  assert.match(imStyles, /\.dim-panel \.dim-cardFooterLayout \{[^}]*width: 100%;[^}]*flex-direction: column;[^}]*align-items: stretch;/);
  assert.match(imStyles, /\.dim-panel \.dim-cardFooterLayout > \.dim-cardActions \{[^}]*align-self: stretch;/);
  assert.match(imStyles, /\.dim-panel \.dim-cardActions \{[^}]*width: 100%;[^}]*justify-content: flex-end;[^}]*flex-wrap: wrap;/);
  assert.match(imStyles, /\.dim-panel \.dim-cardFeedback \{[^}]*width: 100%;[^}]*overflow-wrap: anywhere;[^}]*white-space: normal;/);
  assert.match(imStyles, /\.dim-panel \.dim-cardActions \.dim-cardAction \{[^}]*min-height: 32px;[^}]*border-radius: 8px;[^}]*font-size: 13px;/);
  assert.match(imStyles, /\.dim-panel \.dim-cardActions \.dim-cardAction\[data-kind="danger"\] \{[^}]*#d54941/);

  const account = {
    botId: 'footer-layout-bot',
    connected: true,
    configured: true,
    state: 'connected',
    groupResponseMode: 'mention',
    bot: {
      name: '布局测试机器人',
      username: 'layout_bot',
      appIdMasked: 'cli_test••••1234',
      accountIdMasked: 'wx_test••••1234',
      clientIdMasked: 'ding_test••••1234',
      idMasked: 'bot_test••••1234',
    },
    health: { summary: '连接运行正常', lastCheckedAt: Date.now() },
    error: null,
  };
  const callbacks = {
    onReconnect() {},
    onRequestRemove() {},
    onConfirmRemove() {},
    onCancelRemove() {},
  };
  const notice = '测试消息已发送，请到对应机器人会话中确认。';
  const cards = [
    ['飞书', FeishuBotCard, { connection: account, testNotice: notice }],
    ['微信', WeixinAccountCard, { account, feedback: notice }],
    ['钉钉', DingtalkAccountCard, { account, feedback: notice }],
    ['企业微信', WecomAccountCard, { account, feedback: notice }],
    ['QQ', QqAccountCard, { account, feedback: notice }],
    ['Slack', SlackAccountCard, { account, testNotice: notice }],
    ['Telegram', TelegramAccountCard, { account, testNotice: notice }],
    ['Discord', DiscordAccountCard, { account, testNotice: notice }],
    ['WhatsApp', WhatsappAccountCard, { account, testNotice: notice }],
  ];

  for (const [channel, Card, props] of cards) {
    const markup = renderToStaticMarkup(React.createElement(Card, { ...callbacks, ...props }));
    assert.match(markup, /class="dim-cardFooterLayout"><div class="[^"]*dim-cardActions[^"]*">[^]*?<\/div><div class="[^"]*dim-cardFeedback[^"]*" role="status"/, channel);
    assert.ok(markup.indexOf('dim-cardActions') < markup.indexOf('dim-cardFeedback'), channel);
  }
});

test('all channel bot cards use the DingTalk card treatment', async () => {
  const styles = await readFile(STYLES_URL, 'utf8');

  assert.match(styles, /\.dim-panel \.dim-botCard \{[^}]*border-radius: 14px;[^}]*background: var\(--dsw-alias-bg-layer-1, #fff\);[^}]*box-shadow: 0 1px 2px/);
  assert.match(styles, /\.dim-panel \.dim-botCardBody \{[^}]*padding: 12px 8px;/);
  assert.match(styles, /\.dim-panel \.dim-botCardTop \{[^}]*align-items: flex-start;[^}]*gap: 6px;/);
  assert.match(styles, /\.dim-panel \.dim-botAvatar \{[^}]*width: 38px;[^}]*height: 38px;[^}]*border-radius: 11px;/);
  assert.match(styles, /\.dim-panel \.dim-botName h3 \{[^}]*font-size: 15px;/);
  assert.match(styles, /\.dim-panel \.dim-botHealthGroup \{[^}]*display: grid;[^}]*justify-items: end;[^}]*gap: 5px;/);
  assert.match(styles, /\.dim-panel \.dim-botCard \.dim-botHealth \{[^}]*background: transparent;[^}]*font-size: 12px;[^}]*font-weight: 400;/);
  assert.match(styles, /\.dim-panel \.dim-lastChecked \{[^}]*display: inline-flex;[^}]*font-size: 11px;[^}]*white-space: nowrap;/);
  assert.doesNotMatch(styles, /\.dim-panel \.dim-botMetrics|\.dim-panel \.dim-botMetric/);
});

test('bot card status stays in the top-right corner at every responsive breakpoint', async () => {
  const styles = await readFile(STYLES_URL, 'utf8');

  assert.match(styles, /\.dim-panel \.dim-botCardTop \{[^}]*display: flex;[^}]*align-items: flex-start;[^}]*justify-content: space-between;/);
  assert.match(styles, /\.dim-panel \.dim-botIdentity \{[^}]*min-width: 0;[^}]*flex: 1 1 0;/);
  assert.match(styles, /\.dim-panel \.dim-botHealthGroup \{[^}]*flex: none;[^}]*justify-items: end;/);
  assert.doesNotMatch(styles, /\.dim-panel \.dim-botCardTop \{ flex-direction: column;/);
  assert.doesNotMatch(styles, /\.dim-panel \.dim-botHealthGroup \{ justify-items: start;/);
});

test('bot cards wrap full workspace paths without horizontal scrolling', async () => {
  const styles = await readFile(STYLES_URL, 'utf8');

  assert.match(styles, /\.dim-panel \.dim-workspace \{[^}]*grid-template-columns: minmax\(0, 1fr\) max-content;[^}]*row-gap: 4px;[^}]*margin-top: 6px;[^}]*padding: 6px 10px;/);
  assert.match(styles, /\.dim-panel \.dim-workspaceHeader \{[^}]*display: contents;/);
  assert.match(styles, /\.dim-panel \.dim-workspacePath \{[^}]*grid-column: 1 \/ -1;[^}]*grid-row: 2;[^}]*overflow: hidden;[^}]*overflow-wrap: anywhere;[^}]*white-space: normal;/);
  assert.doesNotMatch(styles, /\.dim-panel \.dim-workspacePath \{[^}]*overflow-x: auto;/);
  assert.match(styles, /\.dim-panel \.dim-workspaceEdit \{[^}]*grid-column: 2;[^}]*grid-row: 1;[^}]*white-space: nowrap;/);
});

test('bot cards keep Agent Preset guidance in a keyboard-accessible help tooltip', async () => {
  const styles = await readFile(STYLES_URL, 'utf8');

  assert.match(styles, /\.dim-panel \.dim-preset \{[^}]*grid-template-columns: minmax\(0, 1fr\) max-content;[^}]*margin-top: 6px;[^}]*padding: 6px 10px;/);
  assert.match(styles, /\.dim-panel \.dim-presetHeader \{[^}]*position: relative;[^}]*grid-column: 1 \/ -1;[^}]*display: flex;[^}]*justify-content: space-between;/);
  assert.match(styles, /\.dim-panel \.dim-presetTitle \{[^}]*display: inline-flex;[^}]*gap: 5px;[^}]*white-space: nowrap;/);
  assert.match(styles, /\.dim-panel \.dim-presetHelpButton:focus-visible \{[^}]*box-shadow:/);
  assert.match(styles, /\.dim-panel \.dim-presetTooltip \{[^}]*position: absolute;[^}]*width: min\(320px, 100%\);[^}]*white-space: normal;[^}]*opacity: 0;[^}]*visibility: hidden;[^}]*pointer-events: none;/);
  assert.match(styles, /\.dim-panel \.dim-presetHelp:hover \.dim-presetTooltip, \.dim-panel \.dim-presetHelp:focus-within \.dim-presetTooltip \{[^}]*opacity: 1;[^}]*visibility: visible;/);
  assert.match(styles, /\.dim-panel \.dim-presetSelect \{[^}]*grid-column: 1 \/ -1;[^}]*grid-row: 2;/);
  assert.match(styles, /\.dim-panel \.dim-presetError \{[^}]*grid-column: 1 \/ -1;[^}]*grid-row: 3;/);
  assert.doesNotMatch(styles, /\.dim-panel \.dim-presetHelp \{[^}]*grid-row: 3;/);
});

test('the bundled DingTalk channel has no local sender approval workflow', async () => {
  const [source, bundle] = await Promise.all([
    readFile(DINGTALK_CLIENT_SOURCE_URL, 'utf8'),
    readFile(CLIENT_BUNDLE_URL, 'utf8'),
  ]);

  assert.equal('approveSender' in DINGTALK_ENDPOINTS, false);
  assert.equal('revokeSender' in DINGTALK_ENDPOINTS, false);
  assert.doesNotMatch(source, /SenderAccess|onApprove|onRevoke|approveSender|revokeSender/);
  assert.doesNotMatch(
    bundle,
    /bot\.sender\.approve|bot\.sender\.revoke|允许使用机器人的钉钉账号|批准使用/,
  );
});

test('the bilingual dictionary has no duplicate object keys', async () => {
  const source = await readFile(new URL('../plugin-src/client/i18n.js', import.meta.url), 'utf8');
  const { warnings } = await transform(source, { loader: 'js', logLevel: 'silent' });
  assert.deepEqual(warnings.filter((warning) => warning.id === 'duplicate-object-key'), []);
});

test('every shipped Chinese client string has an English projection', async () => {
  const paths = (await readdir(CLIENT_SOURCE_DIRECTORY_URL, { recursive: true }))
    .filter((path) => path.endsWith('.js') && path !== 'i18n.js');
  const sources = await Promise.all(paths.map((path) =>
    readFile(new URL(path, CLIENT_SOURCE_DIRECTORY_URL), 'utf8')));
  const strings = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
      if (/[\p{Script=Han}]/u.test(match[2])) strings.add(match[2]);
    }
  }

  setImTranslator((key) => en[key] ?? key);
  try {
    const untranslated = [...strings].filter((value) =>
      /[\p{Script=Han}]/u.test(localizeText(value)));
    assert.deepEqual(untranslated, []);
    assert.ok(strings.size > 350);
  } finally {
    setImTranslator(null);
  }
});

test('client source contains no legacy Plugins-tab settings registrations', async () => {
  const paths = (await readdir(CLIENT_SOURCE_DIRECTORY_URL, { recursive: true }))
    .filter((path) => path.endsWith('.js'));
  const sources = await Promise.all(paths.map(async (path) => ({
    path,
    source: await readFile(new URL(path, CLIENT_SOURCE_DIRECTORY_URL), 'utf8'),
  })));
  const legacy = sources
    .filter(({ source }) => source.includes('settings.plugins.tab'))
    .map(({ path }) => path);

  assert.deepEqual(legacy, []);
});

test('client registers one top-level bilingual IM settings section with a directory picker', async () => {
  const effects = [];
  const registrations = [];
  const dictionaries = [];
  const directoryCalls = [];
  const rpcCalls = [];
  const rpcCall = async (...args) => {
    rpcCalls.push(args);
    return { ok: true, value: {} };
  };
  const localeListeners = new Set();
  const ctx = {
    effect(install, label) {
      effects.push({ install, label });
      if (label === 'im-settings: client panel service') return install();
    },
    on(event, listener) {
      assert.equal(event, 'locale/change');
      localeListeners.add(listener);
      return () => localeListeners.delete(listener);
    },
    locale: {
      bind(namespace) {
        assert.equal(namespace, IM_LOCALE_NAMESPACE);
        return (key) => en[key] ?? key;
      },
      register(namespace, value) {
        dictionaries.push({ namespace, value });
        return () => {};
      },
      getLocale() {
        return { active: 'en', locales: [], revision: 1 };
      },
    },
    connection: { rpc: { call: rpcCall } },
    workspaces: {
      async listDirectory(path, signal) {
        directoryCalls.push({ operation: 'list', path, signal });
        return { path, entries: [] };
      },
      async pickDirectory() {
        directoryCalls.push({ operation: 'pick' });
        return '/workspace/chosen';
      },
    },
    slots: {
      inject(name, install) {
        assert.equal(name, 'settings.section');
        return install();
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };

  try {
    applyClient(ctx);
    const dictionaryEffect = effects.find((entry) => entry.label === 'im-settings: bilingual dictionaries');
    assert.ok(dictionaryEffect);
    dictionaryEffect.install();

    assert.deepEqual(clientInject, ['slots', 'connection', 'locale', 'workspaces']);
    assert.equal(dictionaries[0].namespace, IM_LOCALE_NAMESPACE);
    assert.deepEqual(Object.keys(dictionaries[0].value.en).sort(), Object.keys(dictionaries[0].value.zh).sort());
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].options.name, 'settings.section');
    assert.equal(registrations[0].options.id, 'xmanrui-dsh-im');
    assert.equal(registrations[0].options.order, 21);
    assert.equal(registrations[0].options.locale, IM_LOCALE_NAMESPACE);
    assert.equal(registrations[0].options.label(), 'IM bots');
    assert.equal(typeof registrations[0].component, 'function');

    const injected = registrations[0].options.inject();
    const signal = new AbortController().signal;
    await injected.updateRpcCall('update.status', {}, signal);
    await injected.globalSettingsRpcCall('settings.inbound-ttl.get', {}, signal);
    await injected.imessageRpcCall('connection.status', {}, signal);
    assert.deepEqual(rpcCalls, [
      ['/api', 'dsh-im/dsh-im', { method: 'update.status', payload: {} }, signal],
      ['/api', `dsh-im${GLOBAL_SETTINGS_RPC_CHANNEL}`, { method: 'settings.inbound-ttl.get', payload: {} }, signal],
      ['/api', 'dsh-im/imessage', { method: 'connection.status', payload: {} }, signal],
    ]);
    assert.deepEqual(
      await injected.workspaceDirectoryPicker.listDirectory('/workspace/current', signal),
      { path: '/workspace/current', entries: [] },
    );
    assert.equal(await injected.workspaceDirectoryPicker.pickDirectory(), '/workspace/chosen');
    assert.deepEqual(directoryCalls, [
      { operation: 'list', path: '/workspace/current', signal },
      { operation: 'pick' },
    ]);

    const markup = renderToStaticMarkup(React.createElement(
      registrations[0].component,
      injected,
    ));
    // A browser-derived interface locale reaches the Host only through this
    // mirror, so the settings section must report it while it is mounted.
    const mirrorEffect = effects.find((entry) =>
      entry.label === 'im-settings: mirror the DSH interface language');
    assert.ok(mirrorEffect, 'the interface language mirror is installed');
    const before = rpcCalls.length;
    const disposeMirror = mirrorEffect.install();
    assert.deepEqual(rpcCalls.slice(before), [
      ['/api', `dsh-im${HOST_LANGUAGE_RPC_CHANNEL}`, {
        method: HOST_LANGUAGE_ENDPOINTS.mirror, payload: { locale: 'en' },
      }, undefined],
    ]);
    assert.equal(localeListeners.size, 1);
    disposeMirror();
    assert.equal(localeListeners.size, 0);

    assert.match(markup, /Connecting DeepSeek Harness/);
    assert.match(markup, new RegExp(
      `class="dim-brandVersion">v${IM_PLUGIN_VERSION.replaceAll('.', '\\.')}<\\/span>`,
    ));
    assert.match(markup, /Help &amp; feedback · Open GitHub/);
    assert.match(markup, /General settings/);
    assert.match(markup, />WeChat<|>Feishu<|>DingTalk<|>WeCom</);
    assert.match(markup, />QQ<[^]*>Slack<[^]*>Telegram<[^]*>Discord<[^]*>WhatsApp</);
    assert.match(markup, />AI Office<\/strong><small class="dim-channelNote">\(Experimental\)<\/small>/);
    assert.doesNotMatch(markup, /[\p{Script=Han}]/u);
  } finally {
    setImTranslator(null);
  }
});

test('client directory picker uses the current DSH uiWorkspace service', async () => {
  const registrations = [];
  const directoryCalls = [];
  let uiWorkspace;
  const ctx = {
    effect(install, label) {
      if (label === 'im-settings: client panel service') return install();
    },
    get(name) {
      assert.equal(name, 'uiWorkspace');
      return uiWorkspace;
    },
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
    },
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
    workspaces: {
      list: {
        getSnapshot: () => ({ items: [] }),
        subscribe: () => () => {},
      },
    },
    slots: {
      inject(name, install) {
        assert.equal(name, 'settings.section');
        return install();
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };

  try {
    applyClient(ctx);
    uiWorkspace = {
      async listDirectory(path, signal) {
        directoryCalls.push({ operation: 'list', path, signal });
        return { path, entries: [] };
      },
      async pickDirectory() {
        directoryCalls.push({ operation: 'pick' });
        return '/workspace/current-host';
      },
    };

    const injected = registrations[0].options.inject();
    const signal = new AbortController().signal;
    assert.deepEqual(
      await injected.workspaceDirectoryPicker.listDirectory('/workspace/current', signal),
      { path: '/workspace/current', entries: [] },
    );
    assert.equal(
      await injected.workspaceDirectoryPicker.pickDirectory(),
      '/workspace/current-host',
    );
    assert.deepEqual(directoryCalls, [
      { operation: 'list', path: '/workspace/current', signal },
      { operation: 'pick' },
    ]);
  } finally {
    setImTranslator(null);
  }
});

test('all nine channel settings and connected cards render English copy', () => {
  const rpcCall = async () => ({ ok: true, value: {} });
  const noop = () => {};
  const account = {
    botId: 'bot-english',
    state: 'connected',
    connected: true,
    bot: {
      name: 'Demo Bot',
      accountIdMasked: 'account••01',
      appIdMasked: 'app••01',
      clientIdMasked: 'client••01',
      idMasked: 'bot••01',
      username: 'demo_bot',
    },
    health: { summary: 'Connection is healthy', lastCheckedAt: '2026-08-16T08:00:00.000Z' },
  };

  setImTranslator((key) => en[key] ?? key);
  try {
    const globalMarkup = renderToStaticMarkup(React.createElement(GlobalSettingsPanel, {
      rpcCall: async () => ({ ok: true, value: { ttlHours: 24 } }),
    }));
    assert.match(globalMarkup, /General settings/);
    assert.match(globalMarkup, />Attachments<\/button>/);
    assert.match(globalMarkup, /Attachment retention \(hours\)/);
    assert.match(globalMarkup, /Clean up expired attachments/);
    assert.match(globalMarkup, /Loading general settings…/);
    assert.doesNotMatch(globalMarkup, /[\p{Script=Han}]/u);

    const pages = [
      WeixinSettingsTab,
      FeishuSettingsTab,
      DingtalkSettingsTab,
      WecomSettingsTab,
      WecomAppSettingsTab,
      QqSettingsTab,
      SlackSettingsTab,
      TelegramSettingsTab,
      DiscordSettingsTab,
      WhatsappSettingsTab,
      IMessageSettingsTab,
    ];
    const pageMarkup = pages.map((Component) =>
      renderToStaticMarkup(React.createElement(Component, { rpcCall }))).join('\n');
    assert.match(pageMarkup, /Scan QR code/);
    assert.match(pageMarkup, /Manual setup/);
    assert.match(pageMarkup, /Loading WeChat connection status/);
    assert.match(pageMarkup, /Loading Feishu bots/);
    assert.match(pageMarkup, /Loading DingTalk connection status/);
    assert.match(pageMarkup, /Loading WeCom bot status/);
    assert.match(pageMarkup, /Loading WeCom app status/);
    assert.match(pageMarkup, /Loading QQ bot status/);
    assert.match(pageMarkup, /Loading Slack bot status/);
    assert.match(pageMarkup, /Loading Telegram bot status/);
    assert.match(pageMarkup, /Loading Discord bot status/);
    assert.match(pageMarkup, /Loading WhatsApp bot status/);
    assert.match(pageMarkup, /Loading iMessage bot status/);
    assert.doesNotMatch(pageMarkup, /[\p{Script=Han}]/u);

    const sharedCardProps = {
      removing: true,
      onReconnect: noop,
      onRequestRemove: noop,
      onConfirmRemove: noop,
      onCancelRemove: noop,
    };
    const cards = [
      React.createElement(WeixinAccountCard, { ...sharedCardProps, account }),
      React.createElement(FeishuBotCard, { ...sharedCardProps, connection: account }),
      React.createElement(DingtalkAccountCard, { ...sharedCardProps, account }),
      React.createElement(WecomAccountCard, { ...sharedCardProps, account }),
      React.createElement(QqAccountCard, { ...sharedCardProps, account }),
      React.createElement(SlackAccountCard, { ...sharedCardProps, account }),
      React.createElement(TelegramAccountCard, { ...sharedCardProps, account }),
      React.createElement(DiscordAccountCard, { ...sharedCardProps, account }),
      React.createElement(WhatsappAccountCard, { ...sharedCardProps, account }),
      React.createElement(IMessageAccountCard, { ...sharedCardProps, account }),
    ];
    const cardMarkup = cards.map(renderToStaticMarkup).join('\n');
    assert.match(cardMarkup, /Connected/);
    assert.doesNotMatch(cardMarkup, /Message channel/);
    assert.match(cardMarkup, /Last checked/);
    assert.match(cardMarkup, /Check connection/);
    assert.match(cardMarkup, /Remove connection/);
    assert.doesNotMatch(cardMarkup, /[\p{Script=Han}]/u);

    const qqRetryMarkup = renderToStaticMarkup(React.createElement(QqAccountCard, {
      ...sharedCardProps,
      removing: false,
      account: {
        ...account,
        state: 'error',
        connected: false,
        error: {
          code: 'connection-failed',
          message: 'QQ 连接未就绪，插件会自动重试。',
        },
      },
    }));
    assert.match(qqRetryMarkup, /The QQ connection is not ready; the plugin will retry automatically\./);
    assert.doesNotMatch(qqRetryMarkup, /[\p{Script=Han}]/u);
  } finally {
    setImTranslator(null);
  }
});

test('every channel tab receives its RPC call from the settings render site', async () => {
  // Regression guard: the render site lists one prop per channel by hand. When
  // a new channel was added to the tab list but not to that list, its settings
  // page mounted without an RPC call and rendered "missing RPC connection".
  const source = await readFile(new URL('index.js', CLIENT_SOURCE_DIRECTORY_URL), 'utf8');
  const tabIds = [...source.matchAll(/\{\s*id:\s*'([a-zA-Z]+)',\s*label:/g)].map(m => m[1]);
  assert.ok(tabIds.length >= 12, `expected the channel tab list, found ${tabIds.length}`);

  // Parse the dependency block that feeds IMSettingsTab. Upstream (#231)
  // refactored the render site into a reusable panel, so the props now come
  // from `panelDependencies` rather than an inline `inject` block; this guard
  // is about the props reaching the tab, not how they are assembled.
  const renderSite = source.indexOf('h(IMSettingsTab, {');
  assert.ok(renderSite > 0, 'the IMSettingsTab render site must exist');
  const blockStart = source.lastIndexOf('const panelDependencies = {', renderSite);
  const injectStart = blockStart >= 0
    ? blockStart
    : source.lastIndexOf('inject: () => ({', renderSite);
  assert.ok(injectStart > 0, 'the settings tab dependency block must exist');
  const injectBlock = source.slice(injectStart, source.indexOf('};', injectStart));
  const providedProps = new Set(
    [...injectBlock.matchAll(/([a-zA-Z]+RpcCall)\s*,/g)].map(m => m[1]),
  );
  const missing = tabIds
    .map((id) => `${id}RpcCall`)
    .filter((name) => !providedProps.has(name));
  assert.deepEqual(missing, [], 'every channel tab must receive its RPC call prop');
});

test('the Email settings form forwards every mailbox field to the bind RPC', async () => {
  // Regression guard: credentialPayload reduced the form values to an empty
  // object, so the Host received no address and rejected a valid mailbox with
  // "邮箱地址格式不正确". The payload must reach the RPC intact.
  const { EMAIL_SETTINGS_DEFINITION } = await import(
    '../plugin-src/client/channels/email/index.js'
  );
  const values = {
    address: 'user@qq.com',
    password: 'app-password',
    provider: 'qq',
    allowedSenders: ['boss@example.com'],
  };
  assert.deepEqual(
    EMAIL_SETTINGS_DEFINITION.credentialPayload(values),
    values,
    'the mailbox form payload must pass through unchanged',
  );
});

test('the token settings tab wires the RPC bridge into the account card', async () => {
  // Regression guard: the settings tab owns the RPC bridge and passes it down
  // to each account card. When the email panel used a bridge that was never
  // threaded through, React threw "rpcCall is not defined" and the whole IM
  // settings slot rendered nothing.
  //
  // The failure was in the wiring, not in the card itself, so the wiring is
  // what this asserts: every prop the account card consumes must be supplied
  // by the render site.
  const source = await readFile(
    new URL('../plugin-src/client/channels/shared/token-channel.js', import.meta.url),
    'utf8',
  );

  const cardSignature = /function AccountCard\(\{([^}]*)\}\)/.exec(source);
  assert.ok(cardSignature, 'the account card signature must exist');
  const consumed = cardSignature[1]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  // Locate the render site that mounts the card.
  const renderSite = source.slice(source.indexOf('h(AccountCard, {'));
  const renderProps = renderSite.slice(0, renderSite.indexOf('})'));
  const supplied = new Set(
    [...renderProps.matchAll(/([a-zA-Z]+)\s*[:,]/g)].map((m) => m[1]),
  );

  const optional = new Set(['testNotice', 'removing']);
  const missing = consumed.filter((name) => !supplied.has(name) && !optional.has(name));
  assert.deepEqual(missing, [], 'every prop the account card reads must be passed by the render site');

  // The extra settings panels need the bridge and a way to refresh.
  assert.ok(supplied.has('rpcCall'), 'the RPC bridge must reach the account card');
  assert.ok(supplied.has('reload'), 'a refresh callback must reach the account card');
});

test('the Email account card renders its settings panel without crashing', async () => {
  const { EmailAccountCard } = await import('../plugin-src/client/channels/email/index.js');
  const calls = [];
  const rpcCall = async (endpoint) => {
    calls.push(endpoint);
    if (endpoint === 'bot.session-binding.get') {
      return { ok: true, value: { account: null, senders: {}, knownSenders: ['boss@example.com'] } };
    }
    if (endpoint === 'bot.session.list') {
      return { ok: true, value: { workspace: '/tmp', sessions: [{ sessionId: 'session-1', title: 'T1' }] } };
    }
    return { ok: true, value: {} };
  };
  let renderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(EmailAccountCard, {
      account: {
        botId: 'email-account-card', state: 'connected', connected: true,
        bot: { name: 'user@qq.com', idMasked: 'us****@qq.com' },
        allowedSenders: ['boss@example.com'], health: { summary: '邮箱通道运行正常' },
      },
      rpcCall,
      onReconnect() {}, onRequestRemove() {}, onConfirmRemove() {}, onCancelRemove() {},
    }));
  });
  const labels = renderer.root
    .findAll((node) => node.type === 'button')
    .map((button) => (button.children ?? []).filter((c) => typeof c === 'string').join(''));
  assert.ok(labels.includes('保存绑定'), 'the binding panel must mount');
  assert.ok(calls.includes('bot.session-binding.get'), 'the panel must read the current binding');
  assert.ok(calls.includes('bot.session.list'), 'the panel must list bindable sessions');
  renderer.unmount();
});


test('the Email connector form follows the chosen transport', async () => {
  // One channel serves every mail protocol: the transport choice decides which
  // fields are collected, so an Agent mailbox is never asked for an app
  // password or IMAP/SMTP hosts it does not have.
  const { EMAIL_SETTINGS_DEFINITION } = await import(
    '../plugin-src/client/channels/email/index.js'
  );
  const Panel = EMAIL_SETTINGS_DEFINITION.CredentialPanel;
  // Read the label text by walking the tree: React renders a text child as a
  // node, so reading `children` directly returns objects, not strings.
  const textOf = (node) => {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(textOf).join('');
    if (node?.children) return textOf(node.children);
    return '';
  };
  const fieldLabels = (renderer) => renderer.root
    .findAll((node) => node.type === 'label')
    .map((label) => textOf(label.children).trim())
    .filter(Boolean);

  let renderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(Panel, {
      busy: false, error: null, onSubmit() {}, onCancel() {},
    }));
  });

  const selects = () => renderer.root.findAll((node) => node.type === 'select');
  const transportSelect = () => selects().find((select) => [...select.props.children]
    .some((option) => option.props.value === 'agent-mail'));

  assert.ok(transportSelect(), 'the form must offer a transport choice');
  // A label carries its hint text too, so the field is matched by prefix.
  const hasField = (labels, name) => labels.some((label) => label.startsWith(name));
  const imapFields = fieldLabels(renderer);
  assert.ok(hasField(imapFields, '应用密码 / 授权码'), 'IMAP asks for an app password');
  assert.ok(hasField(imapFields, '邮箱服务商'), 'IMAP asks for a provider');

  await TestRenderer.act(async () => {
    transportSelect().props.onChange({ target: { value: 'agent-mail' } });
  });
  const agentFields = fieldLabels(renderer);
  assert.ok(!hasField(agentFields, '应用密码 / 授权码'),
    'an Agent mailbox authorizes by QR code, so no password is collected');
  assert.ok(!hasField(agentFields, '邮箱服务商'), 'it has no provider to choose');
  assert.ok(hasField(agentFields, '邮箱地址'));
  assert.ok(hasField(agentFields, '允许的发件人'));
  renderer.unmount();
});

test('the Email connector submits the fields for the standard transport', async () => {
  const { EMAIL_SETTINGS_DEFINITION } = await import(
    '../plugin-src/client/channels/email/index.js'
  );
  const submitted = [];
  let renderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(
      EMAIL_SETTINGS_DEFINITION.CredentialPanel,
      { busy: false, error: null, onSubmit: (v) => submitted.push(v), onCancel() {} },
    ));
  });

  const texts = () => renderer.root.findAll((node) => node.type === 'input' || node.type === 'textarea');
  // Address is the only text input in Agent mode.
  // The standard mode is where the address is typed; in Agent mode it arrives
  // with the authorization and the field is read-only.
  const addressInput = texts().find((input) => input.props.type === 'email');
  assert.equal(typeof addressInput.props.onChange, 'function',
    'the standard mode lets the address be typed');
  await TestRenderer.act(async () => {
    addressInput.props.onChange({ target: { value: 'bot@agent.qq.com' } });
  });
  // The standard mode also collects the app password.
  const passwordInput = texts().find((input) => input.props.type === 'password');
  await TestRenderer.act(async () => {
    passwordInput.props.onChange({ target: { value: 'app-password' } });
  });
  const allowlist = texts().find((input) => input.type === 'textarea');
  await TestRenderer.act(async () => {
    allowlist.props.onChange({ target: { value: 'boss@corp.com' } });
  });
  const connect = renderer.root.findAll((node) => node.type === 'button')
    .find((b) => (b.children ?? []).includes('连接邮箱'));
  await TestRenderer.act(async () => { connect.props.onClick(); });

  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].transport, 'imap-smtp');
  assert.equal(submitted[0].address, 'bot@agent.qq.com');
  assert.deepEqual(submitted[0].allowedSenders, ['boss@corp.com']);
  // The standard mode carries the app password it collected.
  assert.equal(submitted[0].password, 'app-password');
  renderer.unmount();
});
test('the connector form requires authorization before binding an Agent mailbox', async () => {
  const { EMAIL_SETTINGS_DEFINITION } = await import(
    '../plugin-src/client/channels/email/index.js'
  );
  const textOf = (node) => {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(textOf).join('');
    if (node?.children) return textOf(node.children);
    return '';
  };
  let renderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(
      EMAIL_SETTINGS_DEFINITION.CredentialPanel,
      {
        busy: false, error: null, onSubmit() {}, onCancel() {},
        rpcCall: async () => ({ ok: true, value: {} }), endpoints: {},
      },
    ));
  });
  const buttons = () => renderer.root.findAll((node) => node.type === 'button')
    .map((b) => textOf(b.children));
  const submit = () => renderer.root.findAll((node) => node.type === 'button')
    .find((b) => textOf(b.children) === '连接邮箱');

  // Agent mode offers the authorization step instead of a password.
  const transportSelect = renderer.root.findAll((node) => node.type === 'select')
    .find((select) => [...select.props.children]
      .some((option) => option.props.value === 'agent-mail'));
  await TestRenderer.act(async () => {
    transportSelect.props.onChange({ target: { value: 'agent-mail' } });
  });
  assert.ok(buttons().includes('生成授权链接'), 'the authorization step must be offered');
  const address = renderer.root.findAll((node) => node.type === 'input')
    .find((input) => input.props.type === 'email');
  // The Agent mailbox address arrives with the authorization, so it may be
  // read-only here; set it only when the field is editable.
  if (typeof address.props.onChange === 'function') {
    await TestRenderer.act(async () => {
      address.props.onChange({ target: { value: 'bot@agent.qq.com' } });
    });
  }
  assert.equal(submit().props.disabled, true,
    'the mailbox cannot be bound before the authorization completes');
  renderer.unmount();
});
test('a completed authorization connects without a second click', async () => {
  // The panel says "connecting", so it must actually connect. Requiring
  // another click stranded users who had already scanned — and a reload threw
  // the tokens away.
  const { EMAIL_SETTINGS_DEFINITION } = await import(
    '../plugin-src/client/channels/email/index.js'
  );
  const submitted = [];
  const rpcCall = async (endpoint) => {
    if (endpoint === 'bot.auth.start') {
      return { ok: true, value: {
        browserUrl: 'https://agent.qq.com/a', inputCode: 'ic_1', expiresInMs: 600_000,
      } };
    }
    if (endpoint === 'bot.auth.poll') {
      // The server resolves the address, which the panel fills in itself.
      return { ok: true, value: {
        authorized: true,
        address: 'bot@agent.qq.com',
      } };
    }
    return { ok: true, value: {} };
  };
  const textOf = (node) => {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(textOf).join('');
    if (node?.children) return textOf(node.children);
    return '';
  };
  let renderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(
      EMAIL_SETTINGS_DEFINITION.CredentialPanel,
      {
        busy: false, error: null, onCancel() {},
        onSubmit: (value) => submitted.push(value),
        rpcCall,
        endpoints: { startAuth: 'bot.auth.start', pollAuth: 'bot.auth.poll' },
      },
    ));
  });
  const button = (label) => renderer.root.findAll((node) => node.type === 'button')
    .find((b) => textOf(b.children) === label);

  // Choose the Agent mailbox, then supply the fields the bind needs.
  const transportSelect = renderer.root.findAll((node) => node.type === 'select')
    .find((select) => [...select.props.children]
      .some((option) => option.props.value === 'agent-mail'));
  await TestRenderer.act(async () => {
    transportSelect.props.onChange({ target: { value: 'agent-mail' } });
  });
  const address = renderer.root.findAll((node) => node.type === 'input')
    .find((input) => input.props.type === 'email');
  // The Agent mailbox address arrives with the authorization, so it may be
  // read-only here; set it only when the field is editable.
  if (typeof address.props.onChange === 'function') {
    await TestRenderer.act(async () => {
      address.props.onChange({ target: { value: 'bot@agent.qq.com' } });
    });
  }
  const allowlist = renderer.root.findAll((node) => node.type === 'textarea')[0];
  await TestRenderer.act(async () => {
    allowlist.props.onChange({ target: { value: 'boss@corp.com' } });
  });

  await TestRenderer.act(async () => { button('生成授权链接').props.onClick(); });
  // Let the poll interval observe the authorization.
  await TestRenderer.act(async () => { await new Promise((r) => { setTimeout(r, 3_400); }); });

  assert.equal(submitted.length, 1, 'the authorization submits the bind on its own');
  assert.equal(submitted[0].transport, 'agent-mail');
  assert.equal(submitted[0].address, 'bot@agent.qq.com');
  // agently-cli keeps the credentials, so no token travels through the bind.
  assert.equal(submitted[0].accessToken, undefined);
  assert.equal(submitted[0].address, 'bot@agent.qq.com');
  assert.deepEqual(submitted[0].allowedSenders, ['boss@corp.com']);
  renderer.unmount();
});

test('the bindable session list refreshes while the panel stays open', async () => {
  // Sessions are created elsewhere, so a list fetched once when the panel
  // opened goes stale: a conversation started a minute ago never appeared.
  const { EmailAccountCard } = await import('../plugin-src/client/channels/email/index.js');
  const listings = [];
  let sessionList = [{ sessionId: 'session-1', title: 'First' }];
  const rpcCall = async (endpoint) => {
    if (endpoint === 'bot.session-binding.get') {
      return { ok: true, value: { account: 'session-1', senders: {}, knownSenders: ['a@x.com'] } };
    }
    if (endpoint === 'bot.session.list') {
      listings.push(sessionList.length);
      return { ok: true, value: { workspace: '/tmp', sessions: sessionList } };
    }
    return { ok: true, value: {} };
  };
  let renderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(EmailAccountCard, {
      account: {
        botId: 'e1', state: 'connected', connected: true,
        bot: { name: 'me@agent.qq.com' }, allowedSenders: ['a@x.com'],
        health: { summary: 'ok' },
      },
      rpcCall, onReconnect() {}, onRequestRemove() {}, onConfirmRemove() {}, onCancelRemove() {},
    }));
  });
  const before = listings.length;

  // A new conversation appears elsewhere while the panel is open.
  await TestRenderer.act(async () => {
    sessionList = [...sessionList, { sessionId: 'session-2', title: 'Second' }];
  });
  const optionsOf = () => renderer.root
    .findAll((node) => node.type === 'option')
    .map((option) => String(option.props.children ?? ''));
  assert.ok(optionsOf().some((label) => label.includes('First')), 'the first session is listed');

  // The refresh button re-reads immediately.
  const refresh = renderer.root.findAll((node) => node.type === 'button')
    .find((b) => (b.children ?? []).includes('刷新会话列表'));
  assert.ok(refresh, 'a refresh control is offered');
  await TestRenderer.act(async () => { refresh.props.onClick(); });
  await TestRenderer.act(async () => { await new Promise((r) => { setTimeout(r, 50); }); });

  assert.ok(listings.length > before, 'the list is re-read on demand');
  assert.ok(optionsOf().some((label) => label.includes('Second')),
    'a session created while the panel was open appears');
  renderer.unmount();
});

test('saving the allowlist refreshes the per-sender rows', async () => {
  // The allowlist decides which senders the binding panel offers. Saving it
  // reloaded channel state but not that panel, so a newly allowed sender never
  // appeared as a row — the value was stored and simply not shown.
  const { EmailAccountCard } = await import('../plugin-src/client/channels/email/index.js');
  const textOf = (node) => {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(textOf).join('');
    if (node?.children) return textOf(node.children);
    return '';
  };
  let knownSenders = ['a@x.com'];
  const calls = [];
  const rpcCall = async (endpoint) => {
    calls.push(endpoint);
    if (endpoint === 'bot.session-binding.get') {
      return { ok: true, value: { account: null, senders: {}, knownSenders: [...knownSenders] } };
    }
    if (endpoint === 'bot.session.list') {
      return { ok: true, value: { workspace: '/tmp', sessions: [] } };
    }
    return { ok: true, value: {} };
  };
  let renderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(EmailAccountCard, {
      account: {
        botId: 'e1', state: 'connected', connected: true,
        bot: { name: 'me@agent.qq.com' }, allowedSenders: ['a@x.com'],
        health: { summary: 'ok' },
      },
      rpcCall, onReconnect() {}, onRequestRemove() {}, onConfirmRemove() {}, onCancelRemove() {},
    }));
  });
  const senderRows = () => renderer.root
    .findAll((node) => String(node.props?.className ?? '').includes('dim-emailBindingSender'))
    .map((node) => textOf(node.children));
  assert.deepEqual(senderRows(), ['a@x.com']);

  // A second address is allowed and the form is saved.
  knownSenders = ['a@x.com', 'newboss@corp.com'];
  const allowlist = renderer.root.findAll((node) => node.type === 'textarea')[0];
  await TestRenderer.act(async () => {
    allowlist.props.onChange({ target: { value: 'a@x.com\nnewboss@corp.com' } });
  });
  const save = renderer.root.findAll((node) => node.type === 'button')
    .find((b) => textOf(b.children) === '保存');
  await TestRenderer.act(async () => { await save.props.onClick(); });
  await TestRenderer.act(async () => { await new Promise((r) => { setTimeout(r, 100); }); });

  assert.ok(calls.filter((c) => c === 'bot.session-binding.get').length > 1,
    'the binding panel is re-read when the allowlist changes');
  assert.deepEqual(senderRows(), ['a@x.com', 'newboss@corp.com'],
    'a newly allowed sender gets a row');
  renderer.unmount();
});

test('a bound agent mailbox offers re-authorization', async () => {
  // agently-cli holds the login and it can lapse. Reconnecting cannot fix
  // that, so the card must offer the scan again — otherwise the only way back
  // was to remove and re-add the mailbox.
  const { EMAIL_SETTINGS_DEFINITION } = await import(
    '../plugin-src/client/channels/email/index.js'
  );
  const textOf = (node) => {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(textOf).join('');
    if (node?.children) return textOf(node.children);
    return '';
  };
  const called = [];
  let renderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(
      EMAIL_SETTINGS_DEFINITION.AccountSettings,
      {
        account: {
          botId: 'e1', platformId: 'diyhome@agent.qq.com', transport: 'agent-mail',
          allowedSenders: ['a@x.com'], connected: false,
        },
        busy: false, error: null, onSave: async () => {}, onCancel() {},
        rpcCall: async (endpoint, payload) => {
          called.push({ endpoint, payload });
          if (endpoint === 'bot.auth.start') {
            return { ok: true, value: {
              browserUrl: 'https://agent.qq.com/page/oauth?oauth_type=device&user_code=uc_T',
              inputCode: 'uc_T', expiresInMs: 600_000,
            } };
          }
          return { ok: true, value: {} };
        },
        endpoints: {
          startAuth: 'bot.auth.start', pollAuth: 'bot.auth.poll',
          listSessions: 'bot.session.list', getBinding: 'bot.session-binding.get',
          setBinding: 'bot.session-binding.set',
        },
        onChanged: async () => {},
      },
    ));
  });
  const button = renderer.root.findAll((node) => node.type === 'button')
    .find((b) => textOf(b.children) === '重新扫码授权');
  assert.ok(button, 'a bound Agent mailbox offers re-authorization');

  await TestRenderer.act(async () => { button.props.onClick(); });
  // The link is the whole point of the control: the panel said it had one and
  // showed nothing, so the user had nothing to scan.
  const links = renderer.root.findAll((node) => node.type === 'a').map((a) => a.props.href);
  assert.ok(links.some((href) => String(href ?? '').includes('agent.qq.com/page/oauth')),
    'the authorization link is shown after it is generated');
  const start = called.find((c) => c.endpoint === 'bot.auth.start');
  assert.ok(start, 'the scan is started');
  assert.equal(start.payload.workspace, 'diyhome@agent.qq.com',
    'the scan lands in the workspace this mailbox reads from');
  renderer.unmount();
});

test('an IMAP mailbox is not offered re-authorization', async () => {
  const { EMAIL_SETTINGS_DEFINITION } = await import(
    '../plugin-src/client/channels/email/index.js'
  );
  const textOf = (node) => {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(textOf).join('');
    if (node?.children) return textOf(node.children);
    return '';
  };
  let renderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(
      EMAIL_SETTINGS_DEFINITION.AccountSettings,
      {
        account: {
          botId: 'e2', platformId: 'me@qq.com', transport: 'imap-smtp',
          allowedSenders: ['a@x.com'], connected: true,
        },
        busy: false, error: null, onSave: async () => {}, onCancel() {},
        rpcCall: async () => ({ ok: true, value: {} }),
        endpoints: {
          startAuth: 'bot.auth.start', pollAuth: 'bot.auth.poll',
          listSessions: 'bot.session.list', getBinding: 'bot.session-binding.get',
          setBinding: 'bot.session-binding.set',
        },
        onChanged: async () => {},
      },
    ));
  });
  const labels = renderer.root.findAll((node) => node.type === 'button').map((b) => textOf(b.children));
  assert.ok(!labels.includes('重新扫码授权'),
    'a password mailbox has nothing to re-authorize');
  renderer.unmount();
});

test('the email entry point stays hidden while the Host reports the channel closed', async () => {
  const textOf = (node) => {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(textOf).join('');
    if (node?.children) return textOf(node.children);
    return '';
  };
  const rpcCalls = Object.fromEntries(
    ['feishu', 'weixin', 'dingtalk', 'wecom', 'wecomApp', 'qq', 'slack', 'telegram',
      'discord', 'whatsapp', 'imessage', 'office']
      .map((channel) => [`${channel}RpcCall`, async () => ({ ok: true, value: {} })]),
  );
  const closed = [];
  let renderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(IMSettingsTab, {
      ...rpcCalls,
      emailRpcCall: async (endpoint) => {
        closed.push(endpoint);
        return { ok: false, error: { code: 'email-channel-disabled', message: 'Email is not available yet.' } };
      },
    }));
  });
  const labels = () => renderer.root
    .findAll((node) => node.type === 'button')
    .map((node) => textOf(node.children));
  // The rail button renders the label and its note together.
  const hasMailbox = () => labels().some((label) => label.startsWith('邮箱'));
  assert.equal(hasMailbox(), false,
    'a closed channel exposes no mailbox entry point');
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(IMSettingsTab, {
      ...rpcCalls,
      emailRpcCall: async () => ({ ok: true, value: { enabled: false } }),
    }));
  });
  assert.equal(hasMailbox(), false,
    'an explicit closed answer also hides the entry point');
  const { registerManagementRpc } = await import('../plugin-src/management-rpc.mjs');
  const { managementFetch } = await import('./fixtures/management-rpc.mjs');
  let emailRpcCall;
  registerManagementRpc({
    connection: { fetch: managementFetch((_channel, handler) => { emailRpcCall = handler; }) },
  }, '/email', async (endpoint) => {
    assert.equal(endpoint, 'channel.availability');
    return { ok: true, value: { enabled: true } };
  });
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(IMSettingsTab, {
      ...rpcCalls,
      emailRpcCall,
    }));
  });
  assert.equal(hasMailbox(), true,
    'reopening the Host switch brings the entry point back with no client change');
  renderer.unmount();
});
