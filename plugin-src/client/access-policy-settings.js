import * as React from 'react';

import {
  DEFAULT_ACCESS_POLICY,
  normalizeAccessPolicy,
  validateAccessPolicy,
} from '../../src/channels/shared/access-policy.mjs';
import { h, localizeText } from './i18n.js';
import { DINGTALK_ENDPOINTS } from './channels/dingtalk/api.js';

export const ACCESS_POLICY_ENDPOINT = 'bot.access-policy.set';
const STALE_NOTICE = '这条记录已经不存在了（可能已被处理过），列表已刷新。';
const CONFIRMED_OWNER_CHANNELS = new Set(['weixin', 'feishu', 'qq', 'whatsapp', 'discord']);

export const ACCESS_CHANNEL_DEFINITIONS = Object.freeze({
  weixin: Object.freeze({
    directUserLabel: '微信用户 ID',
    directPlaceholder: '填写微信用户 ID',
    groupSupported: false,
  }),
  feishu: Object.freeze({
    directUserLabel: '飞书 Open ID',
    directPlaceholder: '填写使用者的 Open ID（ou_xxx），不是机器人 ID',
    groupUserLabel: '群成员 Open ID',
    groupPlaceholder: '填写使用者的 Open ID（ou_xxx），不是机器人 ID',
  }),
  dingtalk: Object.freeze({
    directUserLabel: '钉钉用户 ID',
    directPlaceholder: '填写 senderStaffId 或 senderId',
    groupUserLabel: '群成员用户 ID',
    groupPlaceholder: '填写 senderStaffId 或 senderId',
  }),
  wecom: Object.freeze({
    directUserLabel: '企业微信用户 ID',
    directPlaceholder: '填写 userid',
    groupUserLabel: '群成员用户 ID',
    groupPlaceholder: '填写 userid',
  }),
  wecomApp: Object.freeze({
    directUserLabel: '企业微信用户 ID',
    directPlaceholder: '填写 userid',
    groupUserLabel: '群成员用户 ID',
    groupPlaceholder: '填写 userid',
  }),
  qq: Object.freeze({
    directUserLabel: 'QQ User Open ID',
    directPlaceholder: '填写 user_openid',
    groupUserLabel: '群成员 Open ID',
    groupPlaceholder: '填写 member_openid',
  }),
  slack: Object.freeze({
    directUserLabel: 'Slack User ID',
    directPlaceholder: 'U0123456789',
    groupUserLabel: '群成员 User ID',
    groupPlaceholder: 'U0123456789',
  }),
  telegram: Object.freeze({
    directUserLabel: 'Telegram User ID',
    directPlaceholder: '填写数字 User ID',
    groupUserLabel: '群成员 User ID',
    groupPlaceholder: '填写数字 User ID',
  }),
  discord: Object.freeze({
    directUserLabel: 'Discord User ID',
    directPlaceholder: '填写数字 User ID',
    groupUserLabel: '群成员 User ID',
    groupPlaceholder: '填写数字 User ID',
  }),
  whatsapp: Object.freeze({
    directUserLabel: 'WhatsApp 电话号码或 JID',
    directPlaceholder: '8613800000000 或完整 JID',
    groupUserLabel: '群成员电话号码或 JID',
    groupPlaceholder: '8613800000000 或完整 JID',
  }),
  imessage: Object.freeze({
    directUserLabel: 'iMessage Chat GUID',
    directPlaceholder: 'iMessage;+;chat123',
    groupSupported: false,
  }),
});

function clonePolicy(policy) {
  const cloneScope = (scope) => ({
    mode: scope.mode,
    open: {
      defaultCanExecuteCommands: scope.open.defaultCanExecuteCommands,
      commandPermissionOverrides: scope.open.commandPermissionOverrides.map((user) => ({
        ...user,
      })),
    },
    allowlist: {
      users: scope.allowlist.users.map((user) => ({ ...user })),
    },
  });
  return {
    direct: cloneScope(policy.direct),
    group: cloneScope(policy.group),
  };
}

function unwrapRpcResult(result) {
  if (result?.ok === true) return result.value;
  if (result?.ok === false) {
    const error = new Error(result.error?.message || '访问设置保存失败，请稍后重试。');
    error.code = result.error?.code;
    throw error;
  }
  return result;
}

function policyFromSnapshot(value, botId) {
  const source = value?.snapshot ?? value;
  const bot = Array.isArray(source?.bots)
    ? source.bots.find((entry) => entry?.botId === botId)
    : null;
  return normalizeAccessPolicy(bot?.accessPolicy ?? source?.accessPolicy ?? source?.policy);
}

function commandValue(value) {
  return value === 'allow';
}

function ScenePolicyEditor({
  scene,
  title,
  policy,
  userLabel,
  placeholder,
  disabled = false,
  unsupported = false,
  ownerHelp,
  identityHelp,
  onChange,
}) {
  const ownerHelpId = React.useId();
  const emptyAllowlistHelpId = React.useId();
  const allowlist = policy.mode === 'allowlist';
  const collectionKey = allowlist ? 'users' : 'commandPermissionOverrides';
  const branchKey = allowlist ? 'allowlist' : 'open';
  const users = policy[branchKey][collectionKey];
  const emptyAllowlist = allowlist && users.length === 0;
  const updateUsers = (nextUsers) => onChange({
    ...policy,
    [branchKey]: {
      ...policy[branchKey],
      [collectionKey]: nextUsers,
    },
  });
  const updateUser = (index, patch) => updateUsers(users.map((user, userIndex) => (
      userIndex === index ? { ...user, ...patch } : user
    )));

  return h('fieldset', {
    className: 'dim-accessScene',
    disabled,
    'data-scene': scene,
    'aria-label': localizeText(title),
  },
  h('legend', null,
    h('span', { className: 'dim-accessLegendContent' },
      h('span', null, title),
      h('span', { className: 'dim-channelHelp dim-accessLegendHelp' },
        h('button', {
          type: 'button',
          className: 'dim-channelHelpButton',
          'aria-label': [localizeText(title), localizeText('查看访问权限说明')].join(' '),
          'aria-describedby': ownerHelpId,
        }, h('span', { 'aria-hidden': true }, '?')),
        h('span', {
          id: ownerHelpId,
          className: 'dim-channelTooltip dim-accessHelpTooltip',
          role: 'tooltip',
        }, ownerHelp, identityHelp ? h('br') : null, identityHelp)))),
  unsupported
    ? h('div', { className: 'dim-accessUnsupported', role: 'note' },
        h('strong', null, '当前渠道不支持群聊'),
        h('p', null, '此区域无需配置，保存私聊设置时会保留现有群聊策略。'))
    : h(React.Fragment, null,
        h('div', { className: 'dim-accessControls', 'data-mode': policy.mode },
          h('label', { className: 'dim-accessField' },
            h('span', null, '访问模式'),
            h('select', {
              value: policy.mode,
              'aria-label': [localizeText(title), localizeText('访问模式')].join(' '),
              onChange: (event) => onChange({ ...policy, mode: event.target.value }),
            },
            h('option', { value: 'open' }, '允许所有用户'),
            h('option', { value: 'allowlist' }, '仅白名单用户'))),
          allowlist ? null : h('label', { className: 'dim-accessField' },
              h('span', null, '默认命令权限'),
              h('select', {
                value: policy.open.defaultCanExecuteCommands ? 'allow' : 'deny',
                'aria-label': [localizeText(title), localizeText('默认命令权限')].join(' '),
                onChange: (event) => onChange({
                  ...policy,
                  open: {
                    ...policy.open,
                    defaultCanExecuteCommands: commandValue(event.target.value),
                  },
                }),
              },
              h('option', { value: 'allow' }, '可以执行命令'),
              h('option', { value: 'deny' }, '不可以执行命令')))),
        h('div', { className: 'dim-accessUsers' },
          h('div', { className: 'dim-accessUsersHeading' },
            h('div', { className: 'dim-accessUsersTitle' },
              h('strong', null, allowlist ? '白名单用户' : '命令权限例外'),
              emptyAllowlist
                ? h('span', { className: 'dim-channelHelp dim-accessUsersHelp' },
                    h('button', {
                      type: 'button',
                      className: 'dim-channelHelpButton',
                      'aria-label': [localizeText(title), localizeText('查看白名单说明')].join(' '),
                      'aria-describedby': emptyAllowlistHelpId,
                    }, h('span', { 'aria-hidden': true }, '?')),
                    h('span', {
                      id: emptyAllowlistHelpId,
                      className: 'dim-channelTooltip dim-accessEmptyAllowlistTooltip',
                      role: 'tooltip',
                    }, '当前没有白名单用户，保存后普通用户将无法使用机器人。'))
                : null),
            h('button', {
              type: 'button',
              className: 'dim-deliveryButton dim-accessAddUser',
              'aria-label': [localizeText(title), localizeText('新增用户')].join(' '),
              title: localizeText('新增用户'),
              onClick: () => updateUsers([...users, {
                id: '',
                canExecuteCommands: allowlist
                  ? false
                  : !policy.open.defaultCanExecuteCommands,
              }]),
            }, h('span', { 'aria-hidden': true }, '+'))),
          users.length === 0
            ? h('div', { className: 'dim-accessUsersEmpty' }, '尚未添加用户')
            : h('ul', { className: 'dim-accessUserList' }, users.map((user, index) =>
                h('li', { key: `${scene}-${policy.mode}-${index}`, className: 'dim-accessUserRow' },
                  h('label', { className: 'dim-accessField dim-accessUserId' },
                    h('span', null, userLabel),
                    h('input', {
                      value: user.id,
                      maxLength: 256,
                      required: true,
                      autoCapitalize: 'none',
                      autoCorrect: 'off',
                      spellCheck: false,
                      placeholder,
                      'aria-label': [localizeText(title), localizeText(userLabel), index + 1].join(' '),
                      onChange: (event) => updateUser(index, { id: event.target.value }),
                    })),
                  h('label', { className: 'dim-accessField dim-accessUserCommand' },
                    h('span', null, '命令权限'),
                    h('select', {
                      value: user.canExecuteCommands ? 'allow' : 'deny',
                      'aria-label': [
                        localizeText(title), localizeText('用户'), index + 1,
                        localizeText('命令权限'),
                      ].join(' '),
                      onChange: (event) => updateUser(index, {
                        canExecuteCommands: commandValue(event.target.value),
                      }),
                    },
                    h('option', { value: 'allow' }, '可以执行命令'),
                    h('option', { value: 'deny' }, '不可以执行命令'))),
                  h('button', {
                    type: 'button',
                    className: 'dim-deliveryButton dim-accessDeleteUser',
                    'data-kind': 'danger',
                    'aria-label': [
                      localizeText(title), localizeText('删除'),
                      localizeText('用户'), index + 1,
                    ].join(' '),
                    onClick: () => updateUsers(users.filter((_, userIndex) => userIndex !== index)),
                  }, '删除')))))));
}

export function AccessPolicySettingsPage({ channel, account, rpcCall, onSaved }) {
  const definition = ACCESS_CHANNEL_DEFINITIONS[channel];
  const ownerHelp = CONFIRMED_OWNER_CHANNELS.has(channel)
    ? '已由接入流程确认的所有者可以访问并执行命令，不受本页限制。未识别到所有者身份时，按本页访问设置执行。'
    : '原所有者或扫码接入者始终可以访问并执行命令；以下设置仅约束其他用户。';
  const identityHelp = channel === 'feishu'
    ? '白名单请填写使用者的 Open ID，不是机器人的 Open ID。仅保存通配符的接入配置不包含所有者身份。'
    : null;
  const initialPolicy = normalizeAccessPolicy(account?.accessPolicy);
  const initialKey = JSON.stringify(initialPolicy);
  const [draft, setDraft] = React.useState(() => clonePolicy(
    initialPolicy ?? DEFAULT_ACCESS_POLICY,
  ));
  const [saving, setSaving] = React.useState(false);
  const [feedback, setFeedback] = React.useState(null);
  // 被访问策略拦下的人：桥接层记进 pendingSenders，这里逐个放行。
  const [pendingSenders, setPendingSenders] = React.useState([]);
  const [approvedSenders, setApprovedSenders] = React.useState([]);
  const [pendingLoading, setPendingLoading] = React.useState(channel === 'dingtalk');
  const [approvingId, setApprovingId] = React.useState(null);
  const [removingId, setRemovingId] = React.useState(null);
  const [pendingFeedback, setPendingFeedback] = React.useState(null);

  const refreshPolicyFromServer = async () => {
    try {
      const result = await rpcCall('connection.status', {});
      const bot = result?.value?.bots?.find((entry) => entry.botId === account?.botId);
      const refreshed = normalizeAccessPolicy(bot?.accessPolicy);
      if (refreshed) {
        setDraft(clonePolicy(refreshed));
        onSaved?.(refreshed);
      }
    } catch {
      // 读不到就保持当前草稿，用户可手动刷新。
    }
  };

  const loadPendingSenders = React.useCallback(async () => {
    if (channel !== 'dingtalk') return;
    try {
      const result = await rpcCall('connection.status', {});
      if (result?.ok !== true) throw new Error(result?.error?.message || '无法读取被拦截的用户。');
      const bot = result.value?.bots?.find((entry) => entry.botId === account?.botId);
      setPendingSenders(Array.isArray(bot?.senders?.pending) ? bot.senders.pending : []);
      setApprovedSenders(Array.isArray(bot?.senders?.approved) ? bot.senders.approved : []);
    } catch (error) {
      setPendingFeedback(error.message);
    } finally {
      setPendingLoading(false);
    }
  }, [channel, account?.botId, rpcCall]);

  React.useEffect(() => { void loadPendingSenders(); }, [loadPendingSenders]);

  // 上游要求原始 staffId 只留在宿主侧，所以这里只把不透明的 requestId 交回去，
  // 由宿主完成放行（加入该机器人的已批准名单）。
  const allowPendingSender = async (sender) => {
    if (approvingId || !sender?.requestId) return;
    setApprovingId(sender.requestId);
    setPendingFeedback(null);
    try {
      const result = await rpcCall(DINGTALK_ENDPOINTS.allowSender, {
        botId: account.botId, requestId: sender.requestId, confirm: true,
      });
      if (result?.ok !== true) {
        const code = result?.error?.code;
        if (code === 'sender-allow-failed' || code === 'sender-request-not-found') {
          await Promise.all([loadPendingSenders(), refreshPolicyFromServer()]);
          setFeedback({ tone: 'success', message: STALE_NOTICE });
          return;
        }
        throw new Error(result?.error?.message || '允许失败，请重试。');
      }
      // 以服务端返回为准刷新：senderKey 是宿主生成的，前端不能自己编。
      await Promise.all([loadPendingSenders(), refreshPolicyFromServer()]);
      setFeedback({ tone: 'success', message: '已允许该用户，下一条消息会正常回答。' });
    } catch (error) {
      setPendingFeedback(error.message);
    } finally {
      setApprovingId(null);
    }
  };

  const removeApprovedSender = async (sender) => {
    if (removingId) return;
    // 没有 senderKey 就不要静默失败：旧数据或读取失败时给出明确提示。
    if (!sender?.senderKey) {
      setPendingFeedback('这条记录缺少身份标识（可能是旧版本留下的数据）。请刷新页面后重试；仍然失败就重启一次应用。');
      return;
    }
    setRemovingId(sender.senderKey);
    setPendingFeedback(null);
    try {
      const result = await rpcCall(DINGTALK_ENDPOINTS.removeApproved, {
        botId: account.botId, senderKey: sender.senderKey, confirm: true,
      });
      if (result?.ok !== true) {
        const code = result?.error?.code;
        if (code === 'sender-remove-failed' || code === 'approved-sender-not-found') {
          // 记录已经不在了：刷新列表即可，不要拿它当错误吓人。
          await Promise.all([loadPendingSenders(), refreshPolicyFromServer()]);
          setFeedback({ tone: 'success', message: STALE_NOTICE });
          return;
        }
        const fallback = '移除失败，请重试。';
        throw new Error(code
          ? `${result?.error?.message || fallback} [${code}]`
          : (result?.error?.message || fallback));
      }
      await Promise.all([loadPendingSenders(), refreshPolicyFromServer()]);
      setFeedback({ tone: 'success', message: '已移除该用户，之后发消息会被重新拦截。' });
    } catch (error) {
      setPendingFeedback(error.message);
    } finally {
      setRemovingId(null);
    }
  };

  const save = async (event) => {
    event.preventDefault();
    setFeedback(null);
    setSaving(true);
    try {
      const policy = validateAccessPolicy(draft);
      if (typeof rpcCall !== 'function') throw new Error('访问设置暂不可用。');
      const value = unwrapRpcResult(await rpcCall(ACCESS_POLICY_ENDPOINT, {
        botId: account.botId,
        policy,
      }));
      const saved = policyFromSnapshot(value, account.botId);
      if (!saved) throw new Error('服务没有返回已保存的访问策略，请刷新后重试。');
      setDraft(clonePolicy(saved));
      onSaved?.(saved);
      setFeedback({ tone: 'success', message: '访问设置已保存。' });
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: error?.message || '访问设置保存失败，请稍后重试。',
      });
    } finally {
      setSaving(false);
    }
  };

  return h('form', {
    className: 'dim-accessPage',
    onSubmit: (event) => void save(event),
  },
  initialPolicy
    ? null
    : h('div', { className: 'dim-accessState', role: 'alert' },
        '访问策略尚未就绪，请返回机器人列表刷新后重试。'),
  h(ScenePolicyEditor, {
    scene: 'direct',
    title: '私聊',
    policy: draft.direct,
    userLabel: definition.directUserLabel,
    placeholder: definition.directPlaceholder,
    ownerHelp,
    identityHelp,
    disabled: saving,
    onChange: (direct) => { setDraft((current) => ({ ...current, direct })); setFeedback(null); },
  }),
  h(ScenePolicyEditor, {
    scene: 'group',
    title: '群聊',
    policy: draft.group,
    userLabel: definition.groupUserLabel ?? definition.directUserLabel,
    placeholder: definition.groupPlaceholder ?? definition.directPlaceholder,
    ownerHelp,
    identityHelp: channel === 'qq'
      ? '扫码获得的是私聊身份，群聊只有匹配已确认的所有者身份时才豁免；其他成员按群聊白名单设置执行。'
      : identityHelp,
    disabled: saving || definition.groupSupported === false,
    unsupported: definition.groupSupported === false,
    onChange: (group) => { setDraft((current) => ({ ...current, group })); setFeedback(null); },
  }),
  channel === 'dingtalk' ? h('fieldset', {
    className: 'dim-accessScene',
    'data-scene': 'denied',
    'aria-label': localizeText('被拦截的用户'),
  },
  h('legend', null,
    h('span', { className: 'dim-accessLegendContent' },
      h('span', null, '被拦截的用户'))),
  h('p', { className: 'dim-accessHint' },
    '不在白名单、私聊过机器人的人。允许后会加入白名单，下一次消息就能正常回答。'),
  pendingLoading
    ? h('div', { className: 'dim-accessState' }, '正在读取…')
    : pendingSenders.length === 0
      ? h('div', { className: 'dim-accessUsersEmpty' }, '暂无被拦截的用户')
      : h('ul', { className: 'dim-accessUserList' }, pendingSenders.map((sender) => h('li', {
          key: sender.requestId,
          className: 'dim-accessDeniedRow',
        },
          h('div', { className: 'dim-accessDeniedName' },
            h('strong', null, sender.displayName || '钉钉用户'),
            h('code', null, sender.senderIdMasked)),
          h('button', {
            type: 'button',
            className: 'dim-deliveryButton',
            disabled: approvingId !== null,
            onClick: () => void allowPendingSender(sender),
          }, approvingId === sender.requestId ? '正在允许…' : '允许')))),
  pendingFeedback ? h('p', {
    className: 'dim-accessFeedback', 'data-tone': 'error', role: 'alert',
  }, pendingFeedback) : null,
  approvedSenders.length === 0 ? null : h('fieldset', {
    className: 'dim-accessScene',
    'data-scene': 'approved',
    'aria-label': localizeText('已批准的用户'),
  },
  h('legend', null,
    h('span', { className: 'dim-accessLegendContent' },
      h('span', null, '已批准的用户'))),
  h('ul', { className: 'dim-accessUserList' }, approvedSenders.map((sender) => h('li', {
    key: sender.senderKey ?? sender.senderIdMasked,
    className: 'dim-accessDeniedRow',
  },
    h('div', { className: 'dim-accessDeniedName' },
      h('strong', null, sender.displayName || '钉钉用户'),
      h('code', null, sender.senderIdMasked)),
    h('button', {
      type: 'button',
      className: 'dim-deliveryButton',
      disabled: removingId !== null,
      onClick: () => void removeApprovedSender(sender),
    }, removingId === sender.senderKey ? '正在移除…' : '移除')))))) : null,
  feedback ? h('p', {
    className: 'dim-accessFeedback',
    'data-tone': feedback.tone,
    role: feedback.tone === 'error' ? 'alert' : 'status',
    'aria-live': 'polite',
  }, feedback.message) : null,
  h('div', { className: 'dim-accessActions' },
    h('button', {
      type: 'submit',
      className: 'dim-deliveryButton',
      'data-kind': 'primary',
      disabled: saving || !initialPolicy,
    }, saving ? '正在保存…' : '保存访问设置')));
}
