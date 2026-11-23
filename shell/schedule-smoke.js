'use strict';
// #31 smoke (Electron asli, userData temp): Settings → simpan jadwal (validasi ketat) →
// "Jalankan sekarang" → runner → /api/chat (tanpa LLM = 503) → status/log/state +
// hasil disuntik ke panel WA Engine; IPC schedule-run ditolak dari sender non-Settings.
const assert = require('node:assert/strict');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout, label) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await check()) return; } catch { /* belum siap */ } await pause(150); }
  throw new Error(`schedule smoke timeout: ${label}`);
}
const evaluate = (wc, code) => wc.executeJavaScript(code, true);

module.exports = async function scheduleSmoke({ win, agent, settingsView, backend, invalidateLookup }) {
  await until(() => evaluate(settingsView.wc, '!!window.neko && !!document.getElementById("schedule-list")'), 20000, 'settings renderer');
  await until(() => evaluate(agent.wc, '!!globalThis.__nekoScheduled'), 20000, 'agent panel');
  const settings = code => evaluate(settingsView.wc, code);
  const item = { id: 'j-smoke', name: 'Smoke rangkum', enabled: true, time: '07:00', account: '', chats: ['Fixture'], prompt: '' };

  const saved = await settings(`window.neko.saveSettings(${JSON.stringify({ schedules: { enabled: false, items: [item] } })})`);
  assert.equal(saved.error, undefined, JSON.stringify(saved.error));
  assert.deepEqual(saved.schedules.items.map(entry => entry.id), ['j-smoke']);
  assert.equal(saved.schedules.enabled, false); // master default OFF tetap OFF
  const invalid = await settings(`window.neko.saveSettings(${JSON.stringify({ schedules: { items: [{ ...item, id: 'Bad Id' }] } })})`);
  assert.ok(invalid.error, 'invalid schedule must be rejected');
  assert.deepEqual((await settings('window.neko.getSettings()')).schedules.items.map(entry => entry.id), ['j-smoke']);

  // Sender bukan halaman Settings → ditolak.
  const untrusted = await evaluate(win.webContents, `window.neko.runSchedule('j-smoke')`);
  assert.match(String(untrusted?.error), /untrusted/);

  const run = await settings(`window.neko.runSchedule('j-smoke')`);
  assert.equal(run.status, 'failed'); // profil temp tanpa LLM → /api/chat 503
  assert.match(run.detail, /503/);
  const after = await settings('window.neko.getSettings()');
  assert.equal(after.scheduleState['j-smoke'].lastStatus, 'failed');
  assert.equal(after.scheduleRuns[0].id, 'j-smoke');
  assert.equal(after.scheduleRuns[0].manual, true);
  await until(() => evaluate(agent.wc, `[...globalThis.__nekoSessions.values()].some(s => s.pane.textContent.includes('Jadwal · Smoke rangkum'))`), 5000, 'result in WA Engine panel');
  await until(() => settings(`document.getElementById('schedule-runs').textContent.includes('Smoke rangkum')`), 5000, 'run listed in Settings');
  // Jadwal tersimpan tampil di daftar (regresi: draf dari render pertama sebelum settings tiba = daftar kosong).
  await until(() => settings(`document.getElementById('sched-0-name')?.value === 'Smoke rangkum'`), 5000, 'saved schedule listed in Settings');
  // Akun & grup dari arsip: dropdown Akun terisi walau WA belum connected; grup = daftar centang (UI asli).
  const ingest = await fetch(`${backend.ingestUrl}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: '628111000001@c.us', messages: [{ id: 'schedule-smoke-1', chat: 'Grup Smoke Gudang', sender: 'Fixture', text: 'pesan contoh', timestamp: new Date().toISOString(), isGroup: true, fromMe: false }] }) });
  assert.equal(ingest.status, 202);
  await until(async () => { invalidateLookup(); const p = await settings('window.neko.getSettings()'); return p.scheduleGroups?.some(g => g.name === 'Grup Smoke Gudang'); }, 15000, 'group archived');
  await settings('window.neko.getSettings().then(p => { P = p; renderSchedules(); return true; })');
  assert.ok(await settings(`[...document.getElementById('sched-0-account').options].some(o => o.value === '628111000001@c.us')`), 'archive account selectable');
  await settings(`(() => { const s = document.getElementById('sched-0-account'); s.value = '628111000001@c.us'; s.dispatchEvent(new Event('change')); return true; })()`);
  await until(() => settings(`[...document.querySelectorAll('#sched-0-chats label')].some(l => l.textContent.includes('Grup Smoke Gudang'))`), 5000, 'group in checklist');
  await settings(`(() => { const l = [...document.querySelectorAll('#sched-0-chats label')].find(x => x.textContent.includes('Grup Smoke Gudang')); l.querySelector('input').click(); document.getElementById('schedule-save').click(); return true; })()`);
  await until(async () => (await settings('window.neko.getSettings()')).schedules.items[0].chats.includes('Grup Smoke Gudang'), 5000, 'checked group saved');
  const savedItem = (await settings('window.neko.getSettings()')).schedules.items[0];
  assert.equal(savedItem.account, '628111000001@c.us');
  assert.deepEqual(savedItem.chats, ['Fixture', 'Grup Smoke Gudang']); // nama lama (tak ada di arsip) tetap + yang dicentang
  // Validasi per jadwal di UI: jadwal baru tanpa grup & prompt ditolak dengan alasan jelas, tidak terkirim ke main.
  const before = (await settings('window.neko.getSettings()')).schedules.items.length;
  await settings(`(() => { document.getElementById('schedule-add').click(); document.getElementById('schedule-save').click(); return true; })()`);
  await until(() => settings(`document.getElementById('schedule-saved').textContent.includes('Check at least one group')`), 5000, 'per-schedule error shown');
  assert.equal(await settings(`document.querySelectorAll('fieldset.sched.invalid').length`), 1);
  assert.equal((await settings('window.neko.getSettings()')).schedules.items.length, before);
  console.log('[schedule-smoke] PASS Settings save (strict validation, master OFF), untrusted IPC refused, run now → /api/chat → state/log, result injected into WA Engine panel + Settings, archive accounts selectable, group checklist saves, per-schedule validation message');
};
