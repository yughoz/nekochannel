# Nekochannel

> One desktop app for all your WhatsApp accounts — with a built-in AI agent over everything it captures.

Nekochannel is an Electron app that puts multiple WhatsApp Web accounts in a single window and turns incoming messages into a durable, queryable archive. It replaces the fragile "browser + extension" capture setup with a native app: isolated accounts, reliable queues, offline recovery, and a chat UI over your own message history.

**Not affiliated with WhatsApp or Meta.** Nekochannel renders WhatsApp Web the same way a browser does — use it in accordance with WhatsApp's terms of service.

## Features

### Multi-account
- Many accounts, one window — each runs in an isolated Chromium partition
- QR login; sessions persist across restarts (scan once per account)
- All accounts stay live simultaneously — capture keeps running for hidden/background views
- Per-account status badges, custom icons (or colored initials), rename via right-click
- Drag-to-reorder sidebar, collapsible icon-only mode, quick switcher (`Ctrl+K`)

### Reliable capture
- Per-account durable queue (append-before-ack) with flush retry + exponential backoff
- At-least-once delivery and dedupe on `(account, message id)` — no loss, no duplicates
- Backfill driver: after a long offline gap it recovers missed messages with checkpoints, pacing and cooldowns
- Renderer crash auto-recovery with reload backoff — capture survives UI crashes

### Built-in AI agent
- Agent tab embeds a self-hosted chat UI over your captured history
- Dockable right-hand pane: talk to the agent while watching the account it references
- Bring your own LLM — provider/model/key configured in Settings, stored locally

### External agent access
- Ships an MCP server so external AI agents can query the captured archive

### Desktop integration
- Tray with close-to-tray — capture continues with the window closed
- Autostart on login; dark mode (follows system); English + Bahasa Indonesia
- Per-account desktop notifications with global mute
- Single-instance lock; automatic rotating backups of local config

### Privacy mode *(planned)*
- Blur names, profile photos, message previews and chat content (master switch + per-target toggles, hotkey)
- Screen lock with password and optional auto-lock on idle

### Roadmap
- **Agent actions** — AI auto-replies within strict limits (master switch default **off**, per-account toggle, text-only, rate-limited, audited)
- **Email adapter** — Gmail as a second channel behind the same shell

## Architecture

- One main process owns the capture transport (queue → flush), the backfill driver, and settings
- One `WebContentsView` per account; the capture engine is injected directly into each view — no MV3 service worker, no content-script cache bugs
- Built-in services (started with the app, ports configurable):
  - **Ingest API** (default `:4317`) — `POST /ingest {account, messages[]}`, dedupe by primary key, `/health`
  - **Agent chat server** (default `:4318`) — serves the embedded chat UI and LLM bridge
  - **MCP server** — query access for external agents
- Channel-generic shell: per-channel adapters (`adapters/whatsapp` today, email next)
- Capture is **read-only** — no sending/typing/clicking from code unless you explicitly enable agent actions

## Getting started

Requirements: Node.js 20+ and npm. A display is required (it's a desktop app).

```bash
git clone https://github.com/yughoz/nekochannel
cd nekochannel
npm install
npm start        # run the app
npm test         # unit tests
npm run dist     # package installers (AppImage / NSIS / dmg)
```

First run: click **Add account**, scan the QR with the phone. Open **Settings** to configure an LLM provider — the Agent tab needs one to answer.

Runtime data lives in the OS user-data directory: `accounts.json` (accounts, icons, order), `settings.json` (LLM, language, preferences), per-account queue files, and rotating config backups. Server/agent endpoints can be overridden with environment variables for self-hosted setups.

## Status

Early and moving fast — APIs and data layout may change between versions. Used daily in production by the author, but treat releases as beta.

## License

TBD — will be released under a permissive license (MIT/Apache-2.0).
