'use strict';
// Smoke send_message (MCP → konfirmasi → kirim lewat view akun). Fixture WA dari
// reader-smoke; dialog native di-stub HANYA di sini supaya jawaban bisa diatur.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await check()) return; } catch {}
    await pause(100);
  }
  throw new Error(`send smoke timeout: ${label}`);
}
async function evaluate(wc, expression) {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  const result = await wc.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

// DOM WA Web tiruan: selector sama dengan adapters/whatsapp/action.js SEL. Hanya
// baris di viewport yang dirender (seperti WA), judul dibungkus tanda bidi, klik
// dan Enter hanya diterima bila isTrusted (WA memblok event sintetis).
const FAKE_WA = `(() => {
  const H = 72;
  const mk = (id, title, extra = {}) => ({ id: { _serialized: id }, formattedTitle: title, name: extra.name, contact: extra.contact || {}, msgs: { models: [] } });
  const chats = [];
  for (let i = 0; i < 149; i++) chats.push(mk('62811000' + String(i).padStart(4, '0') + '@c.us', 'Kontak ' + i, { name: 'Kontak ' + i }));
  const decoy = mk('620000000001@c.us', 'Dimas Kantor', { name: 'Dimas Kantor' });
  const target = mk('235428766560410@lid', '+62 856-9378-4939', { contact: { pushname: 'Dimas', phoneNumber: { user: '6285693784939' } } });
  chats.splice(1, 0, decoy);
  chats.splice(120, 0, target);
  window.__wa = { chats, target, decoy, opened: [] };
  Object.assign(window.Store.Chat, { models: chats, getModelsArray: () => chats, get: id => chats.find(c => c.id._serialized === id) });
  const style = document.createElement('style');
  style.textContent = '#app{display:flex;height:100vh;font:14px sans-serif}#pane-side{width:320px;height:100vh;overflow-y:auto}[data-testid="chat-list"]{position:relative}[role=row]{position:absolute;left:0;right:0;height:' + H + 'px}[role=gridcell]{display:block;height:' + H + 'px}#main{flex:1;display:flex;flex-direction:column;justify-content:space-between}footer [contenteditable]{min-height:40px;border:1px solid #888}';
  document.head.append(style);
  const app = document.createElement('div'); app.id = 'app';
  const pane = document.createElement('div'); pane.id = 'pane-side';
  const list = document.createElement('div'); list.dataset.testid = 'chat-list'; list.style.height = chats.length * H + 'px';
  const main = document.createElement('div'); main.id = 'main';
  pane.append(list); app.append(pane, main); document.body.replaceChildren(app); document.body.style.margin = '0';
  const open = chat => {
    window.__wa.opened.push(chat.formattedTitle);
    const header = document.createElement('header'); header.dataset.testid = 'conversation-header';
    const name = document.createElement('span'); name.dataset.testid = 'conversation-info-header-chat-title-name'; name.textContent = chat.formattedTitle;
    header.append(name);
    const footer = document.createElement('footer');
    const compose = document.createElement('div'); compose.contentEditable = 'true';
    compose.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || !e.isTrusted) return;
      e.preventDefault();
      if (compose.textContent) { chat.msgs.models.push({ body: compose.textContent }); compose.textContent = ''; }
    });
    const send = document.createElement('button'); send.setAttribute('aria-label', 'Send'); send.textContent = 'Send';
    footer.append(compose, send);
    main.replaceChildren(header, footer);
  };
  const render = () => {
    const first = Math.max(0, Math.floor(pane.scrollTop / H) - 2);
    const last = Math.min(chats.length, Math.ceil((pane.scrollTop + pane.clientHeight) / H) + 2);
    list.replaceChildren(...chats.slice(first, last).map((chat, k) => {
      const row = document.createElement('div'); row.setAttribute('role', 'row'); row.dataset.testid = 'list-item-' + (first + k); row.style.top = (first + k) * H + 'px';
      const cell = document.createElement('div'); cell.setAttribute('role', 'gridcell'); cell.tabIndex = 0;
      const title = document.createElement('span'); title.dataset.testid = 'cell-frame-title'; title.textContent = '\\u202A' + chat.formattedTitle + '\\u202C';
      cell.append(title, document.createTextNode(' 09:13 pesan terakhir 12345'));
      cell.addEventListener('click', e => { if (e.isTrusted) open(chat); });
      row.append(cell);
      return row;
    }));
  };
  pane.addEventListener('scroll', render);
  render();
  return true;
})()`;

module.exports = async ({ app, win, accounts, driver, backend, settingsView }) => {
  const dir = app.getPath('userData');
  await Promise.all(accounts.map(account => account.injected));
  await until(() => accounts[0].status?.state === 'connected' && accounts[0].account, 'account connected');
  const account = accounts[0].account;
  const key = require('./integrations').openStore(dir, electron.safeStorage).get().mcp.key;
  const rpc = async (method, params) => {
    const response = await fetch(`${backend.mcpUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return (await response.json()).result;
  };
  const tool = async (name, args) => {
    const result = await rpc('tools/call', { name, arguments: args });
    let data = result.content[0].text;
    try { data = JSON.parse(data); } catch {}
    return { isError: result.isError, data };
  };
  assert.ok((await rpc('tools/list', {})).tools.some(def => def.name === 'send_message'));

  // Arsip: satu pesan ber-ID format WA (JID chat 99999@c.us) di chat "Fixture" akun 1.
  await evaluate(accounts[0].wc, `dispatchEvent(new CustomEvent('wa-reader-message', {detail:{account:Store.Conn.wid,id:'false_99999@c.us_3EB0SENDSMOKE',chat:'Fixture',sender:'Fixture',text:'send-smoke seed',timestamp:new Date().toISOString(),isGroup:false,fromMe:false}})); true`);
  await until(async () => { await driver.flushNow(); return (await tool('search_messages', { query: 'send-smoke seed' })).data.count === 1; }, 'seed archived');

  const shown = [];
  let answer = () => ({ response: 1 });
  electron.dialog.showMessageBox = async (parent, options) => { shown.push({ parent, options }); return answer(options); };

  // 0) Default OFF: ditolak dengan petunjuk Settings, tanpa dialog. Lalu dinyalakan
  //    manual lewat checkbox asli di Settings > LLM Agent (bukan lewat tool/API lain).
  const off = await tool('send_message', { chat: 'Fixture', text: 'x', account: 'Fixture 1' });
  assert.equal(off.isError, true);
  assert.equal(off.data.status, 'disabled');
  assert.match(off.data.detail, /Settings > LLM Agent/);
  assert.equal(shown.length, 0);
  await until(() => evaluate(settingsView.wc, `!!window.neko && !!document.getElementById('send-label').textContent && document.getElementById('send-enabled').checked === false`), 'send toggle rendered OFF');
  assert.equal(await evaluate(settingsView.wc, `document.getElementById('send-label').textContent`), 'Allow Agent & MCP to send messages');
  await evaluate(settingsView.wc, `document.getElementById('send-enabled').click(); true`);
  await until(async () => (await evaluate(settingsView.wc, 'window.neko.getSettings()')).sendEnabled === true, 'send toggle saved ON');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).sendEnabled, true);

  // Capture asli (page engine → normalize → bridge → driver → ingest) menyimpan JID chat
  // fixture di tabel chats untuk KEDUA akun → nama "Fixture" ambigu tanpa `account`.
  const ambiguous = await tool('send_message', { chat: 'Fixture', text: 'x' });
  assert.match(ambiguous.data, /several accounts; pass account: (?=.*Fixture 1 \(111111@c\.us\))(?=.*Fixture 2 \(211111@c\.us\))/);
  assert.equal((await tool('list_chats', {})).data.chats.find(row => row.chat === 'Fixture').chatId, '99999@c.us');

  // 1) Batal di dialog → cancelled, tidak menyentuh view.
  let out = await tool('send_message', { chat: 'Fixture', text: 'halo dari smoke', account: 'Fixture 1' });
  assert.deepEqual({ isError: out.isError, status: out.data.status }, { isError: false, status: 'cancelled' }, JSON.stringify(out.data));
  assert.equal(shown.length, 1);
  const { parent, options } = shown[0];
  assert.equal(parent, win);
  assert.deepEqual({ buttons: options.buttons, defaultId: options.defaultId, cancelId: options.cancelId }, { buttons: ['Send', 'Cancel'], defaultId: 1, cancelId: 1 });
  assert.equal(options.detail, 'From: Fixture 1\nTo: Fixture (+99999)\nRequested via: MCP\n\nhalo dari smoke'); // nomor dari tabel chats
  assert.ok(options.signal instanceof AbortSignal);

  // 2) Selama satu dialog terbuka, permintaan lain langsung ditolak (tidak menumpuk dialog).
  let release;
  answer = () => new Promise(resolve => { release = () => resolve({ response: 1 }); });
  const pending = tool('send_message', { chat: 'Fixture', text: 'pertama', account: 'Fixture 1' });
  await until(() => shown.length === 2 && release, 'second dialog');
  out = await tool('send_message', { chat: 'Fixture', text: 'kedua', account: 'Fixture 1' });
  assert.equal(out.data.status, 'failed');
  assert.match(out.data.detail, /another send confirmation/);
  assert.equal(shown.length, 2);
  release();
  assert.equal((await pending).data.status, 'cancelled');

  // 3) Disetujui → lewat viewSend/sendReply. Fixture tanpa DOM chat list → gagal di find-row
  //    (bukti jalur kirim tercapai), tab aktif kembali ke semula.
  answer = () => ({ response: 0 });
  const activeBefore = await evaluate(win.webContents, `document.querySelector('#channels .acc.active')?.dataset.id || null`);
  out = await tool('send_message', { chat: 'Fixture', text: 'halo kirim', account: 'Fixture 1' });
  assert.equal(out.isError, true);
  assert.equal(out.data.status, 'failed');
  assert.match(out.data.detail, /^find-row: /);
  await until(async () => (await evaluate(win.webContents, `document.querySelector('#channels .acc.active')?.dataset.id || null`)) === activeBefore, 'active tab restored');

  // 4) Kirim penuh di DOM WA tiruan: list tervirtualisasi (151 chat), target LID tanpa
  //    nama tersimpan ("+62 …", posisi 121, di luar layar) + pengecoh "Dimas Kantor"
  //    yang terlihat (pushname target "Dimas"). Input trusted asli dari sendReply.
  //    Pesan membawa chatId + chatPhone seperti hasil normalize → tersimpan di tabel chats.
  await evaluate(accounts[0].wc, `dispatchEvent(new CustomEvent('wa-reader-message', {detail:{account:Store.Conn.wid,id:'false_235428766560410@lid_3EB0LIDSMOKE',chat:'+62 856-9378-4939',chatId:'235428766560410@lid',chatPhone:'6285693784939',sender:'+62 856-9378-4939',text:'lid seed',timestamp:new Date().toISOString(),isGroup:false,fromMe:false}})); true`);
  await until(async () => { await driver.flushNow(); return (await tool('search_messages', { query: 'lid seed' })).data.count === 1; }, 'lid seed archived');
  const listed = (await tool('list_chats', {})).data.chats.find(row => row.chat === '+62 856-9378-4939');
  assert.deepEqual({ chatId: listed.chatId, phone: listed.phone }, { chatId: '235428766560410@lid', phone: '6285693784939' });
  await evaluate(accounts[0].wc, FAKE_WA);
  const before = shown.length;
  out = await tool('send_message', { chat: '6285693784939', text: 'hai test kirim' }); // kirim pakai NOMOR WA
  assert.deepEqual({ isError: out.isError, status: out.data.status }, { isError: false, status: 'sent' }, JSON.stringify(out.data));
  assert.equal(shown[before].options.detail, 'From: Fixture 1\nTo: +62 856-9378-4939\nRequested via: MCP\n\nhai test kirim');
  const wa = await evaluate(accounts[0].wc, `({ opened: __wa.opened, target: __wa.target.msgs.models.map(m => m.body), decoy: __wa.decoy.msgs.models.length, scrolled: document.getElementById('pane-side').scrollTop })`);
  assert.deepEqual(wa.opened, ['+62 856-9378-4939']);
  assert.deepEqual(wa.target, ['hai test kirim']);
  assert.equal(wa.decoy, 0);
  assert.ok(wa.scrolled > 0, 'target di luar layar harus dicapai dengan scroll');

  const audit = fs.readFileSync(path.join(dir, 'action-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.action === 'send');
  assert.deepEqual(audit.map(entry => [entry.result, entry.text]), [['cancelled', 'halo dari smoke'], ['cancelled', 'pertama'], ['error', 'halo kirim'], ['sent', 'hai test kirim']]);
  assert.ok(audit.every(entry => entry.source === 'mcp' && entry.account === account));
  console.log(`[send-smoke] PASS mcp send_message: default OFF → disabled (no dialog), enabled via Settings checkbox, dialog detail/buttons/timeout, cancel, single pending confirm, find-row failure, tab restored, chats table JID/phone/name, send by WA number to off-screen LID chat in virtualized list (decoy untouched), audit=${audit.length}`);
};
