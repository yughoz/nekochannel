'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScheduleRunner, parseSse } = require('../shell/schedule-runner');

const sse = (...events) => events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const item = (over = {}) => ({ id: 'j-1', name: 'Rangkum pagi', enabled: true, time: '07:00', account: '628111@c.us', chats: ['Transys'], prompt: '', ...over });
const DUE = Date.parse('2026-11-21T00:00:00Z'); // 07:00 WIB

function setup(t, { config = { enabled: true, items: [item()] }, reply = sse(['delta', { text: 'ringkasan grup' }], ['done', { model: 'nekopro', fallback: false }]), locked = false, clock = DUE + 60_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-sched-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = []; const delivered = [];
  const env = { now: clock, locked, config };
  const fetchImpl = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return typeof reply === 'function' ? reply() : { ok: true, status: 200, text: async () => reply }; };
  const runner = createScheduleRunner({
    schedules: () => env.config, stateFile: path.join(dir, 'schedule-state.json'), logFile: path.join(dir, 'schedule-log.jsonl'),
    chatUrl: () => 'http://127.0.0.1:4318', isLocked: () => env.locked, deliver: (it, result) => delivered.push({ id: it.id, result }), fetchImpl, now: () => env.now,
  });
  return { runner, calls, delivered, env, dir };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('parseSse: teks dari delta, model dari done, error terdeteksi', () => {
  assert.deepEqual(parseSse(sse(['tool', { name: 'x' }], ['delta', { text: 'a' }], ['delta', { text: 'b' }], ['done', { model: 'm', fallback: true }])), { text: 'ab', error: '', done: true, model: 'm', fallback: true });
  assert.equal(parseSse(sse(['error', { message: 'Model timeout' }])).error, 'Model timeout');
});

test('tick: jatuh tempo → run readOnly lewat /api/chat, hasil ke deliver + state + log', async t => {
  const { runner, calls, delivered, dir } = setup(t);
  assert.deepEqual(runner.tick(), [['j-1', 'run']]);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:4318/api/chat');
  assert.equal(calls[0].body.readOnly, true);
  assert.equal(calls[0].body.account, '628111@c.us');
  assert.match(calls[0].body.messages[0].content, /Rangkum aktivitas grup[\s\S]*- Transys/);
  assert.deepEqual(delivered.map(d => [d.id, d.result.status, d.result.text]), [['j-1', 'ok', 'ringkasan grup']]);
  const state = runner.state()['j-1'];
  assert.equal(state.lastStatus, 'ok');
  assert.equal(state.lastText, 'ringkasan grup');
  assert.equal(state.lastRun, DUE);
  const log = fs.readFileSync(path.join(dir, 'schedule-log.jsonl'), 'utf8');
  assert.doesNotMatch(log, /ringkasan grup/); // log tanpa isi
  assert.deepEqual(runner.tick(), []); // sudah jalan hari ini
});

test('tick: master OFF → tidak jalan; terkunci → defer; unlock telat > 1 jam → missed (tanpa backlog)', async t => {
  const { runner, calls, env } = setup(t, { locked: true });
  env.config = { ...env.config, enabled: false };
  assert.deepEqual(runner.tick(), []);
  env.config = { ...env.config, enabled: true };
  assert.deepEqual(runner.tick(), [['j-1', 'defer']]);
  env.now = DUE + 61 * 60_000; env.locked = false;
  assert.deepEqual(runner.tick(), [['j-1', 'missed']]);
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(runner.state()['j-1'].lastStatus, 'missed');
  assert.deepEqual(runner.tick(), []);
  assert.equal(runner.runs()[0].status, 'missed');
});

test('gagal: error SSE / http / jawaban kosong → status failed + detail, tetap di-deliver', async t => {
  const { runner, delivered } = setup(t, { reply: sse(['error', { message: 'Primary and fallback models failed' }]) });
  runner.tick(); await settle();
  assert.equal(delivered[0].result.status, 'failed');
  assert.equal(delivered[0].result.detail, 'Primary and fallback models failed');
  assert.equal(runner.state()['j-1'].lastStatus, 'failed');
  const http = setup(t, { reply: () => ({ ok: false, status: 503, text: async () => '' }) });
  http.runner.tick(); await settle();
  assert.equal(http.delivered[0].result.detail, 'agent http 503');
});

test('runNow: manual walau master OFF, jadwal tak dikenal ditolak, terkunci ditolak, run ganda = busy', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { runner, calls, env } = setup(t, { config: { enabled: false, items: [item()] }, reply: async () => { await gate; return { ok: true, status: 200, text: async () => sse(['delta', { text: 'ok' }], ['done', {}]) }; } });
  const first = runner.runNow('j-1');
  assert.deepEqual(await runner.runNow('j-1'), { status: 'busy' });
  release();
  assert.equal((await first).status, 'ok');
  assert.equal(calls.length, 1);
  assert.equal((await runner.runNow('nope')).detail, 'unknown schedule');
  env.locked = true;
  assert.equal((await runner.runNow('j-1')).detail, 'locked');
});

test('state bertahan lintas instance (restart) + prune jadwal yang dihapus', async t => {
  const { runner, dir } = setup(t);
  runner.tick(); await settle();
  const again = createScheduleRunner({ schedules: () => ({ enabled: true, items: [item()] }), stateFile: path.join(dir, 'schedule-state.json'), logFile: path.join(dir, 'schedule-log.jsonl'), chatUrl: () => null, now: () => DUE + 120_000 });
  assert.deepEqual(again.tick(), []); // lastRun tersimpan → tidak jalan dua kali setelah restart
  again.prune([]);
  assert.deepEqual(again.state(), {});
});
