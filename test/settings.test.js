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
  assert.deepEqual(load(dir), { reader: true, notif: false, lang: 'en', agentDock: true, sidebarCollapsed: true, settingsSection: 'general', action: { master: false, accounts: {} }, privacy: DEFAULTS.privacy });
  save(dir, { notif: true, lang: 'de' }); // bahasa tak dikenal → id, dock default off
  assert.deepEqual(load(dir), { reader: true, notif: true, lang: 'id', agentDock: false, sidebarCollapsed: false, settingsSection: 'general', action: { master: false, accounts: {} }, privacy: DEFAULTS.privacy });
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
