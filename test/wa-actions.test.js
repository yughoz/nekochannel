'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateActionEnvelope, rateAction, ACTIONS } = require('../adapters/whatsapp/action.js');

test('wa action validator: envelope + per-action requirements', () => {
  assert.deepEqual(validateActionEnvelope({ action: 'typing', chat: 'Budi', source: 'mcp' }),
    { action: 'typing', chat: 'Budi', account: undefined, source: 'mcp' });
  assert.deepEqual(validateActionEnvelope({ action: 'react', chat: 'Budi', emoji: ' 👍 ', msgId: ' ABC ' }),
    { action: 'react', chat: 'Budi', account: undefined, source: 'unknown', emoji: '👍', msgId: 'ABC' });
  const attach = validateActionEnvelope({ action: 'sendImage', chat: 'Budi', file: '/tmp/a.png', caption: ' c ' });
  assert.equal(attach.file, '/tmp/a.png');
  assert.equal(attach.caption, ' c ');
  assert.throws(() => validateActionEnvelope(null), /invalid action envelope/);
  assert.throws(() => validateActionEnvelope({ action: 'nope', chat: 'x' }), /unknown action/);
  assert.throws(() => validateActionEnvelope({ action: 'typing', chat: '' }), /chat is required/);
  assert.throws(() => validateActionEnvelope({ action: 'typing', chat: 'x', extra: 1 }), /unexpected keys/);
  assert.throws(() => validateActionEnvelope({ action: 'send', chat: 'x' }), /text is required/);
  assert.throws(() => validateActionEnvelope({ action: 'send', chat: 'x', text: 'x'.repeat(2001) }), /at most 2000/);
  assert.throws(() => validateActionEnvelope({ action: 'react', chat: 'x' }), /emoji is required/);
  assert.throws(() => validateActionEnvelope({ action: 'react', chat: 'x', emoji: '👍' }), /msgId is required/);
  assert.throws(() => validateActionEnvelope({ action: 'pin', chat: 'x', msgId: ' ' }), /msgId is required/);
  assert.throws(() => validateActionEnvelope({ action: 'sendFile', chat: 'x', file: 'tmp/a.png' }), /absolute local path/);
  assert.throws(() => validateActionEnvelope({ action: 'react', chat: 'x', emoji: '👍'.repeat(20), msgId: 'm' }), /too long/);
  assert.equal(ACTIONS.has('typingStop'), true);
});

test('wa action rate limit: spacing, hour/day rollover per account bucket', () => {
  const t0 = Date.parse('2026-11-20T01:00:00.000Z');
  const m = new Map();
  assert.equal(rateAction(m, 'acc', t0).ok, true);
  assert.equal(rateAction(m, 'acc', t0 + 29_999).ok, false);
  assert.equal(rateAction(m, 'acc', t0 + 30_000).ok, true);
  assert.deepEqual([...m.values()][0], { last: t0 + 30_000, hour: '2026-11-20T01', hourCount: 2, day: '2026-11-20', dayCount: 2 });
  const c = [...m.values()][0];
  for (let i = c.hourCount; i < 20; i++) assert.equal(rateAction(m, 'acc', t0 + 60_000 + i * 31_000).ok, true);
  assert.equal(rateAction(m, 'acc', t0 + 60_000 + 31_000 * 20).ok, false);
  const m2 = new Map();
  assert.equal(rateAction(m2, 'acc', t0).ok, true);
  const c2 = m2.get('acc');
  c2.hour = '2026-11-20T01'; c2.hourCount = 20; c2.day = '2026-11-20'; c2.dayCount = 20;
  assert.equal(rateAction(m2, 'acc', t0 + 60_000).ok, false);
  c2.hourCount = 19; c2.dayCount = 100;
  assert.equal(rateAction(m2, 'acc', t0 + 120_000).ok, false, 'day limit harus tetap memblokir');
  c2.dayCount = 20;
  assert.equal(rateAction(m2, 'acc', t0 + 3_600_000).ok, true);
  assert.equal(c2.hourCount, 1);
  assert.equal(c2.dayCount, 21);
  c2.dayCount = 100;
  assert.equal(rateAction(m2, 'acc', t0 + 86_400_000).ok, true);
  assert.equal(c2.dayCount, 1);
  assert.equal(rateAction(m2, 'other', t0).ok, true);
});
