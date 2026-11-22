import * as React from 'react';
import { h, localizeTemplate, localizeText } from '../../i18n.js';
import { WorkspaceEditor } from '../../workspace-editor.js';
import { ModelCatalogContext, ModelEditor, EMPTY_MODEL_CATALOG } from '../../model-setting.js';
import { AgentPresetCatalogContext, AgentPresetEditor, EMPTY_AGENT_PRESET_CATALOG } from '../../agent-preset.js';
import { BotSettingsButton } from '../../channel-card-meta.js';
import { CredentialActionIcon } from '../../credential-binding.js';
import { DEFAULT_XIAOAI_PREFIX } from '../../../../src/channels/xiaoai/constants.mjs';

export const XIAOAI_RPC_CHANNEL = '/xiaoai';
const button = (label, onClick, disabled = false, kind = 'secondary') => h('button', { type: 'button', className: 'ddt-button', 'data-kind': kind, onClick, disabled }, label);
const field = (label, props) => h('label', { className: 'dim-credentialField' }, h('span', null, label), h('input', props));
export function checkedAuth(value) {
  if (!value || typeof value.authId !== 'string' || !Array.isArray(value.devices)
    || !['connecting', 'verification-required', 'verifying', 'ready', 'failed', 'expired'].includes(value.state)) {
    throw new Error('小米认证状态响应不完整，请结束登录后重新尝试。');
  }
  return value;
}
function XiaoAILogo({ size = 64 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 48 48', fill: 'none', 'aria-hidden': true },
    h('rect', { x: 11, y: 5, width: 26, height: 38, rx: 10, stroke: 'currentColor', strokeWidth: 2.4 }),
    h('path', { d: 'M18 13h12', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' }),
    h('circle', { cx: 24, cy: 29, r: 7, stroke: 'currentColor', strokeWidth: 2.4 }),
    h('circle', { cx: 24, cy: 29, r: 2, fill: 'currentColor' }));
}

export function XiaoAILogin({ rpcCall, refresh, onCancel }) {
  const [account, setAccount] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [keyword, setKeyword] = React.useState(DEFAULT_XIAOAI_PREFIX);
  const [selectedDevices, setSelectedDevices] = React.useState([]);
  const [bindingResults, setBindingResults] = React.useState([]);
  const selectedFor = React.useRef(null);
  const [auth, setAuth] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    if (auth?.state === 'ready' && selectedFor.current !== auth.authId) {
      selectedFor.current = auth.authId;
      setSelectedDevices(auth.devices.length === 1 ? [auth.devices[0].deviceId] : []);
      setBindingResults([]);
    }
  }, [auth?.authId, auth?.state]);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const call = async (endpoint, payload) => {
    const result = await rpcCall(endpoint, payload);
    if (result?.ok !== true) throw new Error(result?.error?.message ?? 'XiaoAI 操作失败');
    return ['auth.begin', 'auth.status', 'auth.submit'].includes(endpoint) ? checkedAuth(result.value) : result.value;
  };
  React.useEffect(() => {
    if (!auth?.authId) return;
    let alive = true; let running = false; let stopped = false; let timer;
    const tick = async () => {
      if (stopped || running) return; running = true;
      try {
        const next = await call('auth.status', { authId: auth.authId });
        if (alive) setAuth(next);
        if (next.state === 'expired') { stopped = true; clearInterval(timer); }
      } catch (e) { if (alive) setError(e.message); }
      finally { running = false; }
    };
    timer = setInterval(tick, 2_000);
    return () => { alive = false; clearInterval(timer); void rpcCall('auth.cancel', { authId: auth.authId }).catch(() => {}); };
  }, [auth?.authId, rpcCall]);
  const run = async (action) => {
    setBusy(true); setError(null);
    try { await action(); } catch (e) { if (mounted.current) setError(e.message); }
    finally { if (mounted.current) setBusy(false); }
  };
  return h('section', { className: 'ddt-card dim-surfaceCard dim-credentialPanel', 'aria-label': '小米登录' },
    h('h3', { className: 'dim-credentialTitle' }, '小米账号接入'),
    h('p', { className: 'dim-xiaoaiHelp' }, '使用音箱绑定的小米账号登录，可一次勾选多台音箱。每台音箱分别管理会话和播报。需要安全验证时，下方会显示验证码输入框。'),
    h('p', { className: 'dim-xiaoaiHelp' }, '密码只用于本次登录，不会写入设备凭据；登录状态（passToken）失效时需要重新登录。'),
    !auth ? h('form', { className: 'dim-credentialForm', onSubmit: (e) => { e.preventDefault(); const secret = password; setPassword(''); void run(async () => setAuth(await call('auth.begin', { account, password: secret }))); } },
      field('小米账号', { value: account, placeholder: '输入音箱绑定的小米账号', autoComplete: 'username', required: true, onChange: e => setAccount(e.target.value), disabled: busy }),
      field('小米密码', { value: password, placeholder: '输入小米账号密码', type: 'password', autoComplete: 'current-password', required: true, onChange: e => setPassword(e.target.value), disabled: busy }),
      h('div', { className: 'ddt-actions dim-viewActions dim-credentialActions' },
        h('button', { type: 'submit', className: 'ddt-button', 'data-kind': 'primary', disabled: busy || !account || !password }, busy ? '正在登录…' : '登录并获取设备'),
        button('取消', onCancel, busy))) : h(React.Fragment, null,
      h('p', { className: 'dim-xiaoaiAuthStatus', role: 'status', 'data-state': auth.state },
        h('span', { className: 'ddt-dot dim-stateDot' }),
        ({ connecting: '正在连接小米，验证步骤将自动显示…', 'verification-required': auth.method === 'Email' ? '请输入小米发送的邮箱验证码' : '请输入小米发送的短信验证码', verifying: '正在验证…', ready: '登录成功，请选择设备', failed: '登录失败，请检查账号、网络或小米安全验证后重试', expired: '登录已超时，请重新登录' })[auth.state]),
      auth.state === 'verification-required' ? h('form', { className: 'dim-credentialForm dim-credentialFormSingle', onSubmit: e => { e.preventDefault(); const value = code; setCode(''); void run(async () => setAuth(await call('auth.submit', { authId: auth.authId, code: value }))); } },
        field('验证码', { value: code, placeholder: '输入收到的验证码', autoComplete: 'one-time-code', inputMode: 'numeric', maxLength: 12, onChange: e => setCode(e.target.value), required: true, disabled: busy }),
        h('div', { className: 'ddt-actions dim-viewActions dim-credentialActions' },
          h('button', { type: 'submit', className: 'ddt-button', 'data-kind': 'primary', disabled: busy || !code }, busy ? '正在提交…' : '提交验证码'))) : null,
      auth.state === 'ready' ? h('div', null,
        field('触发前缀（每次对话必需）', { value: keyword, maxLength: 80, required: true, onChange: e => setKeyword(e.target.value) }),
        auth.devices.length ? h('div', null,
          auth.devices.map(d => h('label', { key: d.deviceId, className: 'dim-xiaoaiDevice dim-viewActions' },
            h('input', { type: 'checkbox', checked: selectedDevices.includes(d.deviceId), disabled: busy,
              'aria-label': localizeTemplate('选择 {name}', { name: d.name }), onChange: e => setSelectedDevices(ids => e.target.checked ? [...new Set([...ids, d.deviceId])] : ids.filter(id => id !== d.deviceId)) }),
            h('span', null, `${d.name} · ${d.hardware} · ${d.deviceId}`))),
          h('div', { className: 'ddt-actions dim-viewActions' },
            button(localizeTemplate('接入所选音箱（{count}）', { count: selectedDevices.length }), () => void run(async () => {
              const result = await call('devices.bind', { authId: auth.authId, deviceIds: selectedDevices, keyword });
              setBindingResults(result.results ?? []);
              await refresh();
              if (result.results?.every(r => r.bound)) { setAuth(null); onCancel?.(); }
              else setSelectedDevices(result.results?.filter(r => !r.bound).map(r => r.deviceId) ?? []);
            }), busy || !keyword.trim() || !selectedDevices.length, 'primary')),
          bindingResults.some(r => !r.bound) ? h('p', { role: 'alert' }, '部分设备未接入；成功接入的设备已保留，可重试其余设备。') : null)
          : h('p', null, '该账号未返回小爱音箱，请检查绑定账号。')) : null,
      h('div', { className: 'ddt-actions dim-viewActions' }, button('结束登录', () => { setAuth(null); setError(null); }, busy))),
    error ? h('p', { role: 'alert', className: 'dim-credentialError' }, error) : null);
}

export function XiaoAIDevice({ bot, rpcCall, refresh }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [sessions, setSessions] = React.useState(null);
  const [remove, setRemove] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  const prefixId = React.useId();
  const [keyword, setKeyword] = React.useState(bot.xiaoai?.device?.keyword ?? '');
  React.useEffect(() => {
    setKeyword(bot.xiaoai?.device?.keyword ?? '');
  }, [bot.xiaoai?.device?.keyword]);
  const run = async (endpoint, payload = {}) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await rpcCall(endpoint, { botId: bot.botId, ...payload });
      if (!result?.ok) throw new Error(result?.error?.message ?? '操作未完成');
      if (endpoint === 'device.sessions' || endpoint === 'device.session.set') setSessions(result.value);
      if (endpoint === 'device.test' && result.value?.sent) setNotice('小米云已接受测试播报，请确认音箱是否发声。');
      if (endpoint === 'device.keyword.set') setNotice('触发前缀已保存。');
      if (endpoint === 'device.speech.stop') setNotice(result.value?.playbackStopped === false
        ? '后续播报已取消，设备停止指令尚未确认。' : '本轮剩余播报已取消；结果仍可在 DSH Web 查看。');
      if (endpoint === 'device.stop') setNotice('已请求停止本轮任务和播报。');
      await refresh(); return result.value;
    } catch (e) { setError(e.message); throw e; }
    finally { setBusy(false); }
  };
  const action = (endpoint, payload) => void run(endpoint, payload).catch(() => {});
  const entries = Array.isArray(sessions?.sessions) ? sessions.sessions : sessions?.sessions?.items ?? [];
  const taskActive = bot.xiaoai?.taskActive === true;
  const identity = bot.bot ?? bot.identity ?? { name: '小爱音箱' };
  const capabilities = bot.xiaoai?.capabilities;
  const delivery = bot.xiaoai?.lastDelivery;
  return h('article', { className: 'ddt-card dim-surfaceCard dim-xiaoaiCard', 'aria-label': identity.name },
    h('h3', null, identity.name, h('small', { style: { marginLeft: 12 } }, bot.connected ? '已连接' : '未连接')),
    h('p', null, `${bot.xiaoai?.device?.hardware ?? 'UNKNOWN'} · ${bot.health.summary}`),
    capabilities ? h('p', { className: 'dim-xiaoaiHelp' }, capabilities.tts === 'configured'
      ? '已配置该型号的播报接口，实际发声请通过测试播报确认。'
      : capabilities.profileReason === 'missing-miot-did'
        ? '设备缺少播报适配所需的信息，当前使用兼容接口，发声尚未验证。'
        : '当前使用兼容播报接口，该型号尚未验证。') : null,
    h('p', null, '当前会话：', bot.xiaoai?.sessionId ?? '首次提问时创建'),
    bot.xiaoai?.device ? h('section', { className: 'dim-botGeneralSettings dim-xiaoaiPrefixSettings' },
      h('form', {
        className: 'dim-xiaoaiPrefixForm',
        onSubmit: (event) => {
          event.preventDefault();
          if (busy || !keyword.trim() || keyword === bot.xiaoai.device.keyword) return;
          action('device.keyword.set', { keyword });
        },
      },
      h('div', { className: 'dim-botGeneralRow' },
        h('div', { className: 'dim-botGeneralText' },
          h('label', { className: 'dim-botGeneralTitle', htmlFor: prefixId }, '触发前缀'),
          h('p', { className: 'dim-botGeneralHelp', id: `${prefixId}-help` }, '每条语音都必须以该前缀开头；保存后立即用于下一句话。')),
        h('div', { className: 'dim-botGeneralControl dim-xiaoaiPrefixControl' },
          h('input', {
            id: prefixId, className: 'dim-groupHistoryInput dim-xiaoaiPrefixInput',
            value: keyword, maxLength: 80, disabled: busy, placeholder: '输入触发前缀',
            'aria-label': '修改触发前缀', 'aria-describedby': `${prefixId}-help`,
            autoComplete: 'off', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false,
            onChange: e => setKeyword(e.target.value),
          }))),
      h('div', { className: 'dim-botGeneralActions' },
        h('button', {
          type: 'submit', className: 'dim-deliveryButton dim-xiaoaiPrefixSave', 'data-kind': 'primary',
          disabled: busy || !keyword.trim() || keyword === bot.xiaoai.device.keyword,
        }, busy ? '保存中…' : '保存')))) : null,
    bot.xiaoai?.retryBlocked ? h('p', { role: 'alert' }, '小米授权已失效：请点击上方“小米账号接入”重新登录并选择设备；自动重连已暂停。') : null,
    bot.error && !bot.xiaoai?.retryBlocked ? h('p', { role: 'alert' }, bot.error.message) : null,
    bot.credentialWarning ? h('p', { role: 'alert' }, bot.credentialWarning) : null,
    bot.xiaoai?.waitingInteraction ? h('p', { role: 'status' }, bot.xiaoai.waitingInteraction === 'approval' ? '等待你在 DSH Web 处理审批' : '等待语音补充信息，回答时也需携带触发前缀') : null,
    bot.xiaoai?.lastError ? h('p', { role: 'status' }, bot.xiaoai.lastError) : null,
    bot.xiaoai?.lastCancellation ? h('p', { role: 'status' }, '本轮语音已被打断，旧回复不会自动续播。') : null,
    bot.xiaoai?.nativeSuppression === 'best-effort' ? h('p', { className: 'dim-xiaoaiHelp' }, '已启用原厂回答抑制；受小米云延迟影响，仍可能听到短暂原厂回答。') : null,
    bot.lastMessageError ? h('p', { role: 'status' }, localizeTemplate('最近消息处理失败：{message}', { message: bot.lastMessageError.message ?? localizeText('请查看会话记录') })) : null,
    notice ? h('p', { role: 'status' }, notice) : null,
    delivery ? h('details', null, h('summary', null, '最近播报诊断'),
      h('p', null, localizeTemplate('结果：{status}；{completion}', { status: localizeText(({ accepted: '小米云已接受', failed: '接口拒绝', unknown: '结果不确定', cancelled: '已取消' })[delivery.status] ?? delivery.status), completion: localizeText(delivery.completionConfirmed ? '已确认播放结束' : '尚未确认实际播放结束') })),
      h('p', null, localizeTemplate('适配：{profile}；接口：{transport}；HTTP：{httpStatus}；返回码：{providerCode} / {innerCode}；诊断：{diagnostic}{errorType}', { profile: delivery.modelProfile ?? '未记录', transport: delivery.transport ?? '未记录', httpStatus: delivery.httpStatus ?? '未记录', providerCode: delivery.providerCode ?? '未记录', innerCode: delivery.innerCode ?? '无', diagnostic: delivery.code ?? '无错误回执', errorType: delivery.errorType ? ' / ' + delivery.errorType : '' }))) : null,
    (bot.xiaoai?.uncertainInbound || bot.xiaoai?.uncertainOutbound) ? h('div', { className: 'ddt-actions dim-viewActions' },
      h('p', { role: 'status' }, localizeTemplate('需核对：{inbound} 条接入、{outbound} 条播报。请先查看会话记录再决定是否重发。', { inbound: bot.xiaoai.uncertainInbound, outbound: bot.xiaoai.uncertainOutbound })),
      button('标记已核对', () => action('device.receipts.review'), busy)) : null,
    h('div', { className: 'ddt-actions dim-viewActions' },
      button('重新连接', () => action('bot.reconnect'), busy || taskActive),
      button('测试播报', () => action('device.test'), busy || !bot.connected || taskActive),
      button('停止播报', () => action('device.speech.stop'), busy || !bot.connected),
      button('停止任务与播报', () => action('device.stop'), busy || !bot.connected),
      button('选择会话', () => action('device.sessions'), busy || taskActive),
      button('新建会话', () => action('device.session.set', { sessionId: null }), busy || taskActive),
      button('移除设备', () => setRemove(true), busy),
      h(BotSettingsButton, { channel: 'xiaoai', botId: bot.botId, botName: identity.name, connected: bot.connected, accessPolicy: bot.accessPolicy })),
    remove ? h('div', { role: 'alert' }, h('p', null, '确认移除此设备及本机凭据和映射？DSH 历史会话保留。'),
      button('确认移除', () => action('bot.delete', { confirm: true }), busy), button('取消', () => setRemove(false), busy)) : null,
    sessions ? h('label', { className: 'dim-xiaoaiField' }, h('span', null, '绑定当前工作区的会话'),
      h('select', { value: sessions.currentSessionId ?? '', disabled: busy, onChange: e => action('device.session.set', { sessionId: e.target.value || null }) },
        h('option', { value: '' }, '下次提问创建新会话'),
        entries.map(s => h('option', { key: s.sessionId ?? s.id, value: s.sessionId ?? s.id }, s.title ?? s.sessionId ?? s.id)))) : null,
    h('details', null, h('summary', null, '工作区与模型'),
      h(WorkspaceEditor, { workspace: bot.workspace, disabled: busy, onSave: workspace => run('bot.workspace.set', { workspace }) }),
      h(ModelEditor, { model: bot.model, disabled: busy, onSave: model => run('bot.model.set', { model }) }),
      h(AgentPresetEditor, { agentPreset: bot.agentPreset, disabled: busy, onSave: agentPreset => run('bot.preset.set', { agentPreset }) })),
    error ? h('p', { role: 'alert' }, error) : null);
}

export function XiaoAISettingsTab({ rpcCall }) {
  const [status, setStatus] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [loginOpen, setLoginOpen] = React.useState(false);
  const mounted = React.useRef(true);
  const refresh = React.useCallback(async () => {
    const result = await rpcCall('connection.status', {});
    if (!result?.ok) throw new Error(result?.error?.message ?? '无法读取 XiaoAI 状态');
    if (mounted.current) { setStatus(result.value); setError(null); }
  }, [rpcCall]);
  React.useEffect(() => {
    mounted.current = true; let reading = false;
    const load = async () => { if (reading) return; reading = true; try { await refresh(); } catch (e) { if (mounted.current) setError(e.message); } finally { reading = false; } };
    void load(); const timer = setInterval(load, 5_000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [refresh]);
  return h(ModelCatalogContext.Provider, { value: status?.modelCatalog ?? EMPTY_MODEL_CATALOG },
    h(AgentPresetCatalogContext.Provider, { value: status?.agentPresetCatalog ?? EMPTY_AGENT_PRESET_CATALOG },
      h('section', { className: 'ddt-page dim-channelPage dim-pageXiaoAI dim-xiaoai', 'aria-label': 'XiaoAI 设置' },
        h('style', null, '.dim-xiaoaiCard{padding:24px}.dim-xiaoaiHelp{margin:0;color:var(--dsw-alias-label-secondary,#646a73);font-size:13px;line-height:1.65}.dim-xiaoaiAuthStatus{display:flex;align-items:center;gap:8px;margin:0;font-size:13px;line-height:1.6}.dim-xiaoaiAuthStatus[data-state="failed"]{color:var(--dsw-alias-state-error-primary,#d54941)}.dim-xiaoaiDevice{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-top:14px!important}.dim-xiaoaiDevice span{min-width:0;overflow-wrap:anywhere}.dim-xiaoaiPrefixSettings{margin-top:8px}.dim-xiaoaiPrefixForm{min-width:0}.dim-xiaoaiPrefixControl{width:min(240px,100%)}.dim-xiaoaiPrefixInput{box-sizing:border-box;width:100%;appearance:none;padding:0 14px;font-family:inherit;text-align:left}.dim-xiaoaiPrefixSave{min-width:58px;min-height:36px;border-radius:10px}@container (max-width:560px){.dim-xiaoaiPrefixSettings .dim-botGeneralRow{grid-template-columns:minmax(0,1fr);align-items:start;gap:8px}.dim-xiaoaiPrefixControl{width:100%;justify-self:stretch}.dim-xiaoaiPrefixSettings .dim-botGeneralActions{justify-content:flex-start}}.dim-xiaoai details{margin-top:16px}.dim-xiaoai p{overflow-wrap:anywhere}.dim-xiaoai .ddt-actions{flex-wrap:wrap}.dim-avatarXiaoAI{color:#fff;background:linear-gradient(145deg,#5494ff,#3162df)}.dim-xiaoai .dim-emptyBrand{color:#3977ed;background:transparent}.dim-xiaoai .dim-emptyBrand svg{filter:drop-shadow(0 8px 14px #3977ed30)}'),
        h('div', { className: 'ddt-heading' }, h('div', { className: 'ddt-tools' }, h('div', { className: 'dim-bindActions' },
          h('button', { type: 'button', className: 'ddt-button dim-credentialButton', 'aria-pressed': loginOpen, onClick: () => setLoginOpen(!loginOpen) }, h(CredentialActionIcon), loginOpen ? '收起凭据' : '小米账号接入')))),
        error ? h('p', { role: 'alert' }, error) : null,
        loginOpen ? h(XiaoAILogin, { rpcCall, refresh, onCancel: () => setLoginOpen(false) }) : null,
        status && !status.bots.length && !loginOpen ? h('div', { className: 'ddt-card dim-surfaceCard' },
          h('div', { className: 'ddt-cardBody ddt-empty dim-surfaceBody dim-emptyView' },
            h('div', { className: 'dim-emptyCopy' },
              h('div', { className: 'ddt-stateLabel dim-stateLabel' }, h('span', { className: 'ddt-dot dim-stateDot' }), h('span', null, '尚未接入小爱音箱')),
              h('h3', null, '登录，创建第一个小爱入口'),
              h('p', null, '通过小米云接入原厂固件小爱音箱，并按型号选择播报接口。在音箱进入聆听后，说“让大肥鱼回答，……”即可继续同一个 DSH 会话。'),
              h('div', { className: 'ddt-actions dim-viewActions' }, button('登录小米账号', () => setLoginOpen(true), false, 'primary'))),
            h('div', { className: 'ddt-brandMark dim-emptyBrand', 'aria-hidden': true }, h(XiaoAILogo)))) : null,
        status?.bots.map(bot => h(XiaoAIDevice, { key: bot.botId, bot, rpcCall, refresh })))));
}
