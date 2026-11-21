'use strict';
// Primitive kirim WhatsApp (adapters/whatsapp/action.js) yang dipakai tool
// send_message: script builder + orkestrasi sendReply dengan wc palsu.
const { test } = require('node:test');
const assert = require('node:assert');
const wa = require('../adapters/whatsapp/action');

test('findRowScript: builder murni, selector + jid aman, tanpa variabel bocor', () => {
  const s = wa.findRowScript("62812@c.us'");
  assert.ok(s.includes('[data-testid="chat-list"]'));
  assert.ok(s.includes(JSON.stringify("62812@c.us'")));
  assert.ok(!/"62812@c\.us'"/.test(s.slice(s.indexOf('const JID') + 20))); // bukan interpolasi mentah
  assert.ok(s.includes('cell-frame-title') && s.includes('gridcell'));
});

test('sendReply happy path: klik trusted → verifikasi → insertText → Enter → compose kosong', async () => {
  const calls = []; const evals = [];
  const wc = {
    isDestroyed: () => false,
    executeJavaScript: async expr => { evals.push(expr); const v = evals.length; return v === 1
      ? { x: 100, y: 50, title: 'Budi', strategy: 'name', name: 'Budi' }
      : v === 2 ? { open: true, title: 'Budi', match: true, composeRect: { x: 300, y: 700 } }
      : v === 3 ? { found: true, t: 1 }
      : { composeText: '', sendRect: null }; },
    sendInputEvent: ev => calls.push(['input', ev.type, ev.x ?? ev.keyCode]),
    insertText: t => calls.push(['insert', t]),
  };
  const r = await wa.sendReply(wc, '62812@c.us', 'Siap ya', () => {});
  assert.deepEqual(r, { ok: true, title: 'Budi', strategy: 'name' });
  assert.deepEqual(calls[0], ['input', 'mouseDown', 100]);
  assert.ok(calls.some(c => c[0] === 'input' && c[1] === 'mouseUp'));
  assert.ok(calls.some(c => c[0] === 'insert' && c[1] === 'Siap ya'));
  assert.ok(calls.some(c => c[0] === 'input' && c[1] === 'keyDown' && c[2] === 'Enter'));
  assert.equal(evals.length, 3); // find → open → verify koleksi
});

test('sendReply: view di-zoom → titik CSS px diskala ke DIP sebelum sendInputEvent', async () => {
  const downs = []; let n = 0;
  const wc = {
    isDestroyed: () => false,
    getZoomFactor: () => 0.5,
    executeJavaScript: async () => { n += 1; return n === 1
      ? { x: 100, y: 50, title: 'Budi', strategy: 'name', name: 'Budi' }
      : n === 2 ? { open: true, title: 'Budi', match: true, composeRect: { x: 300, y: 700 } }
      : { found: true, t: 1 }; },
    sendInputEvent: ev => { if (ev.type === 'mouseDown') downs.push([ev.x, ev.y]); },
    insertText: () => {},
  };
  await wa.sendReply(wc, '62812@c.us', 'Siap ya', () => {});
  assert.deepEqual(downs, [[50, 25], [150, 350]]); // baris lalu compose, keduanya × 0.5
});

test('sendReply: baris tidak ketemu → gagal tanpa sentuh input', async () => {
  const calls = [];
  const wc = { isDestroyed: () => false, executeJavaScript: async () => null, sendInputEvent: ev => calls.push(ev), insertText: () => calls.push({}) };
  const r = await wa.sendReply(wc, '62812@c.us', 'x');
  assert.equal(r.stage, 'find-row');
  assert.equal(calls.length, 0);
});

test('sendReply: chat salah kebuka → Esc + gagal (pemicu: verifikasi judul)', async () => {
  const calls = [];
  const wc = { isDestroyed: () => false,
    executeJavaScript: async () => null,
    sendInputEvent: ev => calls.push(ev.type === 'keyDown' ? ev.keyCode : ev.type),
    insertText: () => {} };
  // panggilan: find → null lalu? kita maukan verify mismatch lewat override urutan
  let n = 0;
  wc.executeJavaScript = async () => (++n === 1 ? { x: 1, y: 2, title: 'Budi', strategy: 'name' } : { open: true, title: 'Orang Lain', match: false, composeRect: null });
  const r = await wa.sendReply(wc, '62812@c.us', 'x');
  assert.equal(r.stage, 'verify-chat');
  assert.ok(calls.includes('Escape'));
  assert.ok(!calls.includes('keyDown')); // tidak pernah sampai Enter
});

test('sendReply: Enter gagal → fallback tombol Send', async () => {
  const calls = []; let n = 0;
  const wc = { isDestroyed: () => false,
    executeJavaScript: async () => (++n === 1 ? { x: 5, y: 6, title: 'Budi', strategy: 'digits' }
      : n === 2 ? { open: true, title: 'Budi', match: true, composeRect: { x: 1, y: 2 } }
      : n >= 3 && n <= 4 ? { found: false, t: 0 } // Enter: verify belum muncul (2 percobaan)
      : n === 5 ? { composeText: 'belum terkirim', sendRect: { x: 9, y: 9 } }
      : { found: true, t: 2 }), // pasca klik Send: terkonfirmasi
    sendInputEvent: ev => calls.push(ev.type),
    insertText: () => {} };
  const r = await wa.sendReply(wc, '62812@c.us', 'x');
  assert.equal(r.ok, true);
  const downs = calls.filter(t => t === 'mouseDown').length;
  assert.equal(downs, 3); // baris + compose + tombol Send
});

test('sendReply: kirim tak terkonfirmasi di koleksi → gagal (bukan compose-kosong palsu)', async () => {
  const calls = []; let n = 0;
  const wc = { isDestroyed: () => false,
    executeJavaScript: async () => (++n === 1 ? { x: 5, y: 6, title: 'Budi', strategy: 'name' }
      : n === 2 ? { open: true, title: 'Budi', match: true, composeRect: { x: 1, y: 2 } }
      : n >= 3 && n <= 4 ? { found: false, t: 0 }
      : n === 5 ? { composeText: '', sendRect: { x: 9, y: 9 } }
      : { found: false, t: 0 }),
    sendInputEvent: ev => calls.push(ev.type === 'keyDown' ? ev.keyCode : ev.type),
    insertText: () => {} };
  const r = await wa.sendReply(wc, '62812@c.us', 'x');
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'verify-send');
  assert.ok(calls.includes('Escape'));
});

test('sendReply: view hancur → stage view', async () => {
  const r = await wa.sendReply(null, 'x', 'y');
  assert.equal(r.stage, 'view');
});
