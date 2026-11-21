'use strict';
// Screenshot dokumentasi → docs/img. Profil Electron TERISOLASI berisi data contoh saja
// (akun "Kerja"/"Pribadi", satu jadwal contoh, percakapan contoh) — bukan app harian owner.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'docs', 'img');
assert.ok(process.env.TMPDIR, 'TMPDIR required');
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'neko-docs-shots-'));
fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify([{ channel: 'whatsapp', n: 1, label: 'Kerja' }, { channel: 'whatsapp', n: 2, label: 'Pribadi' }]));
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ lang: 'id', notif: false, schedules: { enabled: true, items: [
  { id: 'j-contoh', name: 'Rangkum grup pagi', enabled: true, time: '07:00', account: '', chats: ['Grup Contoh Tim Gudang', 'Grup Contoh Keluarga'], prompt: 'Fokus ke hal yang perlu aku tindak lanjuti.' },
] } }));
try {
  const result = spawnSync(require('electron'), [root], { cwd: root, encoding: 'utf8', timeout: 300000,
    env: { ...process.env, NEKOCHANNEL_USER_DATA: dir, NEKOCHANNEL_DOCS_SHOTS: out,
      NEKOCHANNEL_INGEST_PORT: '0', NEKOCHANNEL_CHAT_PORT: '0', NEKOCHANNEL_MCP_PORT: '0',
      NEKOCHANNEL_ENV: '', NEKOCHANNEL_IMPORT_SQLITE: '', NEKOCHANNEL_BACKEND_SMOKE: '', NEKOCHANNEL_READER_SMOKE: '',
      NEKOCHANNEL_SMOKE: '', NEKOCHANNEL_PRIVACY_SMOKE: '', ELECTRON_RUN_AS_NODE: '' } });
  process.stdout.write((result.stdout || '').split('\n').filter(line => line.includes('docs-shots')).join('\n') + '\n');
  process.stderr.write(result.stderr && result.status ? result.stderr : '');
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'docs shots failed');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
