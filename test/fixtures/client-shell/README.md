# Manual desktop smoke consumer

This private fixture consumes `dshImClient` inside Deepseek Harness Desktop (the
Tauri application). It is excluded from the published dsh-im package.

Build dsh-im with `npm run build`, link it into a test profile, then install this
directory with the desktop's bundled DSH CLI:

```sh
node "$DSH_CLI" plugin --profile tauri add "link:$PWD/test/fixtures/client-shell"
```

`DSH_CLI` is the absolute path to the installed desktop's DSH `lib/bin.js`.
Restart the desktop after installing or removing the fixture.

The desktop iframe automatically enables **IM 接入测试** and hides the original
IM settings entry. A standalone browser on the same host keeps its default
entry. **设置 → IM 接入验证** exposes controls to restore/hide settings and
enable/disable the integration. The panel also has an explicit remount button.

Check that repeated visibility changes do not duplicate entries, disabling
integration restores settings, re-enabling works, locale changes preserve the
selected channel, and the original Web settings remain independent. Only read
existing bot data; do not connect accounts, save settings or send messages as
part of this smoke check.

Remove the temporary consumer after verification:

```sh
node "$DSH_CLI" plugin --profile tauri remove dsh-im-client-smoke
```

This fixture demonstrates the service contract and cleanup. It is not a
production desktop integration or a release of the desktop's own IM entry.
