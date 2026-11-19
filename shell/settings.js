'use strict';
// Local preferences and write-only LLM config in userData/.env.
const fs = require('node:fs');
const path = require('node:path');
const { backup } = require('./backup');

const DEFAULTS = { notif: true, lang: 'id', agentDock: false, sidebarCollapsed: false, action: { master: false, accounts: {} } };
const LLM_KEYS = ['CHAT_MODEL_URL', 'CHAT_MODEL_NAME', 'CHAT_MODEL_KEY'];
const unquote = v => v.replace(/^["']|["']$/g, '');
// M6: action = { master: bool, accounts: { [accountId]: bool } } — default OFF.
const normAction = a => ({
  master: !!(a && a.master),
  accounts: Object.fromEntries(Object.entries((a && a.accounts) || {}).map(([k, v]) => [k, !!v])),
});

const file = dir => path.join(dir, 'settings.json');
const load = dir => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(dir), 'utf8'));
    return { ...DEFAULTS, ...parsed, action: normAction(parsed.action) };
  }
  catch { return { ...DEFAULTS }; }
};
// Hanya notif+lang+agentDock+sidebarCollapsed+action yang persist di sini; nilai LLM tidak pernah tinggal di settings.json.
const save = (dir, s) => {
  fs.mkdirSync(dir, { recursive: true });
  const f = file(dir);
  fs.writeFileSync(f, JSON.stringify({
    notif: !!s.notif,
    lang: s.lang === 'en' ? 'en' : 'id',
    agentDock: !!s.agentDock,
    sidebarCollapsed: !!s.sidebarCollapsed,
    action: normAction(s.action),
  }, null, 2) + '\n');
  backup(f, path.join(dir, 'backup')); // #13: snapshot tiap perubahan
};

// Baca CHAT_MODEL_* + fallback SUMMARY_MODEL_* dari .env untuk prefill form.
// API key tidak pernah dibalikkan (cuma tanda sudah disimpan).
const readLlm = envPath => {
  const map = {};
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) map[m[1]] = unquote(m[2].trim());
    }
  } catch { /* .env belum ada */ }
  return {
    url: map.CHAT_MODEL_URL || '', name: map.CHAT_MODEL_NAME || '',
    keySet: 'CHAT_MODEL_KEY' in map,
    fbUrl: map.SUMMARY_MODEL_URL || '', fbName: map.SUMMARY_MODEL_NAME || '',
  };
};

// patch: { url?, name?, key? } — undefined = biarkan barisnya; null = hapus
// (fallback ke SUMMARY_MODEL_*); string = tulis. Baris & urutan lain utuh.
const writeLlm = (envPath, patch = {}) => {
  for (const value of Object.values(patch)) {
    if (value !== null && (typeof value !== 'string' || /[\r\n\0]/.test(value))) throw new TypeError('LLM config must be single-line text');
  }
  let lines;
  try { lines = fs.readFileSync(envPath, 'utf8').split('\n'); } catch { lines = []; }
  for (const key of LLM_KEYS) {
    const field = key.slice('CHAT_MODEL_'.length).toLowerCase();
    if (!(field in patch)) continue;
    const i = lines.findIndex(l => l.startsWith(`${key}=`));
    if (patch[field] === null) { if (i >= 0) lines.splice(i, 1); continue; }
    if (i >= 0) lines[i] = `${key}=${patch[field]}`;
    else {
      // sisip sebelum baris kosong ekor (file berakhir \n) supaya trailing newline utuh
      const at = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
      lines.splice(at, 0, `${key}=${patch[field]}`);
    }
  }
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, lines.join('\n'), { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
};

module.exports = { DEFAULTS, file, load, save, readLlm, writeLlm };
