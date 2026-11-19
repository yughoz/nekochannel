'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
assert.ok(process.env.TMPDIR, 'TMPDIR required');
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'neko-menu-electron-'));
console.log('Isolated userData:', dir);
try {
  const result = spawnSync(require('electron'), [root], {
    cwd: root, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, NEKOCHANNEL_USER_DATA: dir, NEKOCHANNEL_ACCOUNT_MENU_SMOKE: '1',
      NEKOCHANNEL_INGEST_PORT: '0', NEKOCHANNEL_CHAT_PORT: '0', NEKOCHANNEL_MCP_PORT: '0',
      NEKOCHANNEL_IMPORT_SQLITE: '', NEKOCHANNEL_BACKEND_SMOKE: '', NEKOCHANNEL_SMOKE: '' },
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'Electron account-menu smoke failed');
  assert.match(result.stdout, /\[account-menu-smoke\] PASS/);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
