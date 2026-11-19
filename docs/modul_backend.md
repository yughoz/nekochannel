# Backend standalone — #22

Approved merge: Electron owns `backend/server`, `backend/chat` (including `ui/`) and `backend/mcp`. They are copied first-party wa-reader code, now maintained here. No sync script or runtime reference to the old checkout. The existing capture bridge/queue/backfill and separate action sender retain their contracts.

## Lifecycle

`app.whenReady` → `startBackend(userData)` → archive writer/ingest → read-only chat → read-only MCP → window/views/driver. Actual bound addresses are passed directly to the driver and Agent view. All listeners bind 127.0.0.1. Defaults 4317/4318/4319; validated port overrides, 0 allowed for isolation. Bind errors roll back previously started listeners and abort app startup, never reuse an unrelated service. Before quit: stop consumers and close MCP/chat/writer in reverse order, then exit. No external process launcher or new npm dependency.

SQLite is `node:sqlite`, supplied by Electron; host Node tests alone are insufficient proof. Data lives at `userData/data/wa.sqlite`. Existing PK/FTS5/unread/group-member schema and validation are retained. Upstream scheduled webhook forwarding is not configured by the lifecycle wrapper, preventing inherited environment from dispatching external events.

## Configuration / defaults

`NEKOCHANNEL_ENV` selects an optional file; app-data `.env` overrides it; process values override both. Settings writes only app-data `.env` (0600) and redacts the key on reads. Restart the app to apply chat config. Without a provider the UI and health remain available (`configured:false`), and chat requests get 503; no model probe is attempted. MCP always requires bearer auth; random persistent 0600 key unless explicitly configured. Actions master/per-account remain OFF on fresh stores.

## Explicit migration

`NEKOCHANNEL_IMPORT_SQLITE` is opt-in, before opening destination services. Refuse any existing destination. Open source read-only, quick-check and require messages table; native SQLite online backup produces a committed snapshot (including WAL), retain separate backup, atomically publish with no-clobber hard link. Only the copy is upgraded by the archive loader. Corrupt/nonarchive sources fail without publishing a destination. Remove import option after success. No scanning personal directories, no old service shutdown, no old database writes/deletion, no copying `.env` from the old repo. Import does not merge into an existing archive.

## Acceptance evidence

`test/backend.test.js`: real HTTP ingest/dedupe, UI, unconfigured chat, MCP unauthorized/search, restart persistence, occupied-port rollback, WAL migration/backup/refusal and env precedence. Copied source suites cover schema migrations, SQL tools and function-calling/SSE with deterministic providers. `shell/backend-smoke.js` exercises the same lifecycle from actual Electron main and loads UI in a real BrowserWindow. Headless execution is transport/render proof, not interactive multi-account WhatsApp or production-provider acceptance.

Executed verification for #22: `npm test` = 178 passed, 0 failed. Actual Electron 45.3.4 / SQLite 3.54.1 headless main-process smoke passed ingest=1, duplicate replay, BrowserWindow UI, MCP auth 403/search=1, chat 503 without config. With an explicit local deterministic OpenAI-compatible fixture: two HTTP model rounds, SQL search tool result count=1 and SSE done (chat 200); no production model credential involved. Separate full-shell boot asserted first-run account=1 and internal health, loaded Agent UI and injected the WA reader on the login page, then exited 0. Interactive QR login/multi-account delivery, real-provider answers and target-OS packaging were not rerun for this merge. Headless GPU initialization initially failed without `--disable-gpu`; that flag resolved it.

See README for reproducible configuration/import commands and provenance.md for publication gates.
