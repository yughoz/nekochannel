'use strict';
// Real-Electron smoke for the wa_action tool (MCP → gates → account view fixture).
// Isolated userData + ephemeral ports; native dialog is stubbed inside the app.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
assert.ok(process.env.TMPDIR, 'TMPDIR required');
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'neko-reader-electron-wa-actions-'));
fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify([1, 2].map(n => ({ channel: 'whatsapp', n, label: `Fixture ${n}` }))));
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ lang: 'en', notif: false }));
fs.writeFileSync(path.join(dir, 'action-upload.png'), Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
  '0d0a2db40000000049454e44ae426082', 'hex'));
try {
  const result = spawnSync(require('electron'), [root], { cwd: root, encoding: 'utf8', timeout: 300000,
    env: { ...process.env, NEKOCHANNEL_USER_DATA: dir, NEKOCHANNEL_WA_ACTIONS_SMOKE: '1',
      NEKOCHANNEL_INGEST_PORT: '0', NEKOCHANNEL_CHAT_PORT: '0', NEKOCHANNEL_MCP_PORT: '0',
      NEKOCHANNEL_ENV: '', NEKOCHANNEL_IMPORT_SQLITE: '', NEKOCHANNEL_BACKEND_SMOKE: '', NEKOCHANNEL_READER_SMOKE: '',
      NEKOCHANNEL_SMOKE: '', NEKOCHANNEL_PRIVACY_SMOKE: '', ELECTRON_RUN_AS_NODE: '' } });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'Electron wa-actions smoke failed');
  assert.match(result.stdout, /\[wa-actions-smoke\] PASS/);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
