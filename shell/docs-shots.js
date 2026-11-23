'use strict';
// Screenshot dokumentasi (docs/img) dari profil TERISOLASI berisi data contoh saja —
// bukan dari app harian owner, jadi tidak ada chat/nama asli yang ikut ter-commit.
// Jalankan: node scripts/docs-shots.js
const fs = require('node:fs');
const path = require('node:path');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout, label) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await check()) return; } catch { /* belum siap */ } await pause(150); }
  throw new Error(`docs-shots timeout: ${label}`);
}
const evaluate = (wc, code) => wc.executeJavaScript(code, true);
const SAMPLE_SUMMARY = [
  '**Grup Contoh Tim Gudang**',
  '- Topik: jadwal bongkar muat Senin dipindah ke pukul 09.00.',
  '- Keputusan: stok kardus dipesan 200 lembar lewat vendor biasa.',
  '- Belum terjawab: siapa yang piket Sabtu depan?',
  '- Menyebut kamu: Andi minta konfirmasi invoice Oktober.',
  '',
  '**Grup Contoh Keluarga**',
  '- tidak ada aktivitas',
].join('\n');

module.exports = async function docsShots({ win, agent, settingsView, openSettings, setActive, backend, invalidateLookup, dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const shot = async (wc, name) => fs.writeFileSync(path.join(dir, `${name}.png`), (await wc.capturePage()).toPNG());
  await until(() => evaluate(settingsView.wc, '!!window.neko && !!document.getElementById("schedule-list")'), 20000, 'settings renderer');
  await until(() => evaluate(agent.wc, '!!globalThis.__nekoScheduled'), 20000, 'agent panel');

  // Panel WA Engine: contoh percakapan + hasil jadwal (semua teks contoh).
  setActive('agent');
  await pause(800);
  await evaluate(agent.wc, `(() => {
    const key = [...__nekoSessions.keys()][0] || 'default';
    const s = __nekoSessions.get(key);
    const row = (cls, text) => { const el = document.createElement('div'); el.className = 'row ' + cls; el.innerHTML = chatUI.renderRich(text); s.pane.appendChild(el); };
    row('user', 'Ada yang perlu aku tindak lanjuti dari grup kerja hari ini?');
    row('agent', 'Dari arsip hari ini ada 2 hal:\\n- **Grup Contoh Tim Gudang**: Andi minta konfirmasi invoice Oktober.\\n- **Grup Contoh Vendor**: penawaran harga kardus menunggu jawabanmu.');
    __nekoScheduled({ key, name: 'Rangkum grup pagi', status: 'ok', text: ${JSON.stringify(SAMPLE_SUMMARY)} });
    return true;
  })()`);
  await evaluate(agent.wc, `document.getElementById('modelinfo').textContent = 'model-contoh · 12.480 pesan'; document.getElementById('dot').className = 'ok'; true`); // profil contoh tanpa LLM
  await pause(500);
  await shot(agent.wc, 'wa-engine');

  // Arsip contoh: beberapa grup supaya daftar centang Jadwal Agent terisi (data fiktif).
  const sample = [['Grup Contoh Tim Gudang', 14], ['Grup Contoh Keluarga', 6], ['Grup Contoh Vendor', 9], ['Grup Contoh Arisan RT', 3]];
  const messages = sample.flatMap(([chat, n], gi) => Array.from({ length: n }, (_, i) => ({ id: `docs-${gi}-${i}`, chat, sender: 'Contoh', text: 'pesan contoh', timestamp: new Date(Date.now() - (gi * 3 + i) * 3600e3).toISOString(), isGroup: true, fromMe: false })));
  await fetch(`${backend.ingestUrl}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: '6281200000001@c.us', messages }) });
  await until(async () => { invalidateLookup(); return (await evaluate(settingsView.wc, 'window.neko.getSettings()')).scheduleGroups?.length >= sample.length; }, 15000, 'sample groups archived');
  await evaluate(settingsView.wc, `window.neko.saveSettings({ schedules: { items: [{ id: 'j-contoh', name: 'Rangkum grup pagi', enabled: true, time: '07:00', account: '6281200000001@c.us', chats: ['Grup Contoh Tim Gudang', 'Grup Contoh Keluarga'], prompt: 'Fokus ke hal yang perlu aku tindak lanjuti.', sendSelf: true }] } }).then(p => { P = p; renderSchedules(); return true; })`);

  // Settings per section (bahasa Indonesia), dengan contoh jadwal di profil temp.
  openSettings();
  await until(() => settingsView.view.getVisible(), 5000, 'settings open');
  await evaluate(settingsView.wc, `window.neko.saveSettings({ lang: 'id' })`);
  await pause(600);
  for (const [key, name] of [['general', 'settings-umum'], ['reader', 'settings-reader'], ['privacy', 'settings-privasi'], ['integrations', 'settings-integrasi'], ['llm', 'settings-llm-agent'], ['schedule', 'settings-jadwal'], ['about', 'settings-tentang']]) {
    await evaluate(settingsView.wc, `document.getElementById('nav-${key}').click()`);
    await until(() => evaluate(settingsView.wc, `!document.getElementById('panel-${key}').hidden`), 5000, `show ${key}`);
    await evaluate(settingsView.wc, `document.querySelector('main').scrollTop = 0; true`);
    // Jangan bocorkan jaringan mesin pembuat docs: IP Tailscale asli & port ephemeral → nilai contoh.
    await evaluate(settingsView.wc, `(() => {
      const ip = document.getElementById('mcp-tailscale'); if (ip) ip.textContent = ip.textContent.replace(/100\\.\\d+\\.\\d+\\.\\d+/g, '100.64.0.1');
      const st = document.getElementById('integrations-status'); st.textContent = st.textContent.replace(/127\\.0\\.0\\.1:\\d+/g, '127.0.0.1:4319'); st.title = '';
      return true; })()`);
    await pause(300);
    // capturePage bisa mengambil frame lama → tunggu frame baru tergambar (2 rAF) + jeda.
    await evaluate(settingsView.wc, 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
    await pause(500);
    await shot(settingsView.wc, name);
  }
  console.log(`[docs-shots] PASS ${fs.readdirSync(dir).filter(file => file.endsWith('.png')).length} screenshots → ${dir}`);
};
