'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { STR, t } = require('../shell/i18n');

test('id & en punya kumpulan kunci yang sama persis', () => {
  assert.deepEqual(Object.keys(STR.en).sort(), Object.keys(STR.id).sort());
});

test('t: locale dikenal, fallback en→id→kunci', () => {
  assert.equal(t('id', 'addAccount'), STR.id.addAccount);
  assert.equal(t('en', 'addAccount'), STR.en.addAccount);
  assert.equal(t('xx', 'addAccount'), STR.id.addAccount); // locale tak dikenal → id
  assert.equal(t('en', 'kunciNgawur'), 'kunciNgawur'); // kunci tak dikenal → kunci
  assert.notEqual(t('id', 'addAccount'), t('en', 'addAccount')); // beda bahasa beda copy
});
