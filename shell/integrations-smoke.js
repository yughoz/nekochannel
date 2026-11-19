'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, safeStorage, clipboard } = require('electron');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function evaluate(wc, expression) {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  const result = await wc.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error('Fixture renderer evaluation failed');
  return result.result.value;
}
const post = (url, body, authorization) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body) });
module.exports = async ({ app, win, backend, openSettings }) => {
  const dir = app.getPath('userData');
  assert.ok(dir.startsWith(path.join(process.env.TMPDIR, 'neko-integrations-electron-')));
  assert.equal(new URL(process.env.NEKOCHANNEL_FIXTURE_URL).hostname, '127.0.0.1');
  assert.ok(safeStorage.isEncryptionAvailable(), 'OS encryption required');
  assert.notEqual(safeStorage.getSelectedStorageBackend?.(), 'basic_text');
  openSettings();
  const settingsWindow = BrowserWindow.getAllWindows().find(window => window !== win);
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await evaluate(settingsWindow.webContents, '!!window.neko && !!document.getElementById("jev-url")')) break;
    await pause(100);
  }
  const call = expression => evaluate(settingsWindow.webContents, expression);
  const get = () => call('window.neko.getSettings()');
  const save = patch => call(`window.neko.saveSettings(${JSON.stringify(patch)})`);
  const phase = process.env.NEKOCHANNEL_INTEGRATIONS_SMOKE;
  if (phase === 'first') {
    const initial = await get();
    assert.equal(initial.integrationStatus.secure, true);
    assert.equal(initial.integrations.jev.enabled, false);
    assert.equal(initial.integrations.webhook.enabled, false);
    const url = process.env.NEKOCHANNEL_FIXTURE_URL;
    const config = { llm: { url, name: 'fixture-agent', key: 'fixture-agent-key' }, summary: { url, name: 'fixture-summary', key: 'fixture-summary-key' },
      jev: { enabled: true, url, name: 'fixture-jev', key: 'fixture-jev-key', threshold: 0.6 },
      webhook: { enabled: false, url: url + '/webhook', key: 'fixture-webhook-key' }, mcp: { enabled: true, port: 43219, key: 'fixture-mcp-key' } };
    await call(`(() => { const config = ${JSON.stringify(config)}; for (const [section, values] of Object.entries(config)) { if (section === 'llm') continue; for (const [field, value] of Object.entries(values)) { const input = document.getElementById(section + '-' + field); if (field === 'enabled') input.checked = value; else input.value = value; } } document.getElementById('integrations-save').click(); return true; })()`);
    for (let attempt = 0; attempt < 150 && (await get()).integrations.jev.name !== 'fixture-jev'; attempt++) await pause(100);
    await call(`(() => { const config = ${JSON.stringify(config.llm)}; for (const [field, value] of Object.entries(config)) document.getElementById('llm-' + field).value = value; document.getElementById('llm-save').click(); return true; })()`);
    for (let attempt = 0; attempt < 150 && (await get()).integrations.llm.name !== 'fixture-agent'; attempt++) await pause(100);
    const result = await get();
    assert.equal(result.integrations.jev.name, 'fixture-jev');
    assert.equal(result.integrations.llm.name, 'fixture-agent');
    assert.equal(result.integrationStatus.restartRequired, true);
    assert.equal(JSON.stringify(result).includes('fixture-mcp-key'), false);
    assert.ok((await save({ integrations: { mcp: { port: 0 } } })).error);
    assert.equal((await call('window.neko.testWebhook()')).ok, true);
    assert.equal(await call('Array.from(document.querySelectorAll("input[type=password]")).every(input => input.value === "")'), true);
    const writeText = clipboard.writeText;
    let copiedKey;
    clipboard.writeText = async text => { copiedKey = text; };
    try { assert.equal((await call('window.neko.copyMcpKey()')).ok, true); assert.equal(copiedKey, 'fixture-mcp-key'); }
    finally { clipboard.writeText = writeText; }
    for (const name of ['integrations.enc']) {
      const bytes = fs.readFileSync(path.join(dir, name));
      assert.equal(bytes.includes(Buffer.from('fixture-')), false);
      assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
    }
    assert.equal(fs.existsSync(path.join(dir, '.env')), false);
    assert.equal(fs.existsSync(path.join(dir, 'mcp-key')), false);
  } else {
    const result = await get();
    assert.equal(result.integrationStatus.restartRequired, false);
    assert.ok(result.integrationStatus.mcpUrl);
    const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    assert.equal((await post(result.integrationStatus.mcpUrl, rpc)).status, 403);
    assert.equal((await (await post(result.integrationStatus.mcpUrl, rpc, 'Bearer fixture-mcp-key')).json()).result.tools.length, 6);
    await pause(20);
    assert.equal((await post(backend.ingestUrl + '/ingest', { account: '123456@c.us', messages: [{ id: 'integration-fixture', chat: 'Fixture group', sender: 'Fixture', text: 'Synthetic archive fixture only', timestamp: new Date().toISOString(), isGroup: true, fromMe: false }] })).status, 202);
    assert.equal((await post(backend.ingestUrl + '/debug/summary-preview', {})).status, 200);
    await (await post(backend.chatUrl + '/api/chat', { messages: [{ role: 'user', content: 'Synthetic test' }] })).text();
    assert.equal((await save({ reader: false })).reader, false);
    assert.equal((await post(backend.ingestUrl + '/debug/summary-preview', {})).status, 403);
    assert.equal((await (await fetch(backend.ingestUrl + '/health')).json()).messages, 1);
  }
  console.log(`[integrations-smoke] PASS ${phase}: real OS safeStorage, Settings IPC, staged restart, local fixture only`);
};
