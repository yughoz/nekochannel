'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startBackend, migrateArchive, loadEnv } = require('../backend');
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR, 'neko-backend-'));
const quiet = { info() {}, warn() {}, error() {} };

test('integrated lifecycle: ingest/dedupe, UI, unconfigured chat, MCP auth, restart', async () => {
  const dir = tmp();
  const env = { NEKOCHANNEL_INGEST_PORT: '0', NEKOCHANNEL_CHAT_PORT: '0', NEKOCHANNEL_MCP_PORT: '0' };
  let backend = await startBackend({ dir, env, logger: quiet });
  const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const body = { account: '123456@c.us', messages: [{ id: 'standalone', chat: 'Test', sender: 'Test', text: 'hello archive', timestamp: new Date().toISOString(), isGroup: false, fromMe: false }] };
  try {
    assert.equal((await post(backend.ingestUrl + '/ingest', body)).status, 202);
    assert.equal((await (await post(backend.ingestUrl + '/ingest', body)).json()).duplicates, 1);
    assert.equal((await (await fetch(backend.chatUrl + '/api/health')).json()).configured, false);
    assert.match(await (await fetch(backend.chatUrl)).text(), /<html/);
    assert.equal((await post(backend.chatUrl + '/api/chat', { messages: [] })).status, 503);
    const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_messages', arguments: { query: 'hello' } } };
    assert.equal((await post(backend.mcpUrl + '/mcp', rpc)).status, 403);
    const key = fs.readFileSync(path.join(dir, 'mcp-key'), 'utf8');
    const out = await (await post(backend.mcpUrl + '/mcp', rpc, { authorization: `Bearer ${key}` })).json();
    assert.equal(JSON.parse(out.result.content[0].text).count, 1);
  } finally { await backend.close(); }
  await assert.rejects(fetch(backend.ingestUrl + '/health'));
  backend = await startBackend({ dir, env, logger: quiet });
  try { assert.equal((await (await fetch(backend.ingestUrl + '/health')).json()).messages, 1); }
  finally { await backend.close(); }
});

test('migration snapshots WAL read-only, refuses overwrite and corrupt source', async () => {
  const root = tmp();
  const source = path.join(root, 'old.sqlite');
  const db = new DatabaseSync(source);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE messages(account TEXT,id TEXT); INSERT INTO messages VALUES (\'123@c.us\',\'one\');');
  const dir = path.join(root, 'new');
  try {
    const result = await migrateArchive(source, dir);
    const copy = new DatabaseSync(result.destination, { readOnly: true });
    assert.equal(copy.prepare('SELECT count(*) n FROM messages').get().n, 1); copy.close();
    assert.ok(fs.existsSync(result.backup));
    assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n, 1);
    await assert.rejects(migrateArchive(source, dir), /exists/);
    const invalid = path.join(root, 'invalid'); fs.writeFileSync(invalid, 'broken');
    await assert.rejects(migrateArchive(invalid, path.join(root, 'invalid-target')));
    assert.equal(fs.existsSync(path.join(root, 'invalid-target', 'wa.sqlite')), false);
  } finally { db.close(); }
});

test('imported real archive boots with accounts, unread, members and FTS preserved', async () => {
  const { MessageArchive } = require('../backend/server');
  const root = tmp();
  const old = new MessageArchive({ dataDir: path.join(root, 'old'), logger: quiet });
  await old.ready;
  await old.appendMany([{ id: 'imported', chat: 'Import', sender: 'Import', text: 'migrationproof', timestamp: new Date().toISOString(), isGroup: false, fromMe: false }], { account: '123@c.us', label: 'Imported' });
  const source = old.dbPath;
  await old.close();
  const before = require('node:crypto').createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const dir = path.join(root, 'new');
  const backend = await startBackend({ dir, logger: quiet, env: { NEKOCHANNEL_IMPORT_SQLITE: source, NEKOCHANNEL_INGEST_PORT: '0', NEKOCHANNEL_CHAT_PORT: '0', NEKOCHANNEL_MCP_PORT: '0' } });
  try {
    const health = await (await fetch(backend.ingestUrl + '/health')).json();
    assert.equal(health.messages, 1);
    const db = new DatabaseSync(path.join(dir, 'data', 'wa.sqlite'), { readOnly: true });
    assert.equal(db.prepare('SELECT label FROM accounts').get().label, 'Imported');
    assert.equal(db.prepare("SELECT count(*) n FROM messages_fts WHERE messages_fts MATCH 'migrationproof'").get().n, 1);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='chat_unread'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='group_members'").get());
    db.close();
    assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(source)).digest('hex'), before);
  } finally { await backend.close(); }
});

test('env loading is explicit, user config overrides file, process overrides both', () => {
  const dir = tmp(); const local = path.join(dir, 'local.env');
  fs.writeFileSync(local, 'CHAT_MODEL_NAME=local\nCHAT_MODEL_URL=https://example.invalid/v1\n');
  fs.writeFileSync(path.join(dir, '.env'), 'CHAT_MODEL_NAME=user\n');
  assert.equal(loadEnv(dir, {}, local).CHAT_MODEL_NAME, 'user');
  assert.equal(loadEnv(dir, { CHAT_MODEL_NAME: 'process' }, local).CHAT_MODEL_NAME, 'process');
});

test('port conflict fails closed and rolls back already-started services', async () => {
  const http = require('node:http');
  const occupied = http.createServer();
  await new Promise(r => occupied.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(startBackend({ dir: tmp(), logger: quiet, env: { NEKOCHANNEL_INGEST_PORT: '0', NEKOCHANNEL_CHAT_PORT: String(occupied.address().port), NEKOCHANNEL_MCP_PORT: '0' } }), /EADDRINUSE/);
  } finally { await new Promise(r => occupied.close(r)); }
});
