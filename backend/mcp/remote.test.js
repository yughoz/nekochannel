'use strict';
// #32 MCP remote via Tailscale: deteksi IP tailnet, aturan request remote, bind guard.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { tailscaleAddress, inTailnet, isLoopback, startServer, REMOTE_RATE_LIMIT } = require('./server.js');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-remote-'));
  const db = new DatabaseSync(path.join(dir, 'wa.sqlite'));
  db.exec(`
    CREATE TABLE messages (account TEXT NOT NULL, id TEXT NOT NULL, chat TEXT, isGroup INTEGER, sender TEXT, text TEXT, timestamp TEXT, fromMe INTEGER, mentionsMe INTEGER, replyToMe INTEGER, chatId TEXT DEFAULT '', createdAt TEXT, PRIMARY KEY(account, id));
    CREATE VIRTUAL TABLE messages_fts USING fts5(text, chat, sender, account, content='messages', content_rowid='rowid', tokenize='unicode61');
    CREATE TABLE chat_unread (account TEXT NOT NULL, chat TEXT NOT NULL, chatId TEXT, unread INTEGER, isGroup INTEGER, updatedAt TEXT, PRIMARY KEY(account, chat));
    CREATE TABLE accounts (account TEXT PRIMARY KEY, label TEXT, lastSeen TEXT);
    CREATE TABLE group_members (account TEXT NOT NULL, chatId TEXT NOT NULL, jid TEXT NOT NULL, chat TEXT, name TEXT, phone TEXT, isAdmin INTEGER, updatedAt TEXT, PRIMARY KEY(account, chatId, jid));
  `);
  return { db, dir };
}
const logs = () => { const lines = []; return { lines, info: m => lines.push(m), warn: m => lines.push(m), error: m => lines.push(m) }; };
// Sumber request disimulasikan lewat header x-test-ip (hanya addressOf test yang membacanya).
const addressOf = req => req.headers['x-test-ip'] || req.socket.remoteAddress;
async function withServer(t, { config = {}, logger = logs() } = {}, fn) {
  const { db, dir } = tempDb();
  const srv = await startServer({ config: { host: '127.0.0.1', port: 0, key: 'k-remote', dbPath: path.join(dir, 'wa.sqlite'), ...config }, logger, db, addressOf });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${srv.server.address().port}`;
  const rpc = (body, headers = {}) => fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer k-remote', ...headers }, body: JSON.stringify(body) });
  await fn({ url, rpc, srv, logger });
}

test('inTailnet / isLoopback: batas rentang CGNAT 100.64.0.0/10 dan IPv4-mapped', () => {
  for (const ip of ['100.64.0.1', '100.97.227.96', '100.127.255.255', '::ffff:100.100.1.1']) assert.equal(inTailnet(ip), true, ip);
  for (const ip of ['100.63.255.255', '100.128.0.1', '10.0.0.1', '192.168.1.5', '', undefined]) assert.equal(inTailnet(ip), false, String(ip));
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback(ip), true, ip);
  assert.equal(isLoopback('100.97.227.96'), false);
});

test('tailscaleAddress: utun/tailscale0 dengan IP tailnet; abaikan internal & non-tailnet; tidak ada → null', () => {
  const v4 = (address, internal = false) => ({ family: 'IPv4', address, internal });
  assert.equal(tailscaleAddress({ lo0: [v4('127.0.0.1', true)], en0: [v4('192.168.1.5')], utun9: [v4('100.97.227.96')] }), '100.97.227.96');
  assert.equal(tailscaleAddress({ utun3: [v4('100.70.0.2')], tailscale0: [v4('100.80.0.9')] }), '100.80.0.9'); // nama tailscale diutamakan
  assert.equal(tailscaleAddress({ en0: [v4('192.168.1.5')], utun1: [{ family: 'IPv6', address: 'fd7a::1' }] }), null);
});

test('remote: Bearer benar = boleh; tanpa/salah token = 403; non-tailnet = 403; selain POST /mcp = 404; log tanpa isi', async t => {
  await withServer(t, {}, async ({ url, rpc, logger }) => {
    const remote = { 'x-test-ip': '100.97.1.2' };
    const ok = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'db_overview', arguments: { rahasia: 'isi-pesan' } } }, remote)).json();
    assert.equal(ok.id, 1);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { ...remote, authorization: '' })).status, 403);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { ...remote, authorization: 'Bearer salah-key' })).status, 403);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, { 'x-test-ip': '192.168.1.50' })).status, 403);
    assert.equal((await fetch(`${url}/health`, { headers: remote })).status, 404);
    assert.equal((await fetch(`${url}/`, { method: 'POST', headers: { ...remote, authorization: 'Bearer k-remote' }, body: '{}' })).status, 404);
    assert.ok(logger.lines.some(line => line === 'remote 100.97.1.2 tools/call db_overview'));
    assert.ok(!logger.lines.some(line => line.includes('isi-pesan')));
    // Loopback tidak berubah: /health tetap ada, Bearer tetap wajib untuk /mcp.
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, { authorization: '' })).status, 403);
  });
});

test('remote: rate limit per IP (60/menit) → 429 + retry-after; IP lain & loopback tidak terdampak', async t => {
  await withServer(t, {}, async ({ rpc }) => {
    const a = { 'x-test-ip': '100.64.0.10' };
    for (let i = 0; i < REMOTE_RATE_LIMIT; i++) assert.equal((await rpc({ jsonrpc: '2.0', id: i, method: 'tools/list' }, a)).status, 200);
    const blocked = await rpc({ jsonrpc: '2.0', id: 99, method: 'tools/list' }, a);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 100, method: 'tools/list' }, { 'x-test-ip': '100.64.0.11' })).status, 200);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 101, method: 'tools/list' })).status, 200);
  });
});

test('bind guard: remote ON tanpa IP Tailscale / alamat non-tailnet → remote OFF dengan alasan, lokal tetap jalan', async t => {
  await withServer(t, { config: { remote: true, remoteHost: '192.168.1.5' } }, async ({ srv, rpc }) => {
    assert.deepEqual({ active: srv.remote.active, error: srv.remote.error }, { active: false, error: 'tailscale address not found' });
    assert.equal(srv.servers.length, 1);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 200);
  });
  await withServer(t, { config: { remote: false } }, async ({ srv }) => {
    assert.deepEqual(srv.remote, { enabled: false, active: false, address: null, port: null, error: null });
  });
});

test('bind: remote ON di IP tailnet yang tidak dimiliki mesin → gagal tertutup (EADDRNOTAVAIL), lokal tetap', async t => {
  await withServer(t, { config: { remote: true, remoteHost: '100.127.254.253' } }, async ({ srv }) => {
    assert.equal(srv.remote.active, false);
    assert.match(String(srv.remote.error), /EADDRNOTAVAIL|bind failed|EINVAL/);
    assert.equal(srv.servers.length, 1);
  });
});
