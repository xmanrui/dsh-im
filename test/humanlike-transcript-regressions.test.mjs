import assert from 'node:assert/strict';
import test from 'node:test';

import { flattenMarkdown } from '../src/channels/shared/humanize-outbound.mjs';
import { channelDeliveryFailure } from '../src/channels/shared/message-failure.mjs';

//
// 这三条全部来自同一段真实群聊回放（2026-11-02 05:24-05:32）：
//   中间几帧：![第40帧](D:/dsh-im-robot/_v3_1.png)
//   结果文件…已生成，但微信拒绝了该文件消息。错误码：CHANNEL_DELIVERY；参考号：MF-1DB643B7
// 群友看到的是本地磁盘路径和一张错误码卡片 —— 都是机器味。
//
test('图片标签被丢弃，而不是拍平成本地路径', () => {
  const text = '中间几帧：\n![第40帧](D:/dsh-im-robot/_v3_1.png)';
  const flat = flattenMarkdown(text);
  assert.equal(flat.includes('_v3_1.png'), false);
  assert.equal(flat.includes('D:/'), false);
  assert.match(flat, /中间几帧/u);
});

test('普通链接仍保留地址：图片是投递物，链接是内容', () => {
  assert.equal(
    flattenMarkdown('看这个 [文档](https://example.com/a) 挺好'),
    '看这个 文档（https://example.com/a） 挺好',
  );
});

test('投递类失败是可分类的错误，微信桥据此不显示码', () => {
  const error = Object.assign(new Error('WeChat refused the file'), { code: 'channel-send-failed' });
  const failure = channelDeliveryFailure(error);
  assert.equal(typeof failure, 'object');
});
