'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeDriver } = require('../adapters/whatsapp/driver');

const ACCOUNT = '6281234567890@c.us';
const SESSION = 'sess-1';
const msg = overrides => ({
  id: `bf-${Math.random().toString(36).slice(2)}`, account: ACCOUNT,
  chat: 'Backfill', sender: 'budi', text: 'halo',
  timestamp: new Date().toISOString(), isGroup: true, fromMe: false, ...overrides,
});
const progress = over => ({
  account: ACCOUNT, session: SESSION, status: 'running',
  chatIds: ['a@g.us', 'b@c.us'], chatIndex: 1, total: 2, messageCount: 5,
  maxPerChat: 100, current: null, detail: '', ...over,
});

function setup() {
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-bf-'));
  const file = path.join(queueDir, 'state.json');
  const driver = makeDriver({
    queueDir, stateFile: file, endpoint: 'http://x', autoFlushMs: 0, log: () => {},
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  return { queueDir, file, driver };
}

test('backfill-ready returns null before any checkpoint', () => {
  const { driver } = setup();
  assert.equal(driver.handle({ type: 'backfill-ready', account: ACCOUNT }).progress, null);
  driver.dispose();
});

test('checkpoint persists to the state file and round-trips via ready', () => {
  const { driver, file } = setup();
  assert.equal(driver.handle({ type: 'backfill-checkpoint', account: ACCOUNT, session: SESSION, progress: progress() }).stored, true);
  const back = driver.handle({ type: 'backfill-ready', account: ACCOUNT });
  assert.equal(back.progress.session, SESSION);
  assert.equal(back.progress.chatIndex, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).backfills[ACCOUNT].session, SESSION);
  driver.dispose();
});

test('checkpoint rejects session/account mismatch and invalid shape', () => {
  const { driver } = setup();
  assert.equal(driver.handle({ type: 'backfill-checkpoint', account: ACCOUNT, session: 'other', progress: progress() }).stored, false);
  assert.equal(driver.handle({ type: 'backfill-checkpoint', account: '6298765432109@c.us', session: SESSION, progress: progress() }).stored, false);
  assert.equal(driver.handle({ type: 'backfill-checkpoint', account: ACCOUNT, session: SESSION, progress: { ...progress(), total: 99 } }).stored, false);
  driver.dispose();
});

test('pause is sticky: a running checkpoint must not undo pause', () => {
  const { driver } = setup();
  driver.handle({ type: 'backfill-checkpoint', account: ACCOUNT, session: SESSION, progress: progress({ status: 'paused' }) });
  const r = driver.handle({ type: 'backfill-checkpoint', account: ACCOUNT, session: SESSION, progress: progress({ status: 'running' }) });
  assert.equal(r.progress.status, 'paused');
  driver.dispose();
});

test('backfill-batch: session guard + queue-level dedupe', () => {
  const { queueDir, driver } = setup();
  driver.handle({ type: 'backfill-checkpoint', account: ACCOUNT, session: SESSION, progress: progress() });
  const m1 = msg();
  assert.equal(driver.handle({ type: 'backfill-batch', account: ACCOUNT, session: 'wrong', messages: [m1] }).stored, false);
  const ok = driver.handle({ type: 'backfill-batch', account: ACCOUNT, session: SESSION, messages: [m1, msg()] });
  assert.equal(ok.queued, 2);
  const dup = driver.handle({ type: 'backfill-batch', account: ACCOUNT, session: SESSION, messages: [m1] });
  assert.equal(dup.queued, 0);
  assert.equal(dup.duplicates, 1);
  const lines = fs.readFileSync(path.join(queueDir, `${ACCOUNT}.jsonl`), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  driver.dispose();
});

test('auto backfill fires after ≥1h offline gap, respects 6h cooldown, persists session', () => {
  const { queueDir, file } = setup();
  const hours = n => new Date(Date.now() - n * 3600000).toISOString();
  fs.writeFileSync(file, JSON.stringify({ accounts: { [ACCOUNT]: { seenAt: hours(2), lastAutoBackfillAt: hours(7) } }, backfills: {} }));
  let fired = null;
  const driver = makeDriver({
    queueDir, stateFile: file, endpoint: 'http://x', autoFlushMs: 0, log: () => {},
    fetchImpl: async () => ({ ok: true, status: 200 }),
    onAutoBackfill: (account, p) => { fired = { account, p }; },
  });
  const waStatus = { type: 'wa-status', account: ACCOUNT, connected: true, detail: '', mode: 'internal' };
  driver.handle(waStatus);
  assert.ok(fired, 'auto backfill should fire after the offline gap');
  assert.equal(fired.account, ACCOUNT);
  assert.equal(fired.p.status, 'running');
  assert.ok(fired.p.session);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).backfills[ACCOUNT].session, fired.p.session);
  fired = null;
  driver.handle(waStatus); // cooldown active → no second fire
  assert.equal(fired, null);
  driver.dispose();
});

test('first authenticated connect starts exactly one latest-100 session', () => {
  const { queueDir, file } = setup();
  let fired = 0;
  const driver = makeDriver({
    queueDir, stateFile: file, endpoint: 'http://x', autoFlushMs: 0, log: () => {},
    fetchImpl: async () => ({ ok: true, status: 200 }),
    onAutoBackfill: () => { fired += 1; },
  });
  const waStatus = { type: 'wa-status', account: ACCOUNT, connected: true, detail: '', mode: 'internal' };
  driver.handle({ ...waStatus, connected: false });
  assert.equal(fired, 0);
  driver.handle(waStatus);
  const initial = driver.handle({ type: 'backfill-ready', account: ACCOUNT }).progress;
  assert.equal(initial.maxPerChat, 100);
  driver.handle(waStatus);
  assert.equal(fired, 1);
  assert.equal(driver.handle({ type: 'backfill-ready', account: ACCOUNT }).progress.session, initial.session);
  driver.dispose();
});

test('existing account without backfills qualifies; restart, OFF/ON and completed status retain session', context => {
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-initial-'));
  context.after(() => fs.rmSync(queueDir, { recursive: true, force: true }));
  const stateFile = path.join(queueDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ accounts: { [ACCOUNT]: { seenAt: new Date().toISOString() } }, backfills: {} }));
  let starts = 0;
  const options = { queueDir, stateFile, autoFlushMs: 0, log: () => {}, onAutoBackfill: () => starts++ };
  const connect = driver => driver.handle({ type: 'wa-status', account: ACCOUNT, connected: true });
  const ready = driver => driver.handle({ type: 'backfill-ready', account: ACCOUNT }).progress;
  const first = makeDriver({ ...options, enabled: false });
  connect(first);
  assert.equal(starts, 0);
  first.setEnabled(true);
  connect(first);
  assert.equal(starts, 1);
  const saved = { ...ready(first), chatIds: ['chat'], total: 1, current: { id: 'chat', ids: ['one'] }, messageCount: 1 };
  assert.equal(first.handle({ type: 'backfill-checkpoint', account: ACCOUNT, session: saved.session, progress: saved }).stored, true);
  first.dispose();
  const restarted = makeDriver(options);
  context.after(() => restarted.dispose());
  connect(restarted);
  assert.deepEqual(ready(restarted), saved);
  restarted.setEnabled(false);
  assert.equal(restarted.handle({ type: 'backfill-ready', account: ACCOUNT }).stored, false);
  restarted.setEnabled(true);
  connect(restarted);
  assert.deepEqual(ready(restarted), saved);
  assert.equal(starts, 1);
  assert.equal(restarted.handle({ type: 'backfill-checkpoint', account: ACCOUNT, session: 'stale', progress: { ...saved, session: 'stale' } }).stored, false);
  const done = { ...saved, status: 'done', chatIndex: 1, current: null };
  restarted.handle({ type: 'backfill-checkpoint', account: ACCOUNT, session: done.session, progress: done });
  connect(restarted);
  assert.deepEqual(ready(restarted), done);
  const completed = makeDriver(options);
  connect(completed);
  assert.deepEqual(ready(completed), done);
  assert.equal(starts, 1);
  assert.equal(completed.backfill(ACCOUNT, 'start').maxPerChat, 100);
  completed.dispose();
});

test('offline reconnect never replaces a running or manually paused checkpoint', context => {
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-resume-'));
  context.after(() => fs.rmSync(queueDir, { recursive: true, force: true }));
  for (const status of ['running', 'paused']) {
    const stateFile = path.join(queueDir, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ accounts: { [ACCOUNT]: { seenAt: new Date(Date.now() - 7200000).toISOString() } }, backfills: { [ACCOUNT]: progress({ status }) } }));
    const driver = makeDriver({ queueDir, stateFile, autoFlushMs: 0, log: () => {}, onAutoBackfill: () => assert.fail('must resume, not replace') });
    driver.handle({ type: 'wa-status', account: ACCOUNT, connected: true });
    assert.deepEqual(driver.handle({ type: 'backfill-ready', account: ACCOUNT }).progress, progress({ status }));
    driver.dispose();
  }
});

test('flush backoff grows after failures, resets after a successful flush', async () => {
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-bo-'));
  let fail = true;
  const driver = makeDriver({
    queueDir, endpoint: 'http://x', autoFlushMs: 50, log: () => {},
    fetchImpl: async () => (fail ? { ok: false, status: 503 } : { ok: true, status: 200 }),
  });
  assert.equal(driver.nextFlushMs(), 50);
  driver.handle({ type: 'messages', account: ACCOUNT, messages: [msg()] }); // a queued file makes rounds actually fail
  await new Promise(r => setTimeout(r, 200)); // a few failing rounds
  assert.ok(driver.nextFlushMs() > 50, `expected backoff growth, got ${driver.nextFlushMs()}`);
  fail = false;
  driver.handle({ type: 'messages', account: ACCOUNT, messages: [msg()] });
  assert.equal(await driver.flushNow(), true);
  assert.equal(driver.nextFlushMs(), 50);
  driver.dispose();
});
