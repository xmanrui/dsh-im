# AI Office Connector

The **AI Office** page lets the local Harness connect outward to a public Office. The machine needs no public IP, forwarded port, or WebSocket server. The Device Token is written only to the Harness credential provider; the ordinary config file contains only the device ID, Office origin, workspace aliases, and instruction-preset aliases. Office selects aliases and never receives local absolute paths.

The current protocol is `office-harness.v1`. The connector authenticates and advertises capabilities with `POST /api/harness/connector/heartbeat`, then opens the downstream event plane with `GET /api/harness/connector/stream` over SSE. The settings page derives every fixed hook from the Office Base URL and reconnects with backoff after a disconnect.

A `job.available` event makes the local connector fetch the payload, validate Workspace/Preset aliases, claim a 90-second lease, and renew it every 30 seconds. It creates an isolated Harness Session, reports safe status/tool/text progress, and writes a terminal result exactly once. Tool approvals and follow-up questions surface in Office; approve, reject, and text answers return over SSE to the original Session. Heartbeats and leases recover from dropped connections.

A successful heartbeat response must be JSON: `{"ok":true,"protocolVersion":"office-harness.v1"}`. This makes a successful connection test proof of a compatible Office Connector instead of any URL that happens to return 200.
