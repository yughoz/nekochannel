'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// app.js dijalankan via vm TANPA DOM: guard `typeof document` melewati wiring
// browser, objek chatUI tetap diekspor ke global sandbox (pola background.test.js).
const chatUI = (() => {
  const code = fs.readFileSync(path.join(__dirname, 'ui', 'app.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.chatUI;
})();

test('escapeHtml melindungi semua entitas berbahaya', () => {
  assert.equal(chatUI.escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(chatUI.escapeHtml("a & b 'c'"), 'a &amp; b &#39;c&#39;');
});

test('renderRich: escape dulu, baru markdown-lite', () => {
  const html = chatUI.renderRich('<script>alert(1)</script>\n**tebal** dan `kode`\n- item satu\n- item dua\nteks biasa');
  assert.ok(!html.includes('<script'), 'tag script harus ter-escape');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('<strong>tebal</strong>'));
  assert.ok(html.includes('<code>kode</code>'));
  assert.ok(html.includes('<ul><li>item satu</li><li>item dua</li></ul>'), 'bullet berurutan = satu <ul>');
  assert.ok(html.includes('<div>teks biasa</div>'));
});

test('renderRich: injeksi atribut tidak pernah jadi tag hidup', () => {
  const html = chatUI.renderRich('<img src=x onerror=alert(1)> **x**');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('sseParser: chunk terpotong antar-batas tetap ter-parse', () => {
  const parse = chatUI.sseParser();
  assert.equal(parse('event: tool\nda').length, 0);
  const events = parse('ta: {"name":"search_messages","summary":3}\n\nevent: delta\ndata: {"text":"hai"}\n\n');
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'tool');
  assert.equal(events[0].data.name, 'search_messages');
  assert.equal(events[0].data.summary, 3);
  assert.equal(events[1].event, 'delta');
  assert.equal(events[1].data.text, 'hai');
});

test('sseParser: data non-JSON dibiarkan mentah', () => {
  const events = chatUI.sseParser()('event: done\ndata: ping\n\n');
  assert.equal(events[0].event, 'done');
  assert.equal(events[0].data, 'ping');
});

test('formatArgs: JSON valid di-pretty, string terpotong dibiarkan', () => {
  assert.equal(chatUI.formatArgs('{"query":"x","limit":5}'), '{\n  "query": "x",\n  "limit": 5\n}');
  const clipped = '{"query":"kata panjang",…';
  assert.equal(chatUI.formatArgs(clipped), clipped);
  assert.equal(chatUI.formatArgs({ a: 1 }), '{\n  "a": 1\n}');
});
