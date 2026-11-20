'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { load, save, DEFAULTS } = require('../shell/settings');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nkc-settings-'));

test('load: default saat file tidak ada / rusak; save→load roundtrip', () => {
  const dir = tmp();
  assert.deepEqual(load(dir), DEFAULTS);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{bukan json');
  assert.deepEqual(load(dir), DEFAULTS);
  save(dir, { notif: false, lang: 'en', agentDock: true, sidebarCollapsed: true, llm: { url: 'x' } }); // llm memang tidak persist di sini
  assert.deepEqual(load(dir), { reader: true, notif: false, lang: 'en', agentDock: true, sidebarCollapsed: true, settingsSection: 'general', sendEnabled: false, actionsEnabled: false, privacy: DEFAULTS.privacy });
  save(dir, { notif: true, lang: 'de' }); // bahasa tak dikenal → id, dock default off
  assert.deepEqual(load(dir), { reader: true, notif: true, lang: 'id', agentDock: false, sidebarCollapsed: false, settingsSection: 'general', sendEnabled: false, actionsEnabled: false, privacy: DEFAULTS.privacy });
});

test('sidebarCollapsed (#18): default false; persist true↔false untuk rail collapse', () => {
  const dir = tmp();
  assert.equal(load(dir).sidebarCollapsed, false);
  save(dir, { sidebarCollapsed: true });
  assert.equal(load(dir).sidebarCollapsed, true);
  save(dir, { sidebarCollapsed: false });
  assert.equal(load(dir).sidebarCollapsed, false);
});

test('settingsSection (#27): valid sidebar persist; invalid → general', () => {
  const dir = tmp();
  assert.equal(load(dir).settingsSection, 'general');
  save(dir, { settingsSection: 'integrations' });
  assert.equal(load(dir).settingsSection, 'integrations');
  save(dir, { settingsSection: 'xss' });
  assert.equal(load(dir).settingsSection, 'general');
});

test('sendEnabled: default OFF, hanya true persis yang ON, action lama (auto-reply) dibuang', () => {
  const dir = tmp();
  assert.equal(DEFAULTS.sendEnabled, false);
  assert.equal(load(dir).sendEnabled, false);
  save(dir, { sendEnabled: true });
  assert.equal(load(dir).sendEnabled, true);
  save(dir, { sendEnabled: 'true' });
  assert.equal(load(dir).sendEnabled, false);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ sendEnabled: 1, action: { master: true, accounts: { 'whatsapp-1': true } } }));
  const loaded = load(dir);
  assert.equal(loaded.sendEnabled, false);
  assert.ok(!('action' in loaded));
  save(dir, loaded);
  assert.ok(!('action' in JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))));
});

test('actionsEnabled (#29 wa_action): default OFF, hanya true persis yang ON, terpisah dari sendEnabled', () => {
  const dir = tmp();
  assert.equal(DEFAULTS.actionsEnabled, false);
  assert.equal(load(dir).actionsEnabled, false);
  save(dir, { actionsEnabled: true });
  assert.deepEqual([load(dir).actionsEnabled, load(dir).sendEnabled], [true, false]);
  save(dir, { actionsEnabled: 1, sendEnabled: true });
  assert.deepEqual([load(dir).actionsEnabled, load(dir).sendEnabled], [false, true]);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ actionsEnabled: 'true', action: { master: true, manualAccounts: { 'whatsapp-1': true } } }));
  assert.equal(load(dir).actionsEnabled, false); // izin per akun lama (#29 versi Action) tidak ikut menyalakan
});
