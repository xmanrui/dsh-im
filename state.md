# Project state

- 2026-11-06: Assigned historical Trending unit `codex-history-20261027-dsh-im` for `xmanrui/dsh-im`.
- Canonical source: 2026-10-27 JavaScript Trending capture, Git blob `d61c30aa89bba9e4d6dc86cc679f59ee3e21630e`.
- Canonical upstream is public, active, nonfork `xmanrui/dsh-im`, default branch `main`; exact all-rig owner scan found only this assigned task. Local checkout and project records were absent, so the canonical repo was cloned to the assigned path.
- Selected open issue #528: Weixin steer success emits a redundant “submitted” receipt. No overlapping open PR was found. Scope: make the shared dispatcher success receipt default-on, suppress it only for Weixin, and keep queued fallback receipts.
- Worker branch: `fix/528-weixin-steer-silent`. Local fix, tests and built host bundle are ready; push and PR status pending.
