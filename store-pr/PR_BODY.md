## Plugin submission
- Plugin ID: `com.fax.apifox`
- Version: `1.1.0`
- Publisher ID: `fax`

## Source repository and tag
https://github.com/zsky1/apifox-polaris-api — tag `v1.1.0`, release `v1.1.0`.
All unsigned target packages are built by the repository's `plugin-release.yml`
via `t8y2/dbx/.github/workflows/plugin-release-reusable.yml@main` from that tag.
The `sha256` / `size` in `candidates/com.fax.apifox.json` pin those exact unsigned bytes.

This is a community fork of an upstream `polaris-api` derivative. The original
authors and license are attributed in the packaged `NOTICE` (Apache-2.0 §4);
the fork relationship is stated in the listing description.

## Capabilities and user workflow
- Workbench contribution `com.fax.apifox.workbench` (label: apifox-polaris-api).
- The plugin keeps the upstream `.http` file-first API client intact: local
  `.http` / `.rest` source editing, syntax highlighting, multi-tab, environment
  variables, cURL import/export, multipart/form-data, streaming SSE and
  WebSocket sessions. Requests are sent by the native sidecar (reqwest).
- Apifox integration is **read-only**: from the toolbar button "⇅ Apifox" the
  user configures Project ID / Access Token, tests the connection, and pulls
  the project's API tree and environments into local files. No local change is
  ever written back to Apifox; all write RPCs were removed from the sidecar.
- Source of truth remains the local workspace (`wpa-workspace.json` +
  `.http` files); the workbench contains no separate data store.

## Permissions, data access, and network access
Manifest permissions:
- `host.storage` — persist plugin settings (Apifox base URL, Project ID,
  Access Token, API/Client version headers) in plugin-local storage; read/write
  the user-selected workspace files via host file APIs.
- `host.events` — receive host lifecycle events (used for tab/workbench
  integration); no plugin-generated events are emitted.

File access: only the workspace directory the user selects (the `.http` /
`.rest` files, `http-client.env.json`, `wpa-workspace.json`, and `_history/` /
`_results/` subdirectories under it). No other filesystem locations are read
or written by the plugin logic.

Network access:
- The Rust sidecar sends the user's own HTTP requests to whatever host the user
  puts in the request URL (that is the core function of an API client).
- For Apifox pull only, it calls `https://api.apifox.com/v1/...` with the
  user-supplied Bearer token, using `X-Apifox-Api-Version` and
  `X-Client-Version` headers. It falls back to the official `export-openapi`
  endpoint when the private endpoints are unavailable.
- No telemetry, analytics, or third-party network calls.

Credentials: the Apifox Access Token is stored only in plugin-local storage;
it is never written into `.http` files, logs, or event payloads.

## Native sidecar behavior
The plugin ships one native Rust executable per platform
(`bin/windows-x64/dbx-plugin-apifox.exe`, etc.), launched by the host as a
JSON-RPC sidecar over stdio.
- No listening ports; no child processes spawned by the sidecar.
- Filesystem writes are limited to the selected workspace (API history,
  request/response snapshots, pulled `Apifox-*.http` and `http-client.env.json`)
  and to plugin-local settings storage.
- Uses reqwest (rustls + native roots) for outgoing HTTP and tungstenite for
  WebSocket. No `eval`, no shell execution, no dynamic native code loading.

## License
Apache-2.0 (LICENSE and NOTICE are shipped in the package root).

## Homepage or support URL
https://github.com/zsky1/apifox-polaris-api

## Confirmation
- [x] The candidate packages are unsigned and match the disclosed source tag.
- [x] I have not included private keys, tokens, credentials, or proprietary data.
- [x] The candidates are listed in `candidates/com.fax.apifox.json`; `plugins/` and `catalog/` were not edited manually.
