'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeEngine, pickTarget, rateCheck, sanitizeReply, envLookup, SPACING_MS, MAX_PER_HOUR, MAX_PER_DAY } = require('../shell/action');
const wa = require('../adapters/whatsapp/action');

const ts = () => new Date().toISOString();
const incoming = over => ({ id: 'm1', chat: '6281234567890@c.us', sender: 'Budi', text: 'halo tolong', timestamp: ts(), isGroup: false, fromMe: false, ...over });
const settings = over => ({ action: { master: true, accounts: { '6281@c.us': true }, ...over } });
const mkEngine = (over = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-action-'));
  const envFile = over.envFile || (() => {
    const f = path.join(dir, 'wa.env');
    fs.writeFileSync(f, 'CHAT_MODEL_URL=http://llm.local/v1\nCHAT_MODEL_NAME=neko-test\nCHAT_MODEL_KEY=rhasia\n');
    return f;
  })();
  const sent = [];
  const engine = makeEngine({
    logFile: path.join(dir, 'log.jsonl'),
    settings: over.settings || settings(),
    envFile,
    send: async (account, chat, text) => { sent.push({ account, chat, text }); return { ok: true, title: 'Budi' }; },
    fetchImpl: over.fetchImpl || (async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'Siap, kami cek ya.' } }] }) })),
    busy: over.busy || (() => false),
    timings: { quietMs: 20, busyRetryMs: 10, ...(over.timings || {}) },
    ...over,
  });
  return { engine, sent, dir };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- murni: pickTarget / sanitize / rate ----
test('pickTarget: incoming ber-text valid; fromMe/kosong/stale/group-tanpa-mention ditolak', () => {
  assert.ok(pickTarget([incoming()]));
  assert.equal(pickTarget([incoming({ fromMe: true })]), null);
  assert.equal(pickTarget([incoming({ text: '' })]), null);
  assert.equal(pickTarget([incoming({ timestamp: new Date(Date.now() - 11 * 60000).toISOString() })]), null);
  assert.equal(pickTarget([incoming({ isGroup: true })]), null); // grup harus mentionsMe
  assert.ok(pickTarget([incoming({ isGroup: true, mentionsMe: true })]));
  const batch = [incoming({ fromMe: true, id: 'a' }), incoming({ id: 'b', text: 'akhirnya masuk' })];
  assert.equal(pickTarget(batch).text, 'akhirnya masuk'); // yang TERAKHIR yang dinilai
});

test('sanitizeReply: buang URL/markdown-link, cap 800', () => {
  assert.equal(sanitizeReply('cek [katalog](https://x.co/a) ya'), 'cek katalog ya');
  assert.equal(sanitizeReply('buka https://situs.com/panjang?x=1 dunk'), 'buka dunk');
  assert.equal(sanitizeReply('https://cuma-link.biz'), ''); // balasan cuma link → kosong → skip
  assert.ok(sanitizeReply('  hello  \n\n\n\n world ').startsWith('hello'));
  assert.equal(sanitizeReply('x'.repeat(900)).length, 800);
});

test('rateCheck: spacing, jam, hari', () => {
  const now = Date.now();
  assert.ok(rateCheck({}, now).ok);
  assert.equal(rateCheck({ lastSentAt: now - SPACING_MS + 1000 }, now).reason, 'spacing');
  assert.equal(rateCheck({ sentHour: MAX_PER_HOUR, hour: new Date(now).toISOString().slice(0, 13), day: '', sentDay: 0 }, now).reason, 'jam');
  assert.equal(rateCheck({ sentDay: MAX_PER_DAY, day: new Date(now).toISOString().slice(0, 10) }, now).reason, 'hari');
  assert.ok(rateCheck({ sentHour: 99, hour: 'lama', sentDay: 99, day: 'lama', lastSentAt: 0 }, now).ok); // window baru reset
});

test('envLookup: CHAT_MODEL_* menang, fallback SUMMARY_*, trim slash', () => {
  const f = path.join(os.tmpdir(), `neko-env-${Date.now()}.env`);
  fs.writeFileSync(f, ['SUMMARY_MODEL_URL=http://fb.local/v1/', 'CHAT_MODEL_URL=http://main.local/v1/', 'CHAT_MODEL_KEY=kunci', '# komentar', ''].join('\n'));
  assert.equal(envLookup(f, ['CHAT_MODEL_URL', 'SUMMARY_MODEL_URL']), 'http://main.local/v1');
  assert.equal(envLookup(f, ['CHAT_MODEL_KEY']), 'kunci');
  const f2 = path.join(os.tmpdir(), `neko-env2-${Date.now()}.env`);
  fs.writeFileSync(f2, 'SUMMARY_MODEL_NAME=fb-model\n');
  assert.equal(envLookup(f2, ['CHAT_MODEL_NAME', 'SUMMARY_MODEL_NAME']), 'fb-model');
  assert.equal(envLookup(path.join(os.tmpdir(), 'tak-ada.env'), ['CHAT_MODEL_URL']), '');
});

// ---- engine: gating + loop ----
test('master OFF: tidak ada satu pun action jalan (verifikasi #16 poin 1)', async () => {
  const { engine, sent } = mkEngine({ settings: { action: { master: false, accounts: { '6281@c.us': true } } } });
  engine.onMessages('6281@c.us', [incoming()]);
  assert.equal(engine.snapshot().pending, 0);
  await sleep(60);
  assert.equal(sent.length, 0);
  assert.equal(engine.snapshot().events.filter(e => e.kind !== 'info').length, 0);
});

test('akun OFF → gak ada pending walau master ON', () => {
  const { engine } = mkEngine({ settings: { action: { master: true, accounts: {} } } });
  engine.onMessages('6281@c.us', [incoming()]);
  assert.equal(engine.snapshot().pending, 0);
});

test('ON + auto: LLM dipanggil, send jalan, audit + event tercatat (verifikasi #16 poin 2)', async () => {
  const { engine, sent, dir } = mkEngine();
  engine.onMessages('6281@c.us', [incoming()]);
  assert.equal(engine.snapshot().pending, 1);
  await sleep(120);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'Siap, kami cek ya.');
  const audit = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].result, 'sent');
  assert.equal(audit[0].chat, '6281234567890@c.us');
  assert.equal(engine.snapshot().events.find(e => e.kind === 'sent').text, 'Siap, kami cek ya.');
  // prompt bawa konteks history (role user/assistant)
});

test('LLM prompt: system + history berurutan', async () => {
  let body = null;
  const { engine } = mkEngine({
    fetchImpl: async (url, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }; },
  });
  engine.onMessages('6281@c.us', [incoming({ text: 'sebelumnya' }), incoming({ id: 'm2', fromMe: true, text: 'jawaban lama' }), incoming({ id: 'm3', text: 'pertanyaan terakhir' })]);
  await sleep(120);
  assert.equal(body.messages[0].role, 'system');
  assert.ok(/tanpa tautan/i.test(body.messages[0].content));
  assert.deepEqual(body.messages.slice(1).map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(body.messages.at(-1).content, 'pertanyaan terakhir');
});

test('kill switch (master OFF) membatalkan antrean pending', async () => {
  const { engine, sent } = mkEngine();
  engine.onMessages('6281@c.us', [incoming()]);
  engine.setMaster(false);
  await sleep(120);
  assert.equal(sent.length, 0);
  assert.equal(engine.snapshot().pending, 0);
});

test('setAccount OFF membatalkan pending akun itu saja', async () => {
  const { engine, sent } = mkEngine({ settings: { action: { master: true, accounts: { '6281@c.us': true, '6289@c.us': true } } } });
  engine.onMessages('6281@c.us', [incoming()]);
  engine.onMessages('6289@c.us', [incoming({ chat: '6289@c.us', id: 'x' })]);
  engine.setAccount('6281@c.us', false);
  await sleep(120);
  assert.equal(sent.length, 1); // cuma 6289 yang jalan
  assert.equal(sent[0].account, '6289@c.us');
});

test('view-busy: ditunda berulang, lalu give-up (verifikasi #16 view-busy)', async () => {
  const { engine, sent } = mkEngine({ busy: () => true });
  engine.onMessages('6281@c.us', [incoming()]);
  await sleep(260); // 1 attempt + 5 retry @10ms
  assert.equal(sent.length, 0);
  const kinds = engine.snapshot().events.map(e => e.kind);
  assert.ok(kinds.filter(k => k === 'defer').length >= 5);
  assert.ok(engine.snapshot().events.some(e => e.kind === 'skip' && /aktif/.test(e.detail)));
});

test('busy lalu lega: kirim jalan', async () => {
  let busyNow = true;
  const { engine, sent } = mkEngine({ busy: () => busyNow });
  engine.onMessages('6281@c.us', [incoming()]);
  await sleep(80);
  busyNow = false;
  await sleep(120);
  assert.equal(sent.length, 1);
});

test('LLM gagal → tidak kirim, audit error', async () => {
  const { engine, sent } = mkEngine({ fetchImpl: async () => { throw new Error('boom'); } });
  engine.onMessages('6281@c.us', [incoming()]);
  await sleep(120);
  assert.equal(sent.length, 0);
  const ev = engine.snapshot().events.find(e => e.kind === 'error');
  assert.ok(/LLM gagal/.test(ev.detail));
});

test('balasan LLM kosong setelah sanitasi → skip tanpa kirim', async () => {
  const { engine, sent } = mkEngine({ fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'https://spam.link' } }] }) }) });
  engine.onMessages('6281@c.us', [incoming()]);
  await sleep(120);
  assert.equal(sent.length, 0); // cuma link → habis disapu
});

test('rate limit spacing: kirim kedua beruntun ditahan (verifikasi #16 rate limit)', async () => {
  const { engine, sent } = mkEngine();
  engine.onMessages('6281@c.us', [incoming()]);
  await sleep(120);
  assert.equal(sent.length, 1);
  engine.onMessages('6281@c.us', [incoming({ id: 'm2', text: 'lagi' })]);
  await sleep(120);
  assert.equal(sent.length, 1); // spacing 30s menahan
  assert.ok(engine.snapshot().events.some(e => e.kind === 'skip' && /rate limit/.test(e.detail)));
});

test('config LLM kosong → skip jelas', async () => {
  const { engine, sent } = mkEngine({ envFile: '/nonexistent/.env' });
  engine.onMessages('6281@c.us', [incoming()]);
  await sleep(120);
  assert.equal(sent.length, 0);
  assert.ok(engine.snapshot().events.some(e => e.kind === 'skip' && /LLM kosong/.test(e.detail)));
});

test('enabled resolver: toggle disimpan per id lain (sidebar-id) tetap dihormati', async () => {
  const { engine, sent } = mkEngine({
    enabled: account => account === '6289@c.us', // main.js resolve nomor → id
    settings: { action: { master: true, accounts: {} } },
  });
  engine.onMessages('6281@c.us', [incoming()]);
  engine.onMessages('6289@c.us', [incoming({ chat: '6289@c.us', id: 'x' })]);
  await sleep(120);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].account, '6289@c.us');
});

// ---- adapter WA: script builder + orkestrasi sendReply (wc palsu) ----
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
