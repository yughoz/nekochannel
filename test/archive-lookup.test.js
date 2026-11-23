'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createArchiveLookup } = require('../shell/archive-lookup');

test('archive lookup: akun + grup (urut aktivitas, per akun, tanpa chat pribadi), cache, file tidak ada', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-lookup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'wa.sqlite');
  assert.deepEqual(createArchiveLookup(file).snapshot(), { accounts: [], groups: [] });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE messages (account TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, chat TEXT, isGroup INTEGER, timestamp TEXT);
    CREATE TABLE accounts (account TEXT PRIMARY KEY, label TEXT, lastSeen TEXT);`);
  db.prepare('INSERT INTO accounts VALUES (?,?,?)').run('628111@c.us', 'Wawa', null);
  const insert = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)');
  insert.run('628111@c.us', 'a', 'Grup Lama', 1, '2026-11-01T00:00:00Z');
  insert.run('628111@c.us', 'b', 'Grup Baru', 1, '2026-11-20T00:00:00Z');
  insert.run('628111@c.us', 'c', 'Grup Baru', 1, '2026-11-21T00:00:00Z');
  insert.run('628111@c.us', 'd', 'Andi', 0, '2026-11-22T00:00:00Z');
  insert.run('628222@c.us', 'e', 'Grup Lain Akun', 1, '2026-11-19T00:00:00Z');
  db.close();
  let clock = 0;
  const lookup = createArchiveLookup(file, { now: () => clock });
  const snap = lookup.snapshot();
  assert.deepEqual(snap.accounts, [{ account: '628111@c.us', label: 'Wawa' }]);
  assert.deepEqual(snap.groups.map(g => [g.account, g.name, g.messages]), [['628111@c.us', 'Grup Baru', 2], ['628222@c.us', 'Grup Lain Akun', 1], ['628111@c.us', 'Grup Lama', 1]]);
  assert.equal(lookup.snapshot(), snap); // cache 30 dtk
  clock = 31_000;
  assert.notEqual(lookup.snapshot(), snap);
  lookup.close();
});

test('#33 groupMessages: nama PERSIS (bukan parsial), filter akun, rentang, khusus grup, batas + truncated', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-lookup-msg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'wa.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE messages (account TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, chat TEXT, isGroup INTEGER, sender TEXT, text TEXT, timestamp TEXT, fromMe INTEGER, mentionsMe INTEGER, replyToMe INTEGER);
    CREATE TABLE accounts (account TEXT PRIMARY KEY, label TEXT, lastSeen TEXT);`);
  const insert = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 8; i++) insert.run('628111@c.us', `t${i}`, 'Team', 1, 'Budi', `pesan ${i}`, `2026-11-22T0${i}:00:00Z`, 0, i === 7 ? 1 : 0, 0);
  insert.run('628111@c.us', 'x1', 'Team DKI', 1, 'Andi', 'grup lain mirip nama', '2026-11-22T03:30:00Z', 0, 0, 0);
  insert.run('628222@c.us', 'x2', 'Team', 1, 'Cici', 'akun lain', '2026-11-22T03:30:00Z', 0, 0, 0);
  insert.run('628111@c.us', 'x3', 'Team', 0, 'Dodi', 'chat pribadi nama sama', '2026-11-22T03:30:00Z', 0, 0, 0);
  insert.run('628111@c.us', 'x4', 'Team', 1, 'Budi', 'di luar rentang', '2026-11-20T00:00:00Z', 0, 0, 0);
  db.close();
  const lookup = createArchiveLookup(file);
  t.after(() => lookup.close());
  const range = { since: '2026-11-22T00:00:00Z', until: '2026-11-22T23:59:59Z' };
  const all = lookup.groupMessages({ chat: 'Team', account: '628111@c.us', ...range });
  assert.equal(all.total, 8);
  assert.equal(all.truncated, false);
  assert.deepEqual(all.messages.map(m => m.text), Array.from({ length: 8 }, (_, i) => `pesan ${i}`)); // lama → baru, tanpa "Team DKI"/akun lain/chat pribadi
  assert.equal(all.messages[7].mentionsMe, true);
  const anyAccount = lookup.groupMessages({ chat: 'Team', account: '', ...range });
  assert.equal(anyAccount.total, 9); // tanpa filter akun ikut akun 628222
  const capped = lookup.groupMessages({ chat: 'Team', account: '628111@c.us', ...range, limit: 3 });
  assert.deepEqual({ total: capped.total, truncated: capped.truncated, texts: capped.messages.map(m => m.text) }, { total: 8, truncated: true, texts: ['pesan 5', 'pesan 6', 'pesan 7'] });
});
