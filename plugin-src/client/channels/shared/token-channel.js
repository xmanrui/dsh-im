import * as React from 'react';

import { CredentialActionIcon, CredentialBindingPanel } from '../../credential-binding.js';
import { CollapsibleAccountSection } from './collapsible-account.js';
import { h } from '../../i18n.js';
import { installDingtalkStyles } from '../dingtalk/styles.js';
import { WorkspaceEditor } from '../../workspace-editor.js';
import { ContextEnhancementEditor } from '../../context-enhancement.js';
import {
  AgentPresetCatalogContext,
  AgentPresetEditor,
  EMPTY_AGENT_PRESET_CATALOG,
} from '../../agent-preset.js';
import {
  EMPTY_MODEL_CATALOG,
  ModelCatalogContext,
  ModelEditor,
} from '../../model-setting.js';
import { useWorkspaceSnapshotFence } from '../../workspace-snapshot-fence.js';
import {
  BotSettingsButton,
  BotStatusMeta,
  ChannelListHeading,
  LastMessageErrorSummary,
} from '../../channel-card-meta.js';

const Button = React.forwardRef(function Button(
  { children, kind = 'secondary', className = '', ...props },
  ref,
) {
  return h('button', {
    ...props,
    ref,
    type: 'button',
    className: `ddt-button ${className}`.trim(),
    'data-kind': kind,
  }, children);
});

function checkedTime(value) {
  if (!value) return '尚未检查';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date(value));
  } catch {
    return '刚刚';
  }
}

function connectionTestNotice(value) {
  if (value?.testMessage?.sent === true) return '测试消息已发送，请到对应机器人会话中确认。';
  if (value?.testMessage?.code === 'test-target-unavailable') {
    return '连接检查完成。机器人尚未收到可用于测试的私聊消息。';
  }
  return value?.testMessage ? '连接检查完成，但测试消息发送失败。' : null;
}

export function createTokenChannelSettings(definition) {
  const {
    channel,
    endpoints,
    api,
    LogoGlyph,
    installStyles,
    pageClass,
    avatarClass,
    connectionLabel,
    tokenPlaceholder,
    emptyTitle,
    emptyDescription,
    platformLabel,
    CredentialPanel = null,
    credentialPayload = ({ secret }) => ({ token: secret }),
    credentialAriaLabel = `使用 Bot Token 接入 ${channel} 机器人`,
    credentialOpenLabel = '手动接入',
    credentialCloseLabel = '收起凭据',
    credentialNoun = 'Bot Token',
    emptyActionLabel = '填写 Bot Token',
    AccountSettings = null,
    accountSettingsEndpoint = null,
  } = definition;

  function AccountCard({ account, busy, testNotice, removing, onReconnect, onWorkspaceSave, onModelSave, onAgentPresetSave, onContextEnhancementSave, onAccountSettingsSave, onRequestRemove, onConfirmRemove, onCancelRemove }) {
    const state = busy === 'reconnect' ? 'connecting' : account.state;
    const tone = account.connected ? 'success' : state === 'error' ? 'error' : 'warning';
    const stateLabel = account.connected ? '运行正常' : state === 'connecting' ? '正在连接' : '连接未就绪';
    const summary = account.error?.message ?? (account.connected ? null : account.health.summary);
    const identity = account.bot.username ? `@${account.bot.username}` : account.bot.idMasked;
    return h('article', { className: 'ddt-card dim-botCard', 'data-bot-id': account.botId },
      h('div', { className: 'ddt-cardBody dim-botCardBody' },
        h(CollapsibleAccountSection, {
          id: `tok-settings-${account.botId.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
          header: h('div', { className: 'ddt-accountTop dim-botCardTop' },
            h('div', { className: 'ddt-accountIdentity dim-botIdentity' },
              h('div', { className: `ddt-avatar dim-botAvatar ${avatarClass}`, 'aria-hidden': 'true' },
                h(LogoGlyph, { size: 29 })),
              h('div', { className: 'dim-botName' },
                h('h3', null, account.bot.name), h('p', null, identity))),
            h('div', {
              className: 'dim-botCardTools',
              // The header is the collapse toggle; keep inner controls clickable.
              onClick: (event) => { event.stopPropagation(); },
              onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); },
            },
              h(BotStatusMeta, {
                className: 'ddt-health',
                dotClassName: 'ddt-dot',
                tone,
                stateLabel,
                lastCheckedAt: account.health.lastCheckedAt,
                formatCheckedTime: checkedTime,
              }),
              h(BotSettingsButton, {
                channel: channel.toLowerCase(),
                botId: account.botId,
                botName: account.bot.name,
                connected: account.connected,
                accessPolicy: account.accessPolicy,
              }))),
        },
          h(WorkspaceEditor, {
            workspace: account.workspace,
            disabled: Boolean(busy),
            onSave: onWorkspaceSave,
          }),
        h(ModelEditor, {
          model: account.model,
          disabled: Boolean(busy),
          onSave: onModelSave,
        }),
        h(AgentPresetEditor, {
          agentPreset: account.agentPreset,
          disabled: Boolean(busy),
          onSave: onAgentPresetSave,
        }),
        h(ContextEnhancementEditor, {
          config: account.contextEnhancement,
          disabled: Boolean(busy),
          onSave: onContextEnhancementSave,
        }),
        AccountSettings ? h(AccountSettings, {
          account,
          busy: Boolean(busy),
          onSave: onAccountSettingsSave,
        }) : null,
        h('div', { className: 'ddt-accountFooter dim-cardFooter' },
          h('div', { className: 'dim-cardFooterLayout' },
            h('div', { className: 'ddt-actions dim-cardActions' },
              h(Button, {
                className: 'dim-cardAction',
                onClick: onReconnect,
                disabled: Boolean(busy),
              }, busy === 'reconnect' ? '检查中…' : account.connected ? '检查连接' : '重试连接'),
              h(Button, {
                className: 'dim-cardAction',
                kind: 'danger',
                onClick: onRequestRemove,
                disabled: Boolean(busy),
              }, '移除接入')),
            summary ? h('div', { className: 'ddt-summary dim-cardSummary' }, summary) : null,
            account.lastMessageError ? h(LastMessageErrorSummary, {
              className: 'ddt-summary',
              error: account.lastMessageError,
            }) : null,
            testNotice ? h('div', {
              className: 'ddt-summary dim-cardFeedback',
              role: 'status',
            }, testNotice) : null)),
        ),
      ),
      removing ? h('div', { className: 'ddt-confirm dim-confirm', role: 'alertdialog' },
        h('strong', null, `从 DeepSeek Harness 移除“${account.bot.name}”？`),
        h('p', null, `这会停止消息连接，并删除本机保存的 ${credentialNoun}、机器人配置及会话映射。${platformLabel}中的机器人不会被自动删除。`),
        h('div', { className: 'ddt-actions dim-viewActions' },
          h(Button, { onClick: onCancelRemove, disabled: Boolean(busy) }, '保留机器人'),
          h(Button, { kind: 'danger', onClick: onConfirmRemove, disabled: Boolean(busy) },
            busy === 'delete' ? '正在移除…' : '确认移除接入'))) : null);
  }

  function SettingsTab({ rpcCall }) {
    const [model, setModel] = React.useState({
      phase: 'loading', bots: [], totals: { configured: 0, connected: 0 }, error: null,
      agentPresetCatalog: EMPTY_AGENT_PRESET_CATALOG,
      modelCatalog: EMPTY_MODEL_CATALOG,
    });
    const [credentialOpen, setCredentialOpen] = React.useState(false);
    const [credentialError, setCredentialError] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [busyByBot, setBusyByBot] = React.useState({});
    const [testNoticeByBot, setTestNoticeByBot] = React.useState({});
    const [removeTarget, setRemoveTarget] = React.useState(null);
    const mounted = React.useRef(true);
    const workspaceFence = useWorkspaceSnapshotFence();

    React.useEffect(() => {
      const disposeDingtalk = installDingtalkStyles();
      const disposeChannel = installStyles();
      mounted.current = true;
      return () => {
        mounted.current = false;
        disposeChannel();
        disposeDingtalk();
      };
    }, []);

    const invoke = React.useCallback(async (endpoint, payload = {}, signal) => {
      if (typeof rpcCall !== 'function') throw new TypeError(`${channel} 设置页缺少 RPC 连接`);
      return api.unwrapRpcResult(await rpcCall(endpoint, payload, signal));
    }, [rpcCall]);

    const loadStatus = React.useCallback(async ({ signal, silent = false } = {}) => {
      const workspaceVersion = workspaceFence.beginStatus();
      if (workspaceVersion === null) return;
      if (!silent && mounted.current) setModel((current) => ({ ...current, phase: 'loading', error: null }));
      try {
        const snapshot = api.normalizeSnapshot(await invoke(endpoints.status, {}, signal));
        if (!mounted.current || signal?.aborted
          || !workspaceFence.canCommitStatus(workspaceVersion)) return;
        setModel({
          phase: 'ready', bots: snapshot.bots, totals: snapshot.totals, error: null,
          agentPresetCatalog: snapshot.agentPresetCatalog ?? EMPTY_AGENT_PRESET_CATALOG,
          modelCatalog: snapshot.modelCatalog ?? EMPTY_MODEL_CATALOG,
        });
      } catch (error) {
        if (error?.name !== 'AbortError' && mounted.current && !signal?.aborted
          && workspaceFence.canCommitStatus(workspaceVersion)) {
          setModel((current) => ({
            ...current,
            phase: silent ? current.phase : 'error',
            error: api.presentError(error),
          }));
        }
      }
    }, [invoke, workspaceFence]);

    React.useEffect(() => {
      const controller = new AbortController();
      void loadStatus({ signal: controller.signal });
      return () => controller.abort();
    }, [loadStatus]);

    React.useEffect(() => {
      if (model.phase !== 'ready') return undefined;
      const controller = new AbortController();
      const timer = window.setInterval(
        () => void loadStatus({ signal: controller.signal, silent: true }),
        15_000,
      );
      return () => {
        controller.abort();
        window.clearInterval(timer);
      };
    }, [loadStatus, model.phase]);

    const bindCredentials = React.useCallback(async (values) => {
      const snapshotVersion = workspaceFence.beginMutation();
      setBusy(true);
      setCredentialError(null);
      try {
        const snapshot = api.normalizeSnapshot(await invoke(
          endpoints.bindCredentials,
          credentialPayload(values),
        ));
        if (!mounted.current) return;
        if (workspaceFence.canCommitMutation(snapshotVersion)) {
          setModel({
          phase: 'ready', bots: snapshot.bots, totals: snapshot.totals, error: null,
          agentPresetCatalog: snapshot.agentPresetCatalog ?? EMPTY_AGENT_PRESET_CATALOG,
          modelCatalog: snapshot.modelCatalog ?? EMPTY_MODEL_CATALOG,
        });
        }
        setCredentialOpen(false);
      } catch (error) {
        if (mounted.current) setCredentialError(api.presentError(error));
      } finally {
        const shouldRefresh = workspaceFence.endMutation();
        if (shouldRefresh && mounted.current) void loadStatus({ silent: true });
        if (mounted.current) setBusy(false);
      }
    }, [invoke, loadStatus, workspaceFence]);

    const botAction = React.useCallback(async (account, operation, endpoint, payload) => {
      const snapshotVersion = workspaceFence.beginMutation();
      setBusyByBot((current) => ({ ...current, [account.botId]: operation }));
      try {
        const value = await invoke(endpoint, payload);
        const snapshot = api.normalizeSnapshot(value);
        if (mounted.current && workspaceFence.canCommitMutation(snapshotVersion)) {
          setModel({
          phase: 'ready', bots: snapshot.bots, totals: snapshot.totals, error: null,
          agentPresetCatalog: snapshot.agentPresetCatalog ?? EMPTY_AGENT_PRESET_CATALOG,
          modelCatalog: snapshot.modelCatalog ?? EMPTY_MODEL_CATALOG,
        });
        }
        if (mounted.current && operation === 'reconnect') {
          setTestNoticeByBot((current) => ({
            ...current,
            [account.botId]: connectionTestNotice(value),
          }));
        }
      } catch (error) {
        if (operation !== 'reconnect') throw error;
        if (mounted.current) {
          setTestNoticeByBot((current) => ({
            ...current,
            [account.botId]: '连接检查失败，请稍后重试。',
          }));
        }
      } finally {
        const shouldRefresh = workspaceFence.endMutation();
        if (shouldRefresh && mounted.current) void loadStatus({ silent: true });
        if (mounted.current) setBusyByBot((current) => {
          const next = { ...current };
          delete next[account.botId];
          return next;
        });
      }
    }, [invoke, loadStatus, workspaceFence]);

    const botList = model.bots.length > 0
      ? h('section', { className: 'dim-listSection' },
          h(ChannelListHeading, {
            className: 'ddt-listHeading',
            title: `已接入的 ${channel} 机器人`,
            connectionLabel,
          }),
          h('ul', { className: 'ddt-list dim-botList' }, model.bots.map((account) =>
            h('li', { key: account.botId }, h(AccountCard, {
              account,
              busy: busyByBot[account.botId],
              testNotice: testNoticeByBot[account.botId],
              removing: removeTarget === account.botId,
              onReconnect: () => void botAction(
                account,
                'reconnect',
                endpoints.reconnectBot,
                { botId: account.botId, sendTest: true },
              ),
              onWorkspaceSave: (workspace) => botAction(
                account,
                'workspace',
                endpoints.setWorkspace,
                { botId: account.botId, workspace },
              ),
              onModelSave: (selectedModel) => botAction(
                account,
                'model',
                endpoints.setModel,
                { botId: account.botId, model: selectedModel },
              ),
              onAgentPresetSave: (agentPreset) => botAction(
                account,
                'preset',
                endpoints.setAgentPreset,
                { botId: account.botId, agentPreset },
              ),
              onContextEnhancementSave: (config) => botAction(
                account,
                'context-enhancement',
                endpoints.setContextEnhancement,
                { botId: account.botId, config },
              ),
              onAccountSettingsSave: AccountSettings && accountSettingsEndpoint
                ? (payload) => botAction(
                    account,
                    'settings',
                    accountSettingsEndpoint,
                    { botId: account.botId, ...payload },
                  )
                : undefined,
              onRequestRemove: () => setRemoveTarget(account.botId),
              onCancelRemove: () => setRemoveTarget(null),
              onConfirmRemove: async () => {
                await botAction(account, 'delete', endpoints.deleteBot, {
                  botId: account.botId,
                  confirm: true,
                });
                if (mounted.current) setRemoveTarget(null);
              },
            })))))
      : null;

    return h(ModelCatalogContext.Provider, {
      value: model.modelCatalog ?? EMPTY_MODEL_CATALOG,
    }, h(AgentPresetCatalogContext.Provider, {
      value: model.agentPresetCatalog ?? EMPTY_AGENT_PRESET_CATALOG,
    }, h('section', {
      className: `ddt-page ${pageClass} dim-channelPage`,
      'aria-label': `${channel} 设置`,
    },
    h('div', { className: 'ddt-heading' },
      h('div', { className: 'ddt-tools' },
        h('div', { className: 'dim-bindActions' },
          h(Button, {
            kind: 'credential',
            className: 'dim-credentialButton',
            onClick: () => { setCredentialOpen((value) => !value); setCredentialError(null); },
            disabled: busy,
            'aria-pressed': credentialOpen,
            'aria-label': credentialAriaLabel,
          }, h(CredentialActionIcon), credentialOpen ? credentialCloseLabel : credentialOpenLabel)),
        model.totals.configured > 0
          ? h('div', { className: 'ddt-badge dim-onlineBadge' },
              h('span', null, `${model.totals.connected} / ${model.totals.configured} 在线`))
          : null)),
    model.phase === 'loading'
      ? h('div', {
          className: 'ddt-card ddt-loading dim-surfaceCard dim-loadingView',
          'aria-busy': 'true',
        }, h('div', { className: 'ddt-spinner dim-spinner' }), `正在读取 ${channel} 机器人状态…`)
      : model.phase === 'error'
        ? h('div', { className: 'ddt-card dim-surfaceCard' },
            h('div', { className: 'ddt-inlineError dim-inlineError' },
              h('h3', null, `无法读取 ${channel} 机器人状态`),
              h('p', null, model.error?.message),
              h(Button, { onClick: () => void loadStatus() }, '重新读取')))
        : h(React.Fragment, null,
            credentialOpen ? (CredentialPanel
              ? h(CredentialPanel, {
                  busy,
                  error: credentialError,
                  onSubmit: bindCredentials,
                  onCancel: () => { setCredentialOpen(false); setCredentialError(null); },
                })
              : h(CredentialBindingPanel, {
                  channel,
                  secretLabel: 'Bot Token',
                  secretPlaceholder: tokenPlaceholder,
                  busy,
                  error: credentialError,
                  onSubmit: bindCredentials,
                  onCancel: () => { setCredentialOpen(false); setCredentialError(null); },
                })) : null,
            model.bots.length === 0 && !credentialOpen
              ? h('div', { className: 'ddt-card dim-surfaceCard' },
                  h('div', { className: 'ddt-cardBody ddt-empty dim-surfaceBody dim-emptyView' },
                    h('div', { className: 'dim-emptyCopy' },
                      h('div', { className: 'ddt-stateLabel dim-stateLabel' },
                        h('span', { className: 'ddt-dot dim-stateDot' }),
                        h('span', null, `尚未接入 ${channel} 机器人`)),
                      h('h3', null, emptyTitle),
                      h('p', null, emptyDescription),
                      h('div', { className: 'ddt-actions dim-viewActions' },
                        h(Button, {
                          kind: 'primary',
                          onClick: () => setCredentialOpen(true),
                        }, emptyActionLabel))),
                    h('div', {
                      className: `ddt-brandMark dim-emptyBrand ${avatarClass}`,
                      'aria-hidden': 'true',
                    }, h(LogoGlyph, { size: 64 }))))
              : null,
            botList))));
  }

  return { SettingsTab, AccountCard };
}
