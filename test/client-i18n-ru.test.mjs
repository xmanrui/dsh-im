import assert from 'node:assert/strict';
import test from 'node:test';

import diagnosticsRu from '../src/channels/shared/i18n-ru/diagnostics.mjs';
import imageInputRu from '../src/channels/shared/i18n-ru/image-input.mjs';
import weixinRu from '../src/channels/shared/i18n-ru/weixin.mjs';
import {
  en,
  imLocale,
  IM_LOCALE_NAMESPACE,
  IM_RUSSIAN_LANGUAGE,
  installImRussianLocale,
  localizeText,
  ru,
  setImTranslator,
  zh,
} from '../plugin-src/client/i18n.js';
import { RU } from '../plugin-src/client/i18n-ru.js';

// Keys the client dictionary borrows verbatim from the Host Russian modules. They
// are whole dictionaries reused as-is, so they may carry a message the settings UI
// never renders; every other key must be one the English dictionary knows too.
const SHARED_KEYS = new Set([
  ...Object.keys(weixinRu),
  ...Object.keys(diagnosticsRu),
  ...Object.keys(imageInputRu),
]);

const EMPTY_TRANSLATOR = (key) => key;

// The lookup the DSH locale registry performs for a language pack: the active
// language, then its declared fallback, then the key itself. Mirrored here so the
// fallback contract can be exercised without a browser registry.
function chainTranslator(dictionaries) {
  return (key) => dictionaries.ru?.[key] ?? dictionaries.en?.[key] ?? key;
}

function placeholders(text) {
  const found = [];
  for (const match of text.matchAll(/\$\{([^{}]*)\}|\{(\w+)\}/gu)) {
    // The name inside a placeholder is the contract; a translated human-readable
    // default inside it ("бот" instead of "bot") is part of the translation.
    found.push(match[1] === undefined
      ? `{${match[2]}}`
      : match[1].replace(/"[^"]*"|'[^']*'/gu, '""'));
  }
  return found.sort();
}

test('the Russian dictionary covers every key the settings UI asks for', () => {
  const missing = Object.keys(en).filter((key) => typeof RU[key] !== 'string' || RU[key] === '');
  assert.deepEqual(missing, []);
});

test('the Russian dictionary adds no key the settings UI cannot ask for', () => {
  const unknown = Object.keys(RU).filter((key) => !Object.hasOwn(en, key) && !SHARED_KEYS.has(key));
  assert.deepEqual(unknown, []);
});

test('the served Russian dictionary has exactly the keys of the English one', () => {
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
  assert.deepEqual(
    Object.keys(ru).filter((key) => typeof ru[key] !== 'string' || ru[key] === ''),
    [],
  );
});

test('every placeholder of an English string survives its Russian translation', () => {
  const broken = Object.keys(ru).filter((key) => {
    const expected = placeholders(en[key]);
    const actual = placeholders(ru[key]);
    return expected.length !== actual.length || expected.some((value, at) => value !== actual[at]);
  });
  assert.deepEqual(broken, []);
});

test('a Russian reader is served Russian for the settings strings', () => {
  setImTranslator(chainTranslator({ ru, en }));
  assert.equal(imLocale(), 'ru');
  assert.equal(localizeText('侧边栏入口'), 'Пункт в боковой панели');
  assert.equal(localizeText('保存'), 'Сохранить');
  assert.equal(localizeText('正在读取通用设置…'), 'Загружаем общие настройки…');
  assert.equal(ru['$locale'], 'ru');
});

test('a Russian gap falls back to English before the Chinese key', () => {
  const withoutSave = Object.fromEntries(Object.entries(ru).filter(([key]) => key !== '保存'));
  setImTranslator(chainTranslator({ ru: withoutSave, en }));
  assert.equal(localizeText('保存'), 'Save');
});

test('a key neither dictionary knows stays the Chinese literal', () => {
  setImTranslator(chainTranslator({ ru, en }));
  assert.equal(localizeText('这个文案谁都没有翻译'), '这个文案谁都没有翻译');
  // A message composed outside the UI is in neither dictionary either, but the
  // dynamic table recognises its Chinese shape and renders it in Russian instead of
  // leaving it Chinese — the string a Russian reader was shown before it existed.
  assert.equal(
    localizeText('一次最多只能处理 9 张图片。'),
    'В одном сообщении может быть не больше 9 изображений.',
  );
});

test('Chinese and English readers keep the text they have today', () => {
  setImTranslator((key) => zh[key] ?? key);
  assert.equal(imLocale(), 'zh');
  assert.equal(localizeText('侧边栏入口'), '侧边栏入口');
  assert.equal(localizeText('保存'), '保存');

  setImTranslator(chainTranslator({ en }));
  assert.equal(imLocale(), 'en');
  assert.equal(localizeText('侧边栏入口'), 'Sidebar entry');
  assert.equal(localizeText('保存'), 'Save');
  // English still reaches the dynamic heuristics for a key it does not carry.
  assert.equal(localizeText('一次最多只能处理 9 张图片。'), 'A message can contain at most 9 images.');
});

test('installing the language pack registers the definition and the dictionary', () => {
  const calls = [];
  const locale = {
    getLocale: () => ({ active: 'ru', locales: [{ id: 'zh' }, { id: 'en' }], revision: 1 }),
    addLanguage(input) {
      calls.push(['addLanguage', input]);
      return () => calls.push(['disposeLanguage']);
    },
    register(namespace, id, dictionary) {
      calls.push(['register', namespace, id, dictionary]);
      return () => calls.push(['disposeDictionary']);
    },
  };

  const dispose = installImRussianLocale(locale);
  assert.deepEqual(calls[0], ['addLanguage', { id: 'ru', label: 'Русский', fallback: 'en' }]);
  assert.deepEqual(calls[1].slice(0, 3), ['register', IM_LOCALE_NAMESPACE, 'ru']);
  assert.equal(calls[1][3], ru);
  assert.equal(IM_RUSSIAN_LANGUAGE.fallback, 'en');

  dispose();
  // Teardown drops the dictionary before the definition that chains to it.
  assert.deepEqual(calls.slice(2), [['disposeDictionary'], ['disposeLanguage']]);
});

test('an occupied Russian id keeps the dictionary and skips the definition', () => {
  const calls = [];
  const locale = {
    getLocale: () => ({ active: 'en', locales: [{ id: 'en' }, { id: 'ru' }], revision: 1 }),
    addLanguage(input) {
      calls.push(['addLanguage', input]);
      return () => {};
    },
    register(namespace, id) {
      calls.push(['register', namespace, id]);
      return () => {};
    },
  };

  installImRussianLocale(locale);
  assert.deepEqual(calls, [['register', IM_LOCALE_NAMESPACE, 'ru']]);
});

test('a definition that lands mid-flight does not abort plugin activation', () => {
  const calls = [];
  const locale = {
    getLocale: () => ({ active: 'en', locales: [{ id: 'en' }], revision: 1 }),
    addLanguage() {
      throw new Error('locale "ru" is already registered');
    },
    register(namespace, id) {
      calls.push(['register', namespace, id]);
      return () => {};
    },
  };

  installImRussianLocale(locale);
  assert.deepEqual(calls, [['register', IM_LOCALE_NAMESPACE, 'ru']]);
});

test('any other registration failure is still reported', () => {
  const locale = {
    getLocale: () => ({ active: 'en', locales: [{ id: 'en' }], revision: 1 }),
    addLanguage() {
      throw new Error('fallback "en" is unknown');
    },
    register() {
      return () => {};
    },
  };

  assert.throws(() => installImRussianLocale(locale), /fallback "en" is unknown/u);
});

test('a plugin context without a locale service is left alone', () => {
  assert.equal(typeof installImRussianLocale(undefined), 'function');
  assert.equal(typeof installImRussianLocale({}), 'function');
  setImTranslator(EMPTY_TRANSLATOR);
});
