'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createActions, MAX_FILE_BYTES, SEND_TYPES } = require('../shell/wa-actions');

function fixture(context, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-action-test-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const accounts = [1, 2].map(number => ({ id: `whatsapp-${number}`, account: `${number}11111@c.us`, status: { state: 'connected' } }));
  // Sama dengan gate di main.js: saklar aksi chat; kirim konten baru juga butuh saklar kirim.
  const settings = { actionsEnabled: true, sendEnabled: true };
  const gate = target => !settings.actionsEnabled ? 'actions OFF' : SEND_TYPES.has(target.action) && !settings.sendEnabled ? 'send OFF' : null;
  const calls = [];
  let clock = Date.parse('2026-11-20T01:00:00Z');
  const run = createActions({ accounts: () => accounts, gate, trustedEvent: event => event.trusted === true,
    perform: async (account, target) => { calls.push({ account, target }); return { ok: true, verified: false }; },
    logFile: path.join(dir, 'action-log.jsonl'), now: () => clock, ...overrides });
  const input = { action: 'reply', chat: 'Fixture', chatJid: '99999@c.us', accountId: accounts[0].id, msgId: 'false_99999@c.us_A', text: 'secret body' };
  return { dir, accounts, settings, calls, run, input, advance: milliseconds => { clock += milliseconds; } };
}

test('wa actions: Settings gates (aksi + kirim untuk reply/file), IPC sender and account validation', async context => {
  const state = fixture(context);
  const { run, input, settings, calls } = state;
  settings.actionsEnabled = false;
  assert.deepEqual(await run(input), { status: 'disabled', detail: 'actions OFF' });
  settings.actionsEnabled = true;
  settings.sendEnabled = false;
  assert.deepEqual(await run(input), { status: 'disabled', detail: 'send OFF' }); // reply = kirim konten baru
  assert.match((await run({ ...input, action: 'send' })).detail, /send_message/); // teks biasa bukan jalur ini
  settings.sendEnabled = true;
  assert.match((await run(input, { trusted: false })).detail, /untrusted/);
  assert.match((await run({ ...input, accountId: undefined }, { trusted: true })).detail, /accountId is required/);
  assert.match((await run({ ...input, accountId: 'unknown' })).detail, /unknown/);
  assert.match((await run({ ...input, account: 'wrong' })).detail, /mismatch/);
  assert.match((await run({ ...input, chatJid: 'bad' })).detail, /chatJid/);
  assert.equal(calls.length, 0);
  assert.equal((await run(input, { trusted: true })).status, 'ok');
  assert.equal((await run(input)).status, 'failed');
  assert.match((await run(input)).detail, /rate limited/);
  const audit = fs.readFileSync(path.join(state.dir, 'action-log.jsonl'), 'utf8');
  assert.doesNotMatch(audit, /secret body/);
  assert.deepEqual(audit.trim().split('\n').map(line => JSON.parse(line).result), ['attempt', 'dispatched']);
});

test('manual actions: cancellation, lock/disconnect and permission recheck', async context => {
  let allow = false, blocked = false, onConfirm = () => {};
  const state = fixture(context, { locked: () => blocked, confirm: async () => { onConfirm(); return allow; } });
  assert.equal((await state.run(state.input)).status, 'cancelled');
  allow = true;
  blocked = true;
  assert.match((await state.run(state.input)).detail, /locked/);
  blocked = false;
  state.accounts[0].status.state = 'disconnected';
  assert.match((await state.run(state.input)).detail, /disconnected/);
  state.accounts[0].status.state = 'connected';
  onConfirm = () => { state.settings.actionsEnabled = false; };
  assert.match((await state.run(state.input)).detail, /changed/);
  state.settings.actionsEnabled = true;
  onConfirm = () => {};
  assert.equal((await state.run(state.input)).status, 'ok', 'denials do not spend rate budget');
});

test('wa actions: per-account rate, one action at a time and typing cleanup', async context => {
  let release = null;
  const state = fixture(context, { perform: async () => release ? new Promise(resolve => { const done = release; release = null; done(resolve); }) : { ok: true, verified: false } });
  const { run, input } = state;
  assert.equal((await run({ ...input, action: 'typing' })).status, 'ok');
  assert.equal((await run({ ...input, action: 'typingStop' })).status, 'ok'); // stop yang dilacak tidak makan kuota
  assert.match((await run(input)).detail, /rate limited/);
  assert.equal((await run({ ...input, accountId: 'whatsapp-2' })).status, 'ok'); // kuota per akun
  state.advance(30_000);
  let finish;
  release = resolve => { finish = resolve; };
  const running = run(input);
  await new Promise(resolve => setImmediate(resolve));
  assert.match((await run({ ...input, accountId: 'whatsapp-2' })).detail, /in progress/);
  finish({ ok: true, verified: false });
  assert.equal((await running).status, 'ok');
});

test('manual actions: attachment boundaries and sanitized failure audit', async context => {
  const state = fixture(context);
  const file = path.join(state.dir, 'upload.png');
  const input = { ...state.input, action: 'sendImage', file };
  assert.equal((await state.run(input)).status, 'failed');
  fs.writeFileSync(file, '');
  assert.match((await state.run(input)).detail, /nonempty/);
  fs.writeFileSync(file, 'png');
  fs.truncateSync(file, MAX_FILE_BYTES + 1);
  assert.match((await state.run(input)).detail, /16 MiB/);
  fs.writeFileSync(file, 'png');
  assert.equal((await state.run({ ...input, file: state.dir })).status, 'failed');
  const unsupported = path.join(state.dir, 'file.txt');
  fs.writeFileSync(unsupported, 'text');
  assert.match((await state.run({ ...input, file: unsupported })).detail, /extension/);
  assert.equal((await state.run(input)).status, 'ok');
  assert.deepEqual(state.calls[0].target.file, { name: 'upload.png', mime: 'image/png', data: Buffer.from('png').toString('base64') });
  const failure = fixture(context, { perform: async () => { throw new Error('private text'); } });
  assert.equal((await failure.run(failure.input)).status, 'failed');
  const audit = fs.readFileSync(path.join(failure.dir, 'action-log.jsonl'), 'utf8');
  assert.doesNotMatch(audit, /private text/);
  assert.equal(JSON.parse(audit.trim().split('\n').at(-1)).result, 'failed');
});
