'use strict';
// Real-Electron smoke for the send_message tool (MCP → confirmation → account view).
// Isolated userData + ephemeral ports; the native dialog is stubbed inside the app.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
assert.ok(process.env.TMPDIR, 'TMPDIR required');
// Prefix wajib reader-smoke fixture (dipakai ulang untuk view WA palsu).
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'neko-reader-electron-send-'));
fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify([1, 2].map(n => ({ channel: 'whatsapp', n, label: `Fixture ${n}` }))));
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ lang: 'en', notif: false }));
try {
  const result = spawnSync(require('electron'), [root], { cwd: root, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, NEKOCHANNEL_USER_DATA: dir, NEKOCHANNEL_SEND_SMOKE: '1',
      NEKOCHANNEL_INGEST_PORT: '0', NEKOCHANNEL_CHAT_PORT: '0', NEKOCHANNEL_MCP_PORT: '0',
      NEKOCHANNEL_ENV: '', NEKOCHANNEL_IMPORT_SQLITE: '', NEKOCHANNEL_BACKEND_SMOKE: '', NEKOCHANNEL_READER_SMOKE: '',
      NEKOCHANNEL_SMOKE: '', NEKOCHANNEL_PRIVACY_SMOKE: '', ELECTRON_RUN_AS_NODE: '' } });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'Electron send smoke failed');
  assert.match(result.stdout, /\[send-smoke\] PASS/);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
