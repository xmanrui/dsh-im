import { readFileSync, writeFileSync } from 'node:fs';
const { pollAgentMailDeviceFlow } = await import('./src/channels/email/transports/agent-mail.mjs');
const P = '/tmp/agent-mail-pending.json';
const state = JSON.parse(readFileSync(P, 'utf8'));
const t = setInterval(async () => {
  const waited = Math.round((Date.now() - state.startedAt) / 1000);
  if (waited > 300) {
    console.log(`[${new Date().toLocaleTimeString('zh-CN')}] 已超时（300秒），需重新生成`);
    writeFileSync('/tmp/agent-mail-result.json', JSON.stringify({ status: 'expired' }));
    clearInterval(t); process.exit(0);
  }
  try {
    const r = await pollAgentMailDeviceFlow({ pollUrl: state.pollUrl });
    if (r.status === 'authorized' && r.tokens) {
      writeFileSync('/tmp/agent-mail-result.json', JSON.stringify({
        status: 'authorized', ...r.tokens, at: Date.now(),
      }));
      console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ✓ 授权成功！已保存 token`);
      clearInterval(t); process.exit(0);
    }
    process.stdout.write('.');
  } catch (e) {
    console.log(`\n[错误] ${e.message}`);
  }
}, 5000);
console.log('开始轮询（每 5 秒），最长 300 秒…');
