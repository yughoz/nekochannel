'use strict';
// Real-Electron smoke: Agent chat session per channel (switching account tabs).
// Isolated userData + ephemeral ports; reader fixture views supply account JIDs.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
assert.ok(process.env.TMPDIR, 'TMPDIR required');
// Prefix wajib reader-smoke fixture (dipakai ulang untuk view WA palsu).
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'neko-reader-electron-agent-'));
fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify([1, 2].map(n => ({ channel: 'whatsapp', n, label: `Fixture ${n}` }))));
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ lang: 'en', notif: false }));
try {
  const result = spawnSync(require('electron'), [root], { cwd: root, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, NEKOCHANNEL_USER_DATA: dir, NEKOCHANNEL_AGENT_SESSION_SMOKE: '1',
      NEKOCHANNEL_INGEST_PORT: '0', NEKOCHANNEL_CHAT_PORT: '0', NEKOCHANNEL_MCP_PORT: '0',
      NEKOCHANNEL_ENV: '', NEKOCHANNEL_IMPORT_SQLITE: '', NEKOCHANNEL_BACKEND_SMOKE: '', NEKOCHANNEL_READER_SMOKE: '',
      NEKOCHANNEL_SMOKE: '', NEKOCHANNEL_PRIVACY_SMOKE: '', ELECTRON_RUN_AS_NODE: '' } });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'Electron agent-session smoke failed');
  assert.match(result.stdout, /\[agent-session-smoke\] PASS/);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
