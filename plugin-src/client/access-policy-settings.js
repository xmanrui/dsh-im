import * as React from 'react';

import {
  DEFAULT_ACCESS_POLICY,
  normalizeAccessPolicy,
  validateAccessPolicy,
} from '../../src/channels/shared/access-policy.mjs';
import { h, localizeText, localizeTemplate } from './i18n.js';

export const ACCESS_POLICY_ENDPOINT = 'bot.access-policy.set';
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

const DEFAULT_COMMAND_ALLOWLIST = Object.freeze(['new', 'stop', 'help', 'status', 'compact', 'clear']);

const COMMAND_CHOICES = Object.freeze([
  ['new', '/new 新会话'],
  ['stop', '/stop 停止任务'],
  ['help', '/help 帮助'],
  ['status', '/status 连接状态'],
  ['compact', '/compact 压缩上下文'],
  ['clear', '/clear 清空上下文'],
  ['menu', '/m 或 /menu 菜单'],
  ['version', '/version 版本'],
  ['models', '/models 模型列表'],
  ['model', '/model 模型切换'],
  ['reasoninglist', '/reasonings 推理等级'],
  ['reasoning', '/reasoning 推理等级切换'],
  ['presetlist', '/presets 预设列表'],
  ['preset', '/preset 预设切换'],
  ['permissionlist', '/permissionlist 权限列表'],
  ['permission', '/permission 权限切换'],
  ['history', '/history 历史消息'],
  ['workspace', '/workspace 工作区'],
  ['workspacelist', '/workspaces 工作区列表'],
  ['sessionlist', '/sessionlist 会话列表'],
  ['session', '/session 绑定会话'],
  ['batch', '/batch 批量输入'],
  ['send', '/send 发送批量'],
  ['cancel', '/cancel 取消批量'],
  ['steer', '/steer 补充指令'],
  ['repair', '/repair 修复'],
]);

function clonePolicy(policy) {
  const cloneScope = (scope) => ({
    mode: scope.mode,
    open: {
      defaultCanExecuteCommands: scope.open.defaultCanExecuteCommands,
      commandPermissionOverrides: scope.open.commandPermissionOverrides.map((user) => ({
        ...user,
        ...(user.commandAllowlist === undefined ? {} : { commandAllowlist: [...user.commandAllowlist] }),
      })),
      ...(scope.open.commandAllowlist === undefined ? {} : { commandAllowlist: [...scope.open.commandAllowlist] }),
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
  const [commandPickerOpen, setCommandPickerOpen] = React.useState(false);
  const [commandQuery, setCommandQuery] = React.useState('');
  const commandMode = policy.open.defaultCanExecuteCommands
    ? 'allow'
    : (policy.open.commandAllowlist?.length ? 'custom' : 'deny');
  const allowedCommands = new Set(policy.open.commandAllowlist ?? []);
  const updateOpen = (patch) => onChange({
    ...policy,
    open: { ...policy.open, ...patch },
  });
  const changeCommandMode = (nextMode) => {
    if (nextMode === 'allow') {
      updateOpen({ defaultCanExecuteCommands: true, commandAllowlist: undefined });
      setCommandPickerOpen(false);
      return;
    }
    if (nextMode === 'custom') {
      updateOpen({
        defaultCanExecuteCommands: false,
        commandAllowlist: policy.open.commandAllowlist?.length
          ? [...policy.open.commandAllowlist]
          : [...DEFAULT_COMMAND_ALLOWLIST],
      });
      return;
    }
    updateOpen({ defaultCanExecuteCommands: false, commandAllowlist: undefined });
    setCommandPickerOpen(false);
  };
  const toggleCommand = (name, checked) => {
    const next = new Set(allowedCommands);
    if (checked) next.add(name);
    else if (next.size > 1) next.delete(name);
    else return;
    updateOpen({ commandAllowlist: [...next] });
  };

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
          allowlist ? null : h(React.Fragment, null,
            h('label', { className: 'dim-accessField' },
              h('span', null, '命令权限'),
              h('select', {
                value: commandMode,
                'aria-label': [localizeText(title), localizeText('默认命令权限')].join(' '),
                onChange: (event) => changeCommandMode(event.target.value),
              },
              h('option', { value: 'deny' }, '不能执行命令'),
              h('option', { value: 'allow' }, '可以执行命令'),
              h('option', { value: 'custom' }, '可以执行指定的命令'))),
            commandMode !== 'custom' ? null : h('div', {
              className: 'dim-accessField dim-accessCommandPicker',
              style: { position: 'relative' },
            },
              h('button', {
                type: 'button',
                className: 'dim-deliveryButton',
                'aria-expanded': commandPickerOpen,
                onClick: () => setCommandPickerOpen((value) => !value),
              }, localizeTemplate('选择命令（{count}）', { count: allowedCommands.size })),
              commandPickerOpen ? h('div', {
                role: 'presentation',
                style: {
                  position: 'fixed', inset: 0, zIndex: 1000,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: 24, background: 'rgba(0, 0, 0, 0.42)',
                },
                onClick: () => setCommandPickerOpen(false),
              },
                h('div', {
                  role: 'dialog',
                  'aria-modal': 'true',
                  'aria-label': '选择允许的命令',
                  onClick: (event) => event.stopPropagation(),
                  style: {
                    width: 'min(560px, 100%)',
                    maxHeight: 'min(680px, calc(100vh - 48px))',
                    display: 'flex', flexDirection: 'column', gap: 12,
                    padding: 20, borderRadius: 14,
                    border: '1px solid var(--dsw-alias-border-l1)',
                    background: 'var(--dsw-alias-bg-overlay)',
                    color: 'var(--dsw-alias-label-primary)',
                    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.38)',
                  },
                },
                  h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 } },
                    h('div', null,
                      h('strong', { style: { fontSize: 15 } }, '选择允许的命令'),
                      h('p', { style: { margin: '4px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' } },
                        '默认勾选 new、stop、help、status、compact、clear。')),
                    h('button', {
                      type: 'button',
                      'aria-label': '关闭',
                      onClick: () => setCommandPickerOpen(false),
                      style: {
                        flex: '0 0 auto', width: 28, height: 28, padding: 0,
                        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 7,
                        background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
                        cursor: 'pointer', fontSize: 16, lineHeight: '24px',
                      },
                    }, '×')),
                  h('input', {
                    type: 'search',
                    value: commandQuery,
                    placeholder: '搜索命令…',
                    'aria-label': '搜索命令',
                    onChange: (event) => setCommandQuery(event.target.value),
                    style: {
                      width: '100%', boxSizing: 'border-box', padding: '8px 10px',
                      border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8,
                      background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
                      fontSize: 12,
                    },
                  }),
                  h('div', {
                    style: {
                      display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                      gap: 4, overflow: 'auto', paddingRight: 4,
                      flex: '1 1 auto', minHeight: 0,
                    },
                  },
                    COMMAND_CHOICES
                      .filter(([name, label]) => {
                        const query = commandQuery.trim().toLowerCase();
                        return !query || name.includes(query) || label.toLowerCase().includes(query);
                      })
                      .map(([name, label]) => {
                        const checked = allowedCommands.has(name);
                        return h('button', {
                          key: name,
                          type: 'button',
                          role: 'checkbox',
                          'aria-checked': checked,
                          onClick: () => toggleCommand(name, !checked),
                          style: {
                            display: 'flex', alignItems: 'center', gap: 8,
                            minWidth: 0, padding: '6px 8px', borderRadius: 6,
                            cursor: 'pointer', fontSize: 12, textAlign: 'left',
                            color: 'inherit',
                            border: checked ? '1px solid var(--dsw-alias-brand-primary)' : '1px solid transparent',
                            background: checked ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                          },
                        },
                          h('span', {
                            style: {
                              flex: '0 0 16px', width: 16, height: 16, lineHeight: '16px',
                              textAlign: 'center', borderRadius: 4, fontSize: 11,
                              color: checked ? '#fff' : 'transparent',
                              background: checked ? 'var(--dsw-alias-brand-primary)' : 'transparent',
                              border: checked ? 'none' : '1px solid var(--dsw-alias-border-l2)',
                            },
                          }, '✓'),
                          h('span', {
                            style: { overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' },
                          }, label));
                      })),

                  h('div', {
                    style: {
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      gap: 8, paddingTop: 4,
                    },
                  },
                    h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
                      localizeTemplate('已选 {count} 项', { count: allowedCommands.size })),
                    h('div', { style: { display: 'flex', gap: 8 } },
                      h('button', {
                        type: 'button',
                        className: 'dim-deliveryButton',
                        onClick: () => updateOpen({ commandAllowlist: [...DEFAULT_COMMAND_ALLOWLIST] }),
                      }, '恢复默认'),
                      h('button', {
                        type: 'button',
                        className: 'dim-deliveryButton',
                        onClick: () => updateOpen({ commandAllowlist: COMMAND_CHOICES.map(([name]) => name) }),
                      }, '全部命令'),
                      h('button', {
                        type: 'button',
                        className: 'dim-deliveryButton',
                        'data-kind': 'primary',
                        onClick: () => setCommandPickerOpen(false),
                      }, '完成'))))) : null)

          )),
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

  React.useEffect(() => {
    const next = normalizeAccessPolicy(account?.accessPolicy);
    setDraft(clonePolicy(next ?? DEFAULT_ACCESS_POLICY));
  }, [account?.botId, initialKey]);

  React.useEffect(() => {
    setFeedback(null);
  }, [account?.botId]);

  if (!definition) {
    return h('div', { className: 'dim-accessState', role: 'alert' },
      '当前渠道暂不支持访问设置。');
  }

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
