'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const buildNotif = require('../shell/notify');

const msg = over => ({ id: 'm1', chat: 'Grup Kantor', sender: 'Budi', text: 'halo', timestamp: '2026-11-18T10:00:00.000Z', isGroup: true, fromMe: false, ...over });

test('fromMe / empty text / non-array → null', () => {
  assert.equal(buildNotif([]), null);
  assert.equal(buildNotif(undefined), null);
  assert.equal(buildNotif([msg({ fromMe: true })]), null);
  assert.equal(buildNotif([msg({ text: '   ' })]), null);
  assert.equal(buildNotif([msg(), msg({ fromMe: true })]).account, '');
});

test('single message: title=label, body chat — sender: text', () => {
  const n = buildNotif([msg({ account: '6281@c.us' })], 'Kantor');
  assert.deepEqual(n, { title: 'Kantor', body: 'Grup Kantor — Budi: halo', account: '6281@c.us' });
});

test('title falls back to account then Akun', () => {
  assert.equal(buildNotif([msg({ account: '6281@c.us' })]).title, '6281@c.us');
  assert.equal(buildNotif([msg()]).title, 'Akun');
});

test('long text collapses whitespace and truncates at 80', () => {
  const long = 'x'.repeat(200);
  const n = buildNotif([msg({ text: ` a\n b  ${long} ` })]);
  assert.equal(n.body.length, 'Grup Kantor — Budi: '.length + 81);
  assert.ok(n.body.endsWith('…'));
});

test('multi message coalesces count + unique chats', () => {
  const n = buildNotif([msg(), msg({ id: 'm2', chat: 'Grup Kantor', text: 'lagi' }), msg({ id: 'm3', chat: 'Adik', text: 'ok' })], 'wa-1');
  assert.equal(n.body, '3 pesan baru — Grup Kantor, Adik');
});

test('more than 3 chats gets an ellipsis', () => {
  const batch = [1, 2, 3, 4].map(i => msg({ id: `m${i}`, chat: `c${i}` }));
  assert.equal(buildNotif(batch).body, '4 pesan baru — c1, c2, c3…');
});
