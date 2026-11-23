'use strict';
// Smoke sesi Agent per channel: pindah tab akun → panel chat & riwayat ikut akun,
// tab Agent penuh melanjutkan sesi terakhir, rename tidak menghapus riwayat.
const assert = require('node:assert/strict');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await check()) return; } catch {}
    await pause(100);
  }
  throw new Error(`agent-session smoke timeout: ${label}`);
}
async function evaluate(wc, expression) {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  const result = await wc.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

module.exports = async ({ win, accounts, agent, setActive, settingsView }) => {
  await Promise.all(accounts.map(account => account.injected));
  await until(() => accounts.every(account => account.account), 'accounts detected');
  const wc = agent.wc;
  await until(() => evaluate(wc, `!!globalThis.__nekoSessions && !!document.getElementById('session')`), 'agent chat loaded');
  // Rekam body /api/chat (server tanpa LLM menjawab 503 — cukup untuk uji sesi).
  await evaluate(wc, `(() => { const orig = fetch; globalThis.__bodies = []; globalThis.fetch = (u, o) => { if (String(u).includes('/api/chat')) __bodies.push(JSON.parse(o.body)); return orig(u, o); }; return true; })()`);
  const view = () => evaluate(wc, `({ key: new URLSearchParams(location.hash.slice(1)).get('s'), header: document.getElementById('session').textContent,
    users: [...document.querySelectorAll('#log .row.user')].map(el => el.textContent), streaming: [...__nekoSessions.values()].some(s => s.streaming) })`);
  const ask = async text => {
    await evaluate(wc, `(() => { const input = document.getElementById('input'); input.value = ${JSON.stringify(text)}; document.getElementById('send').click(); return true; })()`);
    await until(async () => { const v = await view(); return v.users.includes(text) && !v.streaming; }, `ask ${text}`);
  };
  const [one, two] = accounts;

  setActive(one.id);
  await until(async () => (await view()).key === one.id, 'session 1');
  const dig1 = one.account.replace(/\D/g, '');
  assert.equal((await view()).header, `· WA ${one.n} · ···${dig1.slice(-4)}`); // privasi default: label disamarkan, nomor tampil 4 digit akhir
  await until(() => evaluate(settingsView.wc, '!!window.neko'), 'settings view');
  await evaluate(settingsView.wc, `window.neko.saveSettings({ privacy: { accountLabels: false } })`);
  await until(async () => (await view()).header === `· ${one.label} · +${dig1}`, 'unmasked header');
  await ask('halo satu');

  setActive(two.id);
  await until(async () => (await view()).key === two.id, 'session 2');
  let v = await view();
  assert.deepEqual({ header: v.header, users: v.users }, { header: `· ${two.label} · +${two.account.replace(/\D/g, '')}`, users: [] }); // sesi baru = kosong
  await ask('halo dua');

  setActive('agent'); // tab Agent penuh → lanjut sesi akun terakhir
  await pause(300);
  v = await view();
  assert.deepEqual({ key: v.key, users: v.users }, { key: two.id, users: ['halo dua'] });

  setActive(one.id);
  await until(async () => (await view()).key === one.id, 'back to session 1');
  assert.deepEqual((await view()).users, ['halo satu']);

  // Rename akun: label sesi ter-update, riwayat sesi tetap.
  await evaluate(win.webContents, `window.neko.rename(${JSON.stringify(one.id)}, 'Toko Satu')`);
  await until(async () => (await view()).header === '· Toko Satu', 'renamed header');
  assert.deepEqual((await view()).users, ['halo satu']);

  const bodies = await evaluate(wc, '__bodies');
  assert.deepEqual(bodies.map(body => [body.account, body.messages.map(m => m.content)]), [[one.account, ['halo satu']], [two.account, ['halo dua']]]);
  // #30: request membawa kunci sesi (persistensi server) + endpoint sesi hidup & same-origin.
  assert.deepEqual(bodies.map(body => body.session), [one.id, two.id]);
  const stored = await evaluate(wc, `fetch('/api/session?key=' + encodeURIComponent(${JSON.stringify(one.id)})).then(async r => ({ status: r.status, body: await r.json() }))`);
  assert.equal(stored.status, 200);
  assert.ok(Array.isArray(stored.body.history));
  assert.equal(await evaluate(wc, `fetch('/api/session?key=' + encodeURIComponent(${JSON.stringify(one.id)}), { method: 'DELETE' }).then(r => r.status)`), 200);
  console.log(`[agent-session-smoke] PASS per-channel sessions: ${one.id}/${two.id} separate panes+history, Agent tab keeps last session, rename keeps history, request carries account + session key, /api/session reachable`);
};
