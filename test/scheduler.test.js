'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../shell/scheduler');

const at = iso => Date.parse(iso);
const item = (over = {}) => ({ id: 'j-1', name: 'Rangkum pagi', enabled: true, time: '07:00', account: '', chats: ['Transys'], prompt: '', ...over });

test('dueAt: HH:MM WIB → epoch (UTC+7 tetap), hari mengikuti tanggal WIB', () => {
  assert.equal(new Date(s.dueAt('07:00', at('2026-11-21T03:00:00Z'))).toISOString(), '2026-11-21T00:00:00.000Z');
  // 23:30 UTC tgl 20 = 06:30 WIB tgl 21 → jadwal 07:00 WIB tgl 21
  assert.equal(new Date(s.dueAt('07:00', at('2026-11-20T23:30:00Z'))).toISOString(), '2026-11-21T00:00:00.000Z');
  assert.equal(new Date(s.dueAt('00:05', at('2026-11-21T03:00:00Z'))).toISOString(), '2026-11-20T17:05:00.000Z');
});

test('decide: belum waktunya / run / sudah jalan / missed > 1 jam / defer saat terkunci / OFF', () => {
  const due = at('2026-11-21T00:00:00Z');
  assert.equal(s.decide(item(), {}, due - 60_000), null);
  assert.equal(s.decide(item(), {}, due + 60_000), 'run');
  assert.equal(s.decide(item(), { lastRun: due }, due + 60_000), null);
  assert.equal(s.decide(item(), { lastRun: due - 86_400_000 }, due + 30 * 60_000), 'run'); // kemarin sudah, hari ini belum
  assert.equal(s.decide(item(), {}, due + s.MISSED_AFTER_MS + 1), 'missed');
  assert.equal(s.decide(item(), {}, due + 60_000, { locked: true }), 'defer');
  assert.equal(s.decide(item(), {}, due + s.MISSED_AFTER_MS + 1, { locked: true }), 'missed'); // unlock telat → skip, bukan backlog
  assert.equal(s.decide(item({ enabled: false }), {}, due + 60_000), null);
});

test('validate: patch ketat (waktu, id unik, batas, akun, grup/prompt wajib salah satu)', () => {
  s.validate({ enabled: true, items: [item(), item({ id: 'j-2', chats: [], prompt: 'rangkum unread' })] });
  for (const bad of [
    { enabled: 'ya' }, { foo: 1 }, { items: [item({ time: '7:00' })] }, { items: [item({ time: '24:00' })] },
    { items: [item(), item()] }, { items: [item({ id: 'Bad Id' })] }, { items: [item({ account: 'evil' })] },
    { items: [item({ chats: [], prompt: '  ' })] }, { items: [item({ prompt: 'x'.repeat(2001) })] },
    { items: [item({ extra: 1 })] }, { items: Array.from({ length: 21 }, (_, i) => item({ id: `j-${i}` })) },
  ]) assert.throws(() => s.validate(bad), TypeError, JSON.stringify(bad).slice(0, 60));
});

test('normalize: file rusak/lama → item invalid dibuang, master default OFF', () => {
  assert.deepEqual(s.normalize(null), { enabled: false, items: [] });
  const out = s.normalize({ enabled: 'true', items: [item(), { id: 'x', time: 'bad' }, item(), item({ id: 'j-3', chats: [' Grup A ', ''] , prompt: 'p' })] });
  assert.equal(out.enabled, false);
  assert.deepEqual(out.items.map(i => i.id), ['j-1', 'j-3']);
  assert.deepEqual(out.items[1].chats, ['Grup A']);
});

test('buildPrompt: rangkum grup sejak run sukses terakhir (fallback 24 jam, maks 7 hari) + catatan', () => {
  const now = at('2026-11-21T00:00:00Z');
  const p = s.buildPrompt(item({ chats: ['Transys', 'Keluarga'], prompt: 'fokus soal armada' }), {}, now);
  assert.match(p, /Mode baca-saja/);
  assert.match(p, /since=2026-11-20T00:00:00\.000Z/);
  assert.match(p, /- Transys\n- Keluarga/);
  assert.match(p, /get_chat_messages/);
  assert.match(p, /Catatan tambahan dari pemilik: fokus soal armada/);
  assert.match(s.buildPrompt(item(), { lastSuccess: at('2026-11-20T18:00:00Z') }, now), /since=2026-11-20T18:00:00\.000Z/);
  assert.match(s.buildPrompt(item(), { lastSuccess: at('2026-10-01T00:00:00Z') }, now), /since=2026-11-14T00:00:00\.000Z/);
  const free = s.buildPrompt(item({ chats: [], prompt: 'rangkum chat unread' }), {}, now);
  assert.match(free, /rangkum chat unread$/);
  assert.doesNotMatch(free, /get_chat_messages/);
});

test('newId: format valid untuk validate', () => {
  const id = s.newId(1795238590322, () => 0.5);
  s.validate({ items: [item({ id })] });
});

test('sendSelf: boolean, wajib pilih akun; selfMessage format WhatsApp + judul', () => {
  s.validate({ items: [item({ account: '628111@c.us', sendSelf: true })] });
  assert.throws(() => s.validate({ items: [item({ account: '', sendSelf: true })] }), /account/);
  assert.throws(() => s.validate({ items: [item({ sendSelf: 'ya' })] }), TypeError);
  assert.equal(s.normalize({ items: [item({ account: '628111@c.us', sendSelf: true })] }).items[0].sendSelf, true);
  assert.equal(s.normalize({ items: [item()] }).items[0].sendSelf, false);
  assert.equal(s.selfMessage(item(), '**Grup A**\n- topik **penting**'), '⏰ *Jadwal Agent · Rangkum pagi*\n\n*Grup A*\n- topik *penting*');
});
