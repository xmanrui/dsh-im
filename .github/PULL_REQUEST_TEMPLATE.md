## 这个 PR 做了什么

<!-- 一段话说清：改了什么、为什么必须这么改 -->

## 关联 issue

<!-- closes #NNN -->

## 判据（必填）

<!-- 贴可复跑命令 + 期望输出末行；门禁绿 ≠ 缺陷已证明 -->

```sh
npm run check
```

## 自查清单

- [ ] `npm run check` 本地通过（贴了末行）
- [ ] 若是缺陷修复：先写了失败用例，并给出**负向对照**（把修复回退后该用例确实变红）
- [ ] 改了 `src/channels/*/` 的实现 → 已跑 `node scripts/channel-capability-matrix.mjs --write` 并提交 README 变更
- [ ] 改了会进入 bundle 的内容（`package.json` / `src` / `plugin-src`）→ 已 `npm run build` 并把 `lib/*.js` 一并提交
- [ ] 没有提交任何凭据、`~/.dsh` 配置、未脱敏日志
- [ ] 提交用 `git commit --only -- <files>` 点名路径（本仓有多会话并行写）
- [ ] 新增用户可见文案 → 已进全部 `i18n-<lang>/` 与合并模块

## 影响面

<!-- 哪些渠道/场景受影响；是否有明确降级；如何回滚 -->
