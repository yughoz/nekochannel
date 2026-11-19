'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { defaults, validate, patchConfig, openStore, testWebhook, modelConfig } = require('../shell/integrations');
const { startBackend } = require('../backend');
const { evaluateMessage, sendWebhookEvent, MessageArchive } = require('../backend/server');
const quiet = { info() {}, warn() {}, error() {} };
const ports = { NEKOCHANNEL_INGEST_PORT: '0', NEKOCHANNEL_CHAT_PORT: '0', NEKOCHANNEL_MCP_PORT: '0' };
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
function directory(context) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'neko-integrations-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function encryption() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test-aes-gcm',
    encryptString(text) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    decryptString(buffer) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
      decipher.setAuthTag(buffer.subarray(12, 28));
      return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}
async function mockServer(context, status = () => 200) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    requests.push({ url: request.url, headers: request.headers, body: JSON.parse(text || '{}') });
    response.statusCode = status(requests.length);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url.endsWith('/systemone') ? { answers: { is_promo: { noul: 0.595 }, needs_reply: { noul: 0.9 } } } : { choices: [{ message: { role: 'assistant', content: 'Fixture summary.' }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

test('encrypted Settings migration, recovery, blank retains, reset and GUI precedence', context => {
  const dir = directory(context), secure = encryption();
  const original = '# retained\nCHAT_MODEL_URL=https://fixture.invalid/v1\nCHAT_MODEL_NAME=old\nCHAT_MODEL_KEY=fake-old-key\nOTHER=value\n';
  fs.writeFileSync(path.join(dir, '.env'), original);
  fs.writeFileSync(path.join(dir, 'mcp-key'), 'fake-mcp-key');
  const store = openStore(dir, secure, { CHAT_MODEL_KEY: 'fake-env-key', WEBHOOK_URL: 'https://hook.invalid', WEBHOOK_KEY: 'fake-hook-key' });
  assert.equal(store.get().llm.key, 'fake-old-key');
  assert.equal(store.get().webhook.enabled, false);
  assert.equal(store.get().jev.enabled, false);
  assert.equal(store.get().mcp.key, 'fake-mcp-key');
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), '# retained\nOTHER=value\n');
  assert.equal(fs.existsSync(path.join(dir, 'mcp-key')), false);
  const recovery = JSON.parse(secure.decryptString(fs.readFileSync(path.join(dir, 'integrations-migration.enc'))));
  assert.equal(recovery.snapshots[0].env, original);
  store.save({ llm: { name: 'new', key: '' }, summary: { url: 'https://summary.invalid', name: 'summary', key: 'fake-summary-key' } });
  assert.equal(store.get().llm.key, 'fake-old-key');
  assert.equal(JSON.stringify(store.public()).includes('fake-'), false);
  assert.equal(store.public().llm.keySet, true);
  assert.equal(openStore(dir, secure, { CHAT_MODEL_NAME: 'ignored', CHAT_MODEL_KEY: 'ignored' }).get().llm.name, 'new');
  store.save({ llm: { reset: true } });
  assert.deepEqual(modelConfig(store.get()), { url: 'https://summary.invalid', name: 'summary', key: 'fake-summary-key', ok: true });
  fs.writeFileSync(path.join(dir, '.env'), 'CHAT_MODEL_KEY=fake-later-key\n');
  openStore(dir, secure, {});
  const later = JSON.parse(secure.decryptString(fs.readFileSync(path.join(dir, 'integrations-migration.enc'))));
  assert.equal(later.snapshots.length, 2);
  assert.match(later.snapshots[1].env, /fake-later-key/);
  for (const name of fs.readdirSync(dir)) {
    const content = fs.readFileSync(path.join(dir, name));
    for (const secret of ['fake-old-key', 'fake-hook-key', 'fake-summary-key', 'fake-mcp-key', 'fake-later-key']) assert.equal(content.includes(secret), false, name);
    assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
  }
});

test('encryption fails closed, corruption and recovery failure never destroy source', context => {
  const dir = directory(context), secure = encryption();
  const file = path.join(dir, '.env'); fs.writeFileSync(file, 'CHAT_MODEL_KEY=fake-keep\n');
  for (const service of [{ ...secure, isEncryptionAvailable: () => false }, { ...secure, getSelectedStorageBackend: () => 'basic_text' }]) {
    assert.throws(() => openStore(dir, service, {}), /unavailable/);
    assert.match(fs.readFileSync(file, 'utf8'), /fake-keep/);
    assert.equal(fs.existsSync(path.join(dir, 'integrations.enc')), false);
  }
  fs.writeFileSync(path.join(dir, 'integrations-migration.enc'), 'corrupt');
  assert.throws(() => openStore(dir, secure, {}));
  assert.match(fs.readFileSync(file, 'utf8'), /fake-keep/);
  fs.writeFileSync(path.join(dir, 'integrations.enc'), 'corrupt');
  assert.throws(() => openStore(dir, secure, {}));
  assert.equal(fs.readFileSync(path.join(dir, 'integrations.enc'), 'utf8'), 'corrupt');
});

test('migration refuses multiline secrets even after encrypted Settings exist', context => {
  const dir = directory(context), secure = encryption();
  const store = openStore(dir, secure, {});
  store.save({ llm: { key: 'fake-existing' } });
  const original = 'CHAT_MODEL_KEY="fake-first-line\nfake-second-line"\n';
  fs.writeFileSync(path.join(dir, '.env'), original);
  assert.throws(() => openStore(dir, secure, {}), /Multiline/);
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), original);
  assert.equal(JSON.parse(secure.decryptString(fs.readFileSync(path.join(dir, 'integrations.enc')))).config.llm.key, 'fake-existing');
});

test('trusted settings reject unknown fields, injection, invalid URLs, bounds and incomplete enables', () => {
  for (const patch of [null, [], { unknown: {} }, { mcp: { port: 0 } }, { mcp: { port: 65536 } }, { mcp: { enabled: 1 } }, { jev: { threshold: NaN } }, { jev: { threshold: 1.1 } }, { llm: { key: 'x'.repeat(4097) } }, { llm: { key: '   ' } }, { llm: { name: 'x\nHOST=bad' } }, ...['file:///tmp/a', 'https://user:key@host', 'https://host/?key=x', 'https://host/#key'].map(url => ({ webhook: { url } }))]) assert.throws(() => validate(patch));
  assert.throws(() => patchConfig(defaults(), { jev: { enabled: true } }), /Incomplete/);
  const config = patchConfig(defaults(), { mcp: { reset: true }, webhook: { url: 'http://127.0.0.1:1234', key: 'fake-key', enabled: true } });
  assert.equal(config.mcp.key.length, 64);
  assert.equal(config.webhook.enabled, true);
});

test('local HTTP JEV uses noul rounding/promo precedence; outgoing bypass; webhook exact auth and synthetic test', async context => {
  const mock = await mockServer(context);
  const config = { jevBaseUrl: mock.url, jevApiKey: 'fake-jev', jevModel: 'fixture', jevThreshold: 0.6 };
  const message = { chat: 'Fixture', sender: 'Fixture', text: 'fixture only', fromMe: false };
  assert.deepEqual(await evaluateMessage(message, config, fetch), { promo: 0.6, perluBalas: 0.9, category: 'promo' });
  assert.equal(mock.requests[0].headers.authorization, 'Bearer fake-jev');
  assert.equal(mock.requests[0].body.questions.needs_reply.type, 'noul');
  await evaluateMessage({ ...message, fromMe: true }, config, fetch);
  assert.equal(mock.requests.length, 1);
  assert.equal(await sendWebhookEvent({ type: 'pengingat', items: [] }, { webhookUrl: mock.url, webhookKey: 'Exact fake-key' }, { fetchImpl: fetch, logger: quiet }), true);
  assert.equal(mock.requests[1].headers.authorization, 'Exact fake-key');
  const saved = defaults(); saved.webhook = { enabled: false, url: mock.url, key: 'Exact fake-key' };
  assert.equal((await testWebhook(saved)).ok, true);
  assert.equal(mock.requests[2].body.test, true);
  assert.deepEqual(mock.requests[2].body.grup, []);
  assert.equal(JSON.stringify(mock.requests[2].body).includes(message.text), false);
  let options;
  assert.deepEqual(await testWebhook(saved, async (_, request) => { options = request; throw new Error('fake-key must not leak'); }), { ok: false });
  assert.equal(options.redirect, 'error');
});

test('managed backend uses GUI configuration, lazy Agent, JEV/summary wiring, reader gate and authenticated MCP', async context => {
  const dir = directory(context), mock = await mockServer(context);
  const config = patchConfig(defaults(), { mcp: { key: 'fake-mcp' }, jev: { enabled: true, url: mock.url, name: 'fixture-jev', key: 'fake-jev', threshold: 0.6 }, summary: { url: mock.url, name: 'fixture-summary', key: 'fake-summary' }, llm: { url: mock.url, name: 'fixture-agent', key: 'fake-agent' } });
  const backend = await startBackend({ dir, integrations: config, env: { ...ports, CHAT_MODEL_URL: 'https://must-not-contact.invalid' }, mcpPort: 0, logger: quiet });
  context.after(() => backend.close());
  assert.equal(mock.requests.length, 0, 'no startup Agent probe');
  assert.equal(fs.existsSync(path.join(dir, 'mcp-key')), false);
  const body = { account: '123456@c.us', messages: [{ id: 'fixture', chat: 'Fixture', sender: 'Tester', text: 'fixture-only-question', timestamp: new Date(Date.now() + 10).toISOString(), isGroup: true, fromMe: false }, { id: 'outgoing', chat: 'Fixture', sender: 'Me', text: 'fixture-only-context', timestamp: new Date(Date.now() + 10).toISOString(), isGroup: true, fromMe: true }] };
  assert.equal((await post(backend.ingestUrl + '/ingest', body)).status, 202);
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  assert.equal((await post(backend.mcpUrl + '/mcp', rpc)).status, 403);
  const tools = await (await post(backend.mcpUrl + '/mcp', rpc, { authorization: 'Bearer fake-mcp' })).json();
  assert.equal(tools.result.tools.length, 6);
  await new Promise(resolve => setTimeout(resolve, 30));
  const response = await post(backend.ingestUrl + '/debug/summary-preview', {});
  assert.equal(response.status, 200);
  assert.ok(mock.requests.some(request => request.url === '/systemone' && request.body.model === 'fixture-jev'));
  assert.ok(mock.requests.some(request => request.url === '/chat/completions' && request.body.model === 'fixture-summary' && request.headers.authorization === 'Bearer fake-summary'));
  const db = new DatabaseSync(path.join(dir, 'data', 'wa.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT category FROM messages WHERE id=?').get('fixture').category, 'promo'); db.close();
  await (await post(backend.chatUrl + '/api/chat', { messages: [{ role: 'user', content: 'fixture-only-question' }] })).text();
  assert.ok(mock.requests.some(request => request.body.model === 'fixture-agent' && request.headers.authorization === 'Bearer fake-agent'));
  const before = mock.requests.length;
  backend.setReaderEnabled(false);
  assert.equal((await post(backend.ingestUrl + '/debug/summary-preview', {})).status, 403);
  assert.equal(mock.requests.length, before);
  assert.equal((await (await fetch(backend.ingestUrl + '/health')).json()).messages, 2);
});

test('MCP disabled or occupied port keeps archive operational; OFF integrations never fetch', async context => {
  const occupied = await mockServer(context);
  for (const enabled of [false, true]) {
    const dir = directory(context);
    const config = patchConfig(defaults(), { mcp: { enabled, key: 'fake-mcp', port: Number(new URL(occupied.url).port) }, jev: { url: occupied.url, name: 'fixture', key: 'fake-key' }, webhook: { url: occupied.url, key: 'fake-key' } });
    let calls = 0;
    const backend = await startBackend({ dir, integrations: config, env: ports, logger: quiet, fetchImpl: async () => { calls++; throw new Error('unexpected'); } });
    try {
      assert.equal(backend.mcpUrl, null);
      assert.equal((await fetch(backend.ingestUrl + '/health')).status, 200);
      assert.equal((await (await fetch(backend.chatUrl + '/api/health')).json()).configured, false);
      assert.equal(calls, 0);
    } finally { await backend.close(); }
  }
});

test('Summary works with JEV OFF without caching null classifications', async context => {
  const dir = directory(context), mock = await mockServer(context);
  const config = patchConfig(defaults(), { mcp: { enabled: false }, summary: { url: mock.url, name: 'summary-only', key: 'fake-summary' } });
  const backend = await startBackend({ dir, integrations: config, env: ports, logger: quiet });
  context.after(() => backend.close());
  await post(backend.ingestUrl + '/ingest', { account: '123456@c.us', messages: [{ id: 'unscored', chat: 'Group fixture', sender: 'Fixture', text: 'Only synthetic context', timestamp: new Date(Date.now() + 10).toISOString(), isGroup: true, fromMe: false }] });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await post(backend.ingestUrl + '/debug/summary-preview', {})).status, 200);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].body.model, 'summary-only');
  const db = new DatabaseSync(path.join(dir, 'data', 'wa.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT category FROM messages WHERE id=?').get('unscored').category, null); }
  finally { db.close(); }
});

test('reader OFF aborts an in-flight integration without losing the archive', async context => {
  const dir = directory(context);
  const config = patchConfig(defaults(), { mcp: { enabled: false }, jev: { enabled: true, url: 'http://127.0.0.1:1', name: 'fixture', key: 'fake-key' } });
  let started;
  const requested = new Promise(resolve => { started = resolve; });
  let aborted = false;
  const backend = await startBackend({ dir, integrations: config, env: ports, logger: quiet,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('fixture abort')); }, { once: true });
      started();
    }),
  });
  context.after(() => backend.close());
  await post(backend.ingestUrl + '/ingest', { account: '123456@c.us', messages: [{ id: 'abort-fixture', chat: 'Fixture group', sender: 'Fixture', text: 'Synthetic question', timestamp: new Date().toISOString(), isGroup: true, fromMe: false }] });
  const preview = post(backend.ingestUrl + '/debug/summary-preview', {});
  await requested;
  backend.setReaderEnabled(false);
  await preview;
  assert.equal(aborted, true);
  assert.equal((await (await fetch(backend.ingestUrl + '/health')).json()).messages, 1);
  assert.equal((await post(backend.ingestUrl + '/debug/summary-preview', {})).status, 403);
});

test('managed webhook retries persisted events with exact auth across backend restarts', async context => {
  const dir = directory(context), mock = await mockServer(context, count => count === 1 ? 503 : 204);
  const account = '123456@c.us', timestamp = new Date().toISOString();
  const archive = new MessageArchive({ dataDir: path.join(dir, 'data'), logger: quiet });
  await archive.ready;
  await archive.appendMany([{ id: 'pending-fixture', chat: 'Fixture group', sender: 'Fixture', text: 'Synthetic only', timestamp, isGroup: true, fromMe: false }], { account });
  await archive.initializeBaseline();
  const event = { type: 'ringkasan', account, periode: { dari: timestamp, sampai: timestamp }, teks: 'Synthetic persisted event', grup: [] };
  await archive.saveEventState({ ...archive.scoped(account).eventState, summaryCursor: timestamp,
    pendingSummary: { event, slot: timestamp, cursor: timestamp, ids: [`${account}\u0000pending-fixture`] },
  }, account);
  await archive.close();
  const config = patchConfig(defaults(), { mcp: { enabled: false }, webhook: { enabled: true, url: mock.url + '/webhook', key: 'fake-raw-hook-key' } });
  for (let attempt = 1; attempt <= 2; attempt++) {
    const backend = await startBackend({ dir, integrations: config, env: ports, logger: quiet });
    try {
      for (let wait = 0; wait < 100 && mock.requests.length < attempt; wait++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(mock.requests.length, attempt);
    } finally { await backend.close(); }
    const db = new DatabaseSync(path.join(dir, 'data', 'wa.sqlite'), { readOnly: true });
    try {
      const state = JSON.parse(db.prepare('SELECT value FROM meta WHERE key=?').get(`eventState:${account}`).value);
      assert.equal(Boolean(state.pendingSummary), attempt === 1);
      assert.equal(state.summaryMessageIds.includes(`${account}\u0000pending-fixture`), attempt === 2);
    } finally { db.close(); }
  }
  assert.ok(mock.requests.every(request => request.headers.authorization === 'fake-raw-hook-key'));
  assert.ok(mock.requests.every(request => request.body.teks === event.teks));
});
