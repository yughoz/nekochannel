# Nekochannel

Desktop multi-account WhatsApp hub with a local SQLite archive, AI chat and read-only MCP access. Not affiliated with WhatsApp or Meta; use WhatsApp Web according to its terms.

## Implemented

- Isolated persistent account sessions, QR login, live background capture (`backgroundThrottling:false`).
- Durable per-account queues, retry/backoff, `(account,id)` dedupe, resumable bounded backfill and renderer recovery. Backfill depends on history available to the linked device; it is not a full-history guarantee.
- Sidebar rename/icons/reorder, collapse, quick switcher (`Ctrl+K`), dockable Agent pane.
- Internal ingest, chat UI/LLM bridge and authenticated read-only MCP, owned by the Electron lifecycle. No separate wa-reader checkout, Node process, browser extension or service required.
- Action auto-replies: separate from read-only capture, master **and** per-account switches default **OFF**. Text-only replies to recent incoming chats, group mention gate, rate limits, busy deferral and audit log.
- Tray/close-to-tray, autostart, system theme, Indonesian/English, desktop notifications and rotating config backups.

Privacy blur and an application lock shield are available. Email is **not implemented**.

## Privacy And Lock

Settings > Privacy (Indonesian/English) applies immediately: master blur defaults ON,
with independent names/groups, profile photos, chat-list previews, all message
content, media previews and compose-input switches. All-message blur includes its
child media; turn it off to use media-only blur. Shell account labels are masked
separately. CSS is injected into every WhatsApp view and reapplied after reload
or navigation, not painted over the shell. WhatsApp can change its DOM: fallback
selectors are best-effort, not guaranteed coverage.

Alt+Z toggles blur; Alt+X and tray > Lock now lock after a password is configured.
Shortcut conflicts are reported in the main-process log. Passwords are write-only
in Settings (8-256 characters); only a random-salted scrypt hash is saved in
`settings.json` and its normal rotating backups. Keep those files private. Unlock
attempts have a shared exponential cooldown (1-30 seconds). Auto-lock uses system
idle minutes (0 disables it, the default; maximum 1440). Unlock requires new user
activity before the next idle lock. Settings and password changes are disabled
while locked. Preferences survive restart; the locked state itself does not.

The opaque native fullscreen shield covers each attached display independently,
including embedded WhatsApp views, and survives hiding/reopening the main window.
Close, reload shortcuts and normal app quit are blocked until unlock. This is
**not an OS lock**: force quit, process termination, OS/window-manager switching,
other applications, screen recording and privileged debugging remain outside its
security boundary. Blur is cosmetic, may briefly appear during page load, and does
not erase DOM text, stop capture/auto-replies, encrypt the archive, or protect
backend/MCP data. Use the OS lock for actual workstation security. No password
recovery is provided; someone with filesystem access can alter local settings.

Run `npm test` for unit tests and `node scripts/privacy-smoke.js` for the real
Electron/CDP smoke (desktop required, TMPDIR must not be `/tmp`). The smoke creates
and deletes its own isolated userData, uses ephemeral backend ports and a disposable
password, and checks restart persistence. It prints actual WhatsApp selector counts
before using explicitly synthetic fixtures for CSS lifecycle tests. A QR/login-only
session **blocks authenticated selector verification**; fixture success is not proof
of real-chat coverage. Idle thresholds are tested with injected seconds, not by
waiting for real system inactivity. Multi-display hardware/platform verification
is limited to the displays and OS where the smoke is run.

## Run

Development requires Node.js **22.16+**, npm and a desktop display. Runtime uses the pinned Electron 45.3.4 (including its SQLite implementation).

```sh
npm ci
npm start
npm test
npm run dist
```

Installers use electron-builder (AppImage, NSIS, dmg). Build/sign/release on the target OS; this change does not certify every platform installer.

First launch seeds one WhatsApp account. Scan its QR, or add another account from the sidebar. Set the LLM base URL (OpenAI-compatible `/v1` base), model and API key in Settings, then **quit from the tray and restart**. Closing the window only hides it. Without LLM settings the chat UI still loads and `/api/chat` returns a clear 503 configuration error.

## Local data and configuration

All state is under the OS application-data directory `nekochannel`: `accounts.json`, `settings.json`, persistent Chromium partitions, `queue/`, `state.json`, `data/wa.sqlite`, `action-log.jsonl`, `backup/`, private `.env` and `mcp-key`. Back up the whole directory with the app stopped; config snapshots alone do not back up messages or sessions.

Settings saves LLM values to **this app's** `.env` (0600; key write-only in UI), never another checkout. Values are local plaintext, not OS-keychain encrypted. Keep backups private. LLM requests send selected archive content to your configured provider.

Optional file configuration: copy `.env.example` to a private location and launch with `NEKOCHANNEL_ENV=/absolute/path/config.env npm start`. Files are actually parsed at startup. Precedence: process environment > app-data `.env` > explicitly selected config file. No implicit working-directory `.env`. `SUMMARY_MODEL_*` remains an optional fallback. Action defaults stay OFF regardless of provider config.

Loopback services (no public bind option):

| Default | API |
|---|---|
| `127.0.0.1:4317` | `POST /ingest`, `POST /unread`, `GET /health` |
| `127.0.0.1:4318` | chat UI `/`, `GET /api/health`, SSE `POST /api/chat` |
| `127.0.0.1:4319` | read-only JSON-RPC MCP `POST /mcp`, `GET /health` |

Override ports with `NEKOCHANNEL_INGEST_PORT`, `NEKOCHANNEL_CHAT_PORT`, `NEKOCHANNEL_MCP_PORT`. Port 0 selects an ephemeral port for tests. Occupied ports **fail startup** and close already-started internal services; the app never silently connects to an old service or stops it. Move ports or stop the old service yourself after checking it is safe. External `NEKOCHANNEL_SERVER`/`NEKOCHANNEL_AGENT_URL` routing is no longer used by the app.

MCP requires `Authorization: Bearer <key>` for every RPC. A random 0600 `mcp-key` is generated on first boot; optionally set `NEKOCHANNEL_MCP_KEY`. Configure your client with the loopback URL and this key without sharing it. Tools: search messages, chat history, list chats, unread summary, group members, overview. Ingest/chat trust local clients; do not expose them through a tunnel or untrusted browser proxy. Legacy webhook/reminder forwarding is not enabled by the app.

## Explicit legacy SQLite import

No automatic discovery, symlink or shared live database. On a **fresh destination** (no `data/wa.sqlite`), set `NEKOCHANNEL_IMPORT_SQLITE` to the legacy SQLite path for one launch. The source is opened **read-only**, integrity/schema checked, and snapshotted with SQLite's online backup API, including committed WAL rows. A separate `legacy-backup-*.sqlite` is kept beside the new DB; schema upgrades happen only on the imported copy. Existing destination DBs are refused, never merged or overwritten. Remove the import variable after success; repeating it deliberately fails closed.

The old database, checkout and running services are never edited, deleted, stopped or retired automatically. Use different free ports while both apps run. For rollback, quit Nekochannel and retain its data directory separately; the original setup remains untouched. Legacy JSONL files are not imported by this explicit SQLite path.

## Verification

`npm test` covers capture/action regressions, copied archive/chat/MCP suites, lifecycle, restart persistence, port conflicts, WAL import, corruption/overwrite refusal and config precedence. For an isolated real-Electron endpoint/UI smoke (never use your normal profile):

```sh
XDG_CONFIG_HOME="$(mktemp -d)" NEKOCHANNEL_BACKEND_SMOKE=1 \
  NEKOCHANNEL_INGEST_PORT=0 NEKOCHANNEL_CHAT_PORT=0 NEKOCHANNEL_MCP_PORT=0 npm start
```

On headless Linux add `-- --ozone-platform=headless --disable-gpu`. This verifies actual Electron SQLite ingest/dedupe, UI rendering, MCP auth/search and unconfigured chat; a configured test provider also exercises SSE/tool calling. It does not certify live WhatsApp delivery or a production LLM provider.

## License / publication

Private, **UNLICENSED**; no distribution permission is granted here and no final license has been selected. See [provenance and publication gates](docs/provenance.md). Publication requires ownership/license review and a private history/secret audit first. No history rewrite or visibility change is part of this implementation.
