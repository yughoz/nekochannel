'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const {
  MessageArchive, createHttpServer, evaluateMessage, makeConfig, normalizeMessage, originAllowed, requestAllowed,
  runReminderCycle, runSummaryCycle, runMentionCycle, mentionCandidates, mentionEvent,
  buildSummaryEvent, cappedSummaryFrom, messageBareId, truncateSummaryText, clipIncompleteSummary,
  stripInvisibleText, visibleText, isReplyWorthy, isNewsletterChat, snippetText,
} = require('./index.js');

const ACCOUNT = '6281@c.us';
const ACCOUNT_2 = '6282@c.us';
const quietLogger = { info() {}, warn() {}, error() {} };
const sample = (id, extra = {}) => ({
  id, account: ACCOUNT, chat: 'Chat', isGroup: false, sender: 'Alice', text: `message ${id}`,
  timestamp: '2026-11-02T00:30:00Z', fromMe: false, ...extra,
});
const config = (extra = {}) => ({
  ...makeConfig({ WEBHOOK_URL: 'https://webhook.invalid/ingest', WEBHOOK_KEY: 'webhook-secret' }), ...extra,
});
const jevConfig = (extra = {}) => config({
  jevBaseUrl: 'https://jev.invalid/api/', jevApiKey: 'jev-secret', jevModel: 'test-model', ...extra,
});
const jevResponse = (promo, perluBalas) => ({
  status: 200,
  json: async () => ({ answers: { is_promo: { noul: promo }, needs_reply: { noul: perluBalas } } }),
});
const scores = ({ promo, perluBalas, category }) => ({ promo, perluBalas, category });
const replyScore = { promo: 0.1, perluBalas: 0.9, category: 'perlu_balas' };
const infoScore = { promo: 0.1, perluBalas: 0.1, category: 'info' };
const group = (id, extra = {}) => sample(id, { isGroup: true, chat: 'Tim', ...extra });
const BASELINE = '2026-11-02T00:00:00.000Z';
const MORNING = '2026-11-02T02:00:00.000Z';
const NOON = '2026-11-02T05:00:00.000Z'; // 12:00 Asia/Jakarta

async function tempArchive(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'war4-'));
  const archive = new MessageArchive({ dataDir, logger: quietLogger });
  await archive.ready;
  t.after(async () => { await archive.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { archive, dataDir };
}
async function eventArchive(t) {
  const result = await tempArchive(t);
  await result.archive.initializeBaseline(BASELINE);
  return result;
}
async function addScored(archive, messages, evaluate = () => replyScore) {
  const added = await archive.appendMany(messages);
  await archive.scoreMany(added, evaluate);
  return added;
}
function webhookMock(status = 204) {
  const requests = [];
  return { requests, fetchImpl: async (url, options) => { requests.push({ url, options, body: JSON.parse(options.body) }); return { status }; } };
}
function accountEventState(archive, account = ACCOUNT) {
  const row = archive.db.prepare('SELECT value FROM meta WHERE key=?').get(`eventState:${account}`);
  return row ? JSON.parse(row.value) : null;
}

// Existing archive and WAR-2 scoring guarantees remain part of WAR-3.
test('normalizeMessage validates input and ignores untrusted scores', () => {
  assert.deepEqual(normalizeMessage(sample('a')), {
    id: 'a', account: ACCOUNT, chat: 'Chat', isGroup: false, sender: 'Alice', text: 'message a',
    timestamp: '2026-11-02T00:30:00.000Z', fromMe: false,
    mentionsMe: false, replyToMe: false,
  });
  assert.throws(() => normalizeMessage({}), /id is required/);
  assert.equal('promo' in normalizeMessage(sample('untrusted', { promo: 1, perluBalas: 1, category: 'promo' })), false);
});

test('archive deduplicates ids, rejects invalid batches atomically, and survives restart', async (t) => {
  const { archive, dataDir } = await tempArchive(t);
  await assert.rejects(() => archive.appendMany([sample('valid'), { id: 'invalid' }]), /invalid message at index 1/);
  assert.equal(archive.messages.length, 0);
  assert.deepEqual((await Promise.all([
    archive.appendMany([sample('a'), sample('a')]), archive.appendMany([sample('a'), sample('b')]),
  ])).map((items) => items.length), [1, 1]);
  await archive.close();
  const restored = new MessageArchive({ dataDir, logger: quietLogger });
  await restored.ready;
  assert.deepEqual(restored.messages.map((message) => message.id), ['a', 'b']);
  await restored.close();
});

test('archive rolls back failed transactions and remains usable', async (t) => {
  const { archive } = await tempArchive(t);
  archive.db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON messages WHEN new.id='disk-failure' BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
  await assert.rejects(() => archive.appendMany([sample('rolled-back'), sample('disk-failure')]), /disk failure/);
  assert.equal(archive.messages.length, 0);
  archive.db.exec('DROP TRIGGER fail_insert');
  assert.equal((await archive.appendMany([sample('disk-failure')])).length, 1);
});

test('JEV request shape, rounding, category precedence, and archived scores are preserved', async (t) => {
  const { archive } = await tempArchive(t);
  await archive.appendMany([group('rounded'), sample('priority'), sample('reply'), sample('info')]);
  const values = [[0.614, 0.876], [0.595, 0.575], [0.2, 0.6], [0.2, 0.3]];
  const requests = [];
  await archive.scoreMany(archive.messages, (message) => evaluateMessage(message, jevConfig(), async (url, options) => {
    requests.push({ url, options });
    return jevResponse(...values[requests.length - 1]);
  }));
  assert.equal(requests.length, 4);
  assert.equal(requests[0].url, 'https://jev.invalid/api/systemone');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer jev-secret');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    model: 'test-model', state: 'Chat: Tim\nGrup: ya\nPengirim: Alice\nPesan: message rounded',
    questions: {
      is_promo: { type: 'noul', instructions: 'Apakah pesan ini promo, iklan, broadcast, atau pesan massal yang tidak perlu ditanggapi pribadi?' },
      needs_reply: { type: 'noul', instructions: 'Apakah pesan ini perlu dibalas oleh penerima (pertanyaan, permintaan, ajakan, atau hal yang menunggu jawaban)?' },
    },
  });
  assert.match(JSON.parse(requests[1].options.body).state, /Grup: tidak/);
  assert.deepEqual(archive.messages.map(scores), [
    { promo: 0.61, perluBalas: 0.88, category: 'promo' },
    { promo: 0.6, perluBalas: 0.58, category: 'promo' },
    { promo: 0.2, perluBalas: 0.6, category: 'perlu_balas' },
    { promo: 0.2, perluBalas: 0.3, category: 'info' },
  ]);
  assert.deepEqual(archive.db.prepare('SELECT promo, perluBalas, category FROM messages ORDER BY rowid').all().map(scores), archive.messages.map(scores));
});

test('outgoing messages and incomplete JEV configuration bypass scoring', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return jevResponse(0.9, 0.9); };
  const empty = { promo: null, perluBalas: null, category: null };
  assert.deepEqual(await evaluateMessage(sample('own', { fromMe: true }), jevConfig(), fetchImpl), empty);
  for (const setting of ['jevBaseUrl', 'jevApiKey', 'jevModel']) {
    assert.deepEqual(await evaluateMessage(sample(setting), jevConfig({ [setting]: '' }), fetchImpl), empty);
  }
  assert.equal(calls, 0);
});

test('JEV failures and malformed answers yield null scores', async (t) => {
  const failures = {
    rejection: async () => { throw new Error('jev-secret'); },
    http: async () => ({ status: 500 }),
    json: async () => ({ status: 200, json: async () => { throw new Error('jev-secret'); } }),
    missing: async () => ({ status: 200, json: async () => ({ answers: {} }) }),
    string: async () => jevResponse('0.7', 0.8),
    range: async () => jevResponse(1.1, 0.8),
    timeout: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('jev-secret')), { once: true });
    }),
  };
  for (const [name, fail] of Object.entries(failures)) await t.test(name, async () => {
    assert.deepEqual(await evaluateMessage(sample(name), jevConfig({ jevTimeoutMs: 10 }), fail), {
      promo: null, perluBalas: null, category: null,
    });
  });
});

test('JEV results including null are cached by id and survive restart', async (t) => {
  const { archive, dataDir } = await tempArchive(t);
  await archive.appendMany([sample('cached'), sample('cached-failure')]);
  let calls = 0;
  const evaluate = async (message) => {
    calls++;
    return evaluateMessage(message, jevConfig(), async () => {
      if (message.id === 'cached-failure') throw new Error('unavailable');
      return jevResponse(0.3, 0.8);
    });
  };
  await archive.scoreMany(archive.messages, evaluate);
  await archive.scoreMany(archive.messages, evaluate);
  await archive.close();
  const restored = new MessageArchive({ dataDir, logger: quietLogger });
  await restored.ready;
  await restored.scoreMany(restored.messages, evaluate);
  assert.equal(calls, 2);
  assert.deepEqual(restored.messages.map(scores), [
    { promo: 0.3, perluBalas: 0.8, category: 'perlu_balas' }, { promo: null, perluBalas: null, category: null },
  ]);
  await restored.close();
});

test('JEV request concurrency remains bounded at four', async (t) => {
  const { archive } = await tempArchive(t);
  await archive.appendMany(Array.from({ length: 12 }, (_, i) => sample(`parallel-${i}`)));
  let active = 0; let maximum = 0;
  await archive.scoreMany(archive.messages, async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return replyScore;
  });
  assert.ok(maximum >= 1 && maximum <= 4, `maximum active requests: ${maximum}`);
});

test('config keeps localhost, WAR-2 threshold and WAR-3 scheduling defaults', () => {
  const actual = makeConfig({ SERVER_HOST: '0.0.0.0', SERVER_PORT: '80', WEBHOOK_INTERVAL_MIN: '1' });
  assert.equal(actual.host, '127.0.0.1');
  assert.equal(actual.port, 4317);
  assert.equal(actual.jevTimeoutMs, 8000);
  assert.equal(actual.jevThreshold, 0.6);
  assert.equal(actual.reminderAfterMin, 60);
  assert.equal(actual.reminderCheckMs, 5 * 60 * 1000);
  for (const value of ['', 'NaN', '-0.1', '1.1']) assert.equal(makeConfig({ JEV_THRESHOLD: value }).jevThreshold, 0.6);
  for (const value of ['0', '1', '0.8']) assert.equal(makeConfig({ JEV_THRESHOLD: value }).jevThreshold, Number(value));
});

test('reminders combine eligible chats, trim text, retain auth, and never send raw arrays', async (t) => {
  const { archive } = await eventArchive(t);
  await addScored(archive, [sample('a', { chat: 'Alice', text: 'x'.repeat(350) }), sample('b', { chat: 'Bob' })]);
  const mock = webhookMock();
  const options = { ...mock, logger: quietLogger, now: MORNING };
  await runReminderCycle(archive, config({ webhookAuthHeader: 'X-Wiwi-Key' }), options);
  await runReminderCycle(archive, config(), options);
  assert.equal(mock.requests.length, 1);
  const { body, options: request } = mock.requests[0];
  assert.equal(request.headers['X-Wiwi-Key'], 'webhook-secret');
  assert.deepEqual(Object.keys(body).sort(), ['account', 'generatedAt', 'items', 'label', 'text', 'type']);
  assert.equal(body.type, 'pengingat');
  assert.equal(body.generatedAt, MORNING);
  assert.deepEqual(body.items.map((item) => item.chat), ['Alice', 'Bob']);
  assert.equal(body.items[0].text.length, 300);
  assert.equal(body.items[0].menunggu_menit, 90);
  assert.equal(body.text, `Belum dibalas:\n- Alice (90 menit): ${JSON.stringify('x'.repeat(300))}\n- Bob (90 menit): \"message b\"`);
  assert.equal('id' in body.items[0], false);
});

test('reminder requires strictly more than configured wait and latest incoming needs reply', async (t) => {
  const { archive } = await eventArchive(t);
  await addScored(archive, [
    sample('exact', { chat: 'Exact', timestamp: '2026-11-02T01:00:00Z' }),
    sample('old', { chat: 'Info' }), sample('new-info', { chat: 'Info', timestamp: '2026-11-02T01:00:00Z' }),
    group('group'), sample('threshold', { chat: 'Threshold' }),
  ], (message) => message.id === 'new-info' ? infoScore : message.id === 'threshold' ? { promo: 0.8, perluBalas: 0.6, category: 'promo' } : replyScore);
  const mock = webhookMock();
  await runReminderCycle(archive, config(), { ...mock, logger: quietLogger, now: MORNING });
  assert.equal(mock.requests.length, 1);
  assert.deepEqual(mock.requests[0].body.items.map((item) => item.chat), ['Threshold']);
});

test('a later fromMe suppresses reminder even when ingested out of order', async (t) => {
  const { archive } = await eventArchive(t);
  await addScored(archive, [
    sample('reply', { fromMe: true, timestamp: '2026-11-02T01:00:00Z' }), sample('incoming'),
  ]);
  const mock = webhookMock();
  await runReminderCycle(archive, config(), { ...mock, logger: quietLogger, now: MORNING });
  assert.equal(mock.requests.length, 0);
});

test('quiet hours defer and combine reminders once at 06:00 Jakarta', async (t) => {
  const { archive } = await eventArchive(t);
  await addScored(archive, [sample('a', { chat: 'A', timestamp: '2026-11-02T13:00:00Z' })]);
  const mock = webhookMock();
  await runReminderCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-02T15:00:00Z' }); // 22:00
  await addScored(archive, [sample('b', { chat: 'B', timestamp: '2026-11-02T17:00:00Z' })]);
  await runReminderCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-02T22:59:00Z' });
  assert.equal(mock.requests.length, 0);
  await runReminderCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-02T23:00:00Z' }); // 06:00
  await runReminderCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-02T23:05:00Z' });
  assert.equal(mock.requests.length, 1);
  assert.deepEqual(mock.requests[0].body.items.map((item) => item.chat), ['A', 'B']);
});

test('quiet-hour messages already answered before 06:00 do not remind', async (t) => {
  const { archive } = await eventArchive(t);
  await addScored(archive, [sample('question', { timestamp: '2026-11-02T13:00:00Z' })]);
  const mock = webhookMock();
  await runReminderCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-02T15:00:00Z' });
  await addScored(archive, [sample('answered', { fromMe: true, timestamp: '2026-11-02T22:00:00Z' })]);
  await runReminderCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-02T23:00:00Z' });
  assert.equal(mock.requests.length, 0);
});

test('baseline excludes existing archive and old backfill, persists across restart', async (t) => {
  const { archive, dataDir } = await tempArchive(t);
  await addScored(archive, [sample('archived'), group('old-group')]);
  await archive.initializeBaseline('2026-11-02T01:00:00Z');
  await addScored(archive, [sample('backfill'), group('backfill-group')]);
  const mock = webhookMock();
  await runReminderCycle(archive, config(), { ...mock, logger: quietLogger, now: MORNING });
  await runSummaryCycle(archive, config(), { ...mock, logger: quietLogger, now: NOON });
  assert.equal(mock.requests.length, 0);
  await archive.close();
  const restored = new MessageArchive({ dataDir, logger: quietLogger });
  await restored.ready;
  await restored.initializeBaseline('2026-11-02T03:00:00Z');
  await addScored(restored, [sample('fresh', { timestamp: '2026-11-02T01:30:00Z' })]);
  await runReminderCycle(restored, config(), { ...mock, logger: quietLogger, now: '2026-11-02T03:00:00Z' });
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].body.items[0].text, 'message fresh');
  await restored.close();
});

test('reminder retry preserves event and successful delivery persists dedupe through restart', async (t) => {
  const { archive, dataDir } = await eventArchive(t);
  await addScored(archive, [sample('retry')]);
  const failed = webhookMock(503);
  await runReminderCycle(archive, config(), { ...failed, logger: quietLogger, now: MORNING });
  await archive.close();
  const restored = new MessageArchive({ dataDir, logger: quietLogger });
  await restored.ready;
  const mock = webhookMock();
  await runReminderCycle(restored, config(), { ...mock, logger: quietLogger, now: '2026-11-02T02:05:00Z' });
  await runReminderCycle(restored, config(), { ...mock, logger: quietLogger, now: '2026-11-02T02:10:00Z' });
  assert.equal(failed.requests.length, 1);
  assert.equal(mock.requests.length, 1);
  assert.deepEqual(mock.requests[0].body, failed.requests[0].body);
  await addScored(restored, [sample('new-trigger', { timestamp: '2026-11-02T02:15:00Z' })]);
  await runReminderCycle(restored, config(), { ...mock, logger: quietLogger, now: '2026-11-02T03:30:00Z' });
  assert.equal(mock.requests.length, 2);
  await restored.close();
});

test('a failed reminder merges newly due chats and sends once when quiet hours end', async (t) => {
  const { archive } = await eventArchive(t);
  await addScored(archive, [sample('pending-a', { chat: 'A', timestamp: '2026-11-02T13:00:00Z' })]);
  const failed = webhookMock(503);
  await runReminderCycle(archive, config(), { ...failed, logger: quietLogger, now: '2026-11-02T14:55:00Z' }); // 21:55
  assert.equal(failed.requests.length, 1);
  await addScored(archive, [sample('newly-due-b', { chat: 'B', timestamp: '2026-11-02T15:30:00Z' })]);
  const mock = webhookMock();
  await runReminderCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-02T16:35:00Z' });
  assert.equal(mock.requests.length, 0);
  await runReminderCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-02T23:00:00Z' }); // 06:00
  await runReminderCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-02T23:05:00Z' });
  assert.equal(mock.requests.length, 1);
  assert.deepEqual(mock.requests[0].body.items.map((item) => item.chat), ['A', 'B']);
});

test('failed event-state storage sends no webhook and leaves delivery state unchanged', async (t) => {
  for (const [name, cycle, message, now] of [
    ['reminder', runReminderCycle, sample('storage-reminder'), MORNING],
    ['summary', runSummaryCycle, group('storage-summary'), NOON],
  ]) await t.test(name, async (t) => {
    const { archive, dataDir } = await eventArchive(t);
    await addScored(archive, [message]);
    const before = structuredClone(archive.eventState);
    const stateReference = archive.eventState;
    archive.db.exec('PRAGMA query_only=ON');
    const mock = webhookMock();
    await assert.rejects(() => cycle(archive, config(), { ...mock, logger: quietLogger, now }), /readonly/);
    assert.equal(mock.requests.length, 0);
    assert.equal(archive.eventState, stateReference);
    assert.deepEqual(archive.eventState, before);
    archive.db.exec('PRAGMA query_only=OFF');
    await cycle(archive, config(), { ...mock, logger: quietLogger, now });
    assert.equal(mock.requests.length, 1);
  });
});

test('reply before retry cancels a failed reminder rather than delivering stale text', async (t) => {
  const { archive } = await eventArchive(t);
  await addScored(archive, [sample('waiting')]);
  const failed = webhookMock(500);
  await runReminderCycle(archive, config(), { ...failed, logger: quietLogger, now: MORNING });
  await addScored(archive, [sample('reply-after-failure', { fromMe: true, timestamp: '2026-11-02T02:01:00Z' })]);
  const mock = webhookMock();
  await runReminderCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-02T02:05:00Z' });
  assert.equal(mock.requests.length, 0);
  assert.equal(archive.eventState.pendingReminder, null);
});

test('successful webhook delivery is acknowledged even when unused body cancellation fails', async (t) => {
  const { archive } = await eventArchive(t);
  await addScored(archive, [sample('cancel-body')]);
  let calls = 0;
  const options = { logger: quietLogger, now: MORNING, fetchImpl: async () => {
    calls++;
    return { status: 204, body: { cancel() { throw new Error('unusable body'); } } };
  } };
  await runReminderCycle(archive, config(), options);
  await runReminderCycle(archive, config(), options);
  assert.equal(calls, 1);
});

test('first webhook activation refreshes inactive baseline and excludes the disabled interval', async (t) => {
  const { archive } = await tempArchive(t);
  await archive.initializeBaseline(BASELINE, { active: false });
  await addScored(archive, [sample('already-archived')]);
  const mock = webhookMock();
  await runReminderCycle(archive, config({ webhookKey: '' }), { ...mock, logger: quietLogger, now: MORNING });
  assert.equal(archive.baseline.at, BASELINE);
  assert.equal(archive.baseline.active, false);
  await runReminderCycle(archive, config(), { ...mock, logger: quietLogger, now: MORNING });
  assert.equal(archive.baseline.at, MORNING);
  assert.equal(archive.baseline.active, true);
  assert.equal(mock.requests.length, 0);
  await addScored(archive, [sample('after-activation', { timestamp: '2026-11-02T02:01:00Z' })]);
  await runReminderCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-02T03:05:00Z' });
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].body.items[0].text, 'message after-activation');
});

test('summary filters promo/private messages and uses per-group bounded OpenAI input', async (t) => {
  const { archive } = await eventArchive(t);
  await addScored(archive, [
    group('promo', { text: 'PROMO_SECRET' }), sample('private', { text: 'PRIVATE_SECRET' }),
    ...Array.from({ length: 201 }, (_, i) => group(`g${i}`, { text: `group-${i} ${'x'.repeat(2500)}`, timestamp: `2026-11-02T01:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z` })),
    group('own', { chat: 'Lain', fromMe: true, text: 'Aku bisa besok jam 9' }),
  ], (message) => message.id === 'promo' ? { promo: 0.9, perluBalas: 0.1, category: 'promo' } : infoScore);
  const modelRequests = [];
  const webhookRequests = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url === 'https://summary.invalid/v1/chat/completions') {
      modelRequests.push({ url, options, body });
      return { status: 200, json: async () => ({ choices: [{ message: { content: '- Rapat besok jam 9.' } }] }) };
    }
    webhookRequests.push(body);
    return { status: 204 };
  };
  await runSummaryCycle(archive, config({ summaryModelUrl: 'https://summary.invalid/v1/', summaryModelKey: 'model-secret', summaryModelName: 'small-model' }), { fetchImpl, logger: quietLogger, now: NOON });
  assert.equal(modelRequests.length, 2);
  for (const { body, options } of modelRequests) {
    assert.equal(options.headers.Authorization, 'Bearer model-secret');
    assert.equal(body.model, 'small-model');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.ok(body.max_tokens >= 1500);
    assert.ok(JSON.stringify(body).length < 450000);
    assert.equal(JSON.stringify(body).includes('PROMO_SECRET'), false);
    assert.equal(JSON.stringify(body).includes('PRIVATE_SECRET'), false);
  }
  assert.equal(modelRequests.filter(({ body }) => JSON.stringify(body).includes('group-')).length, 1);
  const input = JSON.stringify(modelRequests.find(({ body }) => JSON.stringify(body).includes('group-')).body);
  assert.equal((input.match(/group-\d+ /g) || []).length, 200);
  assert.equal(webhookRequests.length, 1);
  assert.equal(webhookRequests[0].type, 'ringkasan');
  assert.deepEqual(webhookRequests[0].grup, [{ nama: 'Tim', jumlahPesan: 201 }, { nama: 'Lain', jumlahPesan: 1 }]);
  assert.deepEqual(webhookRequests[0].periode, { dari: BASELINE, sampai: NOON });
  assert.match(webhookRequests[0].teks, /Rapat besok/);
  assert.equal(webhookRequests[0].text, webhookRequests[0].teks);
});

test('failed model falls back to counts and last three non-promo messages without logging keys', async (t) => {
  const { archive } = await eventArchive(t);
  await addScored(archive, Array.from({ length: 5 }, (_, i) => group(`fallback-${i}`, { text: `catatan-${i}`, timestamp: `2026-11-02T01:0${i}:00Z` })), () => infoScore);
  const logs = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (...args) => logs.push(args.join(' '))]));
  const bodies = [];
  await runSummaryCycle(archive, config({ summaryModelUrl: 'https://summary.invalid/v1', summaryModelKey: 'model-secret', summaryModelName: 'small' }), {
    now: NOON, logger,
    fetchImpl: async (url, options) => {
      if (url.includes('summary.invalid')) throw new Error('model-secret webhook-secret');
      bodies.push(JSON.parse(options.body)); return { status: 204 };
    },
  });
  assert.equal(bodies.length, 1);
  assert.match(bodies[0].teks, /5 pesan/);
  for (const i of [2, 3, 4]) assert.match(bodies[0].teks, new RegExp(`catatan-${i}`));
  for (const i of [0, 1]) assert.equal(bodies[0].teks.includes(`catatan-${i}`), false);
  assert.equal(logs.join('\n').includes('model-secret'), false);
  assert.equal(logs.join('\n').includes('webhook-secret'), false);
});

test('summary retry after restart reuses exact event without another model call', async (t) => {
  const { archive, dataDir } = await eventArchive(t);
  await addScored(archive, [group('retry-summary')], () => infoScore);
  let modelCalls = 0;
  const bodies = [];
  let status = 500;
  const cfg = config({ summaryModelUrl: 'https://summary.invalid/v1', summaryModelKey: 'secret', summaryModelName: 'small' });
  const fetchImpl = async (url, options) => {
    if (url.includes('summary.invalid')) { modelCalls++; return { status: 200, json: async () => ({ choices: [{ message: { content: '- Hasil tetap.' } }] }) }; }
    bodies.push(JSON.parse(options.body)); return { status };
  };
  await runSummaryCycle(archive, cfg, { fetchImpl, logger: quietLogger, now: NOON });
  await archive.close();
  const restored = new MessageArchive({ dataDir, logger: quietLogger });
  await restored.ready;
  status = 204;
  await runSummaryCycle(restored, cfg, { fetchImpl, logger: quietLogger, now: '2026-11-02T05:05:00Z' });
  await runSummaryCycle(restored, cfg, { fetchImpl, logger: quietLogger, now: '2026-11-02T05:10:00Z' });
  assert.equal(modelCalls, 1);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0], bodies[1]);
  await restored.close();
});

test('summary sends only on schedule and does not send empty/promo-only periods', async (t) => {
  const { archive } = await eventArchive(t);
  const mock = webhookMock();
  await runSummaryCycle(archive, config(), { ...mock, logger: quietLogger, now: NOON });
  await addScored(archive, [group('promo')], () => ({ promo: 1, perluBalas: 0, category: 'promo' }));
  await runSummaryCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-02T13:00:00Z' });
  assert.equal(mock.requests.length, 0);
  await addScored(archive, [group('later', { timestamp: '2026-11-02T13:01:00Z' })], () => infoScore);
  await runSummaryCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-02T13:05:00Z' });
  assert.equal(mock.requests.length, 0);
  await runSummaryCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-03T05:00:00Z' });
  await runSummaryCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-03T05:05:00Z' });
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].body.grup[0].jumlahPesan, 1);
});

test('a delayed post-baseline group message is included in the next summary once', async (t) => {
  const { archive } = await eventArchive(t);
  const mock = webhookMock();
  await addScored(archive, [group('first')], () => infoScore);
  await runSummaryCycle(archive, config(), { ...mock, logger: quietLogger, now: NOON });
  await addScored(archive, [group('delayed', { timestamp: '2026-11-02T01:00:00Z', text: 'terlambat masuk arsip' })], () => infoScore);
  await runSummaryCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-02T13:00:00Z' });
  await runSummaryCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-03T05:00:00Z' });
  assert.equal(mock.requests.length, 2);
  assert.equal(mock.requests[1].body.grup[0].jumlahPesan, 1);
  assert.match(mock.requests[1].body.teks, /terlambat masuk arsip/);
});

test('summary model body timeout falls back and still delivers the prepared summary', async (t) => {
  const { archive } = await eventArchive(t);
  await addScored(archive, [group('body-timeout')], () => infoScore);
  const bodies = [];
  await runSummaryCycle(archive, config({
    summaryModelUrl: 'https://summary.invalid/v1', summaryModelKey: 'secret', summaryModelName: 'small', fetchTimeoutMs: 10,
  }), {
    now: NOON, logger: quietLogger,
    fetchImpl: async (url, options) => {
      if (url.includes('summary.invalid')) return { status: 200, json: () => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }) };
      bodies.push(JSON.parse(options.body)); return { status: 204 };
    },
  });
  assert.equal(bodies.length, 1);
  assert.match(bodies[0].teks, /1 pesan/);
  assert.match(bodies[0].teks, /message body-timeout/);
});

test('summary preview returns event without webhook or advancing summary state', async (t) => {
  const { archive } = await eventArchive(t);
  await addScored(archive, [group('preview')], () => infoScore);
  const before = JSON.stringify(archive.eventState);
  const mock = webhookMock();
  const event = await buildSummaryEvent(archive, config(), { ...mock, logger: quietLogger, now: NOON });
  assert.equal(event.type, 'ringkasan');
  assert.equal(mock.requests.length, 0);
  assert.equal(JSON.stringify(archive.eventState), before);
  await runSummaryCycle(archive, config(), { ...mock, logger: quietLogger, now: NOON });
  assert.equal(mock.requests.length, 1);
});

test('missing webhook configuration skips delivery and failures never log the key', async (t) => {
  const { archive } = await eventArchive(t);
  await addScored(archive, [sample('private')]);
  const logs = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (...args) => logs.push(args.join(' '))]));
  let requests = 0;
  const fetchImpl = async () => { requests++; throw new Error('webhook-secret'); };
  await runReminderCycle(archive, config({ webhookUrl: '', webhookKey: '' }), { fetchImpl, logger, now: MORNING });
  assert.equal(requests, 0);
  await runReminderCycle(archive, config(), { fetchImpl, logger, now: MORNING });
  assert.equal(requests, 1);
  assert.equal(logs.join('\n').includes('webhook-secret'), false);
});

test('origin policy allows extension or absent origin and rejects others', () => {
  assert.equal(originAllowed(undefined), true);
  assert.equal(originAllowed('chrome-extension://abcdefghijklmnop'), true);
  assert.equal(originAllowed('https://web.whatsapp.com'), false);
  assert.equal(originAllowed('chrome-extension://id/path'), false);
});

async function httpFixture(t, extra = {}) {
  const { archive, dataDir } = await eventArchive(t);
  const server = createHttpServer({ archive, config: config({ port: 0 }), logger: quietLogger, now: () => new Date(NOON), ...extra });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { archive, dataDir, server, base: `http://127.0.0.1:${server.address().port}` };
}

test('HTTP rejects disallowed origins, validates whole ingest, dedupes and reports health', async (t) => {
  const { archive, base } = await httpFixture(t);
  const origin = 'chrome-extension://abcdefghijklmnop';
  const blocked = await fetch(`${base}/ingest`, { method: 'POST', headers: { origin: 'https://web.whatsapp.com' }, body: JSON.stringify([sample('blocked')]) });
  assert.equal(blocked.status, 403);
  assert.equal(archive.messages.length, 0);
  const preflight = await fetch(`${base}/ingest`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  const invalid = await fetch(`${base}/ingest`, { method: 'POST', body: JSON.stringify({ account: ACCOUNT, messages: [sample('a'), { id: 'invalid' }] }) });
  assert.equal(invalid.status, 400);
  const accepted = await fetch(`${base}/ingest`, { method: 'POST', headers: { origin }, body: JSON.stringify({ account: ACCOUNT, label: 'Pribadi', messages: [sample('a'), sample('a')] }) });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { accepted: 1, duplicates: 1 });
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true, messages: 1, accounts: [{ account: ACCOUNT, label: 'Pribadi', messages: 1 }] });
});

test('HTTP ingest upserts group members idempotently and validates the payload', async (t) => {
  const { archive, base } = await httpFixture(t);
  const payload = { account: ACCOUNT, messages: [], groupMembers: [{ chatId: '120363425343543980@g.us', chat: 'Token Habis Bubar', participants: [{ jid: '6281@c.us', name: 'Budi', phone: '6281', isAdmin: true }, { jid: '2061@lid', isAdmin: false }] }] };
  const first = await fetch(`${base}/ingest`, { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { accepted: 0, duplicates: 0, members: 2 });
  const renamed = JSON.parse(JSON.stringify(payload));
  renamed.groupMembers[0].participants[0].name = 'Budi S';
  const second = await fetch(`${base}/ingest`, { method: 'POST', body: JSON.stringify(renamed) });
  assert.equal(second.status, 202);
  const rows = JSON.parse(JSON.stringify(archive.db.prepare('SELECT jid, name, phone, isAdmin FROM group_members ORDER BY jid').all()));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { jid: '2061@lid', name: '', phone: '', isAdmin: 0 });
  assert.deepEqual(rows[1], { jid: '6281@c.us', name: 'Budi S', phone: '6281', isAdmin: 1 });
  const bad = await fetch(`${base}/ingest`, { method: 'POST', body: JSON.stringify({ account: ACCOUNT, messages: [], groupMembers: [{ chatId: 'nope', chat: 'x', participants: [] }] }) });
  assert.equal(bad.status, 400);
});

test('HTTP summary-preview is local only and does not deliver or advance the period', async (t) => {
  const mock = webhookMock();
  const { archive, base } = await httpFixture(t, { fetchImpl: mock.fetchImpl });
  await addScored(archive, [group('preview-http')], () => infoScore);
  const before = JSON.stringify(archive.eventState);
  const response = await fetch(`${base}/debug/summary-preview`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).type, 'ringkasan');
  assert.equal(mock.requests.length, 0);
  assert.equal(JSON.stringify(archive.eventState), before);
  const blocked = await fetch(`${base}/debug/summary-preview`, { method: 'POST', headers: { origin: 'https://evil.invalid' } });
  assert.equal(blocked.status, 403);
});


test('legacy JSONL and state migrate once, keep latest scores, and archive old files', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'war4-migration-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const baseline = { at: BASELINE, messageIds: ['a'], active: true };
  const eventState = { remindedIds: ['a'], mentionedIds: [], summaryCursor: BASELINE, summaryMessageIds: ['group-old'], lastSummarySlot: null, pendingReminder: null, pendingSummary: null, pendingMention: null };
  const legacy = [sample('a'), sample('a', replyScore), sample('cached-null', { promo: null, perluBalas: null, category: null }), sample('unscored')];
  const jsonl = legacy.map((message) => JSON.stringify(message)).join('\n') + '\n{"incomplete"';
  await fs.writeFile(path.join(dataDir, 'messages.jsonl'), jsonl);
  await fs.writeFile(path.join(dataDir, 'baseline.json'), JSON.stringify(baseline));
  await fs.writeFile(path.join(dataDir, 'events.json'), JSON.stringify(eventState));
  const archive = new MessageArchive({ dataDir, logger: quietLogger });
  await archive.ready;
  assert.equal(archive.messages.length, 3);
  assert.deepEqual(scores(archive.messages[0]), replyScore);
  assert.deepEqual(scores(archive.messages[1]), { promo: null, perluBalas: null, category: null });
  assert.equal(Object.hasOwn(archive.messages[2], 'promo'), false);
  assert.deepEqual(archive.baseline, baseline);
  assert.deepEqual(archive.eventState, eventState);
  assert.ok(archive.messages.every((message) => Number.isFinite(Date.parse(message.createdAt))));
  for (const file of ['messages.jsonl', 'baseline.json', 'events.json']) {
    await assert.rejects(() => fs.access(path.join(dataDir, file)), { code: 'ENOENT' });
    await fs.access(path.join(dataDir, `${file}.migrated`));
  }
  assert.equal(await fs.readFile(path.join(dataDir, 'messages.jsonl.migrated'), 'utf8'), jsonl);
  await archive.appendMany([sample('after-migration')]);
  await archive.saveEventState({ ...archive.eventState, remindedIds: ['a', 'new-reminded'] });
  await archive.close();
  // Simulate a crash after SQLite COMMIT but before the source file was renamed.
  await fs.rename(path.join(dataDir, 'messages.jsonl.migrated'), path.join(dataDir, 'messages.jsonl'));
  const restored = new MessageArchive({ dataDir, logger: quietLogger });
  await restored.ready;
  assert.equal(restored.messages.length, 4);
  assert.equal(restored.messages.find((message) => message.id === 'a').category, 'perlu_balas');
  await fs.access(path.join(dataDir, 'messages.jsonl.migrated'));
  assert.deepEqual(restored.eventState.remindedIds, ['a', 'new-reminded']);
  assert.equal((await restored.appendMany([sample('a')])).length, 0);
  await restored.close();
});

test('invalid legacy delivery state aborts migration without losing original files', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'war4-bad-state-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, 'messages.jsonl'), JSON.stringify(sample('safe')));
  await fs.writeFile(path.join(dataDir, 'events.json'), '{invalid');
  const archive = new MessageArchive({ dataDir, logger: quietLogger });
  await assert.rejects(archive.ready, /Cannot load eventState/);
  await fs.access(path.join(dataDir, 'messages.jsonl'));
  await fs.writeFile(path.join(dataDir, 'events.json'), JSON.stringify({ remindedIds: [] }));
  const restored = new MessageArchive({ dataDir, logger: quietLogger });
  await restored.ready;
  assert.equal(restored.messages.length, 1);
  await restored.close();
});

test('FTS unicode61 indexes inserts, updates and deletes without a second message store', async (t) => {
  const { archive } = await tempArchive(t);
  await archive.appendMany([sample('meeting', { text: 'Meeting besok', chat: 'Tim Café', sender: 'Nadia' })]);
  const search = (query) => archive.db.prepare('SELECT rowid, text, chat, sender FROM messages_fts WHERE messages_fts MATCH ?').all(query);
  assert.equal(search('meeting')[0].text, 'Meeting besok');
  assert.equal(search('cafe')[0].chat, 'Tim Café');
  assert.equal(search('Nadia').length, 1);
  archive.db.prepare('UPDATE messages SET text=? WHERE id=?').run('Workshop baru', 'meeting');
  assert.equal(search('meeting').length, 0);
  assert.equal(search('workshop').length, 1);
  archive.db.prepare('DELETE FROM messages WHERE id=?').run('meeting');
  assert.equal(search('workshop').length, 0);
});

test('sqlite3 readonly reads live WAL and FTS while HTTP server holds a write transaction', async (t) => {
  const { archive, base } = await httpFixture(t);
  const response = await fetch(`${base}/ingest`, { method: 'POST', body: JSON.stringify({ account: ACCOUNT, messages: [sample('cli', { text: 'meeting' })] }) });
  assert.equal(response.status, 202);
  archive.db.exec('BEGIN IMMEDIATE');
  try {
    archive.db.prepare('INSERT INTO messages(id, text) VALUES (?, ?)').run('uncommitted', 'pending');
    const { stdout } = await execFileAsync('/usr/bin/sqlite3', ['-readonly', archive.dbPath, "SELECT count(*) FROM messages; SELECT text FROM messages_fts WHERE messages_fts MATCH 'meeting'; PRAGMA journal_mode;"]);
    assert.equal(stdout.trim(), '1\nmeeting\nwal');
    await assert.rejects(() => execFileAsync('/usr/bin/sqlite3', ['-readonly', archive.dbPath, 'DELETE FROM messages;']), /readonly/);
  } finally { archive.db.exec('ROLLBACK'); }
});


test('migrated pending events receive readable text and retry without regenerating content', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'war4-pending-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const reminder = { type: 'pengingat', generatedAt: MORNING, items: [{ chat: 'Chat', sender: 'Alice', text: 'Tolong jawab', timestamp: '2026-11-02T00:30:00.000Z', menunggu_menit: 90 }] };
  const summary = { type: 'ringkasan', periode: { dari: BASELINE, sampai: NOON }, teks: 'Isi ringkasan lama', grup: [{ nama: 'Tim', jumlahPesan: 1 }] };
  await fs.writeFile(path.join(dataDir, 'messages.jsonl'), [sample('waiting', replyScore), group('group', infoScore)].map((message) => JSON.stringify(message)).join('\n'));
  await fs.writeFile(path.join(dataDir, 'baseline.json'), JSON.stringify({ at: BASELINE, messageIds: [], active: true }));
  await fs.writeFile(path.join(dataDir, 'events.json'), JSON.stringify({ remindedIds: [], pendingReminder: { ids: ['waiting'], event: reminder }, pendingSummary: { ids: ['group'], event: summary, cursor: NOON, slot: NOON } }));
  const archive = new MessageArchive({ dataDir, logger: quietLogger });
  await archive.ready;
  await archive.appendMany([], { account: ACCOUNT });
  const mock = webhookMock();
  await runReminderCycle(archive, config(), { ...mock, logger: quietLogger, now: MORNING });
  await runSummaryCycle(archive, config(), { ...mock, logger: quietLogger, now: NOON });
  assert.equal(mock.requests.length, 2);
  assert.deepEqual(mock.requests[0].body, { ...reminder, account: ACCOUNT, label: '', text: 'Belum dibalas:\n- Chat (90 menit): "Tolong jawab"' });
  assert.deepEqual(mock.requests[1].body, { ...summary, account: ACCOUNT, label: '', text: summary.teks });
  await archive.close();
});

test('migration never overwrites an existing .migrated file', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'war4-collision-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const original = JSON.stringify(sample('original'));
  await fs.writeFile(path.join(dataDir, 'messages.jsonl'), original);
  await fs.writeFile(path.join(dataDir, 'messages.jsonl.migrated'), 'existing archive');
  const archive = new MessageArchive({ dataDir, logger: quietLogger });
  await assert.rejects(archive.ready, /migrated already exists/);
  assert.equal(await fs.readFile(path.join(dataDir, 'messages.jsonl'), 'utf8'), original);
  assert.equal(await fs.readFile(path.join(dataDir, 'messages.jsonl.migrated'), 'utf8'), 'existing archive');
});

test('restart after migration commit finishes rename without importing legacy data again', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'war4-migration-restart-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'messages.jsonl');
  await fs.writeFile(file, JSON.stringify(sample('committed', replyScore)));
  const archive = new MessageArchive({ dataDir, logger: quietLogger });
  await archive.ready;
  archive.db.prepare('UPDATE messages SET text=? WHERE id=?').run('Updated after import', 'committed');
  await archive.close();
  // Model the remaining old filename when a process stops between COMMIT and rename.
  await fs.rename(`${file}.migrated`, file);
  const restored = new MessageArchive({ dataDir, logger: quietLogger });
  await restored.ready;
  assert.equal(restored.messages.length, 1);
  assert.equal(restored.messages[0].text, 'Updated after import');
  await fs.access(`${file}.migrated`);
  await assert.rejects(() => fs.access(file), { code: 'ENOENT' });
  await restored.close();
});

test('WAR-5 migration backs up WAL rows, rebuilds the composite key/FTS, and assigns legacy data once', async (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'war5-migration-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const dbPath = path.join(dataDir, 'wa.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE messages(id TEXT PRIMARY KEY, chat TEXT, isGroup INTEGER, sender TEXT, text TEXT, timestamp TEXT,
      fromMe INTEGER, promo REAL, perluBalas REAL, category TEXT, createdAt TEXT);
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE VIRTUAL TABLE messages_fts USING fts5(text,chat,sender,content='messages',content_rowid='rowid');
  `);
  const insert = old.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  insert.run('legacy', 'Chat', 0, 'Alice', 'meeting lama', '2026-11-02T00:30:00.000Z', 0, 0.1, 0.9, 'perlu_balas', BASELINE);
  insert.run('null-score', 'Other', 0, 'Bob', 'cached failure', '2026-11-02T00:30:00.000Z', 0, null, null, null, BASELINE);
  old.prepare('INSERT INTO meta VALUES (?,?)').run('scored:null-score', 'true');
  old.prepare('INSERT INTO meta VALUES (?,?)').run('baseline', JSON.stringify({ at: BASELINE, messageIds: ['null-score'], active: true }));
  const pending = { type: 'pengingat', generatedAt: MORNING, items: [{ chat: 'Chat', sender: 'Alice', text: 'meeting lama', timestamp: '2026-11-02T00:30:00.000Z', menunggu_menit: 90 }] };
  old.prepare('INSERT INTO meta VALUES (?,?)').run('eventState', JSON.stringify({ remindedIds: ['already-reminded'], summaryMessageIds: ['already-summarized'], pendingReminder: { ids: ['legacy'], event: pending }, pendingSummary: null, summaryCursor: BASELINE, lastSummarySlot: null }));
  const archive = new MessageArchive({ dataDir, logger: quietLogger });
  await archive.ready;
  old.close();
  const backupBytes = await fs.readFile(`${dbPath}.bak-war5`);
  const backup = new DatabaseSync(`${dbPath}.bak-war5`, { readOnly: true });
  assert.equal(backup.prepare('SELECT count(*) AS n FROM messages').get().n, 2);
  assert.equal(backup.prepare('PRAGMA table_info(messages)').all().some((column) => column.name === 'account'), false);
  backup.close();
  assert.deepEqual(archive.messages.map((message) => message.account), ['', '']);
  assert.deepEqual(scores(archive.messages[1]), { promo: null, perluBalas: null, category: null });
  const mock = webhookMock();
  await runReminderCycle(archive, config(), { ...mock, logger: quietLogger, now: MORNING });
  assert.equal(mock.requests.length, 0, 'unassigned messages must not produce an accountless webhook');
  assert.equal((await archive.appendMany([sample('legacy')], { account: ACCOUNT, label: 'Pribadi' })).length, 0);
  assert.ok(archive.messages.every((message) => message.account === ACCOUNT));
  assert.equal(JSON.parse(archive.db.prepare("SELECT value FROM meta WHERE key='primaryAccount'").get().value), ACCOUNT);
  assert.deepEqual(archive.baseline.messageIds, [`${ACCOUNT}\u0000null-score`]);
  assert.deepEqual(archive.scoped(ACCOUNT).eventState.remindedIds, [`${ACCOUNT}\u0000already-reminded`]);
  assert.deepEqual(archive.scoped(ACCOUNT).eventState.summaryMessageIds, [`${ACCOUNT}\u0000already-summarized`]);
  assert.equal(archive.db.prepare("SELECT account FROM messages_fts WHERE messages_fts MATCH 'meeting'").get().account, ACCOUNT);
  await runReminderCycle(archive, config(), { ...mock, logger: quietLogger, now: MORNING });
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].body.account, ACCOUNT);
  assert.equal(mock.requests[0].body.label, 'Pribadi');
  assert.equal(mock.requests[0].body.generatedAt, pending.generatedAt);
  await archive.close();
  const restored = new MessageArchive({ dataDir, logger: quietLogger });
  await restored.ready;
  await runReminderCycle(restored, config(), { ...mock, logger: quietLogger, now: MORNING });
  assert.equal(mock.requests.length, 1, 'assigned legacy pending event must not resend after restart');
  await restored.appendMany([sample('legacy', { account: ACCOUNT_2 })], { account: ACCOUNT_2, label: 'Kantor' });
  assert.equal(restored.messages.filter((message) => message.id === 'legacy').length, 2);
  assert.equal(restored.messages.find((message) => message.id === 'null-score').account, ACCOUNT);
  assert.deepEqual(await fs.readFile(`${dbPath}.bak-war5`), backupBytes);
  await restored.close();
});

test('WAR-5 failed schema migration rolls back without replacing the backup or original rows', async (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'war5-rollback-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const dbPath = path.join(dataDir, 'wa.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY, chat TEXT, isGroup INTEGER, sender TEXT, text TEXT, timestamp TEXT,
    fromMe INTEGER, promo REAL, perluBalas REAL, category TEXT, createdAt TEXT);
    INSERT INTO messages(id,text) VALUES (NULL,'preserve invalid legacy row');`);
  old.close();
  await fs.writeFile(`${dbPath}.bak-war5`, 'existing backup');
  const archive = new MessageArchive({ dataDir, logger: quietLogger });
  await assert.rejects(archive.ready, /NOT NULL/);
  const unchanged = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(unchanged.prepare('SELECT text FROM messages').get().text, 'preserve invalid legacy row');
  assert.equal(unchanged.prepare('PRAGMA table_info(messages)').all().some((column) => column.name === 'account'), false);
  unchanged.close();
  assert.equal(await fs.readFile(`${dbPath}.bak-war5`, 'utf8'), 'existing backup');
});

test('same message id is stored and scored independently per account and FTS can filter account', async (t) => {
  const { archive } = await tempArchive(t);
  const first = await archive.appendMany([sample('shared', { text: 'Meeting besok', chat: 'Tim Café', sender: 'Nadia' })], { account: ACCOUNT });
  const second = await archive.appendMany([sample('shared', { account: ACCOUNT_2, text: 'Meeting besok' })], { account: ACCOUNT_2 });
  assert.equal((await archive.appendMany([sample('shared')], { account: ACCOUNT })).length, 0);
  await archive.scoreMany(first, () => ({ promo: null, perluBalas: null, category: null }));
  await archive.scoreMany(second, () => replyScore);
  assert.deepEqual(archive.messages.map(scores), [{ promo: null, perluBalas: null, category: null }, replyScore]);
  const search = (account) => archive.db.prepare(`SELECT m.account,m.id FROM messages_fts f JOIN messages m ON m.rowid=f.rowid
    WHERE messages_fts MATCH 'meeting' AND m.account=?`).all(account);
  assert.equal(search(ACCOUNT).length, 1);
  assert.equal(search(ACCOUNT_2).length, 1);
  assert.equal(archive.db.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'account:6281'").get().n, 1);
  archive.db.prepare('UPDATE messages SET account=? WHERE account=? AND id=?').run('6283@c.us', ACCOUNT_2, 'shared');
  assert.equal(search(ACCOUNT_2).length, 0);
  assert.equal(search('6283@c.us').length, 1);
  archive.db.prepare('DELETE FROM messages WHERE account=? AND id=?').run('6283@c.us', 'shared');
  assert.equal(search(ACCOUNT).length, 1);
  assert.deepEqual(scores(archive.messages[0]), { promo: null, perluBalas: null, category: null });
  await assert.rejects(() => archive.appendMany([sample('mixed'), sample('mixed', { account: ACCOUNT_2 })]), /account differs/);
  await assert.rejects(() => archive.appendMany([sample('invalid', { account: '6281' })]), /account is invalid/);
  await assert.rejects(() => archive.appendMany([sample('invalid', { account: '62 81@c.us' })]), /account is invalid/);
  assert.equal(archive.messages.length, 1);
});

test('reply in the same chat on another account does not suppress a reminder', async (t) => {
  const { archive } = await eventArchive(t);
  await addScored(archive, [sample('shared')]);
  await archive.appendMany([sample('shared', { account: ACCOUNT_2 }), sample('answer', { account: ACCOUNT_2, fromMe: true, timestamp: '2026-11-02T01:00:00Z' })], { account: ACCOUNT_2, label: 'Kantor' });
  await archive.appendMany([], { account: ACCOUNT, label: 'Pribadi' });
  const mock = webhookMock();
  await runReminderCycle(archive, config(), { ...mock, logger: quietLogger, now: MORNING });
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].body.account, ACCOUNT);
  assert.equal(mock.requests[0].body.label, 'Pribadi');
  assert.equal(mock.requests[0].body.items[0].chat, 'Chat');
  await archive.appendMany([sample('own-reply', { fromMe: true, timestamp: '2026-11-02T02:01:00Z' })], { account: ACCOUNT });
  await runReminderCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-02T03:30:00Z' });
  assert.equal(mock.requests.length, 1);
});

test('summary and reminder dedupe/pending deliveries stay independent for shared ids across accounts', async (t) => {
  const { archive, dataDir } = await eventArchive(t);
  await addScored(archive, [sample('incoming'), group('group')], (message) => message.isGroup ? infoScore : replyScore);
  const first = webhookMock();
  await runReminderCycle(archive, config(), { ...first, logger: quietLogger, now: MORNING });
  await runSummaryCycle(archive, config(), { ...first, logger: quietLogger, now: NOON });
  const second = await archive.appendMany([sample('incoming', { account: ACCOUNT_2 }), group('group', { account: ACCOUNT_2 })], { account: ACCOUNT_2, label: 'Kantor' });
  await archive.scoreMany(second, (message) => message.isGroup ? infoScore : replyScore);
  const failed = webhookMock(503);
  await runReminderCycle(archive, config(), { ...failed, logger: quietLogger, now: MORNING });
  await runSummaryCycle(archive, config(), { ...failed, logger: quietLogger, now: NOON });
  assert.equal(failed.requests.length, 2);
  assert.ok(failed.requests.every(({ body }) => body.account === ACCOUNT_2 && body.label === 'Kantor'));
  await archive.close();
  const restored = new MessageArchive({ dataDir, logger: quietLogger });
  await restored.ready;
  const mock = webhookMock();
  await runReminderCycle(restored, config(), { ...mock, logger: quietLogger, now: MORNING });
  await runSummaryCycle(restored, config(), { ...mock, logger: quietLogger, now: NOON });
  assert.deepEqual(mock.requests.map(({ body }) => body), failed.requests.map(({ body }) => body));
  await runReminderCycle(restored, config(), { ...mock, logger: quietLogger, now: MORNING });
  await runSummaryCycle(restored, config(), { ...mock, logger: quietLogger, now: NOON });
  assert.equal(mock.requests.length, 2);
  await restored.close();
});

test('HTTP rejects missing/invalid/mixed accounts and registers normalized labels without messages', async (t) => {
  const { archive, base } = await httpFixture(t);
  const post = (body) => fetch(`${base}/ingest`, { method: 'POST', body: JSON.stringify(body) });
  for (const body of [[sample('legacy')], { messages: [sample('missing')] }, { account: '', messages: [] }, { account: 'group@g.us', messages: [] }, { account: ACCOUNT, label: 3, messages: [] }, { account: ACCOUNT, label: 'x'.repeat(101), messages: [] }, { account: ACCOUNT, messages: [sample('mixed', { account: ACCOUNT_2 })] }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal(archive.messages.length, 0);
  const registered = await post({ account: '6281:4@s.whatsapp.net', label: 'Pribadi', messages: [] });
  assert.equal(registered.status, 202);
  assert.deepEqual(archive.accountCounts, [{ account: ACCOUNT, label: 'Pribadi', messages: 0 }]);
  assert.ok(Number.isFinite(Date.parse(archive.db.prepare('SELECT lastSeen FROM accounts WHERE account=?').get(ACCOUNT).lastSeen)));
  const accepted = await post({ account: ACCOUNT, messages: [sample('ok')] });
  assert.equal(accepted.status, 202);
  assert.equal(archive.getAccountLabel(ACCOUNT), 'Pribadi');
  await post({ account: ACCOUNT, label: '', messages: [] });
  assert.equal(archive.getAccountLabel(ACCOUNT), '');
  const health = await (await fetch(`${base}/health`)).json();
  assert.deepEqual(health.accounts, [{ account: ACCOUNT, label: '', messages: 1 }]);
});


test('messageBareId extracts the WhatsApp message id from serialized and bare forms', () => {
  assert.equal(messageBareId('false_261087622627439@lid_3B0FC8EB422D338D9F25'), '3B0FC8EB422D338D9F25');
  assert.equal(messageBareId('true_120363415067688492@g.us_3EB0B9C2FC2F5D65F9C8BB_266794812063933@lid'), '3EB0B9C2FC2F5D65F9C8BB');
  assert.equal(messageBareId('3EB01222851E3EAAA37BB0'), '3EB01222851E3EAAA37BB0');
});

test('repairTimestamps fixes future overflow and day/month swaps from a sane sibling, never writing a future value', async (t) => {
  const { archive } = await tempArchive(t);
  const now = '2026-11-12T00:00:00.000Z';
  await archive.appendMany([
    sample('true_261087622627439@lid_3EB01222851E3EAAA37BB0', {
      chat: 'iIpung ATT', timestamp: '2026-10-30T08:10:01.000Z', fromMe: true, sender: 'me', text: 'asli',
    }),
    sample('false_261087622627439@lid_3B46AEE3FD9EA99894C7', {
      chat: 'iIpung ATT', timestamp: '2026-11-02T04:19:58.000Z', text: 'email',
    }),
    sample('lonely-future', { chat: 'Solo', timestamp: '2026-11-02T00:30:00.000Z', text: 'sendirian' }),
  ]);
  // Bypass ingest clamping to seed the already-stored bad rows the way production has them.
  archive.db.prepare("INSERT INTO messages(account,id,chat,isGroup,sender,text,timestamp,fromMe,createdAt) VALUES (?,?,?,?,?,?,?,?,?)").run(
    ACCOUNT, '3EB01222851E3EAAA37BB0', 'Profile details', 0, 'Alvian', 'asli', '2028-06-10T08:10:00.000Z', 0, '2026-11-03T13:13:33.000Z',
  );
  archive.db.prepare("INSERT INTO messages(account,id,chat,isGroup,sender,text,timestamp,fromMe,createdAt) VALUES (?,?,?,?,?,?,?,?,?)").run(
    ACCOUNT, '3B46AEE3FD9EA99894C7', 'Profile details', 0, 'iIpung ATT', 'email', '2026-02-11T04:19:00.000Z', 0, '2026-11-03T13:13:33.000Z',
  );
  archive.db.prepare("UPDATE messages SET timestamp=?, createdAt=? WHERE id='lonely-future'").run('2028-06-10T08:26:00.000Z', '2026-11-03T13:13:33.000Z');

  const first = await archive.repairTimestamps(now);
  assert.equal(first.length, 3);
  const byId = Object.fromEntries(first.map((row) => [row.id, row]));
  assert.equal(byId['3EB01222851E3EAAA37BB0'].to, '2026-10-30T08:10:01.000Z');
  assert.equal(byId['3B46AEE3FD9EA99894C7'].to, '2026-11-02T04:19:58.000Z');
  assert.equal(byId['lonely-future'].to, '2026-11-03T13:13:33.000Z');
  for (const row of first) assert.ok(Date.parse(row.to) <= Date.parse(now));

  const stored = Object.fromEntries(archive.messages.map((message) => [message.id, message.timestamp]));
  assert.equal(stored['3EB01222851E3EAAA37BB0'], '2026-10-30T08:10:01.000Z');
  assert.equal(stored['3B46AEE3FD9EA99894C7'], '2026-11-02T04:19:58.000Z');
  assert.equal(stored['lonely-future'], '2026-11-03T13:13:33.000Z');
  assert.equal(stored['true_261087622627439@lid_3EB01222851E3EAAA37BB0'], '2026-10-30T08:10:01.000Z');

  const second = await archive.repairTimestamps(now);
  assert.equal(second.length, 0);

  const messages = archive.db.prepare('SELECT count(*) AS c FROM messages').get().c;
  const fts = archive.db.prepare('SELECT count(*) AS c FROM messages_fts').get().c;
  assert.equal(fts, messages);
  archive.db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')").run();
});

test('appendMany never stores a timestamp in the future, preferring a sane sibling', async (t) => {
  const { archive } = await tempArchive(t);
  await archive.appendMany([
    sample('true_chat@lid_ABCDEF1234', { timestamp: '2026-10-30T08:10:01.000Z', text: 'sumber' }),
  ]);
  const added = await archive.appendMany([
    sample('ABCDEF1234', { chat: 'Profile details', timestamp: '2028-06-10T08:10:00.000Z', text: 'salinan' }),
    sample('no-sibling', { chat: 'Lain', timestamp: '2028-06-10T09:00:00.000Z', text: 'mandiri' }),
  ]);
  assert.equal(added.find((message) => message.id === 'ABCDEF1234').timestamp, '2026-10-30T08:10:01.000Z');
  const lonely = added.find((message) => message.id === 'no-sibling');
  assert.ok(Date.parse(lonely.timestamp) <= Date.now() + 15_000);
  assert.ok(!lonely.timestamp.startsWith('2028'));
  for (const message of archive.messages) assert.ok(Date.parse(message.timestamp) <= Date.now() + 15 * 60_000, message.timestamp);
});

test('cappedSummaryFrom keeps a recent cursor and floors an old one to slot minus 24 hours', () => {
  const slot = '2026-11-12T05:00:00.000Z'; // 12:00 WIB on 12 Nov
  const recent = '2026-11-11T13:00:00.000Z'; // 20:00 WIB on 11 Nov, 16 hours earlier
  assert.equal(cappedSummaryFrom(recent, slot, { staleSummaryMs: 24 * 3600_000 }), recent);
  const stale = '2026-11-04T13:00:00.000Z';
  assert.equal(cappedSummaryFrom(stale, slot, { staleSummaryMs: 24 * 3600_000 }), '2026-11-11T05:00:00.000Z');
});

test('truncateSummaryText cuts at a group boundary and reports omitted groups', () => {
  const groups = [
    '### Alpha\n1 pesan.\n- Alice: halo',
    '### Transys3\n2 pesan.\n- Budi: laporan panjang ' + 'x'.repeat(80),
    '### Charlie\n1 pesan.\n- Cici: ok',
    '### Delta\n1 pesan.\n- Dedi: sip',
  ];
  const teks = groups.join('\n\n');
  assert.equal(truncateSummaryText(teks, 10_000), teks);
  // Budget that fits Alpha fully, but not Alpha+Transys3 plus the "+2 grup" suffix.
  const limit = [...groups[0] + '\n\n' + groups[1]].length - 10;
  const result = truncateSummaryText(teks, limit);
  assert.ok(result.startsWith('### Alpha\n'));
  assert.match(result, /\n\n… \+3 grup lainnya$/);
  assert.equal(result.includes('### Transys3'), false);
  assert.equal(result.includes('### Charlie'), false);
  assert.ok([...result].length <= limit);
});

test('truncateSummaryText cuts a single oversized group at a line boundary', () => {
  const teks = '### Transys3\nbaris satu\nbaris dua ' + 'y'.repeat(200) + '\nbaris tiga';
  const result = truncateSummaryText(teks, 40);
  assert.ok(result.startsWith('### Transys3'));
  assert.ok(result.endsWith('…') || result.includes('…'));
  assert.equal(result.includes('baris tiga'), false);
  assert.ok([...result].length <= 40);
  // Prefer a clean line cut, not mid-word leftover without ellipsis.
  assert.equal(result.includes('\nbaris dua'), false);
});

test('a stale pending summary is dropped, the window is capped, and the old draft is not sent', async (t) => {
  const { archive } = await eventArchive(t);
  await addScored(archive, [
    group('old-nov4', { chat: 'Lama', text: 'isi 4 november', timestamp: '2026-11-04T08:00:00Z' }),
  ], () => infoScore);
  const failed = webhookMock(503);
  // 20:00 WIB on 4 Nov = 13:00 UTC
  await runSummaryCycle(archive, config(), { ...failed, logger: quietLogger, now: '2026-11-04T13:00:00Z' });
  assert.equal(failed.requests.length, 1);
  assert.match(failed.requests[0].body.teks, /isi 4 november/);
  assert.equal(accountEventState(archive).pendingSummary?.slot, '2026-11-04T13:00:00.000Z');

  await addScored(archive, [
    group('recent', { chat: 'Baru', text: 'isi 11 november', timestamp: '2026-11-11T10:00:00Z' }),
  ], () => infoScore);
  const mock = webhookMock();
  // 06:14 WIB on 12 Nov is after 11 Nov 20:00 (13:00 UTC). Slot is 11 Nov 20:00.
  await runSummaryCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-11T23:14:00Z' });
  assert.equal(mock.requests.length, 1);
  const body = mock.requests[0].body;
  assert.equal(body.type, 'ringkasan');
  assert.equal(body.teks.includes('isi 4 november'), false);
  assert.match(body.teks, /isi 11 november/);
  assert.deepEqual(body.periode, { dari: '2026-11-10T13:00:00.000Z', sampai: '2026-11-11T13:00:00.000Z' });
  assert.deepEqual(body.grup.map((item) => item.nama), ['Baru']);
  assert.equal(accountEventState(archive).pendingSummary, null);
  assert.equal(accountEventState(archive).summaryCursor, '2026-11-11T13:00:00.000Z');
  // A second cycle must not resend.
  await runSummaryCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-11T23:20:00Z' });
  assert.equal(mock.requests.length, 1);
});

test('a stale pending reminder is regenerated instead of sending the old draft', async (t) => {
  const { archive } = await eventArchive(t);
  await addScored(archive, [sample('waiting', { timestamp: '2026-11-02T00:30:00Z' })]);
  const failed = webhookMock(503);
  await runReminderCycle(archive, config(), { ...failed, logger: quietLogger, now: MORNING });
  assert.equal(failed.requests.length, 1);
  const oldMinutes = failed.requests[0].body.items[0].menunggu_menit;
  const mock = webhookMock();
  // Five hours later, still unanswered — drop the stale draft and send a fresh one.
  await runReminderCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-02T07:00:00Z' });
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].body.type, 'pengingat');
  assert.equal(mock.requests[0].body.items[0].text, 'message waiting');
  assert.ok(mock.requests[0].body.items[0].menunggu_menit > oldMinutes);
  assert.notDeepEqual(mock.requests[0].body, failed.requests[0].body);
});


test('clipIncompleteSummary drops a mid-sentence tail and appends a note', () => {
  const cut = clipIncompleteSummary('- Rapat dijadwalkan besok.\n- Perlu dicek lagi masalah pada modul yang');
  assert.equal(cut, '- Rapat dijadwalkan besok.\n… (ringkasan grup ini terpotong)');
  assert.equal(clipIncompleteSummary('- Semua beres.'), '- Semua beres.\n… (ringkasan grup ini terpotong)');
  assert.equal(clipIncompleteSummary('tanpa tanda baca di tengah kali'), '');
  assert.equal(clipIncompleteSummary('Pertama selesai. Kedua masih terpo'), 'Pertama selesai.\n… (ringkasan grup ini terpotong)');
});

test('summary model stop-reason length is clipped at a complete line and max_tokens is raised', async (t) => {
  const { archive } = await eventArchive(t);
  await addScored(archive, [group('cut', { chat: 'Transys3', text: 'laporan mingguan' })], () => infoScore);
  const bodies = [];
  const modelBodies = [];
  await runSummaryCycle(archive, config({
    summaryModelUrl: 'https://summary.invalid/v1', summaryModelKey: 'secret', summaryModelName: 'glm-5.3-flash',
  }), {
    now: NOON, logger: quietLogger,
    fetchImpl: async (url, options) => {
      if (url.includes('summary.invalid')) {
        modelBodies.push(JSON.parse(options.body));
        return {
          status: 200,
          json: async () => ({
            choices: [{
              finish_reason: 'length',
              message: { content: '- Rapat dijadwalkan besok.\n- Perlu dicek lagi masalah pada modul yang' },
            }],
          }),
        };
      }
      bodies.push(JSON.parse(options.body));
      return { status: 204 };
    },
  });
  assert.equal(modelBodies.length, 1);
  assert.ok(modelBodies[0].max_tokens >= 8192);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0].teks, /### Transys3/);
  assert.match(bodies[0].teks, /Rapat dijadwalkan besok/);
  assert.match(bodies[0].teks, /ringkasan grup ini terpotong/);
  assert.equal(bodies[0].teks.includes('modul yang'), false);
});

test('a length-limited group with many messages is re-summarized in halves', async (t) => {
  const { archive } = await eventArchive(t);
  await addScored(archive, Array.from({ length: 24 }, (_, i) => group(`g${i}`, {
    chat: 'Transys3', text: `catatan-${i}`, timestamp: `2026-11-02T01:${String(i).padStart(2, '0')}:00Z`,
  })), () => infoScore);
  const modelCalls = [];
  const bodies = [];
  await runSummaryCycle(archive, config({
    summaryModelUrl: 'https://summary.invalid/v1', summaryModelKey: 'secret', summaryModelName: 'glm-5.3-flash',
  }), {
    now: NOON, logger: quietLogger,
    fetchImpl: async (url, options) => {
      if (url.includes('summary.invalid')) {
        const body = JSON.parse(options.body);
        modelCalls.push(JSON.parse(body.messages[1].content).jumlahPesan);
        if (modelCalls.length === 1) {
          return { status: 200, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '- Terpotong di tengah kali' } }] }) };
        }
        const label = modelCalls.length === 2 ? 'awal' : 'akhir';
        return { status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: `- Bagian ${label} lengkap.` } }] }) };
      }
      bodies.push(JSON.parse(options.body));
      return { status: 204 };
    },
  });
  assert.deepEqual(modelCalls, [24, 12, 12]);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0].teks, /Bagian awal lengkap/);
  assert.match(bodies[0].teks, /Bagian akhir lengkap/);
  assert.equal(bodies[0].teks.includes('Terpotong di tengah kali'), false);
});


const mentionMsg = (id, extra = {}) => group(id, {
  mentionsMe: true, replyToMe: false, sender: 'Nadia', text: 'Pak @Tuan, bisa review?',
  timestamp: '2026-11-02T01:00:00.000Z', ...extra,
});

test('normalizeMessage accepts mention flags and rejects non-booleans', () => {
  const flagged = normalizeMessage(sample('m', { mentionsMe: true, replyToMe: true }));
  assert.equal(flagged.mentionsMe, true);
  assert.equal(flagged.replyToMe, true);
  assert.throws(() => normalizeMessage(sample('bad', { mentionsMe: 1 })), /mentionsMe must be a boolean/);
  assert.throws(() => normalizeMessage(sample('bad2', { replyToMe: 'yes' })), /replyToMe must be a boolean/);
});

test('appendMany stores mention flags and can upgrade existing rows without re-adding', async (t) => {
  const { archive } = await tempArchive(t);
  const added = await archive.appendMany([mentionMsg('g1', { mentionsMe: false })], { account: ACCOUNT, label: 'Pribadi' });
  assert.equal(added.length, 1);
  assert.equal(archive.messages[0].mentionsMe, false);
  const again = await archive.appendMany([mentionMsg('g1')], { account: ACCOUNT });
  assert.equal(again.length, 0);
  assert.equal(archive.messages[0].mentionsMe, true);
  assert.equal(archive.messages[0].replyToMe, false);
});

test('mention sweeper notifies after the delay when unread is positive or unknown, once, in one batch', async (t) => {
  const { archive } = await eventArchive(t);
  await archive.appendMany([
    mentionMsg('tim', { chat: 'Tim Café', text: 'Pak @Tuan, bisa review?' }),
    mentionMsg('ops', { chat: 'Ops', sender: 'Budi', text: 'Tolong cek @Tuan', replyToMe: true, mentionsMe: false }),
  ], { account: ACCOUNT, label: 'Pribadi' });
  await archive.saveUnread(ACCOUNT, [{ chat: 'Tim Café', unread: 3, isGroup: true }]);
  const mock = webhookMock();
  const logs = [];
  const logger = { info(...args) { logs.push(args.join(' ')); }, warn() {}, error() {} };
  const early = await runMentionCycle(archive, config(), { ...mock, logger, now: '2026-11-02T01:30:00.000Z' });
  assert.equal(early.sent, 0);
  assert.equal(mock.requests.length, 0);
  const result = await runMentionCycle(archive, config(), { ...mock, logger, now: MORNING });
  assert.equal(result.sent, 2);
  assert.equal(mock.requests.length, 1);
  const event = mock.requests[0].body;
  assert.equal(event.type, 'mention');
  assert.equal(event.account, ACCOUNT);
  assert.equal(event.label, 'Pribadi');
  assert.ok(event.generatedAt);
  assert.equal(event.items.length, 2);
  assert.deepEqual(event.items.map((item) => item.chat), ['Tim Café', 'Ops']);
  assert.equal(event.items[0].sender, 'Nadia');
  assert.equal(event.items[0].menunggu_menit, 60);
  assert.equal(event.items[0].text, 'Pak @Tuan, bisa review?');
  assert.match(event.text, /^Mention belum dibaca:\n- Tim Café \(60 menit, dari Nadia\): "Pak @Tuan, bisa review\?"/);
  assert.equal(Object.keys(event).sort().join(), 'account,generatedAt,items,label,text,type');
  const second = await runMentionCycle(archive, config(), { ...mock, logger, now: '2026-11-02T03:00:00.000Z' });
  assert.equal(second.sent, 0);
  assert.equal(mock.requests.length, 1);
  assert.ok(logs.every((line) => !line.includes('Pak @Tuan') && !line.includes('Tolong cek')));
  assert.match(logs.join('\n'), /Mention webhook delivered 2 item\(s\), text length \d+/);
});

test('mention sweeper skips a chat that was replied to or marked read, and drops stale mentions', async (t) => {
  const { archive } = await eventArchive(t);
  await archive.appendMany([
    mentionMsg('replied', { chat: 'Tim' }),
    mentionMsg('mine', { chat: 'Tim', id: 'from-me-later', fromMe: true, mentionsMe: false, sender: 'me', timestamp: '2026-11-02T01:20:00.000Z' }),
    mentionMsg('read', { chat: 'Dibaca', text: 'sudah dibaca' }),
    mentionMsg('stale', { chat: 'Lama', timestamp: '2026-11-01T01:00:00.000Z', text: 'mention kemarin' }),
  ], { account: ACCOUNT, label: 'Pribadi' });
  await archive.saveUnread(ACCOUNT, [
    { chat: 'Tim', unread: 4, isGroup: true },
    { chat: 'Dibaca', unread: 0, isGroup: true },
    { chat: 'Lama', unread: 2, isGroup: true },
  ]);
  const mock = webhookMock();
  const result = await runMentionCycle(archive, config(), { ...mock, logger: quietLogger, now: MORNING });
  assert.equal(result.sent, 0);
  assert.equal(mock.requests.length, 0);
});

test('mention sweeper defers during quiet hours and sends a batch after 06:00 Jakarta', async (t) => {
  const { archive } = await eventArchive(t);
  await archive.appendMany([mentionMsg('a', { chat: 'A', timestamp: '2026-11-02T13:00:00Z' })], { account: ACCOUNT, label: 'Pribadi' });
  const mock = webhookMock();
  await runMentionCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-02T15:00:00Z' });
  await archive.appendMany([mentionMsg('b', { chat: 'B', sender: 'Budi', timestamp: '2026-11-02T17:00:00Z' })], { account: ACCOUNT });
  await runMentionCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-02T22:59:00Z' });
  assert.equal(mock.requests.length, 0);
  await runMentionCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-02T23:00:00Z' });
  await runMentionCycle(archive, config(), { ...mock, logger: quietLogger, now: '2026-11-02T23:05:00Z' });
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].body.type, 'mention');
  assert.deepEqual(mock.requests[0].body.items.map((item) => item.chat), ['A', 'B']);
});

test('a stale pending mention is dropped rather than sent, and makeConfig reads MENTION_DELAY_MIN', async (t) => {
  const { archive } = await eventArchive(t);
  await archive.appendMany([mentionMsg('fresh', { timestamp: '2026-11-02T01:00:00.000Z' })], { account: ACCOUNT, label: 'Pribadi' });
  const staleGenerated = '2026-11-01T00:00:00.000Z';
  await archive.saveEventState({
    ...archive.scoped(ACCOUNT).eventState,
    pendingMention: {
      ids: [`${ACCOUNT}\u0000old`],
      event: mentionEvent([mentionMsg('old', { text: 'draft lama', timestamp: staleGenerated })], new Date(staleGenerated), archive.scoped(ACCOUNT)),
    },
  }, ACCOUNT);
  const mock = webhookMock();
  const result = await runMentionCycle(archive, config({ mentionDelayMin: 15 }), { ...mock, logger: quietLogger, now: MORNING });
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].body.type, 'mention');
  assert.equal(mock.requests[0].body.items.length, 1);
  assert.equal(mock.requests[0].body.items[0].chat, 'Tim');
  assert.equal(result.sent, 1);
  assert.equal(makeConfig({ MENTION_DELAY_MIN: '45' }).mentionDelayMin, 45);
  assert.equal(makeConfig({}).mentionDelayMin, 30);
});

test('HTTP /unread upserts per-chat counts and rejects bad payloads', async (t) => {
  const { archive, base } = await httpFixture(t);
  const origin = 'chrome-extension://abcdefghijklmnop';
  const blocked = await fetch(`${base}/unread`, { method: 'POST', headers: { origin: 'https://web.whatsapp.com' }, body: JSON.stringify({ account: ACCOUNT, chats: [] }) });
  assert.equal(blocked.status, 403);
  const invalid = await fetch(`${base}/unread`, { method: 'POST', body: JSON.stringify({ account: 'not-a-jid', chats: [] }) });
  assert.equal(invalid.status, 400);
  const accepted = await fetch(`${base}/unread`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({
      account: ACCOUNT,
      chats: [
        { chat: 'Tim', chatId: '120@g.us', unread: 4, isGroup: true },
        { chat: 'Direct', unread: 0, isGroup: false },
        { chat: 'Unknown', unread: -1, isGroup: true },
      ],
    }),
  });
  assert.equal(accepted.status, 202);
  assert.equal(archive.getUnread(ACCOUNT, 'Tim'), 4);
  assert.equal(archive.getUnread(ACCOUNT, 'Direct'), 0);
  assert.equal(archive.getUnread(ACCOUNT, 'Unknown'), null);
  assert.equal(archive.getUnread(ACCOUNT, 'Missing'), null);
});

test('WAR-8 migration adds columns and chat_unread, backs up once, and keeps event state', async (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'war8-migration-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const dbPath = path.join(dataDir, 'wa.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE messages (
      account TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, chat TEXT, isGroup INTEGER, sender TEXT, text TEXT,
      timestamp TEXT, fromMe INTEGER, promo REAL, perluBalas REAL, category TEXT, createdAt TEXT,
      PRIMARY KEY(account, id)
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE accounts (account TEXT PRIMARY KEY, label TEXT, lastSeen TEXT);
    CREATE VIRTUAL TABLE messages_fts USING fts5(text, chat, sender, account, content='messages', content_rowid='rowid', tokenize='unicode61');
  `);
  old.prepare('INSERT INTO messages(account,id,chat,isGroup,sender,text,timestamp,fromMe,promo,perluBalas,category,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(ACCOUNT, 'keep-me', 'Tim', 1, 'Nadia', 'halo lama', '2026-11-02T00:30:00.000Z', 0, null, null, null, BASELINE);
  old.prepare('INSERT INTO messages_fts(rowid, text, chat, sender, account) SELECT rowid, text, chat, sender, account FROM messages').run();
  old.prepare('INSERT INTO accounts VALUES (?,?,?)').run(ACCOUNT, 'Pribadi', BASELINE);
  const priorState = {
    remindedIds: [`${ACCOUNT}\u0000old-r`], mentionedIds: undefined, summaryCursor: '2026-11-11T13:00:00.000Z',
    pendingReminder: null, pendingSummary: null, lastSummarySlot: '2026-11-11T13:00:00.000Z', summaryMessageIds: [],
  };
  // Store a pre-WAR-8 event state that omits mentionedIds/pendingMention.
  const stored = { remindedIds: priorState.remindedIds, summaryCursor: priorState.summaryCursor, pendingReminder: null, pendingSummary: null, lastSummarySlot: priorState.lastSummarySlot, summaryMessageIds: [] };
  old.prepare('INSERT INTO meta VALUES (?,?)').run(`eventState:${ACCOUNT}`, JSON.stringify(stored));
  old.close();
  const archive = new MessageArchive({ dataDir, logger: quietLogger });
  await archive.ready;
  const columns = archive.db.prepare('PRAGMA table_info(messages)').all().map((row) => row.name);
  assert.ok(columns.includes('mentionsMe'));
  assert.ok(columns.includes('replyToMe'));
  assert.ok(archive.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_unread'").get());
  assert.equal(archive.messages.length, 1);
  assert.equal(archive.messages[0].id, 'keep-me');
  assert.equal(archive.messages[0].text, 'halo lama');
  assert.equal(archive.messages[0].mentionsMe, false);
  const state = archive.scoped(ACCOUNT).eventState;
  assert.deepEqual(state.mentionedIds, []);
  assert.equal(state.pendingMention, null);
  assert.equal(state.summaryCursor, '2026-11-11T13:00:00.000Z');
  assert.deepEqual(state.remindedIds, [`${ACCOUNT}\u0000old-r`]);
  const backup = `${dbPath}.bak-war8`;
  await fs.access(backup);
  const bak = new DatabaseSync(backup, { readOnly: true });
  assert.equal(bak.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
  assert.equal(bak.prepare('PRAGMA table_info(messages)').all().some((column) => column.name === 'mentionsMe'), false);
  bak.close();
  const firstBackup = await fs.readFile(backup);
  const again = new MessageArchive({ dataDir, logger: quietLogger });
  await again.ready;
  await again.close();
  const secondBackup = await fs.readFile(backup);
  assert.deepEqual(firstBackup, secondBackup);
  await archive.close();
});


test('stripInvisibleText removes bidi and zero-width marks and leaves real text', () => {
  const padded = `ⓘ Menyebut Anda ${'\u200E'.repeat(4001)}*pindah ke saluran itu pls*`;
  assert.equal(visibleText(padded), 'ⓘ Menyebut Anda *pindah ke saluran itu pls*');
  assert.equal(stripInvisibleText('\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u200B\u200C\u200D\uFEFF'), '');
  assert.equal(isReplyWorthy('\u200E'.repeat(50) + '   '), false);
  assert.equal(isReplyWorthy(padded), true);
  const snippet = snippetText(padded, 300);
  assert.equal(snippet.includes('\u200E'), false);
  assert.equal(snippet, 'ⓘ Menyebut Anda *pindah ke saluran itu pls*');
  assert.equal(isNewsletterChat({ chat: '120363334732957782@newsletter' }), true);
  assert.equal(isNewsletterChat({ id: 'false_120363334732957782@newsletter_3AFE42' }), true);
  assert.equal(isNewsletterChat({ chat: 'Alice', id: 'false_6281@c.us_abc' }), false);
});

test('pengingat and mention skip newsletters and empty-after-strip text, and snippets drop LTR marks', async (t) => {
  const { archive } = await eventArchive(t);
  const ltr = '\u200E'.repeat(4001);
  const scored = { promo: 0.1, perluBalas: 0.9, category: 'perlu_balas' };
  await addScored(archive, [
    sample('news', {
      chat: '120363334732957782@newsletter',
      text: `ⓘ Menyebut Anda ${ltr}*pindah ke saluran itu pls, mau aku hapus*`,
      timestamp: '2026-11-12T01:43:26.000Z',
    }),
    sample('ghost', {
      chat: 'Hantu',
      text: ltr,
      timestamp: '2026-11-12T01:43:26.000Z',
    }),
    sample('real', {
      chat: 'Alice',
      text: `Tolong cek ${ltr}jadwal besok?`,
      timestamp: '2026-11-12T01:43:26.000Z',
    }),
  ], () => scored);
  await archive.appendMany([
    mentionMsg('ch-mention', {
      chat: '120363312616947327@newsletter', isGroup: true,
      text: `ⓘ Menyebut Anda ${ltr}halo`,
      timestamp: '2026-11-02T01:00:00.000Z',
    }),
    mentionMsg('ghost-mention', {
      chat: 'Grup Hantu', text: ltr, timestamp: '2026-11-02T01:00:00.000Z',
    }),
    mentionMsg('real-mention', {
      chat: 'Tim Café',
      text: `Pak @Tuan, ${ltr}bisa review?`,
      timestamp: '2026-11-02T01:00:00.000Z',
    }),
  ], { account: ACCOUNT, label: 'Pribadi' });
  await archive.saveUnread(ACCOUNT, [
    { chat: '120363312616947327@newsletter', unread: 3, isGroup: true },
    { chat: 'Grup Hantu', unread: 2, isGroup: true },
    { chat: 'Tim Café', unread: 2, isGroup: true },
  ]);
  const mock = webhookMock();
  const reminder = await runReminderCycle(archive, config({ reminderAfterMin: 60 }), { ...mock, logger: quietLogger, now: '2026-11-12T03:00:00.000Z' });
  assert.equal(reminder.sent, 1);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].body.type, 'pengingat');
  assert.deepEqual(mock.requests[0].body.items.map((item) => item.chat), ['Alice']);
  assert.equal(mock.requests[0].body.items[0].text, 'Tolong cek jadwal besok?');
  assert.equal(mock.requests[0].body.items[0].text.includes('\u200E'), false);
  assert.match(mock.requests[0].body.text, /Tolong cek jadwal besok\?/);
  assert.equal(mock.requests[0].body.text.includes('\u200E'), false);

  const mentionMock = webhookMock();
  const mention = await runMentionCycle(archive, config(), { ...mentionMock, logger: quietLogger, now: MORNING });
  assert.equal(mention.sent, 1);
  assert.equal(mentionMock.requests.length, 1);
  assert.equal(mentionMock.requests[0].body.type, 'mention');
  assert.deepEqual(mentionMock.requests[0].body.items.map((item) => item.chat), ['Tim Café']);
  assert.equal(mentionMock.requests[0].body.items[0].text, 'Pak @Tuan, bisa review?');
  assert.equal(mentionMock.requests[0].body.text.includes('\u200E'), false);
});

test('requestAllowed trusts loopback and requires a bearer token from remote clients', () => {
  const cfg = config({ ingestToken: 'secret-token' });
  const req = (remote, auth) => ({ socket: { remoteAddress: remote }, headers: auth === undefined ? {} : { authorization: auth } });
  assert.equal(requestAllowed(req('127.0.0.1'), cfg), true);
  assert.equal(requestAllowed(req('::1'), cfg), true);
  assert.equal(requestAllowed(req('::ffff:127.0.0.1'), cfg), true);
  assert.equal(requestAllowed(req('10.0.0.9', 'Bearer secret-token'), cfg), true, 'a remote client with the exact token passes');
  assert.equal(requestAllowed(req('10.0.0.9', 'bearer secret-token'), cfg), false, 'the scheme is case sensitive');
  assert.equal(requestAllowed(req('10.0.0.9', 'Bearer wrong'), cfg), false);
  assert.equal(requestAllowed(req('10.0.0.9', 'Bearer secret-token extra'), cfg), false, 'a longer header cannot smuggle a match');
  assert.equal(requestAllowed(req('10.0.0.9'), cfg), false, 'a remote client without a header is rejected');
  const noToken = config({});
  assert.equal(requestAllowed(req('10.0.0.9', 'Bearer anything'), noToken), false, 'no configured token means remote is always rejected');
  assert.equal(requestAllowed(req('127.0.0.1'), noToken), true, 'loopback needs no token');
});

test('makeConfig reads HOST, PORT and INGEST_TOKEN with safe defaults', () => {
  const custom = makeConfig({ HOST: '0.0.0.0', PORT: '9000', INGEST_TOKEN: 'tok' });
  assert.equal(custom.host, '0.0.0.0');
  assert.equal(custom.port, 9000);
  assert.equal(custom.ingestToken, 'tok');
  const fallback = makeConfig({});
  assert.equal(fallback.host, '127.0.0.1');
  assert.equal(fallback.port, 4317);
  assert.equal(fallback.ingestToken, '');
  assert.equal(makeConfig({ PORT: '99999' }).port, 4317, 'an out-of-range port falls back');
  assert.equal(makeConfig({ PORT: 'nan' }).port, 4317, 'a non-numeric port falls back');
});
