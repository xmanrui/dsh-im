import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const CLIENT_URL = new URL('../../../plugin-src/client/channels/dingtalk/index.js', import.meta.url);
const STYLES_URL = new URL('../../../plugin-src/client/channels/dingtalk/styles.js', import.meta.url);

test('channel client exports a reusable settings component without a standalone settings registration', async () => {
  const source = await readFile(CLIENT_URL, 'utf8');
  assert.match(source, /export function DingtalkSettingsTab\(\{ rpcCall \}\)/);
  assert.doesNotMatch(source, /export function apply\(ctx\)/);
  assert.doesNotMatch(source, /settings\.plugins\.tab/);
});

test('QR guidance describes the complete official DingTalk authorization flow', async () => {
  const source = await readFile(CLIENT_URL, 'utf8');
  assert.match(source, /使用已加入企业\/组织的钉钉账号扫描左侧二维码/);
  assert.match(source, /如果钉钉提示尚未加入组织/);
  assert.match(source, /在授权页点击“一键创建新机器人”/);
  assert.match(source, /保持本页打开，等待机器人自动连接/);
  assert.doesNotMatch(source, /OpenClaw 品牌|ddt-brandNotice/);
  assert.match(source, /safeQrSource\(provision\.qrCodeDataUrl\)/);
  assert.doesNotMatch(source, /verificationUrl|打开备用链接/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|window\.open\(/);
});

test('the settings page has no local sender approval workflow', async () => {
  const source = await readFile(CLIENT_URL, 'utf8');
  assert.match(source, /payload: \{ botId: account\.botId, confirm: true \}/);
  assert.doesNotMatch(source, /SenderAccess|approveSender|revokeSender|待批准|已批准|批准使用/);
});

test('the client uses an isolated compact and accessible DingTalk style namespace', async () => {
  const [source, styles] = await Promise.all([
    readFile(CLIENT_URL, 'utf8'),
    readFile(STYLES_URL, 'utf8'),
  ]);
  assert.doesNotMatch(source, /\bdxw-|\bbxf-/);
  assert.doesNotMatch(styles, /\bdxw-|\bbxf-/);
  assert.match(styles, /\.ddt-page \{/);
  assert.match(styles, /--ddt-accent: #1677ff/);
  assert.match(styles, /@media \(max-width: 720px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(source, /aria-live': 'polite'/);
  assert.match(source, /role: 'alertdialog'/);
});

test('the QR card responds to its plugin panel width instead of the browser viewport', async () => {
  const styles = await readFile(STYLES_URL, 'utf8');
  assert.match(styles, /container-type: inline-size/);
  assert.match(
    styles,
    /@container \(max-width: 680px\)[\s\S]*\.ddt-qrLayout \{ grid-template-columns: minmax\(0, 1fr\); justify-items: center;/,
  );
  assert.match(styles, /\.ddt-qrFrame \{[^\n]*width: min\(270px, 100%\)/);
  assert.match(styles, /\.ddt-countdown \{ width: min\(270px, 100%\)/);
  assert.match(styles, /\.ddt-qrLayout \{[^\n]*align-items: start;/);
  assert.match(styles, /\.ddt-qrColumn \{ width: 100%; min-width: 0; \}/);
  assert.match(styles, /\.ddt-qrCopy \{ min-width: 0; overflow-wrap: anywhere; \}/);
});

test('bot cards do not reserve a row for repeated channel metrics', async () => {
  const styles = await readFile(STYLES_URL, 'utf8');
  assert.doesNotMatch(styles, /\.ddt-metrics|\.ddt-metric/);
});

test('the narrow-panel toolbar keeps all three controls on one row', async () => {
  const styles = await readFile(STYLES_URL, 'utf8');
  assert.match(
    styles,
    /@container \(max-width: 680px\)[\s\S]*\.ddt-tools \{ width: 100%; flex-wrap: nowrap; gap: 6px; \}/,
  );
  assert.match(styles, /\.ddt-tools \.ddt-badge \{ min-height: 34px;/);
  assert.match(styles, /\.ddt-tools \.ddt-button \{[^\n]*white-space: nowrap;/);
});
