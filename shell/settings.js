'use strict';
// Local non-secret preferences. Integrations live in integrations.enc.
const fs = require('node:fs');
const path = require('node:path');
const { backup } = require('./backup');
const privacy = require('./privacy');

const DEFAULTS = { reader: true, notif: true, lang: 'id', agentDock: false, sidebarCollapsed: false, action: { master: false, accounts: {} }, privacy: privacy.DEFAULTS };
// M6: action = { master: bool, accounts: { [accountId]: bool } } — default OFF.
const normAction = a => ({
  master: !!(a && a.master),
  accounts: Object.fromEntries(Object.entries((a && a.accounts) || {}).map(([k, v]) => [k, !!v])),
});

const file = dir => path.join(dir, 'settings.json');
const load = dir => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(dir), 'utf8'));
    return { ...DEFAULTS, ...parsed, reader: parsed.reader !== false, action: normAction(parsed.action), privacy: privacy.normalize(parsed.privacy) };
  }
  catch { return { ...DEFAULTS, action: normAction(), privacy: privacy.normalize() }; }
};
// Preferensi lokal saja; nilai LLM tidak pernah tinggal di settings.json.
const save = (dir, s) => {
  fs.mkdirSync(dir, { recursive: true });
  const f = file(dir);
  fs.writeFileSync(f, JSON.stringify({
    reader: s.reader !== false,
    notif: !!s.notif,
    lang: s.lang === 'en' ? 'en' : 'id',
    agentDock: !!s.agentDock,
    sidebarCollapsed: !!s.sidebarCollapsed,
    action: normAction(s.action),
    privacy: privacy.normalize(s.privacy),
  }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(f, 0o600);
  backup(f, path.join(dir, 'backup')); // #13: snapshot tiap perubahan
};

module.exports = { DEFAULTS, file, load, save };
