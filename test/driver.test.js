'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeDriver } = require('../adapters/whatsapp/driver');

const msg = overrides => ({
  id: `m-${Math.random().toString(36).slice(2)}`,
  account: '6281234567890@c.us',
  chat: 'Test Chat', sender: 'budi', text: 'halo',
  timestamp: new Date().toISOString(), isGroup: true, fromMe: false,
  ...overrides,
});

function setup() {
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nekochannel-test-'));
  const posts = [];
  const fetchImpl = async (_url, options) => {
    posts.push(JSON.parse(options.body));
    return { ok: true, status: 200 };
  };
  const driver = makeDriver({ queueDir, endpoint: 'http://x', fetchImpl, autoFlushMs: 0, log: () => {} });
  return { queueDir, posts, driver };
}

test('valid messages are queued durably before ack', () => {
  const { queueDir, driver } = setup();
  const r = driver.handle({ type: 'messages', account: '6281234567890@c.us', messages: [msg()] });
  assert.equal(r.stored, true);
  const file = path.join(queueDir, '6281234567890@c.us.jsonl');
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
  driver.dispose();
});

test('invalid messages are rejected', () => {
  const { driver } = setup();
  assert.equal(driver.handle({ type: 'messages', account: '6281234567890@c.us', messages: [{ ...msg(), text: 5 }] }).stored, false);
  assert.equal(driver.handle({ type: 'messages', account: 'not-a-jid', messages: [msg()] }).stored, false);
  assert.equal(driver.handle({ type: 'messages', account: '6281234567890@c.us', messages: [msg({ account: '6298765432109@c.us' })] }).stored, false);
  assert.equal(driver.handle({ type: 'messages', account: '6281234567890@c.us', messages: Array.from({ length: 101 }, () => msg()) }).stored, false);
  driver.dispose();
});

test('flush posts {account,label,messages} and removes the queue file', async () => {
  const { queueDir, posts, driver } = setup();
  driver.handle({ type: 'messages', account: '6281234567890@c.us', messages: [msg(), msg()] });
  assert.equal(await driver.flushNow(), true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].account, '6281234567890@c.us');
  assert.equal(posts[0].label, '');
  assert.equal(posts[0].messages.length, 2);
  assert.equal(fs.readdirSync(queueDir).filter(f => f.endsWith('.jsonl')).length, 0);
  driver.dispose();
});

test('failed flush keeps the data on disk', async () => {
  const { queueDir, driver } = setup();
  driver.handle({ type: 'messages', account: '6281234567890@c.us', messages: [msg()] });
  const failing = makeDriver({
    queueDir, endpoint: 'http://x', autoFlushMs: 0, log: () => {},
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(await failing.flushNow(), false);
  // data must survive somewhere in the queue dir
  const leftovers = fs.readdirSync(queueDir).join(',');
  assert.ok(leftovers.includes('.jsonl') || leftovers.includes('.flushing'), `lost data: ${leftovers}`);
  driver.dispose(); failing.dispose();
});

test('setLabel tags the next flush; renames apply immediately', async () => {
  const { posts, driver } = setup();
  driver.setLabel('6281234567890@c.us', 'wa-1');
  driver.handle({ type: 'messages', account: '6281234567890@c.us', messages: [msg()] });
  await driver.flushNow();
  assert.equal(posts[0].label, 'wa-1');
  driver.setLabel('6281234567890@c.us', 'bisnis'); // PRD: label diedit manual → /ingest
  driver.handle({ type: 'messages', account: '6281234567890@c.us', messages: [msg()] });
  await driver.flushNow();
  assert.equal(posts[1].label, 'bisnis');
  driver.setLabel('not-a-jid', 'x'); // no-op on unparseable account
  driver.dispose();
});

test('batch split respects 100-item cap', async () => {
  const { posts, driver } = setup();
  // content.js/bridge never sends >100 per call; two calls queue 130 items
  driver.handle({ type: 'messages', account: '6281234567890@c.us', messages: Array.from({ length: 100 }, () => msg()) });
  driver.handle({ type: 'messages', account: '6281234567890@c.us', messages: Array.from({ length: 30 }, () => msg()) });
  assert.equal(await driver.flushNow(), true);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].messages.length, 100);
  assert.equal(posts[1].messages.length, 30);
  driver.dispose();
});
