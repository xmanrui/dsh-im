import * as React from 'react';

import {
  DEFAULT_ACCESS_POLICY,
  normalizeAccessPolicy,
  validateAccessPolicy,
} from '../../src/channels/shared/access-policy.mjs';
import {
  COMMAND_PERMISSION_GROUPS,
  COMMAND_PERMISSION_IDS,
  commandsForPermissionChannel,
} from '../../src/channels/shared/command-permission-catalog.mjs';
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

function copyCommands(commands) {
  return Array.isArray(commands) ? [...commands] : undefined;
}

function clonePolicy(policy) {
  const cloneScope = (scope) => {
    const open = {
      defaultCanExecuteCommands: scope.open.defaultCanExecuteCommands,
      commandPermissionOverrides: scope.open.commandPermissionOverrides.map((user) => ({
        ...user,
        ...(Array.isArray(user.allowedCommands)
          ? { allowedCommands: [...user.allowedCommands] } : {}),
      })),
    };
    const defaultAllowedCommands = copyCommands(scope.open.defaultAllowedCommands);
    if (defaultAllowedCommands) open.defaultAllowedCommands = defaultAllowedCommands;
    const allowlist = {
      users: scope.allowlist.users.map((user) => ({
        ...user,
        ...(Array.isArray(user.allowedCommands)
          ? { allowedCommands: [...user.allowedCommands] } : {}),
      })),
    };
    const nonAllowlistedAllowedCommands = copyCommands(scope.allowlist.nonAllowlistedAllowedCommands);
    if (nonAllowlistedAllowedCommands) {
      allowlist.nonAllowlistedAllowedCommands = nonAllowlistedAllowedCommands;
    }
    return { mode: scope.mode, open, allowlist };
  };
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

function userPermissionValue(user) {
  if (user?.canExecuteCommands === false) return 'deny';
  return Array.isArray(user?.allowedCommands) ? 'custom' : 'allow';
}

function withUserPermissionValue(user, value) {
  if (value === 'deny') {
    const next = { ...user, canExecuteCommands: false };
    delete next.allowedCommands;
    return next;
  }
  if (value === 'custom') {
    return {
      ...user,
      canExecuteCommands: true,
      allowedCommands: Array.isArray(user.allowedCommands) ? [...user.allowedCommands] : [],
    };
  }
  const next = { ...user, canExecuteCommands: true };
  delete next.allowedCommands;
  return next;
}

function defaultPermissionValue(policy) {
  if (policy.open.defaultCanExecuteCommands === false) return 'deny';
  return Array.isArray(policy.open.defaultAllowedCommands) ? 'custom' : 'allow';
}

function withDefaultPermissionValue(policy, value) {
  const open = { ...policy.open };
  if (value === 'deny') {
    open.defaultCanExecuteCommands = false;
    delete open.defaultAllowedCommands;
  } else if (value === 'custom') {
    open.defaultCanExecuteCommands = true;
    open.defaultAllowedCommands = Array.isArray(policy.open.defaultAllowedCommands)
      ? [...policy.open.defaultAllowedCommands] : [];
  } else {
    open.defaultCanExecuteCommands = true;
    delete open.defaultAllowedCommands;
  }
  return { ...policy, open };
}

function otherUsersPermissionValue(policy) {
  return Array.isArray(policy.allowlist.nonAllowlistedAllowedCommands) ? 'custom' : 'none';
}

function withOtherUsersPermissionValue(policy, value) {
  const allowlist = { ...policy.allowlist };
  if (value === 'custom') {
    allowlist.nonAllowlistedAllowedCommands = Array.isArray(policy.allowlist.nonAllowlistedAllowedCommands)
      ? [...policy.allowlist.nonAllowlistedAllowedCommands] : [];
  } else {
    delete allowlist.nonAllowlistedAllowedCommands;
  }
  return { ...policy, allowlist };
}

function CommandPicker({
  selected,
  onChange,
  disabled = false,
  label,
  channel,
}) {
  const selectedSet = new Set(Array.isArray(selected) ? selected : []);
  const order = COMMAND_PERMISSION_IDS;
  const setCommands = (nextSet) => onChange(order.filter((id) => nextSet.has(id)));
  const toggle = (id, checked) => {
    const next = new Set(selectedSet);
    if (checked) next.add(id); else next.delete(id);
    setCommands(next);
  };
  return h('div', {
    className: 'dim-accessCommandPicker',
    'data-role': 'command-picker',
    'aria-label': [label, localizeText('命令选择')].join(' '),
  },
  h('div', { className: 'dim-accessCommandPickerHead' },
    h('span', { className: 'dim-accessCommandCount' },
      selectedSet.size === 0
        ? localizeText('已选择 0 个命令（等于禁止全部命令）')
        : localizeTemplate('已选择 {count} 个命令', { count: selectedSet.size })),
    h('div', { className: 'dim-accessCommandPickerActions' },
      h('button', {
        type: 'button',
        className: 'dim-deliveryButton dim-accessCommandBulk',
        disabled,
        onClick: () => setCommands(new Set(COMMAND_PERMISSION_IDS)),
      }, localizeText('全选')),
      h('button', {
        type: 'button',
        className: 'dim-deliveryButton dim-accessCommandBulk',
        disabled,
        onClick: () => setCommands(new Set()),
      }, localizeText('清空')))),
  commandsForPermissionChannel(channel).map((group) => h('fieldset', {
    key: group.id,
    className: 'dim-accessCommandGroup',
  },
  h('legend', null, localizeText(group.label)),
  h('div', { className: 'dim-accessCommandGroupGrid' }, group.commands.map((command) => h('label', {
    key: command.id,
    className: 'dim-accessCommandOption',
  },
  h('input', {
    type: 'checkbox',
    checked: selectedSet.has(command.id),
    disabled,
    'aria-label': `${label} /${command.id}`,
    onChange: (event) => toggle(command.id, event.target.checked),
  }),
  h('span', null, `/${command.id}`)))))));
}

function CommandPermissionField({
  value,
  onChange,
  disabled,
  ariaLabel,
  allowAll = true,
}) {
  return h('label', { className: 'dim-accessField dim-accessUserCommand' },
    h('span', null, '命令权限'),
    h('select', {
      value,
      disabled,
      'aria-label': ariaLabel,
      onChange: (event) => onChange(event.target.value),
    },
    allowAll ? h('option', { value: 'allow' }, localizeText('全部命令')) : null,
    h('option', { value: 'custom' }, localizeText('仅指定命令')),
    h('option', { value: 'deny' }, localizeText('禁止命令'))));
}

function OtherUsersCommandEditor({
  title,
  policy,
  onChange,
  disabled = false,
  channel,
}) {
  const value = otherUsersPermissionValue(policy);
  const modeLabel = [localizeText(title), localizeText('非白名单用户命令权限')].join(' ');
  const pickerLabel = [localizeText(title), localizeText('非白名单用户命令')].join(' ');
  return h('div', { className: 'dim-accessOtherUsers' },
    h('div', { className: 'dim-accessOtherUsersHeading' },
      h('strong', null, localizeText('非白名单用户')),
      h('p', null, localizeText('非白名单用户不能发送普通消息；只有勾选的命令可以被执行。'))),
    h('label', { className: 'dim-accessField dim-accessOtherUsersMode' },
      h('span', null, localizeText('非白名单用户命令权限')),
      h('select', {
        value,
        disabled,
        'aria-label': modeLabel,
        onChange: (event) => onChange(withOtherUsersPermissionValue(policy, event.target.value)),
      },
      h('option', { value: 'none' }, localizeText('禁止执行命令')),
      h('option', { value: 'custom' }, localizeText('仅可执行指定命令')))),
    value === 'custom'
      ? h(CommandPicker, {
          selected: policy.allowlist.nonAllowlistedAllowedCommands,
          onChange: (commands) => onChange({
            ...policy,
            allowlist: { ...policy.allowlist, nonAllowlistedAllowedCommands: commands },
          }),
          disabled,
          label: pickerLabel,
          channel,
        })
      : null);
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
  channel,
}) {
  const ownerHelpId = React.useId();
  const emptyAllowlistHelpId = React.useId();
  const allowlist = policy.mode === 'allowlist';
  const collectionKey = allowlist ? 'users' : 'commandPermissionOverrides';
  const branchKey = allowlist ? 'allowlist' : 'open';
  const users = policy[branchKey][collectionKey];
  const emptyAllowlist = allowlist && users.length === 0;
  const hasNonAllowlistedCommands = Array.isArray(policy.allowlist.nonAllowlistedAllowedCommands)
    && policy.allowlist.nonAllowlistedAllowedCommands.length > 0;
  const emptyAllowlistHelp = hasNonAllowlistedCommands
    ? '当前没有白名单用户；非白名单用户只能执行已配置的命令。'
    : '当前没有白名单用户，保存后普通用户将无法使用机器人。';
  const updateUsers = (nextUsers) => onChange({
    ...policy,
    [branchKey]: {
      ...policy[branchKey],
      [collectionKey]: nextUsers,
    },
  });
  const updateUser = (index, nextUser) => updateUsers(users.map((user, userIndex) => (
    userIndex === index ? nextUser : user
  )));
  const defaultMode = defaultPermissionValue(policy);
  const sceneDisabled = disabled;

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
          allowlist ? null : h(CommandPermissionField, {
            value: defaultMode,
            onChange: (value) => onChange(withDefaultPermissionValue(policy, value)),
            disabled: sceneDisabled,
            ariaLabel: [localizeText(title), localizeText('默认命令权限')].join(' '),
          })),
        !allowlist && defaultMode === 'custom'
          ? h('div', { className: 'dim-accessDefaultCommands' },
              h('p', { className: 'dim-accessDefaultHint' },
                localizeText('默认命令权限作用于未单独列出的用户（非白名单用户）。')),
              h(CommandPicker, {
                selected: policy.open.defaultAllowedCommands,
                onChange: (commands) => onChange({
                  ...policy,
                  open: { ...policy.open, defaultAllowedCommands: commands },
                }),
                disabled: sceneDisabled,
                label: [localizeText(title), localizeText('默认命令权限')].join(' '),
                channel,
              }))
          : null,
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
                    }, emptyAllowlistHelp))
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
            : h('ul', { className: 'dim-accessUserList' }, users.map((user, index) => {
                const value = userPermissionValue(user);
                return h('li', { key: `${scene}-${policy.mode}-${index}`, className: 'dim-accessUserRow' },
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
                      onChange: (event) => updateUser(index, { ...user, id: event.target.value }),
                    })),
                  h(CommandPermissionField, {
                    value,
                    disabled: sceneDisabled,
                    ariaLabel: [
                      localizeText(title), localizeText('用户'), index + 1,
                      localizeText('命令权限'),
                    ].join(' '),
                    onChange: (nextValue) => updateUser(index, withUserPermissionValue(user, nextValue)),
                  }),
                  h('button', {
                    type: 'button',
                    className: 'dim-deliveryButton dim-accessDeleteUser',
                    'data-kind': 'danger',
                    'aria-label': [
                      localizeText(title), localizeText('删除'),
                      localizeText('用户'), index + 1,
                    ].join(' '),
                    onClick: () => updateUsers(users.filter((_, userIndex) => userIndex !== index)),
                  }, '删除'),
                  value === 'custom'
                    ? h('div', { className: 'dim-accessUserCommandPicker' },
                        h(CommandPicker, {
                          selected: user.allowedCommands,
                          onChange: (commands) => updateUser(index, {
                            ...user,
                            canExecuteCommands: true,
                            allowedCommands: commands,
                          }),
                          disabled: sceneDisabled,
                          label: [
                            localizeText(title), localizeText('用户'), index + 1,
                            localizeText('命令权限'),
                          ].join(' '),
                          channel,
                        }))
                    : null);
              })),
          allowlist && !unsupported
            ? h(OtherUsersCommandEditor, {
                title,
                policy,
                onChange,
                disabled: sceneDisabled,
                channel,
              })
            : null)));
}

export function AccessPolicySettingsPage({ channel, account, rpcCall, onSaved }) {
  const definition = ACCESS_CHANNEL_DEFINITIONS[channel];
  const ownerHelp = CONFIRMED_OWNER_CHANNELS.has(channel)
    ? '已由接入流程确认的所有者可以访问并执行命令，不受本页限制。未识别到所有者身份时，按本页访问设置执行。'
    : '原所有者或扫码接入者始终可以访问并执行命令；以下设置仅约束其他用户。';
  const identityHelp = channel === 'feishu'
    ? '白名单请填写使用者的 Open ID，不是机器人的 Open ID。仅保存通配符的接入配置不包含所有者身份。'
    : null;
  const commandChannel = channel === 'wecomApp' ? 'wecom-app' : channel;
  const initialPolicy = normalizeAccessPolicy(account?.accessPolicy);
  const initialKey = JSON.stringify(initialPolicy);
  const [draft, setDraft] = React.useState(() => clonePolicy(
    initialPolicy ?? DEFAULT_ACCESS_POLICY,
  ));
  const [saving, setSaving] = React.useState(false);
  const [feedback, setFeedback] = React.useState(null);
  const [recoverInvalidPolicy, setRecoverInvalidPolicy] = React.useState(false);
  const canSave = Boolean(initialPolicy) || recoverInvalidPolicy;

  React.useEffect(() => {
    const next = normalizeAccessPolicy(account?.accessPolicy);
    setDraft(clonePolicy(next ?? DEFAULT_ACCESS_POLICY));
    setRecoverInvalidPolicy(false);
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
    if (!canSave) return;
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
  initialPolicy || recoverInvalidPolicy
    ? null
    : h('div', { className: 'dim-accessState', role: 'alert' },
        h('span', null, '访问策略尚未就绪，请返回机器人列表刷新后重试。'),
        h('button', {
          type: 'button',
          className: 'dim-deliveryButton dim-accessRecoverPolicy',
          onClick: () => {
            setDraft(clonePolicy(DEFAULT_ACCESS_POLICY));
            setRecoverInvalidPolicy(true);
          },
        }, localizeText('使用默认访问策略'))),
  h(ScenePolicyEditor, {
    scene: 'direct',
    title: '私聊',
    policy: draft.direct,
    userLabel: definition.directUserLabel,
    placeholder: definition.directPlaceholder,
    ownerHelp,
    identityHelp,
    disabled: saving,
    channel: commandChannel,
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
    channel: commandChannel,
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
      disabled: saving || !canSave,
    }, saving ? '正在保存…' : '保存访问设置')));
}
