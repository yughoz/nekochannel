'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// shell/agent aman di-require di luar Electron: require('electron') cuma
// menghasilkan path binary, dan createAgentView tidak dipanggil di sini.
const { nextStep, errorPage, AGENT_URL } = require('../shell/agent');

test('agent state machine: poll → aksi', () => {
  assert.equal(nextStep(true, false), 'load-chat'); // server hidup, belum tampil
  assert.equal(nextStep(true, true), 'idle'); // hidup & tampil
  assert.equal(nextStep(false, true), 'show-error'); // mati saat tampil → fallback
  assert.equal(nextStep(false, false), 'idle'); // fallback sudah tampil, tunggu poll
});

test('error page: sebut URL chat + tombol retry, tanpa resource eksternal', () => {
  const raw = errorPage('http://127.0.0.1:4318');
  assert.ok(raw.startsWith('data:text/html;charset=utf-8,'));
  const page = decodeURIComponent(raw.replace(/^data:text\/html;charset=utf-8,/, ''));
  assert.ok(page.includes('http://127.0.0.1:4318'));
  assert.ok(page.includes('Retry'));
  assert.ok(!/src=|href=/.test(page), 'halaman error statis: tidak ada resource eksternal');
  assert.equal(AGENT_URL, 'http://127.0.0.1:4318');
});

test('error page mengikuti bahasa settings (#10)', () => {
  const id = decodeURIComponent(errorPage('http://x', 'id').replace(/^data:text\/html;charset=utf-8,/, ''));
  const en = decodeURIComponent(errorPage('http://x', 'en').replace(/^data:text\/html;charset=utf-8,/, ''));
  assert.ok(id.includes('belum jalan'));
  assert.ok(en.includes('not running'));
  assert.equal(errorPage('http://x'), errorPage('http://x', 'id')); // default tetap id
});
