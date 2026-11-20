# Nekochannel

Desktop multi-account WhatsApp hub with a local SQLite archive, AI chat (WA Engine) and MCP access. Not affiliated with WhatsApp or Meta; use WhatsApp Web according to its terms.

## Implemented

- Isolated persistent account sessions, QR login, live background capture (`backgroundThrottling:false`).
- Durable per-account queues, retry/backoff, `(account,id)` dedupe, resumable bounded backfill and renderer recovery. Backfill depends on history available to the linked device; it is not a full-history guarantee.
- Sidebar rename/icons/reorder, collapse, quick switcher (`Ctrl+K`), dockable Agent pane.
- Internal ingest, chat UI/LLM bridge (WA Engine) and authenticated MCP, owned by the Electron lifecycle. Archive tools are read-only; `send_message` is **OFF by default** (enable manually in Settings > LLM Agent) and, when ON, sends only after the user approves a native confirmation dialog for every message. Chat actions (`wa_action`: image/file, reply, reaction, read/unread, archive, pin, edit, typing) have their own Settings switch, also **OFF by default**, and are confirmed per action. The former Action auto-reply feature was removed (2026-11-20). No separate wa-reader checkout, Node process, browser extension or service required.
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

All state is under the OS application-data directory `nekochannel`: `accounts.json`, `settings.json`, persistent Chromium partitions, `queue/`, `state.json`, `data/wa.sqlite`, `action-log.jsonl`, `backup/`, and encrypted `integrations.enc`. Back up the whole directory with the app stopped; config snapshots alone do not back up messages or sessions. Encrypted configuration needs the original OS/keyring to decrypt.

Settings has Agent, Summary, JEV, webhook and MCP inputs in Indonesian/English. Secrets are write-only (blank retains, explicit reset), persisted with Electron safeStorage encryption and 0600 permissions, never new plaintext JSON/backups or `.env`. Insecure/unavailable encryption fails closed; archive access stays operational. Agent/Summary requests send selected archive content to your chosen provider; JEV classifies messages and enabled webhooks deliver events. JEV/webhook default OFF. Save stages integration changes until you quit from the tray and restart; Reader OFF immediately gates automatic integrations. No provider is contacted on startup. Webhook testing is explicit, synthetic-only, and uses the saved URL even when forwarding is OFF.

No integration requires `.env` editing. One-time compatibility import reads app-owned `.env` over process environment, then encrypted Settings becomes authoritative. It preserves old MCP keys and makes encrypted, verified recovery snapshots before removing app-owned integration lines/key files; it never edits the legacy checkout. Agent has per-field Summary fallback; Action stays OFF by default. `NEKOCHANNEL_ENV` is optional for lifecycle options only in the desktop app. The unmanaged Node backend retains file/environment compatibility (process > app-owned file > selected file), not desktop Settings precedence. See [Settings details](docs/modul_settings.md) for recovery and exact integration semantics.

Loopback services (no public bind option):

| Default | API |
|---|---|
| `127.0.0.1:4317` | `POST /ingest`, `POST /unread`, `GET /health` |
| `127.0.0.1:4318` | chat UI `/`, `GET /api/health`, SSE `POST /api/chat`, `POST /api/action` (same-origin loopback; `wa_action` gates) |
| `127.0.0.1:4319` | JSON-RPC MCP `POST /mcp` (read-only tools + confirmed `send_message` / `wa_action`), `GET /health` |

Override ingest/chat ports with `NEKOCHANNEL_INGEST_PORT`, `NEKOCHANNEL_CHAT_PORT` (0 selects ephemeral test ports). Configure MCP in Settings; isolated smoke profiles alone can override it to port 0. Occupied ingest/chat ports fail startup and close already-started services. An occupied MCP port disables MCP only and appears in Settings; the archive/chat remain available. The app never connects to or stops an unrelated service. External `NEKOCHANNEL_SERVER`/`NEKOCHANNEL_AGENT_URL` routing is no longer used.

MCP requires `Authorization: Bearer <key>` for every RPC. A random encrypted key is generated on first boot; copy it only with the explicit Settings action. Tools: search messages, chat history, list chats (with JID and WhatsApp number), unread summary, group members, overview, `send_message` (OFF unless enabled in Settings; per-message confirmation) and `wa_action` (separate Settings switch; per-action confirmation, rate limited). Ingest/chat trust local clients; do not expose them through a tunnel or untrusted browser proxy. Webhook/reminder forwarding requires explicit configuration and enablement in Settings.

## Explicit legacy SQLite import

No automatic discovery, symlink or shared live database. On a **fresh destination** (no `data/wa.sqlite`), set `NEKOCHANNEL_IMPORT_SQLITE` to the legacy SQLite path for one launch. The source is opened **read-only**, integrity/schema checked, and snapshotted with SQLite's online backup API, including committed WAL rows. A separate `legacy-backup-*.sqlite` is kept beside the new DB; schema upgrades happen only on the imported copy. Existing destination DBs are refused, never merged or overwritten. Remove the import variable after success; repeating it deliberately fails closed.

The old database, checkout and running services are never edited, deleted, stopped or retired automatically. Use different free ports while both apps run. For rollback, quit Nekochannel and retain its data directory separately; the original setup remains untouched. Legacy JSONL files are not imported by this explicit SQLite path.

## Verification

`npm test` covers capture/send regressions, copied archive/chat/MCP suites, lifecycle, restart persistence, port conflicts, WAL import, corruption/overwrite refusal and config precedence. For an isolated real-Electron endpoint/UI smoke (never use your normal profile):

```sh
XDG_CONFIG_HOME="$(mktemp -d)" NEKOCHANNEL_BACKEND_SMOKE=1 \
  NEKOCHANNEL_INGEST_PORT=0 NEKOCHANNEL_CHAT_PORT=0 NEKOCHANNEL_MCP_PORT=0 npm start
```

On headless Linux add `-- --ozone-platform=headless --disable-gpu`. This verifies actual Electron SQLite ingest/dedupe, UI rendering, MCP auth/search and unconfigured chat; a configured test provider also exercises SSE/tool calling. It does not certify live WhatsApp delivery or a production LLM provider.

## License / publication

Private, **UNLICENSED**; no distribution permission is granted here and no final license has been selected. See [provenance and publication gates](docs/provenance.md). Publication requires ownership/license review and a private history/secret audit first. No history rewrite or visibility change is part of this implementation.
