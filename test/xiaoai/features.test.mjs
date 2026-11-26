import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { XiaoAIRuntime } from '../../src/channels/xiaoai/runtime.mjs';
import { ReceiptStore, XiaoAIStateStore } from '../../src/channels/xiaoai/state-store.mjs';
import { XiaoAIController } from '../../src/channels/xiaoai/controller.mjs';
import { XiaoAIConfigStore, deriveXiaoAIIdentity } from '../../src/channels/xiaoai/config-store.mjs';
import { AccountTransportPool } from '../../src/channels/xiaoai/account-transport.mjs';
import { SidecarClient, waitReady } from '../../src/channels/xiaoai/sidecar-client.mjs';
import { createXiaoAIRpcHandler } from '../../plugin-src/host/channels/xiaoai/rpc.mjs';
import { fileURLToPath } from 'node:url';

const credential = { account: 'mock-account', accountId: 'a'.repeat(24), deviceId: 'device-one', hardware: 'LX01', name: 'Mock speaker', keyword: '让大肥鱼回答' };
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(predicate) { for (let n=0; n<500; n++) { if (predicate()) return; await pause(10); } throw new Error('Condition timed out'); }
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'xiaoai-features-'));
  t.disposers = [() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })];
  t.after(async () => { for (const dispose of [...t.disposers].reverse()) await dispose(); }); return root;
}
class Client extends EventEmitter {
  constructor() { super(); this.requests=[]; this.sent=[]; this.starts=[]; this.closed=false;
    this.ready=Promise.resolve({ accountId: credential.accountId, capabilities: { tts:'mock', multipleDevices:true } }); }
  async start(value, mode) { this.starts.push({value,mode}); }
  async send(value) { this.sent.push(value); }
  async request(type, fields, options) { this.requests.push({type,fields,options}); return {status:'accepted',playbackStopped:true,completionConfirmed:false}; }
  async close() { this.closed=true; this.emit('exit',{expected:true}); }
}
async function runtimeFor(t, root, harness) {
  const client=new Client(); const state=await new XiaoAIStateStore(join(root,'state.json')).load();
  const runtime=new XiaoAIRuntime({config:{botId:'xiaoai_test'},token:JSON.stringify(credential),state,stateRoot:root,
    harness:{ensureRunning:async()=>{},createSession:async()=>'session-test',sessionExists:async()=>true,...harness},createSidecar:()=>client,
    logger:{warn(){},error(){}}});
  t.after(()=>runtime.stop()); await runtime.start(); return {runtime,client,state};
}

test('separate proactive sends of identical text are delivered, while explicit delivery retries are deduplicated',async t=>{
  const root=await directory(t);const {runtime,client}=await runtimeFor(t,root,{});
  const target={targetId:'same-recipient',route:{deviceId:credential.deviceId}};
  await runtime.sendProactiveText(target,'相同提醒'); await runtime.sendProactiveText(target,'相同提醒');
  assert.equal(client.requests.filter(r=>r.type==='speak').length,2);
  await runtime.sendProactiveText(target,'同一次任务',{deliveryId:'job-run-123'});
  await runtime.sendProactiveText(target,'同一次任务',{deliveryId:'job-run-123'});
  assert.equal(client.requests.filter(r=>r.type==='speak').length,3);
});

test('a protected receipt overflow never drops a newly received or dispatching event',async t=>{
  const root=await directory(t);const path=join(root,'receipts.json');const inbound={};
  for(let n=0;n<2000;n++) inbound['old-'+n]={state:'uncertain',at:Date.now(),event:{eventId:'old-'+n}};
  await writeFile(path,JSON.stringify({inbound,outbound:{}}));const store=await new ReceiptStore(path).load();
  await store.receive({eventId:'new',text:'new question'}); assert.equal(store.getInbound('new').state,'received');
  await store.patchInbound('new','dispatching'); await store.persist();assert.equal(store.getInbound('new').state,'dispatching');
  const restored=await new ReceiptStore(path).load();assert.equal(restored.getInbound('new').state,'uncertain');
  assert.equal(restored.summary().uncertainInbound,2001);
});

test('password migration retries storage errors and never passes the retained password to a runtime',async t=>{
  const root=await directory(t);const configStore=await new XiaoAIConfigStore(join(root,'config.json')).load();
  const identity=deriveXiaoAIIdentity(credential.accountId+':'+credential.deviceId);
  await configStore.save({...identity,platformId:credential.accountId+':'+credential.deviceId,name:credential.name,createdAt:new Date().toISOString(),connectedAt:new Date().toISOString()});
  let value=JSON.stringify({...credential,password:'mock-old-secret'});let writable=false,writes=0;const seen=[];
  const controller=new XiaoAIController({configStore,stateRoot:root,
    credentials:{resolve:async()=>({value}),set:async(ref,next)=>{writes++;if(!writable)throw new Error('mock write failure');value=next;},unset:async()=>{}},
    createRuntime:async args=>{seen.push(JSON.parse(args.token));return {status:{ready:true,connectionState:'connected'},start:async()=>{},stop:async()=>{}};},
    logger:{warn(){},error(){}}}); t.after(()=>controller.close());
  await controller.initialize();assert.equal(Object.hasOwn(seen[0],'password'),false);
  assert.ok(controller.status().bots[0].credentialWarning);
  writable=true;await controller.initialize();assert.equal(writes,2);assert.equal(Object.hasOwn(JSON.parse(value),'password'),false);
  assert.equal(controller.status().bots[0].credentialWarning,undefined);
});

test('stopping speech while the model runs suppresses its later final reply and keeps the session',async t=>{
  const root=await directory(t);let release,asks=0;const answer=new Promise(r=>{release=r;});
  const {runtime,client,state}=await runtimeFor(t,root,{ask:async()=>{asks++;return answer;}});
  const event={type:'utterance',eventId:'b'.repeat(64),timestamp:Date.now(),deviceId:credential.deviceId,text:'让大肥鱼回答，长问题'};
  client.emit('message',event);await until(()=>asks===1);await runtime.cancelSpeech();release('这一条旧回复不应播报');
  await until(()=>!runtime.active);
  assert.equal(client.requests.filter(r=>r.type==='speak').length,0);
  assert.equal(state.sessionFor('direct:'+credential.deviceId),'session-test');
  assert.ok(client.requests.some(r=>r.type==='cancel_speech'&&r.fields.turnIds.includes(event.eventId)));
});

test('unprefixed fresh speech interrupts old output without becoming a DSH prompt or muting the native reply',async t=>{
  const root=await directory(t);let release,asks=0;const answer=new Promise(r=>{release=r;});
  const {runtime,client}=await runtimeFor(t,root,{ask:async()=>{asks++;return answer;}});
  const emit=(id,text)=>client.emit('message',{type:'utterance',eventId:id.repeat(64),timestamp:Date.now(),deviceId:credential.deviceId,text});
  emit('c','让大肥鱼回答，问题');await until(()=>asks===1);emit('d','今天的天气');
  await until(()=>client.requests.some(r=>r.type==='cancel_speech'));release('旧结果');await until(()=>!runtime.active);
  assert.equal(asks,1);assert.equal(client.requests.filter(r=>r.type==='speak').length,0);
  assert.equal(client.requests.filter(r=>r.type==='mute_native').length,1);
  assert.equal(client.requests.find(r=>r.type==='cancel_speech').fields.stopDevice,false);
});

test('one account transport multiplexes two isolated devices and survives removing one endpoint',async t=>{
  const root=await directory(t);const legacy=deriveXiaoAIIdentity(credential.accountId+':'+credential.deviceId);
  await mkdir(join(root,legacy.botId),{recursive:true});await writeFile(join(root,legacy.botId,'mi-token.json'),'{}');
  const children=[];const pool=new AccountTransportPool({stateRoot:root,createClient:()=>{const c=new Client();
    const request=c.request.bind(c);c.request=async(type,fields,options)=>{const result=await request(type,fields,options);
      return type==='device_add'?{...result,capabilities:{tts:'configured',modelProfile:fields.hardware}}:result;};
    children.push(c);return c;}});
  t.after(()=>pool.close());const one=pool.endpoint(credential);const two=pool.endpoint({...credential,deviceId:'device-two',hardware:'OH2'});
  const first=[],second=[];one.on('message',e=>first.push(e));two.on('message',e=>second.push(e));
  await Promise.all([one.start(),two.start()]);assert.equal(children.length,1);assert.equal(children[0].starts.length,1);
  assert.equal((await one.ready).capabilities.modelProfile,'LX01');
  assert.equal((await two.ready).capabilities.modelProfile,'OH2');
  assert.equal(children[0].starts[0].mode,'account');assert.equal(Object.hasOwn(children[0].starts[0].value,'password'),false);
  children[0].emit('message',{type:'utterance',deviceId:'device-two',text:'only device two'});
  assert.equal(first.length,0);assert.equal(second.length,1);
  await assert.rejects(one.request('speak',{deviceId:'device-two',text:'forbidden'}));
  await one.close();assert.equal(children[0].closed,false);
  assert.ok(children[0].requests.some(r=>r.type==='device_remove'&&r.fields.deviceId===credential.deviceId));
  await two.request('speak',{deviceId:'device-two',text:'still connected'});await two.close();assert.equal(children[0].closed,true);
});

test('speech failures expose bounded diagnostics without leaking the raw provider response',async t=>{
  const root=await directory(t);const {runtime,client}=await runtimeFor(t,root,{});
  const request=client.request.bind(client);
  client.request=async(type,fields,options)=>type==='speak'
    ? {status:'failed',transport:'miot',modelProfile:'OH2',code:'tts-rejected',providerCode:-704042011,
       response:'private-token-never-display'}:request(type,fields,options);
  const rpc=createXiaoAIRpcHandler({status(){return {bots:[]};},bindCredentials(){},reconnectBot(){},deleteBot(){},
    sendConnectionTest:()=>runtime.sendConnectionTest('test')});
  const result=await rpc('device.test',{botId:'xiaoai_'+'a'.repeat(24)});
  assert.equal(result.ok,false);assert.match(result.error.message,/小米接口拒绝/);
  assert.equal(runtime.status.lastDelivery.providerCode,-704042011);
  assert.equal(runtime.status.lastDelivery.transport,'miot');
  assert.ok(!JSON.stringify(runtime.status).includes('private-token'));
});

test('one interactive login binds multiple devices without persisting a password or mixing sessions',async t=>{
  const root=await directory(t);const configStore=await new XiaoAIConfigStore(join(root,'config.json')).load();const secrets=new Map(),states=new Map();
  const devices=[{...credential},{...credential,deviceId:'device-two',name:'Second speaker'}];let adopted=0,authClosed=false;
  const controller=new XiaoAIController({configStore,stateRoot:root,
    credentials:{resolve:async ref=>({value:secrets.get(ref)}),set:async(ref,value)=>secrets.set(ref,value),unset:async ref=>secrets.delete(ref)},
    createAuthClient:({stateDir})=>{const c=new Client();c.ready=Promise.resolve({accountId:credential.accountId,devices});
      c.start=async()=>{await mkdir(stateDir,{recursive:true});await writeFile(join(stateDir,'mi-token.json'),'{}');};c.close=async()=>{authClosed=true;};return c;},
    accountTransport:{adoptAccount:async()=>{adopted++;},close:async()=>{},removeAccount:async()=>{}},
    stateFor:async id=>{if(!states.has(id))states.set(id,await new XiaoAIStateStore(join(root,id,'state.json')).load());return states.get(id);},
    listWorkspaceSessions:async()=>({sessions:[{sessionId:'existing'}]}),botWorkspaceFor:()=>root,
    createRuntime:async args=>{assert.equal(Object.hasOwn(JSON.parse(args.token),'password'),false);return {status:{ready:true,connectionState:'connected'},active:false,start:async()=>{},stop:async()=>{}};},
    logger:{warn(){},error(){}}});t.after(()=>controller.close());
  const auth=await controller.beginAuth({account:'mock-account',password:'mock-login-only'});
  const result=await controller.bindDevices({authId:auth.authId,deviceIds:devices.map(d=>d.deviceId),keyword:credential.keyword});
  assert.equal(adopted,1);assert.equal(authClosed,true);assert.equal(result.results.filter(r=>r.bound).length,2);
  assert.equal(secrets.size,2);for(const value of secrets.values())assert.equal(Object.hasOwn(JSON.parse(value),'password'),false);
  const bots=controller.status().bots;await controller.bindSession(bots[0].botId,'existing');
  assert.equal((await controller.deviceSessions(bots[1].botId)).currentSessionId,null);
  await controller.deleteBot(bots[0].botId);assert.equal(controller.status().bots.length,1);
});

const python = process.env.XIAOAI_TEST_PYTHON ?? (process.platform === 'win32' ? undefined : '/usr/bin/python3');
test('real account-mode Python child routes two speakers through one process', {skip:!python,timeout:30000}, async t=>{
  const root=await directory(t);const script=fileURLToPath(new URL('../../sidecar/xiaoai_sidecar.py',import.meta.url));
  const client=new SidecarClient({python,script,stateDir:root,mock:true});t.disposers.push(()=>client.close());
  const devices=[{deviceId:'one',name:'One',hardware:'LX01'},{deviceId:'two',name:'Two',hardware:'LX01'}];
  const messages=[];client.on('message',m=>messages.push(m));
  await client.start({...credential,devices},'account');const ready=await waitReady(client);
  assert.equal(ready.capabilities.multipleDevices,true);
  for(const device of devices)assert.equal((await client.request('device_add',{deviceId:device.deviceId})).status,'accepted');
  await client.send({type:'mock_utterance',deviceId:'two',text:'让大肥鱼回答，第二台',timestamp:Date.now()+50,providerRequestId:'account-test-two'});
  await until(()=>messages.some(m=>m.type==='utterance'));
  assert.equal(messages.find(m=>m.type==='utterance').deviceId,'two');
  await client.send({type:'accepted',eventId:messages.find(m=>m.type==='utterance').eventId,deviceId:'two'});
  const results=await Promise.all(devices.map(d=>client.request('speak',{deviceId:d.deviceId,text:'独立回答',turnId:d.deviceId})));
  assert.ok(results.every(r=>r.status==='accepted'));
  await client.request('device_remove',{deviceId:'one'});
  assert.equal((await client.request('speak',{deviceId:'two',text:'第二台仍可播报',turnId:'two-next'})).status,'accepted');
});
