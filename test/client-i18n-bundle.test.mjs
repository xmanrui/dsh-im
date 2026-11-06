import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { renderToStaticMarkup } from 'react-dom/server';

import { en, ru, zh } from '../plugin-src/client/i18n.js';
import { GLOBAL_SETTINGS_TAB_ID } from '../plugin-src/client/global-settings.js';

test('the published client registers the complete Russian pack and renders each language', async (t) => {
  // Load the shipped entry exactly through its browser loader contract. Source
  // dictionary tests alone cannot detect a stale lib/client.js in the package.
  let client;
  const require = createRequire(import.meta.url);
  runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load({ id, factory }) {
      assert.equal(id, '@xmanrui/dsh-im');
      client = factory(require);
    } } },
    AbortController, setTimeout, clearTimeout, console,
  });

  let active = 'ru';
  let panel;
  const languages = new Map([['zh', { id: 'zh' }], ['en', { id: 'en' }]]);
  const dictionaries = new Map();
  const effects = [];
  const slots = new Map();
  const locale = {
    getLocale: () => ({ active, locales: [...languages.values()] }),
    addLanguage(definition) {
      assert.ok(!languages.has(definition.id));
      languages.set(definition.id, definition);
      return () => languages.delete(definition.id);
    },
    register(namespace, idOrDictionaries, dictionary) {
      assert.equal(namespace, 'dsh-im');
      const entries = typeof idOrDictionaries === 'string'
        ? [[idOrDictionaries, dictionary]] : Object.entries(idOrDictionaries);
      for (const [id, value] of entries) {
        assert.ok(!dictionaries.has(id));
        dictionaries.set(id, value);
      }
      return () => entries.forEach(([id]) => dictionaries.delete(id));
    },
    bind: () => (key) => dictionaries.get(active)?.[key] ?? dictionaries.get('en')?.[key] ?? key,
  };
  t.after(() => {
    for (const dispose of effects.reverse()) dispose?.();
    assert.equal(dictionaries.size, 0);
    assert.ok(!languages.has('ru'));
  });
  client.apply({
    locale,
    effect(install) { effects.push(install()); },
    on: () => () => {},
    // Pending RPCs keep unrelated data loading out of this language test.
    connection: { rpc: { call: () => new Promise(() => {}) } },
    slots: {
      inject: (name, install) => name === 'settings.section' ? install() : () => {},
      register(options, component) {
        slots.set(options.name, { options, component });
        return () => slots.delete(options.name);
      },
    },
    provide(name, service) {
      assert.equal(name, 'dshImClient');
      panel = service;
    },
  });

  assert.deepEqual({ ...languages.get('ru') }, { id: 'ru', label: 'Русский', fallback: 'en' });
  for (const [id, source] of Object.entries({ zh, en, ru })) {
    assert.deepEqual({ ...dictionaries.get(id) }, source, `published ${id} dictionary is stale`);
  }
  assert.equal(locale.bind()('绑定 DS Bot'), 'Привязать DS Bot');
  assert.equal(locale.bind()('机器人群聊行为'), 'Поведение бота в группах');
  for (const [id, label, loading] of [
    ['ru', 'IM-боты', 'Загружаем настройки боковой панели…'],
    ['en', 'IM bots', en['正在读取侧边栏设置…']],
    ['zh', 'IM机器人', '正在读取侧边栏设置…'],
  ]) {
    active = id;
    assert.equal(slots.get('settings.section').options.label(), label);
    const markup = renderToStaticMarkup(panel.render({ preferredSectionId: GLOBAL_SETTINGS_TAB_ID }));
    assert.ok(markup.includes(loading), `${id} settings should render the translated loading state`);
  }
});
