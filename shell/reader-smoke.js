'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { BrowserWindow } = require('electron');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error('Reader smoke condition timed out');
}
async function evaluate(wc, expression) {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  const result = await wc.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
function fixture(index) {
  assert.ok(path.resolve(process.env.NEKOCHANNEL_USER_DATA || '').startsWith(path.join(os.tmpdir(), 'neko-reader-electron-')));
  for (const key of ['INGEST', 'CHAT', 'MCP']) assert.equal(process.env[`NEKOCHANNEL_${key}_PORT`], '0');
  return 'data:text/html,' + encodeURIComponent(`<main id="main">Local WhatsApp fixture</main><script>
    const account = '${index}11111@c.us';
    const handlers = [];
    const msgs = { models: [], on: (name, handler) => handlers.push(handler) };
    window.fixture = { loads: 0, events: 0, requests: 0,
      raw: id => ({ id: account + '-' + id, body: 'reader-fixture', t: 1795080000, from: '99999@c.us' }),
      add(id) { const raw = this.raw(id); for (const handler of handlers) handler(raw); },
      finish(messages = [this.raw('history')]) { this.resolve(messages); } };
    const chat = { id: '99999@c.us', name: 'Fixture', msgs, loadEarlierMsgs() {
      fixture.loads++; if (fixture.loads > 1) return [];
      return new Promise(resolve => fixture.resolve = resolve);
    } };
    msgs.models.push(fixture.raw('initial'));
    window.Store = { Conn: { wid: account }, Chat: { models: [chat], on() {}, get: () => chat }, Msg: msgs };
    addEventListener('wa-reader-message', () => fixture.events++);
    addEventListener('wa-reader-backfill-request', () => fixture.requests++);
  </script>`);
}
module.exports = async ({ app, win, accounts, driver, backend, openSettings }) => {
  const dir = app.getPath('userData');
  assert.equal(accounts.length, 2);
  await Promise.all(accounts.map(account => account.injected));
  await until(() => evaluate(win.webContents, '!!window.neko'));
  openSettings();
  const settingsWindow = BrowserWindow.getAllWindows().find(window => window !== win);
  await until(() => evaluate(settingsWindow.webContents, '!!window.neko && !!document.getElementById("reader-label").textContent'));
  const save = patch => evaluate(settingsWindow.webContents, `window.neko.saveSettings(${JSON.stringify(patch)})`);
  const health = async () => (await (await fetch(backend.ingestUrl + '/health')).json()).messages;
  const count = await health();
  const enabled = value => until(async () => (await Promise.all(accounts.map(account => evaluate(account.wc, 'globalThis.__nekoReaderEnabled')))).every(actual => actual === value));
  const footer = () => evaluate(win.webContents, 'document.getElementById("srvlabel").textContent');
  const switchReader = async value => {
    await evaluate(settingsWindow.webContents, `document.getElementById('reader').checked = ${value}; document.getElementById('reader').dispatchEvent(new Event('change')); true`);
    await until(() => driver.isEnabled() === value);
    await enabled(value);
  };
  if (process.env.NEKOCHANNEL_READER_SMOKE === 'restart') {
    assert.equal(driver.isEnabled(), false);
    await enabled(false);
    assert.equal(await footer(), 'Reader off');
    for (const account of accounts) {
      assert.equal(await evaluate(account.wc, 'fixture.events'), 0);
      await evaluate(account.wc, 'fixture.add("restart-off"); true');
      await account.wc.reload();
    }
    await pause(1000);
    assert.equal(await health(), count);
    assert.equal((await (await fetch(backend.chatUrl + '/api/health')).json()).messages, count);
    console.log('[reader-smoke] PASS restart: persisted OFF, reload gated, archive retained, backend alive');
    return;
  }
  await until(() => driver.status.size === 2);
  await until(async () => (await Promise.all(accounts.map(account => evaluate(account.wc, 'fixture.loads')))).every(loads => loads === 1));
  const initial = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'))).backfills;
  for (const progress of Object.values(initial)) assert.equal(progress.maxPerChat, 100);
  assert.equal(Object.keys(initial).length, 2);
  await evaluate(accounts[1].wc, 'fixture.finish([]); true');
  await until(() => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'))).backfills['211111@c.us']?.status === 'done');
  await pause(700);
  await driver.flushNow();
  assert.equal(await health(), 2);
  await until(async () => (await footer()) === 'Reader connected');
  for (const account of accounts) await evaluate(account.wc, `dispatchEvent(new CustomEvent('wa-reader-status', {detail:{connected:false,account:Store.Conn.wid,mode:'internal'}})); true`);
  await until(async () => (await footer()) === 'Reader disconnected');
  assert.doesNotMatch(await footer(), /127\.0\.0\.1|localhost|:\d+/);
  assert.equal((await evaluate(win.webContents, 'window.neko.saveSettings({reader:false})')).error, 'untrusted settings sender');
  for (const patch of [{ reader: 'false' }, { reader: 0 }, { reader: null }, { reader: false, unexpected: true }]) assert.ok((await save(patch)).error);
  assert.ok((await evaluate(settingsWindow.webContents, 'window.neko.readerBackfill("bad", "start")')).error);
  await switchReader(false);
  assert.equal(await footer(), 'Reader off');
  for (const account of accounts) {
    const before = await evaluate(account.wc, 'fixture.events');
    await evaluate(account.wc, 'fixture.add("off"); true');
    assert.equal(await evaluate(account.wc, 'fixture.events'), before);
    await evaluate(account.wc, `dispatchEvent(new CustomEvent('wa-reader-message', {detail:{account:'111111@c.us',id:'forged',chat:'Fixture',sender:'Fixture',text:'reader-fixture',timestamp:new Date().toISOString(),isGroup:false,fromMe:false}})); true`);
  }
  await pause(700);
  await driver.flushNow();
  assert.equal(await health(), 2);
  assert.ok((await evaluate(settingsWindow.webContents, 'window.neko.readerBackfill("whatsapp-1", "start")')).error);
  await switchReader(true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'))).backfills['111111@c.us'].session, initial['111111@c.us'].session);
  assert.equal((await evaluate(settingsWindow.webContents, 'window.neko.readerBackfill("whatsapp-1", "start")')).ok, true);
  await until(() => evaluate(accounts[0].wc, 'fixture.loads === 1'));
  await switchReader(false);
  const requests = await evaluate(accounts[0].wc, 'fixture.requests');
  await evaluate(accounts[0].wc, 'fixture.finish(); true');
  await pause(1800);
  assert.equal(await evaluate(accounts[0].wc, 'fixture.loads'), 1);
  assert.equal(await evaluate(accounts[0].wc, 'fixture.requests'), requests);
  await driver.flushNow();
  assert.equal(await health(), 2);
  await switchReader(true);
  await until(() => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'))).backfills['111111@c.us']?.status === 'done');
  for (const account of accounts) await evaluate(account.wc, 'fixture.add("live-resumed"); true');
  await pause(700);
  await switchReader(false);
  assert.ok(fs.readdirSync(path.join(dir, 'queue')).some(name => name.endsWith('.jsonl')));
  await driver.flushNow();
  assert.equal(await health(), 5);
  assert.equal((await (await fetch(backend.chatUrl + '/api/health')).json()).messages, 5);
  const key = require('./integrations').openStore(dir, require('electron').safeStorage).get().mcp.key;
  const response = await fetch(backend.mcpUrl + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_messages', arguments: { query: 'reader-fixture' } } }) });
  const result = await response.json();
  assert.equal(JSON.parse(result.result.content[0].text).count, 5);
  const agentWindow = new BrowserWindow({ show: false });
  await agentWindow.loadURL(backend.chatUrl);
  assert.equal(await evaluate(agentWindow.webContents, '!!document.querySelector("textarea, input")'), true);
  agentWindow.destroy();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'))).reader, false);
  assert.ok(fs.readdirSync(path.join(dir, 'backup')).filter(name => name.startsWith('settings.json.')).some(name => JSON.parse(fs.readFileSync(path.join(dir, 'backup', name))).reader === false));
  for (const lang of ['id', 'en']) {
    await save({ lang });
    assert.equal(await footer(), require('./i18n').STR[lang].readerOff);
    assert.doesNotMatch(await footer(), /127\.0\.0\.1|localhost|:\d+/);
  }
  console.log('[reader-smoke] PASS first: automatic initial latest-100 sessions in 2 injected views (hidden included), short history done, real IPC/checkbox, no capture/history while OFF, same in-flight session resumes, manual controls retained, durable drain, 5 archived rows, Agent UI/MCP alive, id/en footer, validation, backups');
};
module.exports.fixture = fixture;
