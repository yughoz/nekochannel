'use strict';
// #13: backup otomatis tiap perubahan config. Rotasi ~5 terakhir.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../shell/accounts');
const settings = require('../shell/settings');
const { backup } = require('../shell/backup');

const tick = () => new Promise(r => setTimeout(r, 2)); // timestamp ms unik per backup

test('backup copies content + rotates to last 5', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-bak-'));
  const src = path.join(dir, 'accounts.json');
  fs.writeFileSync(src, '{"i":-1}');
  for (let i = 0; i < 8; i++) {
    backup(src, dir);
    fs.writeFileSync(src, `{"i":${i}}`);
    await tick();
  }
  const bak = fs.readdirSync(dir).filter(f => f.startsWith('accounts.json.')).sort();
  assert.equal(bak.length, 5);
  // backup k mengcopy isi sebelum write k (i=k-1) → tersisa i=2..6
  assert.equal(fs.readFileSync(path.join(dir, bak[0]), 'utf8'), '{"i":2}');
  assert.equal(fs.readFileSync(path.join(dir, bak.at(-1)), 'utf8'), '{"i":6}');
});

test('store.add leaves a restorable accounts.json backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-cfg-'));
  const added = store.add(path.join(dir, 'accounts.json'), [], 'whatsapp', 'wa');
  const bakDir = path.join(dir, 'backup');
  const [bak] = fs.readdirSync(bakDir).filter(f => f.startsWith('accounts.json.'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bakDir, bak), 'utf8')), [added]);

  // jalur restore: file hidup hilang/korup → salin backup balik → load sama
  fs.rmSync(path.join(dir, 'accounts.json'));
  fs.copyFileSync(path.join(bakDir, bak), path.join(dir, 'accounts.json'));
  assert.deepEqual(store.load(path.join(dir, 'accounts.json')), [added]);
});

test('settings.save leaves a restorable settings.json backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-cfg-'));
  settings.save(dir, { notif: false, lang: 'en', agentDock: true });
  const [bak] = fs.readdirSync(path.join(dir, 'backup')).filter(f => f.startsWith('settings.json.'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'backup', bak), 'utf8')),
    { reader: true, notif: false, lang: 'en', agentDock: true, sidebarCollapsed: false, settingsSection: 'general', action: { master: false, accounts: {} }, privacy: settings.DEFAULTS.privacy });
});
