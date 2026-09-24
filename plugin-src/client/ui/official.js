/**
 * 官方 `@deepseek-ai/dsh-client-ui-primitives` 的直通转发层。
 *
 * 只转发 **0.1.5-rc.1 与 0.1.7-alpha.2 都导出** 的成员（判定依据见 `registry.js`
 * 的 `availableAt`）。两代内核拿到同一个官方实现：本插件不复制官方样式，也不制造
 * 版本漂移，UI 与官方完全一致。
 *
 * 该包在两代内核里都是**平台种子模块**（浏览器启动期即物化），因此 require 它永远
 * 命中种子表，不会走引导图，也不会抛 "missed the module table"：
 *   0.1.5-rc.2   `function by(){return{react:…,"@deepseek-ai/dsh-client-ui-primitives":Zg,…}}`
 *   0.1.7-alpha.2 `function AS(){return{react:…,"@deepseek-ai/dsh-client-ui-primitives":Fj,…}}`
 *
 * 仅 0.1.7 才有导出的组件必须 refork（`Checkbox`、`SegmentedControl` 即先例），否则在
 * 0.1.5 内核上取到 `undefined` 并触发 React #130（`Element type is invalid …`）。
 * 因此这里用 `optionalMember()` 读取它们：名字缺失时返回 `undefined`，由调用点决定回退。
 *
 * `Button` / `Tag` 已由本目录的 `button.js` / 直接使用官方 `Tag` 接管，故不在此转发。
 * 不转发官方 icons 桶：两代导出名不同（`IconXxxOutline16` → `IconXxxRegular`），
 * 通道图标继续走本插件自己的 `channel-logos.js`。
 */

import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';

// 两代内核共同导出的成员：直通转发，语义与样式完全由官方拥有。
export const {
  BrandWordmark,
  ConnectionIndicator,
  DisclosureRow,
  FileTypeIcon,
  FishLogo,
  FISH_LOGO_PATH,
  FISH_LOGO_VIEWBOX,
  HoverCard,
  Input,
  LinkIcon,
  Menu,
  Modal,
  OnboardingSurface,
  Pill,
  ReadBlock,
  ReferenceIcon,
  RiskConfirmation,
  StateDot,
  Switch,
  Tag,
  Toast,
  Tooltip,
  classifyFileType,
  classifyLinkPath,
  extractMarkdownPlainText,
  fileExtension,
  fileSizeText,
  projectUserText,
  rankByName,
  relativeTime,
  useAnchoredMaxHeight,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
  writeClipboard,
} = primitives;

/**
 * 读取一个「仅部分内核导出」的官方成员。
 *
 * `@deepseek-ai/dsh-client-ui-primitives` 是命名空间对象，缺失的名字在这里是
 * `undefined` 而不是抛错，因此可以安全探测。调用点必须处理 `undefined`：能 refork
 * 的就 refork，不能的就不渲染。
 *
 * @param name 官方导出名。
 * @returns 该成员，或 `undefined`（此内核未导出）。
 */
export function optionalMember(name) {
  const value = primitives[name];
  return value === undefined ? undefined : value;
}

/** 内核是否提供该官方成员；用于快照测试与能力探测。 */
export function hasMember(name) {
  return Object.hasOwn(primitives, name);
}
