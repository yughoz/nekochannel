'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const settings = require('../shell/settings');
const { makeDriver } = require('../adapters/whatsapp/driver');
const accounts = ['111111@c.us', '222222@c.us'];
const message = id => ({ id, chat: 'Fixture', sender: 'Fixture', text: 'fixture', timestamp: new Date().toISOString(), isGroup: false, fromMe: false });

test('reader defaults on, persists off through existing backup without changing privacy', context => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-reader-settings-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(settings.load(dir).reader, true);
  fs.writeFileSync(settings.file(dir), JSON.stringify({ lang: 'en' }));
  assert.equal(settings.load(dir).reader, true);
  const previous = settings.load(dir);
  settings.save(dir, { ...previous, reader: false });
  const saved = settings.load(dir);
  assert.equal(saved.reader, false);
  assert.deepEqual(saved.privacy, previous.privacy);
  const backups = fs.readdirSync(path.join(dir, 'backup'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'backup', backups[0]))).reader, false);
});

test('off gates every account and backfill, retains durable queues, avoids deliberate-off auto backfill', async context => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-reader-driver-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'state.json');
  const posts = [];
  let automatic = 0;
  const driver = makeDriver({ queueDir: path.join(dir, 'queue'), stateFile, autoFlushMs: 0, log: () => {},
    fetchImpl: async (_url, options) => { posts.push(JSON.parse(options.body)); return { ok: true }; },
    onAutoBackfill: () => automatic++ });
  context.after(() => driver.dispose());
  for (const account of accounts) {
    driver.handle({ type: 'wa-status', account, connected: true });
    assert.equal(driver.handle({ type: 'messages', account, messages: [message(account)] }).stored, true);
  }
  const progress = driver.backfill(accounts[0], 'start');
  assert.equal(progress.maxPerChat, 100);
  assert.equal(driver.backfill(accounts[0], 'pause').status, 'paused');
  assert.equal(driver.backfill(accounts[0], 'start').session, progress.session);
  assert.throws(() => driver.backfill('../bad', 'start'));
  assert.throws(() => driver.setEnabled('false'));
  driver.setEnabled(false);
  const before = fs.readFileSync(stateFile, 'utf8');
  for (const account of accounts) {
    for (const payload of [
      { type: 'messages', messages: [message('blocked')] },
      { type: 'backfill-batch', session: progress.session, messages: [message('blocked')] },
      { type: 'backfill-checkpoint', session: progress.session, progress },
      { type: 'wa-status', connected: true }, { type: 'backfill-ready' },
    ]) assert.equal(driver.handle({ account, ...payload }).stored, false);
  }
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
  assert.equal(driver.status.size, 0);
  assert.throws(() => driver.backfill(accounts[0], 'start'));
  assert.deepEqual(driver.handle({ type: 'reader-state' }), { enabled: false });
  assert.equal(await driver.flushNow(), true);
  assert.equal(posts.length, 2);
  assert.equal(posts.flatMap(post => post.messages).length, 2);
  driver.setEnabled(true);
  for (const account of accounts) driver.handle({ type: 'wa-status', account, connected: true });
  assert.equal(automatic, 2);
  assert.equal(driver.handle({ type: 'messages', account: accounts[0], messages: [message('resumed')] }).stored, true);
  const stale = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  for (const entry of Object.values(stale.accounts)) entry.seenAt = new Date(Date.now() - 7200000).toISOString();
  fs.writeFileSync(stateFile, JSON.stringify(stale));
  const restarted = makeDriver({ enabled: false, stateFile, queueDir: path.join(dir, 'queue'), autoFlushMs: 0, log: () => {}, onAutoBackfill: () => automatic++ });
  context.after(() => restarted.dispose());
  restarted.setEnabled(true);
  for (const account of accounts) restarted.handle({ type: 'wa-status', account, connected: true });
  assert.equal(automatic, 2, 'two hours deliberately OFF must not trigger a new history session');
});
