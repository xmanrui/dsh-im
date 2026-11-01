import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PERSONA,
  PERSONA_FIELDS,
  PERSONA_GUIDANCE_MAX_LENGTH,
  normalizePersona,
  renderPersonaGuidance,
  validatePersona,
} from '../src/channels/shared/persona.mjs';

test('聚积：默认人设渲染出身份、性格、示例对话三段', () => {
  const text = renderPersonaGuidance(DEFAULT_PERSONA);
  assert.match(text, /^## 你是谁/u);
  assert.match(text, /## 你的性格/u);
  assert.match(text, /## 你平时怎么回/u);
  // The nickname reaches the render: group members address the bot by it.
  assert.match(text, /肥鱼/u);
  assert.ok(text.length > 0 && text.length <= PERSONA_GUIDANCE_MAX_LENGTH);
});

test('空字段不渲染空标题：只有一个名字的人设只剩一段', () => {
  const text = renderPersonaGuidance({ name: '阿黄' });
  assert.equal(text, '## 你是谁\n你是阿黄。');
});

test('normalizePersona 对垃圾输入永不抛错，回落到默认人设', () => {
  assert.equal(normalizePersona(null), DEFAULT_PERSONA);
  assert.equal(normalizePersona('nope'), DEFAULT_PERSONA);
  assert.equal(normalizePersona([]), DEFAULT_PERSONA);
});

test('normalizePersona 截断超长字段并按上限收敛示例条数', () => {
  const many = Array.from({ length: 30 }, (_, index) => ({ user: `u${index}`, bot: `b${index}` }));
  const card = normalizePersona({ name: 'x'.repeat(100), exampleDialogues: many });
  assert.equal(card.name.length, 32);
  assert.equal(card.exampleDialogues.length, 8);
});

test('示例对话接受粘贴的 user:/bot: 纯文本形态，半条不算', () => {
  const card = normalizePersona({
    name: '豆豆',
    exampleDialogues: ['user: 在吗\nbot: 在', { user: '只有一半' }],
  });
  assert.deepEqual(card.exampleDialogues, [{ user: '在吗', bot: '在' }]);
});

test('validatePersona 拒绝未知字段与非对象', () => {
  assert.throws(() => validatePersona({ name: 'a', bogus: 1 }), (error) => error.code === 'persona-invalid');
  assert.throws(() => validatePersona(null), (error) => error.code === 'persona-invalid');
});

test('不认识的人设字段名清单是导出常量，表单与校验永不漂移', () => {
  assert.ok(PERSONA_FIELDS.includes('personality'));
  assert.ok(PERSONA_FIELDS.includes('exampleDialogues'));
  // Every field the renderer reads must be a declared field.
  for (const key of Object.keys(DEFAULT_PERSONA)) {
    assert.ok(PERSONA_FIELDS.includes(key), `未声明的字段：${key}`);
  }
});

test('renderPersonaGuidance 按整行截断，不切断句子', () => {
  const text = renderPersonaGuidance(DEFAULT_PERSONA, { maxChars: 40 });
  assert.ok(text.length <= 40);
  assert.ok(!text.endsWith('，'));
});
