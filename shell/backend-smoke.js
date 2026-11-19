'use strict';
// Real Electron main-process endpoint check; no user accounts or live services.
module.exports = async (backend, dir) => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const { BrowserWindow } = require('electron');
  const { DEFAULTS } = require('./settings');
  assert.equal(DEFAULTS.action.master, false);
  const id = 'electron-standalone-smoke';
  const message = { id, chat: 'Smoke', sender: 'Smoke', text: 'integrated smoke', timestamp: new Date().toISOString(), fromMe: false, isGroup: false };
  const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const body = { account: '123456@c.us', messages: [message] };
  assert.equal((await post(backend.ingestUrl + '/ingest', body)).status, 202);
  assert.equal((await (await post(backend.ingestUrl + '/ingest', body)).json()).duplicates, 1);
  const health = await (await fetch(backend.ingestUrl + '/health')).json();
  assert.equal(health.messages, 1);
  const chatHealth = await (await fetch(backend.chatUrl + '/api/health')).json();
  assert.equal(chatHealth.messages, 1);
  const window = new BrowserWindow({ show: false });
  try {
    await window.loadURL(backend.chatUrl);
    assert.ok(await window.webContents.executeJavaScript('document.querySelector("textarea, input") !== null'));
  } catch (error) { window.destroy(); throw error; }
  const key = fs.readFileSync(path.join(dir, 'mcp-key'), 'utf8').trim();
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_messages', arguments: { query: 'integrated' } } };
  assert.equal((await post(backend.mcpUrl + '/mcp', rpc)).status, 403);
  const result = await (await post(backend.mcpUrl + '/mcp', rpc, { authorization: `Bearer ${key}` })).json();
  assert.equal(JSON.parse(result.result.content[0].text).count, 1);
  const chat = await post(backend.chatUrl + '/api/chat', { messages: [{ role: 'user', content: 'find smoke' }] });
  if (chatHealth.configured) { assert.equal(chat.status, 200); assert.match(await chat.text(), /event: done/); }
  else assert.equal(chat.status, 503);
  console.log('[backend-smoke] PASS', JSON.stringify({ electron: process.versions.electron, sqlite: process.versions.sqlite, ingest: health.messages, dedupe: true, ui: true, mcpSearch: 1, mcpUnauthorized: 403, chat: chat.status, actions: false }));
};
