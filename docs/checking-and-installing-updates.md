# Checking and installing updates

In **Settings → IM Bot**, click **Check for updates** immediately to the left of GitHub. The official npm registry is contacted only on request; confirm the target version and current profile before installing. Only `@xmanrui/dsh-im` is updated, without fetching GitHub or updating Harness / Desktop itself.

After installation, the backend still requires a manual restart, and the panel reports **Installed; restart manually** based on the Host's status. The updater does not request a restart, hot reload, or page refresh. The host's existing module watcher may refresh the plugin interface, but an interface change does not mean the new backend version is running; the Host-reported running version is authoritative. Update when bots are idle, then restart the current Harness / Desktop yourself. Closing the settings page does not cancel a submitted installation.

If the existing page still shows a restart notice after you restart manually, click **Refresh status** in the dialog or reopen **Restart needed**. This reads the current Host status without checking npm or refreshing the page.

The button reuses Desktop's package-management service or the current Harness CLI for an exact-version install equivalent to the following (replace the example profile and version with the confirmed values):

```sh
dsh plugin --profile web add -w --save-exact @xmanrui/dsh-im@3.1.0 --registry=https://registry.npmjs.org/
```

The **Manual update** section at the bottom of the dialog generates a short command for the current profile, such as `dsh plugin --profile web add -w @xmanrui/dsh-im@3.1.1`. Click the copy icon at the far right of the command, then run it in a terminal. It requests a known target version; otherwise, `@latest` resolves the version from npm when executed. The manual command uses your local npm registry configuration without fetching GitHub; the install button still forces the official registry and saves an exact version. If clipboard access fails, select and copy the command manually. For Desktop, use the current Desktop's built-in terminal. For Web, use the environment that started the current Harness and preserve the same `DSH_HOME`. If a restart is already pending, restarting is usually enough without another installation. No potentially destructive command is generated for source links or profiles that cannot be safely identified.

Source `link:`, `file:`, Git, and unrecognized installations can check versions but are never replaced automatically. Confirm the intended profile before manually migrating to npm. Conflicting scoped registries, incompatible Node versions, and unavailable Host executors disable installation with an explanation. Standard Windows CLI installations currently require a manual update; Desktop uses its existing executor.

Do not modify the same profile through a terminal or plugin market during installation. A failed command may leave partial dependency changes; it is not an automatic rollback. Inspect the installation, reinstall the previous exact version if needed, and restart manually. The updater keeps only the profile's latest job and manifest backup under the current `DSH_HOME/updates/dsh-im`, without copying bot credentials. Resolve uncertain remaining installers or locks before retrying; do not blindly delete a lock.
