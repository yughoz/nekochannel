'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const base = process.env.TMPDIR;
assert.ok(base && path.resolve(base) !== '/tmp', 'TMPDIR must be a scratch directory, not /tmp');
const dir = fs.mkdtempSync(path.join(base, 'neko-privacy-electron-'));
console.log('Isolated userData:', dir);
try {
  for (const phase of ['first', 'restart']) {
    const result = spawnSync(require('electron'), [root], {
      cwd: root, encoding: 'utf8', timeout: 180000,
      env: { ...process.env, NEKOCHANNEL_USER_DATA: dir, NEKOCHANNEL_PRIVACY_SMOKE: phase,
        NEKOCHANNEL_INGEST_PORT: '0', NEKOCHANNEL_CHAT_PORT: '0', NEKOCHANNEL_MCP_PORT: '0',
        NEKOCHANNEL_IMPORT_SQLITE: '', NEKOCHANNEL_BACKEND_SMOKE: '', NEKOCHANNEL_SMOKE: '' },
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    assert.ifError(result.error);
    assert.equal(result.status, 0, `Electron ${phase} failed`);
    assert.match(result.stdout, new RegExp(`\\[privacy-smoke\\] PASS ${phase}`));
  }
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
