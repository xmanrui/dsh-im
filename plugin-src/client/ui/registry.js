/**
 * UI 组件清单：每个组件的来源、可用内核与上游路径。
 *
 * 这份表是「以 0.1.5 为基线」这条约束的可执行形式：
 * - `kind: 'reexport'` 直接转发官方实现，`availableAt` 必须同时包含 0.1.5-rc.1；
 * - `kind: 'refork'` 是官方未导出（或在 0.1.5 上缺失）的组件，样式由本插件按官方
 *   几何与 token 复刻，`upstreamPath` 指向被复刻的上游文件。
 *
 * 判定依据来自三个内核槽位的实际导出表：
 * - 0.1.5-rc.2 `dsh-web-frontend/dist/assets/index-BKQ_L1z6.js` 的 123 项导出表；
 * - 0.1.7-alpha.1 / 0.1.7-alpha.2 `@deepseek-ai/dsh-client-ui-primitives/lib/types/index.d.ts`。
 */

export const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives';
export const UI_BASELINE = '0.1.5-rc.1';
export const UI_LATEST = '0.1.7-alpha.2';

/** 两代内核都导出。 */
export const AVAILABLE_BOTH = Object.freeze([UI_BASELINE, UI_LATEST]);
/** 仅 0.1.7 起导出：0.1.5 上必须回退或 refork。 */
export const AVAILABLE_LATEST = Object.freeze([UI_LATEST]);

function slug(name) {
  return name.replaceAll('_', '-').replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * 一个直通转发的官方成员。
 * @param component 官方导出名。
 * @param file 上游文件名（不含扩展名）。
 */
function reexport(component, file) {
  return {
    id: slug(component),
    title: component,
    source: {
      kind: 'reexport',
      component,
      package: PRIMITIVES,
      version: UI_LATEST,
      availableAt: AVAILABLE_BOTH,
      upstreamPath: `packages/client/ui-primitives/src/${file}.tsx`,
    },
  };
}

/**
 * 一个本插件复刻的官方组件或其变体。
 * @param component 组件名。
 * @param variant 变体名，或用 `null` 表示整个组件。
 * @param source 上游来源与可用内核。
 */
function refork(component, variant, source) {
  return {
    id: variant === null ? slug(component) : `${slug(component)}-${slug(variant)}`,
    title: variant === null ? component : `${component} · ${variant}`,
    source: {
      kind: 'refork',
      component,
      ...(variant === null ? {} : { variant }),
      version: UI_LATEST,
      ...source,
    },
  };
}

export const UI_COMPONENT_REGISTRY = Object.freeze([
  // 直通转发：官方拥有实现与样式。
  reexport('Button', 'Button'),
  reexport('Switch', 'Switch'),
  reexport('Tag', 'Tag'),
  reexport('Pill', 'Pill'),
  reexport('Menu', 'Menu'),
  reexport('Input', 'Input'),
  reexport('Tooltip', 'Tooltip'),
  reexport('Modal', 'Modal'),
  reexport('HoverCard', 'HoverCard'),
  reexport('DisclosureRow', 'DisclosureRow'),
  reexport('StateDot', 'StateDot'),
  reexport('ConnectionIndicator', 'ConnectionIndicator'),
  reexport('BrandWordmark', 'BrandWordmark'),
  reexport('FishLogo', 'FishLogo'),
  reexport('Toast', 'Toast'),

  // 官方 Button 没有的变体：复刻官方 button 体系里的同一批 token。
  refork('Button', 'elevated', {
    package: '@deepseek-ai/dsh-client-ui-sidebar',
    availableAt: AVAILABLE_BOTH,
    upstreamPath: 'packages/client/ui-sidebar/src/client/SidebarRoot.module.css',
    mappedClass: 'newSession',
  }),
  refork('Button', 'add', {
    package: '@deepseek-ai/dsh-client-ui-plugin-manager',
    availableAt: AVAILABLE_LATEST,
    upstreamPath: 'packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css',
    mappedClass: 'addButton',
  }),
  refork('Button', 'addGhost', {
    package: '@deepseek-ai/dsh-client-ui-plugin-manager',
    availableAt: AVAILABLE_LATEST,
    upstreamPath: 'packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css',
    mappedClass: 'addButton',
  }),
  refork('Button', 'danger', {
    package: '@deepseek-ai/dsh-client-ui-plugin-manager',
    availableAt: AVAILABLE_LATEST,
    upstreamPath: 'packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css',
    mappedClass: 'danger',
  }),

  // 图标按钮：issue #247 (d) 要求的 28px 方形/圆形规格。
  refork('IconButton', 'action', {
    package: '@deepseek-ai/dsh-client-ui-chat',
    availableAt: AVAILABLE_BOTH,
    upstreamPath: 'packages/client/ui-chat/src/client/chat/MessageIconActions.module.css',
    mappedClass: 'action',
  }),
  refork('IconButton', 'round', {
    package: '@deepseek-ai/dsh-client-ui-sidebar',
    availableAt: AVAILABLE_BOTH,
    upstreamPath: 'packages/client/ui-sidebar/src/client/SidebarRoot.module.css',
    mappedClass: 'iconButton',
  }),
  refork('IconButton', 'toolbar', {
    package: '@deepseek-ai/dsh-client-ui-plugin-manager',
    availableAt: AVAILABLE_LATEST,
    upstreamPath: 'packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css',
    mappedClass: 'iconButton',
  }),

  // 0.1.5 完全没有的官方组件：整组件复刻。
  refork('Checkbox', null, {
    package: PRIMITIVES,
    availableAt: AVAILABLE_LATEST,
    upstreamPath: 'packages/client/ui-primitives/src/Checkbox.tsx',
    mappedClass: 'checkbox',
  }),
  refork('SegmentedControl', null, {
    package: PRIMITIVES,
    availableAt: AVAILABLE_LATEST,
    upstreamPath: 'packages/client/ui-primitives/src/SegmentedControl.tsx',
    mappedClass: 'segmentedControl',
  }),
]);

/** 组件 id → 清单项。 */
export const UI_COMPONENT_BY_ID = Object.freeze(
  new Map(UI_COMPONENT_REGISTRY.map((entry) => [entry.id, entry])),
);
