# PR #216 UI cherry-pick list

These changes are intentionally not split into standalone PRs because they overlap heavily with #261.

## Files involved

- `plugin-src/client/ui-glyphs.js`
- `plugin-src/client/row-selector.js`
- `plugin-src/client/help-tip.js`
- `plugin-src/client/channel-card-meta.js`
- `plugin-src/client/channels/shared/collapsible-account.js`
- `plugin-src/client/agent-preset.js`
- `plugin-src/client/model-setting.js`
- `plugin-src/client/bot-alias.js`
- `plugin-src/client/context-enhancement.js`
- `plugin-src/client/styles.js`
- `plugin-src/client/channels/*/styles.js`
- `plugin-src/client/channels/*/index.js`
- `plugin-src/client/channels/office/index.js`
- `plugin-src/client/workspace-editor.js`
- `plugin-src/client/workspace-directory-picker.js`
- `scripts/verify-package.mjs`
- `test/...`
- `test/support/...`

> Note: `scripts/verify-package.mjs` and `test/client-ui.test.mjs` also carry the
> config-surface migration contract assertions (slot `plugins.bundle.config`, key
> `@xmanrui/dsh-im`, `view` threading, render-site guard). Those contract parts are
> already shipped with PR A (`split/216-plugin-config-slot`); only the UI-related
> assertions and the pure-UI diffs of these files remain for cherry-picking here.

## If #261 is the main PR

Cherry-pick these into #261, preserving author or adding `Co-authored-by: zlZayn`.

Suggested commit groups:

1. Shared UI primitives: `ui-glyphs.js`, `row-selector.js`, `help-tip.js`
2. Collapsible convergence: `channels/shared/collapsible-account.js`
3. Row selector adoption: `agent-preset.js`, `model-setting.js`
4. Context / alias: `context-enhancement.js`, `bot-alias.js`
5. Channel styles: `channels/*/styles.js`, `channels/*/index.js`
6. Office page: `channels/office/index.js`
7. Tests and scripts: `scripts/verify-package.mjs`, `test/...`, `test/support/...`

## If #216 is the main PR

Split in this order as stacked PRs:

1. `split/216-shared-ui`
2. `split/216-row-select`
3. `split/216-context-alias`
4. `split/216-channel-styles`
5. `split/216-tests`
