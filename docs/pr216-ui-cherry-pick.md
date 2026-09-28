# PR #216 UI cherry-pick list

These changes are intentionally not split into standalone PRs because they overlap heavily with #261.
Base range: `6626026..origin/refine/ui-settings-hierarchy` (head `6359294`).

## Excluded already

- `166209f` feat(ui): host the plugin configuration on the host's Plugins page — **already shipped as #277**.
- Merge commits `b7a0aa2`, `0e22180` — do not cherry-pick.
- Build commits `e76c7a1`, `c44dbb3` — regenerated `lib/*`, do not cherry-pick.
- Docs commits (`a852be7`, `112b862`, `acb6693`, `4e5b339`, `2b1e5b2`, `f7e064`, `6359294`) — **already shipped as #278**.
- `scripts/verify-package.mjs` only changed in `166209f` (already in #277); no separate UI commit touches it.

## Files involved

- `plugin-src/client/ui-glyphs.js` (new in `97a2395`, extended in `e24a1be`)
- `plugin-src/client/row-selector.js` (new in `bb845aa`)
- `plugin-src/client/help-tip.js` (new in `e24a1be`)
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
- `plugin-src/client/access-policy-settings.js`, `global-settings.js`, `delivery-settings.js`, `update-panel.js`, `channel-logos.js`, `i18n.js`
- `scripts/dead-rule-audit.mjs`, `surface-audit.mjs`, `surface-probe.js`, `row-anatomy-audit.mjs`, `role-form-audit.mjs`, `help-idiom-audit.mjs`
- `test/...` (client-ui, client-row-control, client-role-form, client-native-border, client-disclosure-contract, client-help-idiom-contract, client-toolbar-role, model-setting-ui, context-enhancement-ui, workspace-editor, plus per-channel client-ui)

## Commit hashes, in cherry-pick order (oldest first)

| # | Commit | Subject | Prim. group | Also touches |
|---|---|---|---|---|
| 1 | `b795365` | take the card chrome to native rows, tabs and radii | 5 channel styles | channel-logos, global-settings, model-setting, styles, test/client-ui |
| 2 | `97a2395` | one action capsule, native glyphs and native hairlines | 1 shared-ui (ui-glyphs new) | 6 office/index, channel-card-meta, access-policy, delivery, model-setting, styles, i18n |
| 3 | `d563a97` | native borders, chevron, progress radius and disabled opacity | 2 collapsible | 6 office/index, agent-preset, bot-alias, context-enhancement, global-settings, i18n, index.js, model-setting, styles, ui-glyphs, test |
| 4 | `222a612` | style the classes that were mounted and never defined | 5 channel styles | 4 context-enhancement, access-policy, global-settings, styles, test/client-ui, test/context-enhancement |
| 5 | `12d769e` | give the tokens one address each | 5 channel styles | styles (607 lines), channels/*/styles |
| 6 | `294171c` | pin the token layer to body and converge the scales | 5 channel styles | styles (406 lines), channels/*/styles |
| 7 | `3bc1e7c` | give each row role one form, and audit the channel sheets | 4 context/alias + 7 tests | context-enhancement (95 lines), channel-card-meta, agent-preset, i18n, styles, role-form-audit.mjs (new), test/client-role-form |
| 8 | `881735e` | the audit findings on colour, alignment and capsules | 5 channel styles + 7 tests | channels/*/styles, styles (81), role-form-audit, client-toolbar-role-contract (new) |
| 9 | `425740b` | one mono family, and the weight and leading axes | 5 channel styles | 6 office/index, channels/*/styles, styles (310) |
| 10 | `ac71595` | take the weights and type rungs from the host | 5 channel styles | context-enhancement (+5), styles (100) |
| 11 | `4f1b848` | delete what could never render, and converge surfaces and colours | 5 channel styles | channels/*/index.js (remove dead lines), channels/*/styles, styles (180) |
| 12 | `1a7363d` | add the surface, dead-rule and role audits | 7 tests/scripts | dead-rule-audit.mjs (new 717), surface-audit.mjs (new), surface-probe.js (new), model-setting, styles |
| 13 | `6f9be04` | give the settings row one shared anatomy | 3 row-select + 7 tests | agent-preset (18), model-setting (35), access-policy, styles (167), row-anatomy-audit.mjs (new), test/client-row-control |
| 14 | `bb845aa` | converge the panel internals, the disclosures and the selects | 1 shared-ui (row-selector new) + 3 row-select + 4 context/alias | agent-preset (36), model-setting (71), context-enhancement (79), row-selector (new 113), styles (265), access-policy, feishu/index, test/client-row-control-contract (new), test/client-disclosure-contract (new) |
| 15 | `bf842c4` | the residual bucket, the dividers, the type tiers and the headings | 5 channel styles | styles (132), model-setting, test/client-row-control |
| 16 | `e24a1be` | the second convergence round — help panel, row form, cross-channel | 1 shared-ui (help-tip new) + 3 row-select + 4 context/alias + 7 tests | help-tip (new 116), ui-glyphs (+20), agent-preset (14), bot-alias (10), context-enhancement (169), access-policy, global-settings, update-panel, i18n, index.js, styles (142), channels/*, help-idiom-audit.mjs (new), test/client-help-idiom-contract (new), test/context-enhancement-ui (508 lines) |
| 17 | `b8aa03c` | put the channel rail in a fixed column beside the panel | 5 channel styles | index.js (+3), styles (37), test/client-ui (47) |
| 18 | `081afd7` | one disclosure affordance per account card, and a larger channel rail | 2 collapsible | styles (12), collapsible-account, test/client-disclosure-contract, test/client-ui |
| 19 | `a0cc84c` | pair the model menu's translucent fill with the host's menu backdrop filter | 5 channel styles | styles (10), test/client-native-border-contract |

## Mixed commits

Almost every commit above touches more than one group. They are **not** cleanly splittable by file — e.g. `bb845aa` introduces `row-selector.js`, rewrites `agent-preset.js` and `model-setting.js`, and rewrites `context-enhancement.js` in one go. Cherry-picking by file group would split hunks inside a single commit and produce broken intermediates.

**Recommended order** (if #261 is the main PR): cherry-pick the 19 commits above as a contiguous range `b795365..a0cc84c` (skipping the already-shipped `166209f` and the merge/build/docs commits), resolving conflicts against #261's `plugin-src/client/ui/` layer. This preserves each commit's atomicity and author attribution.

**Suggested grouping for review** (not for splitting the commits):

1. Shared UI primitives: `97a2395` (ui-glyphs), `bb845aa` (row-selector), `e24a1be` (help-tip)
2. Collapsible convergence: `d563a97`, `bb845aa`, `081afd7` (collapsible-account.js)
3. Row selector adoption: `6f9be04`, `bb845aa`, `e24a1be` (agent-preset/model-setting)
4. Context / alias: `3bc1e7c`, `222a612`, `bb845aa`, `e24a1be` (context-enhancement/bot-alias)
5. Channel styles: every commit in the table (dominant theme)
6. Office page: `97a2395`, `d563a97`, `425740b` (channels/office/index.js)
7. Tests and scripts: `1a7363d`, `3bc1e7c`, `6f9be04`, `881735e`, `e24a1be`

## If #216 is the main PR

Split in this order as stacked PRs (local backup branches exist on `zlZayn/dsh-im`):

1. `split/216-shared-ui`
2. `split/216-row-select`
3. `split/216-context-alias`
4. `split/216-channel-styles`
5. `split/216-tests`