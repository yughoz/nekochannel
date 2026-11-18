'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../shell/accounts');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neko-acc-')), 'accounts.json');

test('load tolerates missing/corrupt file', () => {
  assert.deepEqual(store.load(tmp()), []);
  const bad = tmp();
  fs.writeFileSync(bad, '{oops');
  assert.deepEqual(store.load(bad), []);
});

test('add assigns stable per-channel index + default label, persists', () => {
  const file = tmp();
  const list = [];
  const a1 = store.add(file, list, 'whatsapp', 'wa');
  const a2 = store.add(file, list, 'whatsapp', 'wa');
  assert.deepEqual([a1.n, a2.n], [1, 2]);
  assert.equal(a1.label, 'wa-1');
  assert.equal(a2.label, 'wa-2');
  assert.deepEqual(store.load(file), [
    { channel: 'whatsapp', n: 1, label: 'wa-1' },
    { channel: 'whatsapp', n: 2, label: 'wa-2' },
  ]);
});

test('nextIndex skips used indexes per channel, no cross-channel bleed', () => {
  const list = [
    { channel: 'whatsapp', n: 1, label: 'wa-1' },
    { channel: 'whatsapp', n: 3, label: 'wa-3' },
    { channel: 'email', n: 1, label: 'em-1' },
  ];
  assert.equal(store.nextIndex(list, 'whatsapp'), 2);
  assert.equal(store.nextIndex(list, 'email'), 2);
  assert.equal(store.nextIndex([], 'whatsapp'), 1);
});
