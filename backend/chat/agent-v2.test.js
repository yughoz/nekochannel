'use strict';
// #30 Agent v2: compaction riwayat, persistensi sesi, fallback provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startServer, makeModelChain, compactHistory } = require('./server.js');
const { openSessions } = require('./sessions.js');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wachat-v2-'));
  const db = new DatabaseSync(path.join(dir, 'wa.sqlite'));
  db.exec(`
    CREATE TABLE messages (account TEXT NOT NULL, id TEXT NOT NULL, chat TEXT, isGroup INTEGER, sender TEXT, text TEXT, timestamp TEXT, fromMe INTEGER, mentionsMe INTEGER, replyToMe INTEGER, createdAt TEXT, PRIMARY KEY(account, id));
    CREATE VIRTUAL TABLE messages_fts USING fts5(text, chat, sender, account, content='messages', content_rowid='rowid', tokenize='unicode61');
    CREATE TABLE chat_unread (account TEXT NOT NULL, chat TEXT NOT NULL, chatId TEXT, unread INTEGER, isGroup INTEGER, updatedAt TEXT, PRIMARY KEY(account, chat));
    CREATE TABLE accounts (account TEXT PRIMARY KEY, label TEXT, lastSeen TEXT);
  `);
  return { db, dir };
}
const answer = content => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const toolCall = (name, args, id = 'c1') => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
const http = (status, body = {}) => ({ ok: status < 400, status, json: async () => body });
// fetch palsu per-URL: handler(url, body, n) → payload/Response-like/Error.
function routedFetch(handler) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body, auth: opts.headers?.authorization });
    const out = await handler(url, body, calls.length);
    if (out instanceof Error) throw out;
    return out && typeof out.ok === 'boolean' ? out : http(200, out);
  };
  fn.calls = calls;
  return fn;
}
const base = dir => ({ host: '127.0.0.1', port: 0, modelUrl: 'http://primary.local/v1', modelName: 'utama', modelKey: 'k-utama', dataDir: dir, dbPath: path.join(dir, 'wa.sqlite'), mode: 'fc', maxToolRounds: 4, maxHistory: 24, compactAt: 16, keepRecent: 8 });
const quiet = { info() {}, warn() {}, error() {} };
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
async function withServer(t, { config = {}, fetchImpl, sessions } = {}, fn) {
  const { db, dir } = tempDb();
  const store = sessions === 'file' ? openSessions(path.join(dir, 'wa.sqlite')) : sessions;
  const { server, close } = await startServer({ config: { ...base(dir), ...config }, logger: quiet, fetchImpl, db, sessions: store });
  t.after(async () => { await close(); store?.close?.(); fs.rmSync(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await fn({ url, post, store, dir });
}
const conversation = n => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `pesan ${i}` }));
const isSummaryCall = body => !body.tools && /Ringkas percakapan/.test(body.messages[0].content);

test('compaction: > ambang → blok lama diringkas, 8 terbaru verbatim, done.compacted', async t => {
  const fetchImpl = routedFetch((url, body) => (isSummaryCall(body) ? answer('- user menanyakan promo') : answer('jawaban')));
  await withServer(t, { fetchImpl }, async ({ post }) => {
    const events = await sse(await post({ messages: conversation(19) }));
    assert.deepEqual(events.map(e => e.event), ['delta', 'done']);
    assert.equal(events[1].data.compacted, 11);
    assert.equal(fetchImpl.calls.length, 2);
    assert.ok(isSummaryCall(fetchImpl.calls[0].body));
    assert.match(fetchImpl.calls[0].body.messages[1].content, /User: pesan 0/);
    const agent = fetchImpl.calls[1].body;
    assert.match(agent.messages[0].content, /\[RANGKUMAN PERCAKAPAN SEBELUMNYA[^\]]*\]\n- user menanyakan promo/);
    assert.equal(agent.messages.length, 1 + 8);
    assert.equal(agent.messages.at(-1).content, 'pesan 18');
  });
});

test('compaction gagal ringkas → degradasi ke truncation, chat tetap jalan', async t => {
  const fetchImpl = routedFetch((url, body) => (isSummaryCall(body) ? http(400) : answer('tetap jawab')));
  await withServer(t, { fetchImpl, config: { maxHistory: 6 } }, async ({ post }) => {
    const events = await sse(await post({ messages: conversation(19) }));
    assert.equal(events.at(-1).event, 'done');
    assert.equal(events[0].data.text, 'tetap jawab');
    assert.equal(events.at(-1).data.compacted, undefined);
    const agent = fetchImpl.calls.at(-1).body;
    assert.doesNotMatch(agent.messages[0].content, /RANGKUMAN/);
    assert.equal(agent.messages.length, 1 + 6);
  });
});

test('compaction + sesi: ringkasan di-cache, lanjutan diringkas inkremental', async t => {
  let summaries = 0;
  const fetchImpl = routedFetch((url, body) => (isSummaryCall(body) ? answer(`ringkasan-${++summaries}`) : answer('ok')));
  await withServer(t, { fetchImpl, sessions: 'file' }, async ({ post, store }) => {
    let history = conversation(19);
    await sse(await post({ session: 'whatsapp-1', messages: history }));
    assert.equal(summaries, 1);
    const saved = store.get('whatsapp-1');
    assert.equal(saved.history.length, 20); // 19 + jawaban
    assert.equal(saved.summary, 'ringkasan-1');
    assert.equal(saved.summarizedCount, 11);
    // Blok lama sama persis → cache, tanpa panggilan ringkas baru.
    await sse(await post({ session: 'whatsapp-1', messages: history }));
    assert.equal(summaries, 1);
    // Riwayat bertambah 2 → hanya 2 pesan baru yang diringkas, bersama ringkasan lama.
    history = [...saved.history, { role: 'user', content: 'pesan baru' }];
    const before = fetchImpl.calls.length;
    await sse(await post({ session: 'whatsapp-1', messages: history }));
    assert.equal(summaries, 2);
    const incremental = fetchImpl.calls.slice(before).find(call => isSummaryCall(call.body)).body.messages[1].content;
    assert.match(incremental, /Ringkasan sebelumnya:\nringkasan-1/);
    assert.doesNotMatch(incremental, /pesan 0\n/);
  });
});

test('persistensi: GET/DELETE /api/session, backup, guard origin & kunci', async t => {
  const fetchImpl = routedFetch(() => answer('halo juga'));
  await withServer(t, { fetchImpl, sessions: 'file' }, async ({ url, post, store }) => {
    await sse(await post({ session: 'whatsapp-2', account: '628111@c.us', messages: [{ role: 'user', content: 'halo' }] }));
    const got = await (await fetch(`${url}/api/session?key=whatsapp-2`)).json();
    assert.deepEqual(got.history, [{ role: 'user', content: 'halo' }, { role: 'assistant', content: 'halo juga' }]);
    assert.equal(got.account, '628111@c.us');
    assert.equal((await fetch(`${url}/api/session?key=whatsapp-2`, { headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await fetch(`${url}/api/session?key=../etc`)).status, 400);
    assert.deepEqual(await (await fetch(`${url}/api/session?key=whatsapp-2`, { method: 'DELETE' })).json(), { ok: true, cleared: true });
    assert.deepEqual((await (await fetch(`${url}/api/session?key=whatsapp-2`)).json()).history, []);
    assert.equal(store.backups('whatsapp-2').length, 1);
  });
});

test('persistensi: round-trip setelah restart (tutup + buka ulang store)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wachat-sess-'));
  try {
    const file = path.join(dir, 'wa.sqlite');
    let store = openSessions(file);
    store.save('agent', { account: '628111@c.us', history: [{ role: 'user', content: 'a' }, { role: 'system', content: 'buang' }, { role: 'assistant', content: 'b' }], summary: 's', summarizedCount: 3, summaryHash: 'h' });
    store.close();
    store = openSessions(file);
    const row = store.get('agent');
    assert.deepEqual(row.history, [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
    assert.equal(row.summary, 's');
    assert.equal(row.summarizedCount, 3);
    assert.equal(store.get('bad key!'), null);
    assert.equal(store.save('bad key!', {}), false);
    store.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fallback: utama 403 (kuota) → langsung cadangan tanpa retry; done.model/fallback', async t => {
  const fetchImpl = routedFetch(url => (url.startsWith('http://primary') ? http(403, { error: 'insufficient_user_quota' }) : answer('dari cadangan')));
  const config = { fallbackUrl: 'http://backup.local/v1', fallbackName: 'cadangan', fallbackKey: 'k-cadangan' };
  await withServer(t, { fetchImpl, config }, async ({ url, post }) => {
    const events = await sse(await post({ messages: [{ role: 'user', content: 'halo' }] }));
    assert.equal(events[0].data.text, 'dari cadangan');
    assert.equal(events.at(-1).data.model, 'cadangan');
    assert.equal(events.at(-1).data.fallback, true);
    assert.deepEqual(fetchImpl.calls.map(call => call.url.split('/')[2]), ['primary.local', 'backup.local']);
    assert.equal(fetchImpl.calls[1].auth, 'Bearer k-cadangan');
    assert.equal(fetchImpl.calls[1].body.model, 'cadangan');
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.fallback, 'cadangan');
  });
});

test('fallback: error transien di utama → retry 1x, tetap di utama', async t => {
  let primary = 0;
  const fetchImpl = routedFetch(url => (url.startsWith('http://primary') ? (++primary === 1 ? http(503) : answer('utama pulih')) : answer('cadangan')));
  await withServer(t, { fetchImpl, config: { fallbackUrl: 'http://backup.local/v1', fallbackName: 'cadangan' } }, async ({ post }) => {
    const events = await sse(await post({ messages: [{ role: 'user', content: 'halo' }] }));
    assert.equal(events[0].data.text, 'utama pulih');
    assert.equal(events.at(-1).data.fallback, false);
    assert.equal(primary, 2);
    assert.ok(fetchImpl.calls.every(call => call.url.startsWith('http://primary')));
  });
});

test('fallback: sekali utama gagal, ronde tool berikutnya langsung cadangan', async t => {
  let backup = 0;
  const fetchImpl = routedFetch(url => (url.startsWith('http://primary') ? http(401) : (++backup === 1 ? toolCall('db_overview', {}) : answer('selesai'))));
  await withServer(t, { fetchImpl, config: { fallbackUrl: 'http://backup.local/v1', fallbackName: 'cadangan' } }, async ({ post }) => {
    const events = await sse(await post({ messages: [{ role: 'user', content: 'overview' }] }));
    assert.equal(events.at(-1).data.rounds, 2);
    assert.equal(fetchImpl.calls.filter(call => call.url.startsWith('http://primary')).length, 1);
  });
});

test('fallback: utama & cadangan gagal → error jelas', async t => {
  const fetchImpl = routedFetch(url => (url.startsWith('http://primary') ? http(403) : http(500)));
  await withServer(t, { fetchImpl, config: { fallbackUrl: 'http://backup.local/v1', fallbackName: 'cadangan' } }, async ({ post }) => {
    const events = await sse(await post({ messages: [{ role: 'user', content: 'halo' }] }));
    assert.deepEqual(events.map(e => e.event), ['error']);
    assert.equal(events[0].data.message, 'Primary and fallback models failed');
    assert.equal(fetchImpl.calls.filter(call => call.url.startsWith('http://backup')).length, 2); // 500 = transien → retry 1x
  });
});

test('makeModelChain tanpa cadangan: error asli diteruskan; compactHistory di bawah ambang = no-op', async () => {
  const chain = makeModelChain({ config: { modelUrl: 'http://p', modelName: 'm', modelKey: '' }, fetchImpl: async () => http(403), retryDelayMs: 0 });
  await assert.rejects(chain.call({ messages: [] }), /model http 403/);
  const short = conversation(4);
  const out = await compactHistory({ history: short, config: { compactAt: 16, keepRecent: 8 }, chain });
  assert.equal(out.history, short);
  assert.equal(out.compacted, 0);
});

test('#31 readOnly: tool kirim/aksi tidak ditawarkan, prompt menyatakan baca-saja', async t => {
  const fetchImpl = routedFetch(() => answer('ringkasan'));
  const { db, dir } = tempDb();
  const { server, close } = await startServer({ config: base(dir), logger: quiet, fetchImpl, db, sessions: null,
    send: async () => ({ status: 'sent' }), sendEnabled: () => true, actions: async () => ({ status: 'ok' }), actionsEnabled: () => true });
  t.after(async () => { await close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await sse(await post({ messages: [{ role: 'user', content: 'rangkum' }], readOnly: true }));
  const names = fetchImpl.calls[0].body.tools.map(tool => tool.function.name);
  assert.ok(!names.includes('send_message') && !names.includes('wa_action'));
  assert.match(fetchImpl.calls[0].body.messages[0].content, /tidak bisa mengirim pesan/);
  await sse(await post({ messages: [{ role: 'user', content: 'biasa' }] }));
  assert.ok(fetchImpl.calls[1].body.tools.some(tool => tool.function.name === 'send_message')); // request biasa tetap utuh
});

test('#33 noTools: request ke model tanpa field tools (data sudah di prompt)', async t => {
  const fetchImpl = routedFetch(() => answer('ringkasan'));
  await withServer(t, { fetchImpl }, async ({ post }) => {
    await sse(await post({ messages: [{ role: 'user', content: 'rangkum data terlampir' }], readOnly: true, noTools: true }));
    assert.equal('tools' in fetchImpl.calls[0].body, false);
    assert.match(fetchImpl.calls[0].body.messages[0].content, /data arsip yang dilampirkan/);
  });
});
