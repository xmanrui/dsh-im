/**
 * 本插件的 UI 组件层。
 *
 * 两条来源，一条规则（issue #247 / issue comment 5789784019）：
 * 1. **官方有导出的，一律直通转发**（`official.js`）——两代内核拿到同一个官方实现，
 *    样式与交互由官方拥有，本插件不复制、不漂移；
 * 2. **官方没导出的，按官方几何与 `--dsw-*` token refork**（`button.js` /
 *    `icon-button.js` / `checkbox.js` / `segmented-control.js` + `styles.js`）。
 *
 * 所有 refork 组件都只在 0.1.5-rc.1 缺失的意义上存在；一旦官方补上导出，
 * 把这里换成直通即可，调用点不受影响。
 */

export {
  BrandWordmark,
  ConnectionIndicator,
  DisclosureRow,
  FISH_LOGO_PATH,
  FISH_LOGO_VIEWBOX,
  FileTypeIcon,
  FishLogo,
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
  hasMember,
  optionalMember,
  projectUserText,
  rankByName,
  relativeTime,
  useAnchoredMaxHeight,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
  writeClipboard,
} from './official.js';
export { Button, OFFICIAL_BUTTON_VARIANTS, REFORK_BUTTON_VARIANTS } from './button.js';
export { IconButton, ICON_BUTTON_VARIANTS } from './icon-button.js';
export { Checkbox } from './checkbox.js';
export { SegmentedControl } from './segmented-control.js';
export { cx } from './cx.js';
export { IM_UI_STYLE_ID, installUiStyles } from './styles.js';
export {
  AVAILABLE_BOTH,
  AVAILABLE_LATEST,
  PRIMITIVES,
  UI_BASELINE,
  UI_COMPONENT_BY_ID,
  UI_COMPONENT_REGISTRY,
  UI_LATEST,
} from './registry.js';
