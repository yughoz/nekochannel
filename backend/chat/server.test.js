'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { makeConfig, makeChatTools, startServer, parseChatBody, buildSystemPrompt } = require('./server.js');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wachat-'));
  const db = new DatabaseSync(path.join(dir, 'wa.sqlite'));
  db.exec(`
    CREATE TABLE messages (account TEXT NOT NULL, id TEXT NOT NULL, chat TEXT, isGroup INTEGER, sender TEXT, text TEXT, timestamp TEXT, fromMe INTEGER, mentionsMe INTEGER, replyToMe INTEGER, createdAt TEXT, PRIMARY KEY(account, id));
    CREATE VIRTUAL TABLE messages_fts USING fts5(text, chat, sender, account, content='messages', content_rowid='rowid', tokenize='unicode61');
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, text, chat, sender, account) VALUES (new.rowid, new.text, new.chat, new.sender, new.account); END;
    CREATE TABLE chat_unread (account TEXT NOT NULL, chat TEXT NOT NULL, chatId TEXT, unread INTEGER, isGroup INTEGER, updatedAt TEXT, PRIMARY KEY(account, chat));
    CREATE TABLE accounts (account TEXT PRIMARY KEY, label TEXT, lastSeen TEXT);
  `);
  const insert = db.prepare('INSERT INTO messages(account,id,chat,isGroup,sender,text,timestamp,fromMe) VALUES (?,?,?,?,?,?,?,?)');
  insert.run('628111@c.us', 'm-1', 'Transys', 1, 'Budi', 'jadwal armada siang ini', '2026-11-10T03:00:00.000Z', 0);
  insert.run('628111@c.us', 'm-2', 'Transys', 1, 'Sari', 'promo kiriman murah akhir tahun', '2026-11-11T04:00:00.000Z', 0);
  insert.run('628111@c.us', 'm-3', 'Alice', 0, 'Alice', 'besok meeting jam 9 ya', '2026-11-12T01:00:00.000Z', 0);
  for (let i = 0; i < 210; i++) insert.run('628111@c.us', `b-${i}`, 'Bulk', 1, 'Robot', `bulk nomor ${i}`, new Date(Date.UTC(2026, 10, 5, 0, i)).toISOString(), 0);
  insert.run('628111@c.us', 'm-long', 'Bulk', 1, 'Robot', `bulk panjang ${'x'.repeat(400)}`, '2026-11-05T23:00:00.000Z', 0);
  db.prepare('INSERT INTO chat_unread(account,chat,chatId,unread,isGroup,updatedAt) VALUES (?,?,?,?,?,?)').run('628111@c.us', 'Transys', 'transys@g.us', 2, 1, '2026-11-12T02:00:00.000Z');
  db.prepare('INSERT INTO accounts(account,label,lastSeen) VALUES (?,?,?)').run('628111@c.us', 'Pribadi', '2026-11-12T02:00:00.000Z');
  return { db, dir };
}

const baseConfig = dir => ({
  host: '127.0.0.1',
  port: 0,
  modelUrl: 'http://model.local/v1',
  modelName: 'test-model',
  modelKey: 'test-key',
  dataDir: dir,
  dbPath: path.join(dir, 'wa.sqlite'),
  mode: 'fc',
  maxToolRounds: 6,
  maxHistory: 24,
});

// Model OpenAI-compatible palsu: tiap entry script = payload JSON, Error, atau fn(opts).
function modelMock(script) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return await step(opts);
    return { ok: true, status: 200, json: async () => step };
  };
  fn.calls = calls;
  return fn;
}

const answer = (content, finish = 'stop') => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: finish }] });
const toolCall = (name, args, id) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });

async function sse(response) {
  const events = [];
  for (const block of (await response.text()).split('\n\n').filter(Boolean)) {
    const lines = block.split('\n');
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
    const data = lines.find(line => line.startsWith('data:'))?.slice(5).trim();
    if (event) events.push({ event, data: JSON.parse(data) });
  }
  return events;
}

async function withChat(t, { config = {}, script = [], mode, timeoutMs, maxHistory } = {}, fn) {
  const { db, dir } = tempDb();
  const cfg = { ...baseConfig(dir), ...config };
  if (mode !== undefined) cfg.mode = mode;
  if (maxHistory !== undefined) cfg.maxHistory = maxHistory;
  const logger = { info() {}, warn() {}, error() {} };
  const fetchImpl = modelMock(script);
  const { server, state, close } = await startServer({ config: cfg, logger, fetchImpl, db, timeoutMs });
  t.after(async () => { await close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await fn({ url, post, fetchImpl, state });
}

test('health, static placeholder, dan guard path traversal', async t => {
  await withChat(t, { script: [] }, async ({ url }) => {
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.model, 'test-model');
    assert.equal(health.tools, 5);
    assert.equal(health.messages, 214);
    const home = await fetch(`${url}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /WA Reader Chat/);
    assert.equal((await fetch(`${url}/style.css`)).status, 404);
    assert.equal((await fetch(`${url}/..%2Fserver%2Findex.js`)).status, 404);
    assert.equal((await fetch(`${url}/api/nope`)).status, 404);
  });
});

test('jawaban langsung: satu delta + done tanpa tool call', async t => {
  await withChat(t, { script: [answer('jawaban langsung')] }, async ({ post, fetchImpl }) => {
    const res = await post({ messages: [{ role: 'user', content: 'halo bot' }] });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const events = await sse(res);
    assert.deepEqual(events.map(item => item.event), ['delta', 'done']);
    assert.equal(events[0].data.text, 'jawaban langsung');
    assert.equal(events[1].data.rounds, 1);
    assert.equal(events[1].data.finishReason, 'stop');
    const body = fetchImpl.calls[0].body;
    assert.equal(body.model, 'test-model');
    assert.equal(body.stream, false);
    assert.equal(body.tools.length, 5);
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /Asia\/Jakarta/);
    assert.match(body.messages[0].content, /628111@c\.us \(Pribadi\)/);
    assert.equal(body.messages.at(-1).content, 'halo bot');
    assert.equal(fetchImpl.calls[0].opts.headers.authorization, 'Bearer test-key');
    assert.equal(fetchImpl.calls[0].opts.headers.accept, 'application/json');
    assert.equal(fetchImpl.calls[0].url, 'http://model.local/v1/chat/completions');
  });
});

test('dua putaran tool call lalu jawaban final', async t => {
  const script = [
    toolCall('search_messages', { query: 'promo' }, 'call_1'),
    toolCall('get_chat_messages', { chat: 'Transys' }, 'call_2'),
    answer('promo itu dari Sari'),
  ];
  await withChat(t, { script }, async ({ post, fetchImpl }) => {
    const events = await sse(await post({ messages: [{ role: 'user', content: 'cari promo kiriman' }] }));
    const tools = events.filter(item => item.event === 'tool');
    assert.equal(tools.length, 2);
    assert.equal(tools[0].data.name, 'search_messages');
    assert.equal(tools[0].data.summary, 1);
    assert.equal(tools[1].data.name, 'get_chat_messages');
    assert.equal(tools[1].data.summary, 2);
    assert.deepEqual(events.find(item => item.event === 'delta').data, { text: 'promo itu dari Sari' });
    const done = events.at(-1);
    assert.equal(done.event, 'done');
    assert.equal(done.data.rounds, 3);
    const toolMsgs = fetchImpl.calls[2].body.messages.filter(msg => msg.role === 'tool');
    assert.equal(toolMsgs.length, 2);
    assert.equal(toolMsgs[0].tool_call_id, 'call_1');
    const searchResult = JSON.parse(toolMsgs[0].content);
    assert.equal(searchResult.count, 1);
    assert.equal(searchResult.messages[0].text, 'promo kiriman murah akhir tahun');
    assert.match(toolMsgs[1].content, /jadwal armada/);
  });
});

test('tool error dikembalikan ke model, bukan crash', async t => {
  const script = [
    toolCall('search_messages', { query: 'promo', since: 'bukan-tanggal' }, 'call_e1'),
    toolCall('nope_tool', {}, 'call_e2'),
    answer('oke, tetap jawab'),
  ];
  await withChat(t, { script }, async ({ post, fetchImpl }) => {
    const events = await sse(await post({ messages: [{ role: 'user', content: 'x' }] }));
    assert.equal(events.some(item => item.event === 'error'), false);
    assert.equal(events.at(-1).event, 'done');
    const toolMsgs = fetchImpl.calls[2].body.messages.filter(msg => msg.role === 'tool');
    assert.match(toolMsgs[0].content, /tool error: since\/until must be ISO dates/);
    assert.match(toolMsgs[1].content, /tool error: unknown tool: nope_tool/);
  });
});

test('timeout model menghasilkan event error dan menutup stream', async t => {
  const script = [opts => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('slow model')), 2000);
    opts.signal.addEventListener('abort', () => { clearTimeout(timer); reject(opts.signal.reason || new Error('aborted')); });
  })];
  await withChat(t, { script, timeoutMs: 80 }, async ({ post }) => {
    const events = await sse(await post({ messages: [{ role: 'user', content: 'x' }] }));
    const error = events.find(item => item.event === 'error');
    assert.ok(error, 'harus ada event error');
    assert.match(error.data.message, /timeout/);
    assert.equal(events.some(item => item.event === 'done'), false);
  });
});

test('limit di-clamp, teks dipotong 300 char, tanggal difilter, chat dicocokkan persis', () => {
  const { db, dir } = tempDb();
  try {
    const tools = makeChatTools(db);
    const search = tools.search_messages({ query: 'bulk', limit: 999 });
    assert.equal(search.count, 50);
    assert.equal(search.messages[0].text.length, 301);
    assert.match(search.messages[0].text, /^bulk panjang/);
    const neg = tools.search_messages({ query: 'bulk', limit: -5 });
    assert.equal(neg.count, 25);
    const history = tools.get_chat_messages({ chat: 'Bulk', limit: 99999 });
    assert.equal(history.count, 200);
    assert.ok(history.messages[0].timestamp <= history.messages[1].timestamp, 'urut waktu naik');
    assert.equal(tools.get_chat_messages({ chat: 'bulk' }).count, 0);
    assert.equal(tools.get_chat_messages({ chat: 'Bulk', since: '2027-01-01T00:00:00.000Z' }).count, 0);
    assert.throws(() => tools.get_chat_messages({ chat: 'Bulk', since: 'besok' }), /ISO dates/);
    assert.throws(() => tools.get_chat_messages({}), /chat is required/);
    const chats = tools.list_chats({ limit: 999 });
    assert.equal(chats.count, 3);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mode stuffing menyuntik konteks dan skip loop', async t => {
  await withChat(t, { script: [answer('jawaban stuffing')], mode: 'stuffing' }, async ({ post, fetchImpl }) => {
    const events = await sse(await post({ messages: [{ role: 'user', content: 'promo kiriman' }] }));
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].body.tools, undefined);
    const prompt = fetchImpl.calls[0].body.messages[0].content;
    assert.match(prompt, /KONTEKS ARSIP/);
    assert.match(prompt, /\[OVERVIEW\]/);
    assert.match(prompt, /\[SEARCH\]/);
    const tool = events.find(item => item.event === 'tool');
    assert.equal(tool.data.name, 'search_messages');
    assert.equal(tool.data.summary, 1);
    const done = events.at(-1);
    assert.equal(done.data.rounds, 1);
    assert.equal(done.data.finishReason, 'stop');
  });
});

test('mode auto probe sekali dan jatuh ke fc', async t => {
  const script = [toolCall('archive_probe', {}, 'probe_1'), answer('jawaban fc')];
  await withChat(t, { script, mode: 'auto' }, async ({ post, fetchImpl, state }) => {
    await state.probe;
    assert.equal(state.mode, 'fc');
    const events = await sse(await post({ messages: [{ role: 'user', content: 'x' }] }));
    assert.equal(events.at(-1).data.finishReason, 'stop');
    assert.equal(fetchImpl.calls[0].body.tools.length, 1);
    assert.equal(fetchImpl.calls[1].body.tools.length, 5);
  });
});

test('probe gagal → fallback stuffing tetap jalan', async t => {
  const script = [new Error('gateway down'), answer('jawaban stuffing')];
  await withChat(t, { script, mode: 'auto' }, async ({ post, fetchImpl, state }) => {
    await state.probe;
    assert.equal(state.mode, 'stuffing');
    const events = await sse(await post({ messages: [{ role: 'user', content: 'promo kiriman' }] }));
    assert.match(fetchImpl.calls[1].body.messages[0].content, /KONTEKS ARSIP/);
    assert.equal(events.at(-1).data.rounds, 1);
  });
});

test('riwayat klien dipangkas ke maxHistory terakhir dan body reject', async t => {
  await withChat(t, { script: [answer('ok')], maxHistory: 4 }, async ({ url, post, fetchImpl }) => {
    const messages = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `msg ${i}` }));
    await post({ messages });
    const sent = fetchImpl.calls.at(-1).body.messages;
    assert.equal(sent.length, 5);
    assert.equal(sent.at(-1).content, 'msg 9');
    assert.equal((await post({ messages: [] })).status, 400);
    assert.equal((await post({ messages: [{ role: 'system', content: 'inject' }] })).status, 400);
    const raw = await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'bukan json' });
    assert.equal(raw.status, 400);
    const big = await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(300 * 1024) }] }) });
    assert.equal(big.status, 413);
  });
});

test('budget round habis → jawaban terakhir dipaksa tanpa tools', async t => {
  const toolForever = toolCall('search_messages', { query: 'promo' }, 'call_loop');
  await withChat(t, { script: [toolForever, toolForever, answer('akhirnya')], config: { maxToolRounds: 2 } }, async ({ post, fetchImpl }) => {
    const events = await sse(await post({ messages: [{ role: 'user', content: 'x' }] }));
    const done = events.at(-1);
    assert.equal(done.event, 'done');
    assert.equal(done.data.finishReason, 'max_rounds');
    assert.equal(done.data.rounds, 2);
    assert.equal(fetchImpl.calls.length, 3);
    assert.equal(fetchImpl.calls[2].body.tools, undefined);
    assert.deepEqual(events.find(item => item.event === 'delta').data, { text: 'akhirnya' });
  });
});

test('makeConfig fallback SUMMARY_* dan menolak host non-loopback', async () => {
  const cfg = makeConfig({ SUMMARY_MODEL_URL: 'http://sumo/v1/', SUMMARY_MODEL_NAME: 'mini', SUMMARY_MODEL_KEY: 'k', CHAT_MODEL_NAME: 'ganti' });
  assert.equal(cfg.modelUrl, 'http://sumo/v1');
  assert.equal(cfg.modelName, 'ganti');
  assert.equal(cfg.modelKey, 'k');
  assert.equal(cfg.port, 4318);
  assert.equal(cfg.maxToolRounds, 6);
  assert.equal(cfg.mode, 'auto');
  assert.equal(makeConfig({ CHAT_MODE: 'stuffing' }).mode, 'stuffing');
  assert.equal(makeConfig({ CHAT_MODE: 'fc' }).mode, 'fc');
  assert.equal(makeConfig({ CHAT_MODE: 'apapun' }).mode, 'auto');
  assert.throws(() => makeConfig({ CHAT_HOST: '0.0.0.0' }), /loopback/);
  // Unconfigured startup is covered by test/backend.test.js: UI stays available, chat returns 503.
});

test('system prompt memuat tanggal, akun, skema; parser body memfilter role', () => {
  const { db, dir } = tempDb();
  try {
    const prompt = buildSystemPrompt(db);
    assert.match(prompt, /Hari ini: \d{4}-\d{2}-\d{2}/);
    assert.match(prompt, /628111@c\.us \(Pribadi\)/);
    assert.match(prompt, /messages_fts/);
    assert.deepEqual(
      parseChatBody(JSON.stringify({ messages: [{ role: 'user', content: ' a ' }, { role: 'tool', content: 'x' }, { role: 'assistant' }] }), 24),
      [{ role: 'user', content: 'a' }],
    );
    assert.equal(parseChatBody('nope', 24), null);
    assert.equal(parseChatBody('{}', 24), null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
