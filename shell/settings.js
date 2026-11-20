'use strict';
// Local non-secret preferences. Integrations live in integrations.enc.
const fs = require('node:fs');
const path = require('node:path');
const { backup } = require('./backup');
const privacy = require('./privacy');

const SECTIONS = ['general', 'reader', 'privacy', 'integrations', 'llm', 'about'];
// sendEnabled: izin tool send_message (Agent WA Engine + MCP); actionsEnabled: izin tool
// wa_action (#29 aksi chat). Dua-duanya default OFF, hanya diubah manual di Settings.
const DEFAULTS = { reader: true, notif: true, lang: 'id', agentDock: false, sidebarCollapsed: false, settingsSection: 'general', sendEnabled: false, actionsEnabled: false, privacy: privacy.DEFAULTS };

const file = dir => path.join(dir, 'settings.json');
const load = dir => {
  try {
    const { action: _removedAutoReply, ...parsed } = JSON.parse(fs.readFileSync(file(dir), 'utf8')); // Action auto-reply dihapus
    return { ...DEFAULTS, ...parsed, reader: parsed.reader !== false, sendEnabled: parsed.sendEnabled === true, actionsEnabled: parsed.actionsEnabled === true, settingsSection: SECTIONS.includes(parsed.settingsSection) ? parsed.settingsSection : 'general', privacy: privacy.normalize(parsed.privacy) };
  }
  catch { return { ...DEFAULTS, settingsSection: 'general', privacy: privacy.normalize() }; }
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
    settingsSection: SECTIONS.includes(s.settingsSection) ? s.settingsSection : 'general',
    sendEnabled: s.sendEnabled === true,
    actionsEnabled: s.actionsEnabled === true,
    privacy: privacy.normalize(s.privacy),
  }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(f, 0o600);
  backup(f, path.join(dir, 'backup')); // #13: snapshot tiap perubahan
};

module.exports = { DEFAULTS, file, load, save };
