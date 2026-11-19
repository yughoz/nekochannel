'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { items, filter } = require('../shell/switcher');

const accs = [
  { id: 'wa-1', label: 'Kantor', channel: 'whatsapp', icon: '🏢' },
  { id: 'wa-2', label: 'Pribadi', channel: 'whatsapp' },
];

test('items: akun mengikuti urutan sidebar + Agent paling akhir', () => {
  const all = items(accs);
  assert.deepEqual(all.map(x => x.id), ['wa-1', 'wa-2', 'agent', 'settings']);
  assert.equal(all[2].type, 'agent');
  assert.equal(all[3].type, 'settings');
});

test('items: icon lolos kalau ada, null kalau tidak (#15 siap)', () => {
  const all = items(accs);
  assert.equal(all[0].icon, '🏢');
  assert.equal(all[1].icon, null);
});

test('filter: substring case-insensitive di label', () => {
  assert.deepEqual(filter(items(accs), 'KANT').map(x => x.id), ['wa-1']);
});

test('filter: channel ikut dicocokkan', () => {
  assert.deepEqual(filter(items(accs), 'whats').map(x => x.id), ['wa-1', 'wa-2']);
  assert.deepEqual(filter(items(accs), '  agent ').map(x => x.id), ['agent']);
  assert.deepEqual(filter(items(accs), 'pengaturan').map(x => x.id), ['settings']);
});

test('filter: tanpa query = semua, urutan tetap', () => {
  assert.deepEqual(filter(items(accs), '').map(x => x.id), ['wa-1', 'wa-2', 'agent', 'settings']);
  assert.deepEqual(filter(items(accs), null).length, 4);
});

test('filter: tanpa hasil = array kosong', () => {
  assert.deepEqual(filter(items(accs), 'gmail'), []);
});
