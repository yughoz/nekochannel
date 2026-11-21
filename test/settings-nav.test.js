'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const html = fs.readFileSync('shell/settings.html', 'utf8');
const js = fs.readFileSync('shell/settings.js', 'utf8');
const i18n = fs.readFileSync('shell/i18n.js', 'utf8');

const panels = ['general', 'reader', 'privacy', 'integrations', 'llm', 'schedule', 'about'];
test('#27 settings sidebar: same-DOM panels (+ #31 Jadwal), keyboard, persistence, i18n', () => {
  for (const key of panels) {
    assert.ok(html.includes(`id="panel-${key}"`) && html.includes(`id="nav-${key}"`), key);
  }
  assert.match(html, /nav\[aria-label\] \{ flex: 0 0 220px;/);
  assert.match(html, /section\[hidden\] \{ display: none !important; \}/);
  assert.match(html, new RegExp(String.raw`if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); setTimeout\(\(\) => window\.neko\.openSettings\(\)\); return; \}`));
  assert.match(html, /\/\^Digit\[1-7\]\$\/\.test\(e\.code\)/);
  assert.match(html, /navBox\.addEventListener\('keydown', e => \{/);
  assert.match(html, /saveSettings\(\{ settingsSection: id \}\)/);
  for (const key of ['secGeneral', 'secReader', 'secPrivacy', 'integrationsTitle', 'secLlm', 'secSchedule', 'secAbout']) {
    assert.match(i18n, new RegExp(`${key}:\\s*['"]([^'"]+)['"]`, 'g'));
  }
  assert.match(html, /id="settings-close"/);
  assert.match(html, /\$\('settings-close'\)\.onclick = \(\) => window\.neko\.openSettings\(\);/);
  assert.match(js, /settingsSection: SECTIONS\.includes\(parsed\.settingsSection\)/);
  assert.doesNotMatch(html, /location\.reload|window\.open|history\./);
});
