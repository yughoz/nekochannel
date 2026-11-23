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
