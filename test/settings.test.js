'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { load, save, readLlm, writeLlm, DEFAULTS } = require('../shell/settings');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nkc-settings-'));
const writeEnv = (dir, content) => {
  const p = path.join(dir, 'wa.env');
  fs.writeFileSync(p, content);
  return p;
};

test('load: default saat file tidak ada / rusak; save→load roundtrip', () => {
  const dir = tmp();
  assert.deepEqual(load(dir), DEFAULTS);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{bukan json');
  assert.deepEqual(load(dir), DEFAULTS);
  save(dir, { notif: false, lang: 'en', agentDock: true, sidebarCollapsed: true, llm: { url: 'x' } }); // llm memang tidak persist di sini
  assert.deepEqual(load(dir), { notif: false, lang: 'en', agentDock: true, sidebarCollapsed: true, action: { master: false, accounts: {} }, privacy: DEFAULTS.privacy });
  save(dir, { notif: true, lang: 'de' }); // bahasa tak dikenal → id, dock default off
  assert.deepEqual(load(dir), { notif: true, lang: 'id', agentDock: false, sidebarCollapsed: false, action: { master: false, accounts: {} }, privacy: DEFAULTS.privacy });
});

test('sidebarCollapsed (#18): default false; persist true↔false untuk rail collapse', () => {
  const dir = tmp();
  assert.equal(load(dir).sidebarCollapsed, false);
  save(dir, { sidebarCollapsed: true });
  assert.equal(load(dir).sidebarCollapsed, true);
  save(dir, { sidebarCollapsed: false });
  assert.equal(load(dir).sidebarCollapsed, false);
});

const BASE_ENV = [
  '# komentar harus utuh',
  'WEBHOOK_URL=https://wiwi.example/hook',
  'SUMMARY_MODEL_URL=https://old.example/v1',
  'SUMMARY_MODEL_NAME=old-model',
  'SUMMARY_MODEL_KEY=secret-jangan-timpa',
  '',
].join('\n');

test('readLlm: CHAT_MODEL_* + fallback SUMMARY_*; nilai ter-quote dibersihkan', () => {
  const dir = tmp();
  const p = writeEnv(dir, BASE_ENV + 'CHAT_MODEL_URL="https://new.example/v1"\nCHAT_MODEL_KEY=abc\n');
  const llm = readLlm(p);
  assert.equal(llm.url, 'https://new.example/v1');
  assert.equal(llm.name, '');
  assert.equal(llm.keySet, true);
  assert.equal(llm.fbUrl, 'https://old.example/v1');
  assert.equal(llm.fbName, 'old-model');
  const none = readLlm(path.join(dir, 'missing.env'));
  assert.deepEqual(none, { url: '', name: '', keySet: false, fbUrl: '', fbName: '' });
});

test('writeLlm: upsert menambah di akhir, baris lain & urutan utuh; read balik', () => {
  const dir = tmp();
  const p = writeEnv(dir, BASE_ENV);
  writeLlm(p, { url: 'https://baru.example/v1', name: 'baru-model' });
  const text = fs.readFileSync(p, 'utf8');
  assert.ok(text.startsWith('# komentar harus utuh\n'));
  assert.ok(text.includes('WEBHOOK_URL=https://wiwi.example/hook\n'));
  assert.ok(text.includes('SUMMARY_MODEL_KEY=secret-jangan-timpa\n'), 'fallback key jangan tersentuh');
  assert.ok(text.endsWith('CHAT_MODEL_URL=https://baru.example/v1\nCHAT_MODEL_NAME=baru-model\n'));
  const llm = readLlm(p);
  assert.equal(llm.url, 'https://baru.example/v1');
  assert.equal(llm.name, 'baru-model');
  assert.equal(llm.keySet, false);
});

test('writeLlm: replace di tempat; key ditulis; undefined = tidak disentuh', () => {
  const dir = tmp();
  const p = writeEnv(dir, BASE_ENV + 'CHAT_MODEL_URL=https://lama/v1\n');
  writeLlm(p, { url: 'https://baru/v1', key: 'k3y' });
  const text = fs.readFileSync(p, 'utf8');
  assert.ok(!text.includes('https://lama/v1'));
  assert.ok(text.includes('CHAT_MODEL_URL=https://baru/v1\n'));
  assert.ok(text.includes('CHAT_MODEL_KEY=k3y\n'));
  assert.equal(readLlm(p).keySet, true);
});

test('writeLlm: null = hapus baris (reset → fallback .env bawaan)', () => {
  const dir = tmp();
  const p = writeEnv(dir, BASE_ENV + 'CHAT_MODEL_URL=https://baru/v1\nCHAT_MODEL_NAME=m\nCHAT_MODEL_KEY=k\n');
  writeLlm(p, { url: null, name: null, key: null });
  const text = fs.readFileSync(p, 'utf8');
  assert.ok(!text.includes('CHAT_MODEL_'));
  assert.ok(text.includes('SUMMARY_MODEL_KEY=secret-jangan-timpa'));
  assert.equal(readLlm(p).keySet, false);
});

test('writeLlm rejects newline injection without altering config', () => {
  const dir = tmp(); const p = writeEnv(dir, BASE_ENV);
  assert.throws(() => writeLlm(p, { name: 'model\nHOST=0.0.0.0' }), /single-line/);
  assert.equal(fs.readFileSync(p, 'utf8'), BASE_ENV);
});

test('writeLlm: file belum ada → dibuat beserta direktorinya', () => {
  const dir = tmp();
  const p = path.join(dir, 'sub', 'wa.env');
  writeLlm(p, { url: 'https://x/v1' });
  assert.equal(readLlm(p).url, 'https://x/v1');
});
