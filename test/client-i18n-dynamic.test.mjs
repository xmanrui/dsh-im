import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  channelName,
  en,
  IM_DYNAMIC_PHRASES,
  IM_DYNAMIC_RULES,
  imLocale,
  localizeTemplate,
  localizeText,
  ru,
  setImTranslator,
  translateDynamic,
  zh,
} from '../plugin-src/client/i18n.js';

// The lookup the DSH locale registry performs for a language pack: the active
// language, then its declared fallback, then the key itself.
function chainTranslator(dictionaries) {
  return (key) => dictionaries.ru?.[key] ?? dictionaries.en?.[key] ?? key;
}

const RUSSIAN = chainTranslator({ ru, en });
const ENGLISH = chainTranslator({ en });
const CHINESE = (key) => zh[key] ?? key;

// Call sites localise a captured reason before substituting it, so a case that
// carries one goes through the same step. Under Chinese this is the identity.
function localised(values) {
  if (!Object.hasOwn(values, 'error')) return values;
  return { ...values, error: localizeText(values.error) };
}

function asLocale(translator) {
  setImTranslator(translator);
  assert.equal(imLocale(), translator === RUSSIAN ? 'ru' : translator === ENGLISH ? 'en' : 'zh');
}

const HAN = /[\u4e00-\u9fff]/u;
const PLACEHOLDER = /\{(\w+)\}/gu;

// The sentences the settings UI composes itself. They are template keys in both
// dictionaries, so the Russian sentence is written as a whole and the values are
// filled in afterwards — word order of the translation, not of the Chinese source.
const COMPOSED = [
  {
    key: '已接入的 {channel} 机器人',
    values: { channel: 'Telegram' },
    en: 'Connected Telegram bots',
    ru: 'Подключённые боты Telegram',
  },
  {
    key: '正在读取 {channel} 机器人状态…',
    values: { channel: 'Telegram' },
    en: 'Loading Telegram bot status…',
    ru: 'Читаю состояние ботов Telegram…',
  },
  {
    key: '无法读取 {channel} 机器人状态',
    values: { channel: 'Feishu' },
    en: 'Could not load Feishu bot status',
    ru: 'Не удалось прочитать состояние ботов Feishu',
  },
  {
    key: '尚未接入 {channel} 机器人',
    values: { channel: 'Telegram' },
    en: 'No Telegram bot connected yet',
    ru: 'Бот Telegram пока не подключён',
  },
  {
    key: '手动接入{channel}机器人',
    values: { channel: 'Telegram' },
    en: 'Connect Telegram bot manually',
    ru: 'Подключить бота Telegram вручную',
  },
  {
    key: '{channel} 设置',
    values: { channel: 'Telegram' },
    en: 'Telegram settings',
    ru: 'Настройки Telegram',
  },
  {
    key: '{name}机器人设置',
    values: { name: 'QQ' },
    en: 'QQ bot settings',
    ru: 'Настройки бота QQ',
  },
  {
    key: '{channel} 设置页缺少 RPC 连接',
    values: { channel: 'Telegram' },
    en: 'The Telegram settings are missing an RPC connection',
    ru: 'В настройках Telegram нет подключения RPC',
  },
  {
    key: '{connected} / {configured} 在线',
    values: { connected: 1, configured: 2 },
    en: '1/2 online',
    ru: '1/2 онлайн',
  },
  {
    key: '已接入 {configured} 个机器人，其中 {connected} 个在线',
    values: { connected: 1, configured: 2 },
    en: '1 of 2 bots online',
    ru: '1 из 2 ботов онлайн',
  },
  {
    key: '从 DeepSeek Harness 移除“{name}”？',
    values: { name: 'My Bot' },
    en: 'Remove “My Bot” from DeepSeek Harness?',
    ru: 'Удалить «My Bot» из DeepSeek Harness?',
  },
  {
    key: '从 DeepSeek Harness 移除{name}',
    values: { name: 'My Bot' },
    en: 'Remove My Bot from DeepSeek Harness',
    ru: 'Удалить My Bot из DeepSeek Harness',
  },
  {
    key: '移除{name}',
    values: { name: 'My Bot' },
    en: 'Remove My Bot',
    ru: 'Убрать My Bot',
  },
  {
    key: '二维码剩余 {remaining}',
    values: { remaining: '00:30' },
    en: 'QR code expires in 00:30',
    ru: 'QR-код истекает через 00:30',
  },
  {
    key: '请输入 -1、0 或 1~{max} 之间的整数。',
    values: { max: 24 },
    en: 'Enter -1, 0, or an integer from 1 to 24.',
    ru: 'Введите -1, 0 или целое число от 1 до 24.',
  },
  {
    key: '操作失败：{error}',
    // A captured reason is a phrase of its own, so the caller localises it before
    // substituting it — the reference number and bot names stay as they are.
    values: { error: '网络中断' },
    en: 'Operation failed: network down',
    ru: 'Операция не удалась: сеть недоступна',
  },
  {
    key: '状态刷新失败：{error}',
    values: { error: '请求超时' },
    en: 'Status refresh failed: request timed out',
    ru: 'Не удалось обновить состояние: истекло время ожидания',
  },
  {
    key: '状态自动刷新失败：{error}',
    values: { error: '服务不可用' },
    en: 'Automatic status refresh failed: service unavailable',
    ru: 'Не удалось обновить состояние автоматически: сервис недоступен',
  },
  {
    key: '连接检查失败：{error}',
    values: { error: '连接被拒绝' },
    en: 'Connection check failed: connection refused',
    ru: 'Проверка подключения не удалась: соединение отклонено',
  },
  {
    key: '连接检查失败：{error}（参考号：{reference}）',
    values: { error: '网络中断', reference: 'abc' },
    en: 'Connection check failed: network down (reference: abc)',
    ru: 'Проверка подключения не удалась: сеть недоступна (код обращения: abc)',
  },
  {
    key: '{bot}的飞书授权流程',
    values: { bot: 'My App' },
    en: 'Feishu authorization flow for My App',
    ru: 'Авторизация Feishu для My App',
  },
  {
    key: '用于为{bot}补全权限与回调的一次性授权二维码',
    values: { bot: 'My App' },
    en: 'One-time QR code for completing permissions and the callback for My App',
    ru: 'Одноразовый QR-код для дополнения разрешений и обратного вызова для My App',
  },
  {
    key: '用于为{bot}开通群消息权限的一次性授权二维码',
    values: { bot: 'My App' },
    en: 'One-time QR code for granting group-message permission to My App',
    ru: 'Одноразовый QR-код для выдачи разрешения на групповые сообщения для My App',
  },
  {
    key: '正在为「{bot}」补全权限与回调',
    values: { bot: 'My App' },
    en: 'Completing permissions and the callback for “My App”',
    ru: 'Дополняем разрешения и обратный вызов для «My App»',
  },
  {
    key: '正在为「{bot}」开通群消息权限',
    values: { bot: 'My App' },
    en: 'Granting group-message permission to “My App”',
    ru: 'Выдаём «My App» разрешение на групповые сообщения',
  },
  {
    key: '为{bot}补全权限与回调',
    values: { bot: 'My App' },
    en: 'Complete permissions and the callback for My App',
    ru: 'Дополнить разрешения и обратный вызов для My App',
  },
  {
    key: '{bot}的权限与回调已补全。',
    values: { bot: 'My App' },
    en: 'Permissions and the callback completed for My App.',
    ru: 'Разрешения и обратный вызов для My App дополнены.',
  },
  {
    key: '{bot}的权限补全二维码已生成，请使用飞书扫码。',
    values: { bot: 'My App' },
    en: 'Permission-completion QR code generated for My App. Scan it with Feishu.',
    ru: 'QR-код дополнения разрешений для My App создан. Отсканируйте его в Feishu.',
  },
  {
    key: '{bot}的群消息权限二维码已生成，请使用飞书确认。',
    values: { bot: 'My App' },
    en: 'Group-message permission QR code generated for My App. Confirm it with Feishu.',
    ru: 'QR-код разрешения на групповые сообщения для My App создан. Подтвердите его в Feishu.',
  },
  {
    key: '{bot}已开通群消息权限，并启用“响应所有群消息”。',
    values: { bot: 'My App' },
    en: 'My App now has group-message permission and “Respond to all group messages” is enabled.',
    ru: 'My App: разрешение на групповые сообщения выдано, включено «Отвечать на все групповые сообщения».',
  },
  {
    key: '检查连接{name}',
    values: { name: 'My Bot' },
    en: 'Check connection My Bot',
    ru: 'Проверить подключение My Bot',
  },
  {
    key: '这会停止消息连接，并删除本机保存的 {credentials}、机器人配置及会话映射。{platform}中的机器人不会被自动删除。',
    values: { credentials: 'Bot Token', platform: 'Telegram' },
    en: 'This stops the message connection and removes the locally stored Bot Token, bot configuration, and session mappings. The bot in Telegram is not deleted.',
    ru: 'Подключение сообщений будет остановлено, а локально сохранённые Bot Token, конфигурация бота и привязки сессий удалены. Боты в Telegram не удаляются автоматически.',
  },
];

// The sentences the settings UI does not compose itself: a host status or an RPC
// error arrives as one finished string, so the pattern table recognises its shape.
const FROM_HOST = [
  {
    zh: '增强提示词不得超过 4000 个字符。',
    en: 'Guidance must not exceed 4000 characters.',
    ru: 'Подсказка для контекста не должна превышать 4000 символов.',
  },
  {
    zh: '一次最多只能处理 9 张图片。',
    en: 'A message can contain at most 9 images.',
    ru: 'В одном сообщении может быть не больше 9 изображений.',
  },
  {
    zh: '图片下载失败（HTTP 404），请重新发送后再试。',
    en: 'The image download failed (HTTP 404). Send it again.',
    ru: 'Не удалось скачать изображение (HTTP 404). Отправьте его заново.',
  },
  {
    zh: '微信配置格式错误：config.json。请查看诊断详情，修复后重启 DSH。',
    en: 'The WeChat configuration is invalid: config.json. See the diagnostic details, fix the file, and restart DSH.',
    ru: 'Неверный формат конфигурации WeChat: config.json. Смотрите подробности диагностики, исправьте файл и перезапустите DSH.',
  },
  {
    zh: '请检查微信渠道数据目录中的 config.json，修复后重启 DSH；“重新读取”不会重新加载配置。',
    en: 'Check config.json in the WeChat channel data directory, fix it, and restart DSH; refreshing the status does not reload configuration.',
    ru: 'Проверьте config.json в каталоге данных канала WeChat, исправьте его и перезапустите DSH; «перечитать» не перезагружает конфигурацию.',
  },
];

// Every key either dictionary carries as a template, e.g. `已接入的 {channel} 机器人`.
const TEMPLATE_KEYS = Object.keys(en).filter((key) => /\{(\w+)\}/u.test(key));

const CLIENT_ROOT = fileURLToPath(new URL('../plugin-src/client/', import.meta.url));

// Sources of the client half, read by the two guards below.
async function clientSources(directory = CLIENT_ROOT) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await clientSources(path));
    else if (entry.name.endsWith('.js')) found.push([path, await readFile(path, 'utf8')]);
  }
  return found;
}

test('every dynamic pattern carries an English and a Russian rendering', () => {
  // The guard the previous i18n work was missing: a pattern may not ship with an
  // English column alone, which is what silently left Russian readers on Chinese.
  const incomplete = IM_DYNAMIC_RULES.filter(
    (rule) => !(rule.pattern instanceof RegExp)
      || typeof rule.en !== 'function'
      || typeof rule.ru !== 'function',
  ).map((rule) => String(rule.pattern));
  assert.deepEqual(incomplete, []);
});

test('every dynamic phrase carries a rendering per locale', () => {
  const broken = IM_DYNAMIC_PHRASES.filter((row) => row.length !== 3
    || row.some((column) => typeof column !== 'string' || column === ''));
  assert.deepEqual(broken, []);
});

test('every dynamic pattern is exercised by a sentence from outside the UI', () => {
  const covered = new Set();
  for (const { zh: text } of FROM_HOST) {
    const at = IM_DYNAMIC_RULES.findIndex((rule) => rule.pattern.test(text));
    if (at >= 0) covered.add(at);
  }
  const unexercised = IM_DYNAMIC_RULES
    .filter((_, at) => !covered.has(at))
    .map((rule) => String(rule.pattern));
  assert.deepEqual(unexercised, []);
});

test('the dynamic table holds only text the client cannot compose itself', () => {
  // Client-side sentences are template keys now, so this table is for the statuses
  // and errors that arrive already finished. A longer table is a regression.
  assert.ok(IM_DYNAMIC_RULES.length <= 6, `rules: ${IM_DYNAMIC_RULES.length}`);
});

test('every template key is translated and keeps its placeholders', () => {
  const broken = TEMPLATE_KEYS.filter((key) => {
    const placeholders = [...key.matchAll(PLACEHOLDER)].map((match) => match[1]).sort();
    const english = [...String(en[key]).matchAll(PLACEHOLDER)].map((match) => match[1]).sort();
    const russian = [...String(ru[key]).matchAll(PLACEHOLDER)].map((match) => match[1]).sort();
    return typeof ru[key] !== 'string'
      || english.join() !== placeholders.join()
      || russian.join() !== placeholders.join();
  });
  assert.deepEqual(broken, []);
});

test('a Russian reader gets Russian for every sentence the UI composes', (t) => {
  asLocale(RUSSIAN);
  t.after(() => setImTranslator(null));
  for (const { key, values, ru: expected } of COMPOSED) {
    assert.equal(localizeTemplate(key, localised(values)), expected, key);
  }
});

test('an English reader keeps the English rendering of every composed sentence', (t) => {
  asLocale(ENGLISH);
  t.after(() => setImTranslator(null));
  for (const { key, values, en: expected } of COMPOSED) {
    assert.equal(localizeTemplate(key, localised(values)), expected, key);
  }
});

test('a Chinese reader gets the Chinese template with its values filled in', (t) => {
  asLocale(CHINESE);
  t.after(() => setImTranslator(null));
  for (const { key, values } of COMPOSED) {
    const zh = localised(values);
    const expected = key.replace(PLACEHOLDER, (placeholder, name) => String(zh[name]));
    assert.equal(localizeTemplate(key, zh), expected, key);
  }
});

test('a Russian reader gets Russian for text composed outside the UI', (t) => {
  asLocale(RUSSIAN);
  t.after(() => setImTranslator(null));
  for (const { zh: text, ru: expected } of FROM_HOST) {
    assert.equal(localizeText(text), expected, text);
  }
});

test('an English reader keeps the English rendering of text composed outside the UI', (t) => {
  asLocale(ENGLISH);
  t.after(() => setImTranslator(null));
  for (const { zh: text, en: expected } of FROM_HOST) {
    assert.equal(localizeText(text), expected, text);
  }
});

test('a Chinese reader gets outside text back untouched', (t) => {
  asLocale(CHINESE);
  t.after(() => setImTranslator(null));
  for (const { zh: text } of FROM_HOST) {
    assert.equal(localizeText(text), text);
  }
});

test('a locale the dynamic table does not know is served English', (t) => {
  t.after(() => setImTranslator(null));
  asLocale(RUSSIAN);
  assert.equal(translateDynamic('一次最多只能处理 9 张图片。', 'de'), 'A message can contain at most 9 images.');
  assert.equal(translateDynamic('一次最多只能处理 9 张图片。', 'ru'), 'В одном сообщении может быть не больше 9 изображений.');
  // Chinese is the identity language, so it is handed back rather than rendered.
  assert.equal(translateDynamic('一次最多只能处理 9 张图片。', 'zh'), '一次最多只能处理 9 张图片。');
});

test('Russian sentences name the channel in its Russian form', (t) => {
  asLocale(RUSSIAN);
  t.after(() => setImTranslator(null));
  const CHANNELS = [
    ['Telegram', 'Telegram'],
    ['微信', 'WeChat'],
    ['飞书', 'Feishu'],
    ['钉钉', 'DingTalk'],
    ['企业微信', 'WeCom'],
  ];
  for (const [source, name] of CHANNELS) {
    const channel = channelName(source);
    assert.equal(channel, name);
    assert.equal(
      localizeTemplate('已接入的 {channel} 机器人', { channel }),
      `Подключённые боты ${name}`,
    );
    assert.equal(
      localizeTemplate('尚未接入 {channel} 机器人', { channel }),
      `Бот ${name} пока не подключён`,
    );
    assert.equal(localizeTemplate('{channel} 设置', { channel }), `Настройки ${name}`);
  }
});

test('a reason embedded in a host message is localised, not pasted through', (t) => {
  asLocale(RUSSIAN);
  t.after(() => setImTranslator(null));
  // What the host actually reports as a failure reason, and what the settings UI
  // captured into `{error}` before this table knew it had to translate it.
  const REASONS = [
    ['网络中断', 'сеть недоступна'],
    ['请求超时', 'истекло время ожидания'],
    ['超时', 'истекло время ожидания'],
    ['服务不可用', 'сервис недоступен'],
    ['连接被拒绝', 'соединение отклонено'],
    ['未授权', 'нет авторизации'],
    ['响应格式错误', 'неверный формат ответа'],
  ];
  for (const [reason, expected] of REASONS) {
    assert.equal(localizeText(reason), expected);
    assert.doesNotMatch(expected, HAN);
  }
  // The sentence the reviewer saw with Chinese inside it, now translated end to end.
  const rendered = localizeTemplate(
    '连接检查失败：{error}（参考号：{reference}）',
    { error: localizeText('网络中断'), reference: 'abc' },
  );
  assert.equal(rendered, 'Проверка подключения не удалась: сеть недоступна (код обращения: abc)');
  assert.doesNotMatch(rendered, HAN);

  asLocale(ENGLISH);
  assert.equal(
    localizeTemplate('连接检查失败：{error}（参考号：{reference}）', {
      error: localizeText('网络中断'),
      reference: 'abc',
    }),
    'Connection check failed: network down (reference: abc)',
  );
});

test('a Russian composed sentence carries no Chinese left over', (t) => {
  asLocale(RUSSIAN);
  t.after(() => setImTranslator(null));
  for (const key of TEMPLATE_KEYS) {
    const values = Object.fromEntries([...key.matchAll(PLACEHOLDER)].map((match) => [match[1], 'X']));
    const rendered = localizeTemplate(key, values);
    assert.doesNotMatch(rendered, HAN, `${key} → ${rendered}`);
  }
});

test('the client composes no Chinese sentence of its own outside a template key', async () => {
  // A template literal carrying Chinese and an interpolation can never be looked up
  // in a dictionary — that is exactly how a Russian reader ended up with Chinese.
  const offenders = [];
  for (const [path, source] of await clientSources()) {
    for (const match of source.matchAll(/`(?:[^`\\]|\\.)*`/gsu)) {
      if (HAN.test(match[0]) && match[0].includes('${')) {
        offenders.push(`${path.slice(CLIENT_ROOT.length)}: ${match[0].slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('every template key the client asks for exists in both dictionaries', async () => {
  const missing = [];
  for (const [path, source] of await clientSources()) {
    for (const match of source.matchAll(/localizeTemplate\(\s*'([^']+)'/gu)) {
      const key = match[1];
      const where = path.slice(CLIENT_ROOT.length);
      if (!/\{(\w+)\}/u.test(key)) missing.push(`${where}: ${key} has no placeholder`);
      if (typeof en[key] !== 'string' || typeof ru[key] !== 'string') {
        missing.push(`${where}: ${key} is not in both dictionaries`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('an unrecognised message keeps the phrase table rather than the raw Chinese', (t) => {
  asLocale(RUSSIAN);
  t.after(() => setImTranslator(null));
  // No rule matches this one, so the fragment table is the last resort — and it has
  // to know Russian too, or the reader sees Chinese again.
  assert.equal(translateDynamic('Telegram 连接状态', 'ru'), 'Telegram состояние подключения');
  assert.equal(translateDynamic('Telegram 连接状态', 'en'), 'Telegram connection status');
  assert.equal(localizeText('这个文案谁都没有翻译'), '这个文案谁都没有翻译');
});
