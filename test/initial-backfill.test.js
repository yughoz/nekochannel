'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { makeDriver } = require('../adapters/whatsapp/driver');
const source = fs.readFileSync(path.join(__dirname, '../adapters/whatsapp/vendor/page-main.bundle.js'), 'utf8');
const account = '111111@c.us';
const raw = number => ({ id: `msg-${number}`, body: 'fixture', t: 1795080000 + number, from: '99999@c.us' });
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (check()) return;
    await pause();
  }
  assert.fail('fixture did not complete');
}
function fixture(context, chats, stateFile) {
  const dir = stateFile ? path.dirname(stateFile) : fs.mkdtempSync(path.join(os.tmpdir(), 'neko-initial-page-'));
  if (!stateFile) context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = new EventTarget();
  const timers = new Set();
  const batches = [];
  const live = [];
  const commands = [];
  const intervals = [];
  const dispatch = (type, detail) => events.dispatchEvent(new sandbox.CustomEvent(type, { detail }));
  const driver = makeDriver({ queueDir: path.join(dir, 'queue'), stateFile: path.join(dir, 'state.json'), autoFlushMs: 0, log() {},
    onAutoBackfill: (_account, progress) => { commands.push(progress.session); dispatch('wa-reader-backfill-command', { action: 'start', progress }); } });
  const sandbox = { console, Event,
    CustomEvent: class extends Event { constructor(type, options) { super(type); this.detail = options?.detail; } },
    addEventListener: events.addEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
    setTimeout(callback, delay) { const timer = setTimeout(callback, delay < 30000 ? 1 : delay); timers.add(timer); return timer; },
    clearTimeout, setInterval(callback) { intervals.push(callback); },
    Store: { Conn: { wid: account }, Chat: { models: chats, on() {}, get: id => chats.find(chat => chat.id === id) } } };
  sandbox.window = sandbox;
  events.addEventListener('wa-reader-status', event => driver.handle({ type: 'wa-status', ...event.detail }));
  events.addEventListener('wa-reader-message', event => {
    live.push(event.detail);
    driver.handle({ type: 'messages', account, messages: [event.detail] });
  });
  events.addEventListener('wa-reader-backfill-request', event => {
    const request = event.detail;
    if (request.kind === 'batch') batches.push(...request.messages);
    const response = driver.handle({ type: request.kind === 'batch' ? 'backfill-batch' : 'backfill-checkpoint', ...request });
    queueMicrotask(() => dispatch('wa-reader-backfill-response', { ...response, requestId: request.requestId }));
  });
  const dispose = () => { for (const timer of timers) clearTimeout(timer); driver.dispose(); };
  context.after(dispose);
  vm.runInNewContext(source, sandbox);
  const progress = () => driver.handle({ type: 'backfill-ready', account }).progress;
  const resume = () => dispatch('wa-reader-backfill-command', { action: 'start', progress: progress() });
  resume();
  return { driver, batches, live, commands, dispatch, progress, resume, dispose, dir, scan: () => intervals[0]() };
}

test('initial scan takes newest 100 from shuffled cache without loading older history; live stays unrestricted', async context => {
  let additions;
  let loads = 0;
  const messages = Array.from({ length: 180 }, (_, index) => raw((index * 37) % 180));
  const chat = { id: '99999@c.us', msgs: { models: messages, on(_event, handler) { additions = handler; } }, loadEarlierMsgs() { loads++; return []; } };
  const page = fixture(context, [chat]);
  await until(() => page.progress()?.status === 'done');
  assert.deepEqual(page.batches.map(message => message.id), Array.from({ length: 100 }, (_, index) => `msg-${179 - index}`));
  assert.equal(loads, 0);
  assert.equal(page.progress().messageCount, 100);
  const finished = page.progress();
  for (let repeat = 0; repeat < 5; repeat++) { page.scan(); page.resume(); }
  await pause();
  assert.equal(page.commands.length, 1);
  assert.equal(page.batches.length, 100);
  assert.deepEqual(page.progress(), finished);
  const before = page.live.length;
  for (let index = 180; index < 310; index++) additions(raw(index));
  assert.equal(page.live.length - before, 130);
});

test('short histories finish on exhaustion, unchanged loaders and cached-only chats', async context => {
  let loads = 0;
  const page = fixture(context, [
    { id: '99999@c.us', msgs: { models: [raw(9), raw(10)] }, loadEarlierMsgs() { loads++; return loads === 1 ? [raw(8), raw(7)] : []; } },
    { id: '88888@c.us', msgs: { models: [raw(20)] }, loadEarlierMsgs() { return { messages: [raw(20)] }; } },
    { id: '77777@c.us', msgs: { models: [raw(30)] } },
  ]);
  await until(() => page.progress()?.status === 'done');
  assert.equal(page.progress().messageCount, 6);
  assert.equal(page.progress().chatIndex, 3);
  assert.equal(loads, 2);
  assert.deepEqual(page.batches.map(message => message.id), ['msg-10', 'msg-9', 'msg-8', 'msg-7', 'msg-20', 'msg-30']);
});

test('initial loader caps oversized older pages at latest 100; OFF/ON resumes the same in-flight walk', async context => {
  let finish;
  let loads = 0;
  const page = fixture(context, [{ id: '99999@c.us', msgs: { models: [raw(200)] }, loadEarlierMsgs() { loads++; return new Promise(resolve => { finish = resolve; }); } }]);
  await until(() => finish);
  const session = page.progress().session;
  page.driver.setEnabled(false);
  page.dispatch('neko-reader-control', { enabled: false });
  finish(Array.from({ length: 200 }, (_, index) => raw(index)));
  await pause();
  assert.equal(page.batches.length, 1);
  page.driver.setEnabled(true);
  page.dispatch('neko-reader-control', { enabled: true });
  page.resume();
  page.resume();
  await until(() => page.progress()?.status === 'done');
  assert.equal(page.progress().session, session);
  assert.equal(loads, 1);
  assert.equal(page.commands.length, 1);
  assert.deepEqual(page.batches.map(message => message.id), ['msg-200', ...Array.from({ length: 99 }, (_, index) => `msg-${199 - index}`)]);
});

test('page restart resumes durable partial progress, preserving queue and session', async context => {
  const first = fixture(context, [{ id: '99999@c.us', msgs: { models: [raw(10)] }, loadEarlierMsgs() { return new Promise(() => {}); } }]);
  await until(() => first.progress()?.current?.ids.length === 1);
  const session = first.progress().session;
  first.dispose();
  const second = fixture(context, [{ id: '99999@c.us', msgs: { models: [raw(10)] }, loadEarlierMsgs() { return [raw(9)]; } }], path.join(first.dir, 'state.json'));
  await until(() => second.progress()?.status === 'done');
  assert.equal(second.progress().session, session);
  assert.equal(second.commands.length, 0);
  assert.equal(second.progress().messageCount, 2);
  const rows = fs.readFileSync(path.join(first.dir, 'queue', `${account}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(row => row.id === 'msg-10'));
  assert.ok(rows.some(row => row.id === 'msg-9'));
  assert.deepEqual(second.batches.map(message => message.id), ['msg-9']);
});
