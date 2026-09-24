import { readFileSync, writeFileSync } from 'node:fs';
const { pollAgentMailDeviceFlow } = await import('./src/channels/email/transports/agent-mail.mjs');
const state = JSON.parse(readFileSync('/tmp/agent-mail-pending.json','utf8'));
const t = setInterval(async () => {
  const waited = Math.round((Date.now()-state.startedAt)/1000);
  if (waited > 300) {
    console.log(`超时（${waited}s）`); writeFileSync('/tmp/agent-mail-result.json', JSON.stringify({status:'expired'}));
    clearInterval(t); process.exit(0);
  }
  try {
    const r = await pollAgentMailDeviceFlow({ pollUrl: state.pollUrl });
    if (r.status === 'authorized' && r.tokens) {
      writeFileSync('/tmp/agent-mail-result.json', JSON.stringify({status:'authorized',...r.tokens,at:Date.now()}));
      console.log(`✓ 授权成功（等待 ${waited}s）`); clearInterval(t); process.exit(0);
    }
    process.stdout.write('.');
  } catch (e) { console.log(`\n错误: ${e.message}`); }
}, 5000);
console.log('轮询中…（最长 300 秒）');
