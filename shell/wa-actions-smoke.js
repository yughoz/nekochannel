'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const electron = require('electron');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check, label) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error(`wa-actions smoke timeout: ${label}`);
}
async function evaluate(wc, expression) {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  const result = await wc.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
function fixture(index) {
  assert.ok(path.resolve(process.env.NEKOCHANNEL_USER_DATA || '').startsWith(path.join(os.tmpdir(), 'neko-reader-electron-wa-actions-')));
  for (const key of ['INGEST', 'CHAT', 'MCP']) assert.equal(process.env[`NEKOCHANNEL_${key}_PORT`], '0');
  return 'data:text/html,' + encodeURIComponent(`<!doctype html><meta charset="utf-8">
  <style>body{margin:20px;font:16px sans-serif}button,[role=menuitem]{padding:12px;margin:4px} [contenteditable]{border:1px solid #999;min-height:35px;width:400px} [data-id]{padding:12px;margin:8px;border:1px solid} [role=menu],[role=dialog],[data-testid=drawer-middle]{position:fixed;left:30px;top:60px;background:white;padding:20px;border:2px solid;z-index:9}</style>
  <button id="archived" aria-label="Archived">Archived</button>
  <div data-testid="chat-list"><div role="row" data-testid="list-item-fixture"><div role="gridcell" tabindex="0"><span data-testid="cell-frame-title">Fixture</span></div></div></div>
  <main><header data-testid="conversation-header"><span data-testid="conversation-info-header-chat-title-name">Fixture</span></header>
  <div data-id="incoming">Incoming message</div><div class="message-out" data-id="true_99999@c.us_outgoing">Original outgoing</div>
  <input type="file" accept="image/*" hidden id="sticker-input">
  <footer><button aria-label="Attach">Attach</button><div contenteditable="true" role="textbox"></div></footer></main>
  <script>
  const account = '${index}11111@c.us';
  const msgs = {models:[{id:'false_99999@c.us_incoming',body:'wa action seed',t:1795080000,from:'99999@c.us'}],on(){}};
  const chat = {id:'99999@c.us',name:'Fixture',msgs};
  window.Store = {Conn:{wid:account},Chat:{models:[chat],get:()=>chat,on(){}},Msg:msgs};
  window.fixture = {events:[],trusted:[],quote:null};
  const record = (action, detail={}) => fixture.events.push({action,...detail});
  const composer = document.querySelector('footer [contenteditable]');
  function clear() {document.querySelectorAll('[role=menu],[role=dialog],#picker,[data-testid=drawer-middle]').forEach(element=>element.remove());}
  function drawer() {clear();const element=document.createElement('div');element.dataset.testid='drawer-middle';const canvas=document.createElement('div');canvas.dataset.testid='media-editor-canvas';element.append(canvas);document.body.append(element);return element;}
  function button(parent, label, callback, role) {
    const element=document.createElement('button'); element.textContent=label; element.setAttribute('aria-label',label);
    if(role) element.setAttribute('role',role);
    element.onclick=event=>{fixture.trusted.push(event.isTrusted);callback();}; parent.append(element); return element;
  }
  function dialog() {clear();const element=document.createElement('div');element.setAttribute('role','dialog');document.body.append(element);return element;}
  function menu(labels, callback) {clear();const element=document.createElement('div');element.setAttribute('role','menu');document.body.append(element);for(const label of labels) button(element,label,()=>{clear();callback(label);},'menuitem');}
  const row=document.querySelector('[role=row]');
  row.onclick=event=>{fixture.trusted.push(event.isTrusted);};
  row.oncontextmenu=event=>{event.preventDefault();fixture.trusted.push(event.isTrusted);menu(['Mark as read','Mark as unread','Archive chat','Unarchive chat'],label=>record(label));};
  document.querySelector('#archived').onclick=event=>fixture.trusted.push(event.isTrusted);
  for(const element of document.querySelectorAll('[data-id]')) element.oncontextmenu=event=>{
    event.preventDefault();fixture.trusted.push(event.isTrusted);const id=element.dataset.id;
    // WA 2026: klik kanan = menu + dialog bar reaksi cepat (tombol berisi <img alt=emoji>), tampil terpisah
    queueMicrotask(()=>{const bar=document.createElement('div');bar.setAttribute('role','dialog');bar.style.cssText='left:520px;top:10px';document.body.append(bar);
      for(const emoji of ['👍','❤️']){const b=document.createElement('button');const img=document.createElement('img');img.alt=emoji;img.width=img.height=24;b.append(img);b.onclick=e2=>{fixture.trusted.push(e2.isTrusted);record('react',{id,emoji});clear();};bar.append(b);}});
    menu(['Reply','React','Pin','Unpin','Edit'], label=>{
      if(label==='Reply'){fixture.quote=id;const marker=document.createElement('button');marker.setAttribute('aria-label','Cancel reply');marker.id='quote';marker.textContent='Cancel reply';document.querySelector('footer').prepend(marker);}
      if(label==='Pin'){const panel=dialog();button(panel,'Pin',()=>{record('pin',{id});clear();});}
      if(label==='Unpin')record('unpin',{id});
      if(label==='Edit'){const panel=dialog();const editor=document.createElement('div');editor.contentEditable='true';editor.textContent=element.textContent;panel.append(editor);button(panel,'Save',()=>{record('edit',{id,text:editor.textContent});element.textContent=editor.textContent;clear();});}
    });
  };
  composer.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();record(fixture.quote?'reply':'send',{text:composer.textContent,id:fixture.quote});composer.textContent='';fixture.quote=null;document.querySelector('#quote')?.remove();}};
  composer.oninput=event=>{fixture.trusted.push(event.isTrusted);};
  composer.onblur=()=>record('blur');
  // WA 2026 (tervalidasi live 2026-11-21): Attach = menu; input file dibuat saat item diklik lalu
  // input.click() (file picker). Input image/* yang selalu ada milik "New sticker" → jangan diisi.
  document.querySelector('#sticker-input').onchange=()=>record('sticker');
  document.querySelector('[aria-label=Attach]').onclick=event=>{
    fixture.trusted.push(event.isTrusted);
    menu(['Document','Photos & videos','New sticker'],label=>{
      if(label==='New sticker')return;
      const image=label==='Photos & videos';
      const input=document.createElement('input');input.type='file';input.multiple=true;input.accept=image?'image/*,video/mp4':'*';input.hidden=true;document.body.append(input);
      input.onchange=async()=>{const file=input.files[0];const bytes=[...new Uint8Array(await file.arrayBuffer())];input.remove();const panel=drawer();
        const caption=document.createElement('div');caption.contentEditable='true';caption.dataset.testid='media-caption-input-container';panel.append(caption);
        const send=document.createElement('div');send.setAttribute('role','button');send.setAttribute('aria-label','Send 1 selected');send.textContent='Send';
        send.onclick=ev=>{fixture.trusted.push(ev.isTrusted);record(image?'sendImage':'sendFile',{name:file.name,type:file.type,bytes,caption:caption.textContent});clear();};panel.append(send);};
      input.click();
    });
  };
  document.addEventListener('keydown',event=>{if(event.key==='Escape')clear();});
  </script>`);
}

module.exports = async ({ app, win, accounts, driver, backend, settingsView }) => {
  const dir = app.getPath('userData');
  await Promise.all(accounts.map(account => account.injected));
  await until(() => accounts.every(account => account.account && account.status?.state === 'connected'), 'accounts connected');
  await until(() => evaluate(settingsView.wc, '!!window.neko'), 'settings loaded');
  const first = accounts[0];
  for (const account of accounts) await evaluate(account.wc, `dispatchEvent(new CustomEvent('wa-reader-message',{detail:{account:Store.Conn.wid,id:'false_99999@c.us_incoming',chat:'Fixture',sender:'Fixture',text:'wa action seed',timestamp:new Date().toISOString(),isGroup:false,fromMe:false}}));true`);
  const key = require('./integrations').openStore(dir, electron.safeStorage).get().mcp.key;
  const rpc = async (method, params) => {
    const response = await fetch(`${backend.mcpUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return (await response.json()).result;
  };
  const tool = async args => {
    const result = await rpc('tools/call', { name: 'wa_action', arguments: args });
    return JSON.parse(result.content[0].text);
  };
  const post = async args => (await fetch(`${backend.chatUrl}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })).json();
  await until(async () => { await driver.flushNow(); return (await rpc('tools/call', { name: 'search_messages', arguments: { query: 'wa action seed' } })).content[0].text.includes('99999'); }, 'seed archived');
  assert.ok((await rpc('tools/list', {})).tools.some(tool => tool.name === 'wa_action'));
  assert.match((await rpc('initialize', {})).instructions, /verified:false/);
  // Gating = saklar Settings > LLM Agent (default OFF): aksi chat; reply/gambar/file juga saklar kirim.
  const input = { action: 'markRead', chat: 'Fixture', account: 'Fixture 1' };
  const reply = { action: 'reply', chat: 'Fixture', account: 'Fixture 1', msgId: 'false_99999@c.us_incoming', text: 'balasan' };
  assert.equal((await tool(input)).status, 'disabled');
  assert.match((await tool(input)).detail, /Settings > LLM Agent/);
  assert.equal((await post(input)).status, 'disabled');
  const sendText = await rpc('tools/call', { name: 'wa_action', arguments: { action: 'send', chat: 'Fixture', account: 'Fixture 1', text: 'x' } });
  assert.match(sendText.content[0].text, /send_message/, 'teks biasa hanya lewat send_message');
  const save = patch => evaluate(settingsView.wc, `window.neko.saveSettings(${JSON.stringify(patch)})`);
  await until(() => evaluate(settingsView.wc, `!!document.getElementById('actions-label').textContent && document.getElementById('actions-enabled').checked === false`), 'actions toggle rendered OFF');
  await evaluate(settingsView.wc, `document.getElementById('actions-enabled').click(); true`); // checkbox asli
  await until(async () => (await evaluate(settingsView.wc, 'window.neko.getSettings()')).actionsEnabled === true, 'actions toggle saved ON');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).actionsEnabled, true);
  assert.equal((await tool(reply)).status, 'disabled', 'reply butuh saklar kirim juga');
  const showMessageBox = electron.dialog.showMessageBox;
  const shown = [];
  electron.dialog.showMessageBox = async (_win, options) => { shown.push(options); return { response: 1 }; }; // Batal
  assert.equal((await tool(input)).status, 'cancelled');
  assert.match(shown[0].detail, /Fixture 1[\s\S]*Fixture[\s\S]*MCP/);
  electron.dialog.showMessageBox = async () => ({ response: 0 }); // Jalankan
  try {
    const sent = await tool(input);
    assert.equal(sent.status, 'ok', JSON.stringify(sent));
    assert.equal(sent.verified, false);
    assert.match((await post(input)).detail, /rate limited/);
    const second = await post({ ...input, account: 'Fixture 2' });
    assert.equal(second.status, 'ok', JSON.stringify(second));
    await save({ actionsEnabled: false });
    assert.equal((await post({ ...input, account: 'Fixture 2' })).status, 'disabled');
  } finally { electron.dialog.showMessageBox = showMessageBox; }
  const attacker = new electron.BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  try {
    await attacker.loadURL('data:text/html,untrusted');
    assert.equal((await evaluate(attacker.webContents, `window.neko.waAction(${JSON.stringify({ ...input, accountId: first.id })})`)).error, 'untrusted sender');
  } finally { attacker.destroy(); }
  assert.match((await evaluate(win.webContents, `window.neko.waAction(${JSON.stringify({ ...input, accountId: 'invalid' })})`)).detail, /unknown/);
  await evaluate(win.webContents, `window.neko.setActive(${JSON.stringify(first.id)})`);
  await pause(500);
  const { createActions } = require('./wa-actions');
  const { runPageAction } = require('../adapters/whatsapp/action');
  let clock = Date.now();
  const run = createActions({ accounts: () => accounts, gate: () => null, logFile: path.join(dir, 'fixture-actions.jsonl'), now: () => clock,
    perform: (account, target) => runPageAction(account.wc, target.chatJid, target, undefined, { hint: target.chat }) });
  const cases = [
    { action: 'sendImage', file: path.join(dir, 'action-upload.png'), caption: 'image caption' },
    { action: 'sendFile', file: path.join(dir, 'action-upload.png'), caption: 'document caption' },
    { action: 'reply', msgId: 'false_99999@c.us_incoming', text: 'quoted reply' },
    { action: 'react', msgId: 'false_99999@c.us_incoming', emoji: '👍' },
    { action: 'pin', msgId: 'false_99999@c.us_incoming' },
    { action: 'unpin', msgId: 'false_99999@c.us_incoming' },
    { action: 'edit', msgId: 'true_99999@c.us_outgoing', text: 'edited text' },
    ...['markRead', 'markUnread', 'archive', 'unarchive', 'typing', 'typingStop'].map(action => ({ action })),
  ];
  for (const item of cases) {
    const result = await run({ chat: 'Fixture', chatJid: '99999@c.us', accountId: first.id, ...item });
    assert.equal(result.status, 'ok', `${item.action}: ${JSON.stringify(result)}`);
    assert.equal(result.verified, false);
    clock += 31_000;
  }
  const events = await evaluate(first.wc, 'fixture.events');
  for (const action of ['sendImage', 'sendFile', 'reply', 'react', 'pin', 'unpin', 'edit', 'Mark as read', 'Mark as unread', 'Archive chat', 'Unarchive chat', 'blur']) assert.ok(events.some(event => event.action === action), action);
  for (const action of ['sendImage', 'sendFile']) {
    const event = events.find(event => event.action === action);
    assert.deepEqual(event.bytes, [...fs.readFileSync(path.join(dir, 'action-upload.png'))]);
    assert.ok(event.caption.endsWith('caption'));
  }
  assert.ok(!events.some(event => event.action === 'sticker'), 'sendImage must not use the New sticker input');
  assert.equal(events.find(event => event.action === 'reply').id, 'incoming'); // DOM WA 2026 = KEY; msgId arsip tetap serial penuh
  assert.equal(events.find(event => event.action === 'react').emoji, '👍');
  assert.equal(events.find(event => event.action === 'edit').text, 'edited text');
  assert.equal(await evaluate(first.wc, 'fixture.trusted.every(Boolean)'), true);
  const rejected = await runPageAction(first.wc, '99999@c.us', { action: 'react', msgId: 'missing', emoji: '👍' }, undefined, { hint: 'Fixture' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.detail, /message/);
  console.log('[wa-actions-smoke] PASS real DOM + trusted input: 13 actions, DataTransfer file bytes, exact quote/reaction/edit, Settings gates OFF/ON (send needed for reply), plain send refused, native cancel/allow, per-account rate limit, MCP/chat endpoints, IPC guard; authenticated WA selectors NOT verified');
};
module.exports.fixture = fixture;
