'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { makeTools, makeHandler, startServer, ftsQuery, clip, ACTIONS_DISABLED } = require('./server.js');

const KEY = 'test-key';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warmcp-'));
  const db = new DatabaseSync(path.join(dir, 'wa.sqlite'));
  db.exec(`
    CREATE TABLE messages (account TEXT NOT NULL, id TEXT NOT NULL, chat TEXT, isGroup INTEGER, sender TEXT, text TEXT, timestamp TEXT, fromMe INTEGER, mentionsMe INTEGER, replyToMe INTEGER, chatId TEXT DEFAULT '', createdAt TEXT, PRIMARY KEY(account, id));
    CREATE VIRTUAL TABLE messages_fts USING fts5(text, chat, sender, account, content='messages', content_rowid='rowid', tokenize='unicode61');
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, text, chat, sender, account) VALUES (new.rowid, new.text, new.chat, new.sender, new.account); END;
    CREATE TABLE chat_unread (account TEXT NOT NULL, chat TEXT NOT NULL, chatId TEXT, unread INTEGER, isGroup INTEGER, updatedAt TEXT, PRIMARY KEY(account, chat));
    CREATE TABLE accounts (account TEXT PRIMARY KEY, label TEXT, lastSeen TEXT);
    CREATE TABLE group_members (account TEXT NOT NULL, chatId TEXT NOT NULL, jid TEXT NOT NULL, chat TEXT, name TEXT, phone TEXT, isAdmin INTEGER, updatedAt TEXT, PRIMARY KEY(account, chatId, jid));
  `);
  const insert = db.prepare('INSERT INTO messages(account,id,chat,isGroup,sender,text,timestamp,fromMe) VALUES (?,?,?,?,?,?,?,?)');
  insert.run('628111@c.us', 'm-1', 'Transys', 1, 'Budi', 'jadwal armada siang ini', '2026-11-10T03:00:00.000Z', 0);
  insert.run('628111@c.us', 'm-2', 'Transys', 1, 'Sari', 'promo kiriman murah akhir tahun', '2026-11-11T04:00:00.000Z', 0);
  insert.run('628111@c.us', 'm-3', 'Alice', 0, 'Alice', 'besok meeting jam 9 ya', '2026-11-12T01:00:00.000Z', 0);
  db.prepare('INSERT INTO chat_unread(account,chat,chatId,unread,isGroup,updatedAt) VALUES (?,?,?,?,?,?)').run('628111@c.us', 'Transys', 'transys@g.us', 2, 1, '2026-11-12T02:00:00.000Z');
  db.prepare('INSERT INTO accounts(account,label,lastSeen) VALUES (?,?,?)').run('628111@c.us', 'Pribadi', '2026-11-12T02:00:00.000Z');
  const member = db.prepare('INSERT INTO group_members(account,chatId,jid,chat,name,phone,isAdmin,updatedAt) VALUES (?,?,?,?,?,?,?,?)');
  member.run('628111@c.us', 'transys@g.us', '6281@c.us', 'Transys', 'Budi', '6281', 1, '2026-11-12T02:00:00.000Z');
  member.run('628111@c.us', 'transys@g.us', '2061@lid', 'Transys', '', '', 0, '2026-11-12T02:00:00.000Z');
  return { db, dir };
}

async function withServer(t, fn) {
  const { db, dir } = tempDb();
  const config = { host: '127.0.0.1', port: 0, key: KEY, dbPath: path.join(dir, 'wa.sqlite') };
  const logger = { info() {}, warn() {}, error() {} };
  const { server, close } = await startServer({ config, logger, db });
  t.after(async () => { await close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  // rpc: authenticated by default. raw: pass auth explicitly (undefined = no header).
  const raw = async (payload, auth) => {
    const headers = { 'content-type': 'application/json' };
    if (auth !== undefined) headers.authorization = auth;
    const response = await fetch(`${url}/mcp`, { method: 'POST', headers, body: JSON.stringify(payload) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const rpc = (payload, auth = `Bearer ${KEY}`) => raw(payload, auth);
  await fn({ url, rpc, raw });
}

test('mcp rejects missing, wrong-format and wrong keys', async t => {
  await withServer(t, async ({ raw }) => {
    assert.equal((await raw({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, '')).status, 403);
    assert.equal((await raw({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'Bearer nope')).status, 403);
    assert.equal((await raw({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, undefined)).status, 403);
    assert.equal((await raw({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, `Bearer ${KEY} extra`)).status, 403);
  });
});

test('initialize, tools/list and unknown methods follow JSON-RPC', async t => {
  await withServer(t, async ({ rpc }) => {
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.serverInfo.name, 'wa-reader');
    const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(tools.body.result.tools.map(tool => tool.name), ['search_messages', 'get_chat_messages', 'list_chats', 'unread_summary', 'group_members', 'db_overview']);
    const unknown = await rpc({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
    assert.equal(unknown.body.error.code, -32601);
    const notification = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(notification.status, 202);
    const bad = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } });
    assert.equal(bad.body.error.code, -32602);
  });
});

test('tools read the archive read-only with limits and clipping', async t => {
  await withServer(t, async ({ rpc }) => {
    const call = (name, args) => rpc({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args } });
    const search = await call('search_messages', { query: 'armada' });
    const found = JSON.parse(search.body.result.content[0].text);
    assert.equal(search.body.result.isError, false);
    assert.equal(found.messages.length, 1);
    assert.equal(found.messages[0].text, 'jadwal armada siang ini');
    assert.equal(found.messages[0].account, '628111@c.us');
    const long = 'x'.repeat(400);
    assert.equal(clip(long).length, 301, 'clip keeps an ellipsis marker within the limit');
    const missing = await call('search_messages', {});
    assert.equal(missing.body.result.isError, true);
    const since = await call('search_messages', { query: 'promo', since: '2026-11-11T00:00:00.000Z', until: '2026-11-11T23:59:59.000Z' });
    assert.equal(JSON.parse(since.body.result.content[0].text).messages.length, 1);
    const chat = await call('get_chat_messages', { chat: 'Transys', limit: 10 });
    assert.equal(JSON.parse(chat.body.result.content[0].text).messages.length, 2);
    const chats = await call('list_chats', {});
    const listed = JSON.parse(chats.body.result.content[0].text);
    assert.equal(listed.chats.length, 2);
    assert.equal(listed.chats[0].chat, 'Alice');
    const unread = await call('unread_summary', {});
    const unreadOut = JSON.parse(unread.body.result.content[0].text);
    assert.equal(unreadOut.chats.length, 1);
    assert.equal(unreadOut.chats[0].label, 'Pribadi');
    const overview = await call('db_overview', {});
    const overviewOut = JSON.parse(overview.body.result.content[0].text);
    assert.equal(overviewOut.accounts[0].messages, 3);
    assert.equal(overviewOut.topChats[0].chat, 'Transys');
    const members = await call('group_members', { chat: 'Transys' });
    const membersOut = JSON.parse(members.body.result.content[0].text);
    assert.equal(membersOut.count, 2);
    const budi = membersOut.members.find(m => m.jid === '6281@c.us');
    assert.equal(budi.name, 'Budi');
    assert.equal(budi.phone, '6281');
    assert.equal(budi.isAdmin, 1);
    const missingMembers = await call('group_members', {});
    assert.equal(missingMembers.body.result.isError, true);
  });
});

test('ftsQuery quotes plain phrases and body size is capped', async t => {
  await withServer(t, async ({ url, rpc }) => {
    assert.equal(ftsQuery('jadwal armada'), '"jadwal armada"');
    assert.equal(ftsQuery('armada*'), 'armada*');
    assert.equal(ftsQuery('  '), undefined);
    const response = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'y'.repeat(300 * 1024) } }) });
    assert.equal(response.status, 413);
  });
});

test('startServer refuses to boot without a key', async () => {
  await assert.rejects(() => startServer({ config: { host: '127.0.0.1', port: 0, key: '', dbPath: '/tmp/x.sqlite' } }), /WAREADER_MCP_KEY/);
});

test('send_message: hanya terdaftar bila app menyuntik send; target di-resolve dari arsip', async t => {
  await withServer(t, async ({ rpc }) => {
    const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.ok(!list.body.result.tools.some(tool => tool.name === 'send_message'));
    const call = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_message', arguments: { chat: 'Alice', text: 'x' } } });
    assert.equal(call.body.error.code, -32602);
    const proto = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'constructor', arguments: {} } });
    assert.equal(proto.body.error.code, -32602);
  });

  const { db, dir } = tempDb();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const insert = db.prepare('INSERT INTO messages(account,id,chat,isGroup,sender,text,timestamp,fromMe) VALUES (?,?,?,?,?,?,?,?)');
  insert.run('628111@c.us', 'false_7001@lid_3EB0AA', 'Bobi', 0, 'Bobi', 'halo', '2026-11-13T01:00:00.000Z', 0);
  insert.run('628111@c.us', 'false_1203@g.us_3EB0BB_7002@lid', 'Tim', 1, 'Rina', 'rapat', '2026-11-13T02:00:00.000Z', 0);
  insert.run('628222@c.us', 'true_1203@g.us_3EB0CC', 'Tim', 1, 'me', 'siap', '2026-11-13T03:00:00.000Z', 1);
  insert.run('628111@c.us', 'false_5550@newsletter_99', 'Kanal', 0, 'Kanal', 'info', '2026-11-13T04:00:00.000Z', 0);
  insert.run('628111@c.us', 'false_7003@lid_3EB0DD', 'Dobel', 0, 'Dobel', 'a', '2026-11-13T05:00:00.000Z', 0);
  insert.run('628111@c.us', 'false_7004@lid_3EB0EE', 'Dobel', 0, 'Dobel', 'b', '2026-11-13T06:00:00.000Z', 0);
  db.prepare('INSERT INTO accounts(account,label,lastSeen) VALUES (?,?,?)').run('628222@c.us', 'Kantor', '2026-11-13T02:00:00.000Z');
  const sent = [];
  let reply = { status: 'sent' };
  const send = async target => { sent.push(target); return reply; };
  const handler = makeHandler({ db, config: { key: KEY }, logger: { info() {}, warn() {}, error() {} }, send });
  const http = require('node:http');
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = async (args, id = 1) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'send_message', arguments: args } }) });
    const { result } = await response.json();
    return { isError: result.isError, text: result.content[0].text };
  };
  const listed = await (await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }) })).json();
  assert.ok(listed.result.tools.some(tool => tool.name === 'send_message' && tool.inputSchema.required.includes('text')));

  let out = await call({ chat: 'Bobi', text: '  oke, besok ya  ' });
  assert.deepEqual(JSON.parse(out.text), { status: 'sent', chat: 'Bobi', account: 'Pribadi' });
  assert.equal(out.isError, false);
  assert.deepEqual(sent.at(-1), { account: '628111@c.us', label: 'Pribadi', chat: 'Bobi', chatJid: '7001@lid', phone: '', isGroup: false, text: 'oke, besok ya', source: 'mcp' });
  out = await call({ chat: 'Tim', text: 'x', account: 'Kantor' });
  assert.equal(sent.at(-1).chatJid, '1203@g.us');
  assert.equal(sent.at(-1).account, '628222@c.us');
  out = await call({ chat: 'Tim', text: 'x', account: '+62 8111' });
  assert.equal(sent.at(-1).account, '628111@c.us');
  reply = { status: 'cancelled', detail: 'dibatalkan user' };
  out = await call({ chat: 'Bobi', text: 'x' });
  assert.equal(JSON.parse(out.text).status, 'cancelled');
  assert.equal(out.isError, false);
  reply = { status: 'failed', detail: 'akun WhatsApp belum terhubung' };
  out = await call({ chat: 'Bobi', text: 'x' });
  assert.equal(JSON.parse(out.text).status, 'failed');
  assert.equal(out.isError, true);

  const count = sent.length;
  for (const [args, pattern] of [
    [{ chat: 'Tidak Ada', text: 'x' }, /not found in the archive/],
    [{ chat: 'Tim', text: 'x' }, /several accounts; pass account: (?=.*Pribadi \(628111@c\.us\))(?=.*Kantor \(628222@c\.us\))/],
    [{ chat: 'Tim', text: 'x', account: 'Lain' }, /not found for account/],
    [{ chat: 'Kanal', text: 'x' }, /cannot receive/],
    [{ chat: 'Transys', text: 'x' }, /cannot receive/],
    [{ chat: 'Dobel', text: 'x' }, /ambiguous/],
    [{ chat: 'Bobi', text: '   ' }, /text is required/],
    [{ chat: 'Bobi', text: 'x'.repeat(2001) }, /limited to 2000/],
    [{ text: 'x' }, /chat is required/],
  ]) {
    out = await call(args);
    assert.equal(out.isError, true);
    assert.match(out.text, pattern);
  }
  assert.equal(sent.length, count, 'error validasi tidak boleh memanggil send');
});

test('send_message + list_chats memakai tabel chats: nama, nomor WA (62/0), JID, nama lama', async t => {
  const { db, dir } = tempDb();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE chats (account TEXT NOT NULL, chatId TEXT NOT NULL, name TEXT, phone TEXT, isGroup INTEGER, lastAt TEXT, updatedAt TEXT, PRIMARY KEY(account, chatId));`);
  const insert = db.prepare('INSERT INTO messages(account,id,chat,isGroup,sender,text,timestamp,fromMe,chatId) VALUES (?,?,?,?,?,?,?,?,?)');
  insert.run('628111@c.us', 'false_235428766560410@lid_A0', '+62 856-9378-4939', 0, 'x', 'lama', '2026-11-19T01:00:00.000Z', 0, '235428766560410@lid');
  insert.run('628111@c.us', 'false_235428766560410@lid_A1', 'Dio', 0, 'Dio', 'baru', '2026-11-20T02:13:24.000Z', 0, '235428766560410@lid');
  db.prepare('INSERT INTO chats VALUES (?,?,?,?,?,?,?)').run('628111@c.us', '235428766560410@lid', 'Dio', '6285693784939', 0, '2026-11-20T02:13:24.000Z', '2026-11-20T02:13:25.000Z');
  const target = { account: '628111@c.us', label: 'Pribadi', chat: 'Dio', chatJid: '235428766560410@lid', phone: '6285693784939', isGroup: false, text: 'hai test kirim' };
  const { resolveSendTarget } = require('./server.js');
  for (const chat of ['6285693784939', '+62 856-9378-4939', '085693784939', '235428766560410@lid', 'Dio', '+62 856-9378-4939 ']) {
    assert.deepEqual(resolveSendTarget(db, { chat, text: 'hai test kirim' }), target, chat);
  }
  assert.throws(() => resolveSendTarget(db, { chat: '6281111111111', text: 'x' }), /not found/);
  const listed = makeTools(db).list_chats({});
  assert.deepEqual(listed.chats.filter(row => row.chatId === '235428766560410@lid').map(row => [row.chat, row.phone]).sort(), [['+62 856-9378-4939', '6285693784939'], ['Dio', '6285693784939']]);
  assert.ok(makeTools(db).list_chats({ since: '2026-11-20T00:00:00Z' }).chats.every(row => row.lastAt >= '2026-11-20'));
});

test('saklar kirim OFF: MCP send_message → disabled tanpa membaca arsip atau memanggil app', async t => {
  const { db, dir } = tempDb();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { SEND_DISABLED } = require('./server.js');
  let on = false;
  const sent = [];
  const handler = makeHandler({ db, config: { key: KEY }, logger: { info() {}, warn() {}, error() {} }, send: async target => { sent.push(target); return { status: 'sent' }; }, sendEnabled: () => on });
  const http = require('node:http');
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = async args => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: args } }) });
    const { result } = await response.json();
    let data = result.content[0].text;
    try { data = JSON.parse(data); } catch {}
    return { isError: result.isError, data };
  };
  for (const args of [{ chat: 'Alice', text: 'x' }, { chat: 'tidak ada', text: '' }]) {
    assert.deepEqual(await call(args), { isError: true, data: { status: 'disabled', detail: SEND_DISABLED } });
  }
  assert.match(SEND_DISABLED, /Settings > LLM Agent > "Allow Agent & MCP to send messages"/);
  assert.equal(sent.length, 0);
  on = true;
  assert.match(JSON.stringify(await call({ chat: 'Alice', text: 'x' })), /cannot receive/); // ON → resolver jalan lagi
});

test('wa_action: hanya terdaftar bila app menyuntik actions; OFF gate + resolver', async t => {
  await withServer(t, async ({ rpc }) => {
    const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.ok(!list.body.result.tools.some(tool => tool.name === 'wa_action'));
    const call = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wa_action', arguments: { action: 'typing', chat: 'Alice' } } });
    assert.equal(call.body.error.code, -32602);
  });

  const { db, dir } = tempDb();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  db.prepare('INSERT INTO messages(account,id,chat,isGroup,sender,text,timestamp,fromMe) VALUES (?,?,?,?,?,?,?,?)').run('628111@c.us', 'false_7001@lid_3EB0AA', 'Bobi', 0, 'Bobi', 'halo', '2026-11-13T01:00:00.000Z', 0);
  const calls = [];
  let on = false;
  const handler = makeHandler({ db, config: { key: KEY }, logger: { info() {}, warn() {}, error() {} }, actions: async arg => { calls.push(arg); return { status: 'ok' }; }, actionsEnabled: () => on });
  const http = require('node:http');
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = async (name, args) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const { result } = await response.json();
    let data = result.content[0].text;
    try { data = JSON.parse(data); } catch {}
    return { isError: result.isError, data };
  };
  const list = await (await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })).json();
  assert.ok(list.result.tools.some(tool => tool.name === 'wa_action'));
  assert.deepEqual(await call('wa_action', { action: 'typing', chat: 'Bobi' }), { isError: true, data: { status: 'disabled', detail: ACTIONS_DISABLED } });
  assert.equal(calls.length, 0);
  on = true;
  assert.deepEqual(await call('wa_action', { action: 'typing', chat: 'Bobi' }), { isError: false, data: { status: 'ok', chat: 'Bobi', account: 'Pribadi' } });
  assert.deepEqual(calls.at(-1), { account: '628111@c.us', label: 'Pribadi', chat: 'Bobi', chatJid: '7001@lid', phone: '', isGroup: false, text: '', action: 'typing', source: 'mcp' });
});
