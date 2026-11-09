import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDeliveryService } from '../plugin-src/host/delivery-service.mjs';

function memoryAdapter({ channel = 'qq', botId = 'bot_one', withMedia = true } = {}) {
  const targets = new Map([['daily', {
    targetId: 'daily',
    name: 'Daily',
    kind: 'user',
    route: { userOpenId: 'user-one' },
  }]]);
  const sent = [];
  return {
    channel,
    sent,
    listBots: () => [botId],
    ownsBot: (candidate) => candidate === botId,
    listTargets: () => [...targets.values()].map((target) => structuredClone(target)),
    listSuggestions: () => [],
    createTarget: async () => { throw new Error('not used'); },
    updateTarget: async () => { throw new Error('not used'); },
    deleteTarget: async () => { throw new Error('not used'); },
    async sendText(id, target, text) {
      sent.push({ kind: 'text', botId: id, targetId: target.targetId, text });
    },
    ...(withMedia ? {
      async sendMedia(id, target, media) {
        sent.push({ kind: 'media', botId: id, targetId: target.targetId, media });
      },
    } : {}),
  };
}

async function tempFile(name, bytes) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-proactive-media-'));
  const path = join(directory, name);
  await writeFile(path, Buffer.from(bytes));
  return path;
}

test('sendMedia 读取本地图片并走渠道媒体通道，文本先于媒体', async () => {
  const service = createDeliveryService();
  const adapter = memoryAdapter();
  service.registerAdapter(adapter);
  const path = await tempFile('chart.png', [0x89, 0x50, 0x4e, 0x47]);

  const result = await service.sendMedia('bot_one', 'daily', { path }, { text: '早上好' });

  assert.equal(result.sent, true);
  assert.equal(result.fileName, 'chart.png');
  assert.equal(result.size, 4);
  assert.deepEqual(adapter.sent.map((entry) => entry.kind), ['text', 'media']);
  assert.equal(adapter.sent[1].media.mediaType, 'image/png');
  assert.equal(adapter.sent[1].targetId, 'daily');
});

test('sendMedia 对非图片扩展名按通用文件投递', async () => {
  const service = createDeliveryService();
  const adapter = memoryAdapter();
  service.registerAdapter(adapter);
  const path = await tempFile('report.pdf', [0x25, 0x50, 0x44, 0x46]);

  await service.sendMedia('bot_one', 'daily', { path });

  assert.equal(adapter.sent.length, 1);
  assert.equal(adapter.sent[0].media.mediaType, 'application/pdf');
});

test('sendMedia 在渠道没有媒体能力时抛 capability-unavailable', async () => {
  const service = createDeliveryService();
  service.registerAdapter(memoryAdapter({ withMedia: false }));
  const path = await tempFile('chart.png', [0x89, 0x50, 0x4e, 0x47]);

  await assert.rejects(
    service.sendMedia('bot_one', 'daily', { path }),
    (error) => error.code === 'capability-unavailable',
  );
});

test('sendMedia 拒绝空路径、不存在的文件与未知目标', async () => {
  const service = createDeliveryService();
  service.registerAdapter(memoryAdapter());

  await assert.rejects(service.sendMedia('bot_one', 'daily', { path: '' }),
    (error) => error.code === 'bad-request');
  await assert.rejects(service.sendMedia('bot_one', 'daily', { path: '/nonexistent/chart.png' }),
    (error) => error.code === 'bad-request');
  const path = await tempFile('chart.png', [0x89, 0x50, 0x4e, 0x47]);
  await assert.rejects(service.sendMedia('bot_one', 'missing', { path }),
    (error) => error.code === 'unknown-target');
});
