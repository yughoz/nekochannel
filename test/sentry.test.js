'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const integrations = require('../shell/integrations');
const sentry = require('../shell/sentry');

const encryption = () => ({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => undefined,
  encryptString: value => Buffer.from(`b64:${Buffer.from(value).toString('base64')}`),
  decryptString: value => {
    const text = value.toString();
    assert.match(text, /^b64:/);
    return Buffer.from(text.slice(4), 'base64').toString();
  },
});

test('sentry DSN round-trips encrypted with write-only public state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-sentry-store-'));
  const dsn = 'https://fixturepublic@o123.ingest.sentry.io/456';
  try {
    const store = integrations.openStore(dir, encryption());
    store.save({ sentry: { dsn } });
    const config = store.get();
    const pub = store.public();
    assert.equal(config.sentry.dsn, dsn);
    assert.equal(pub.sentry.dsn, undefined);
    assert.equal(pub.sentry.dsnSet, true);
    assert.equal(fs.readFileSync(path.join(dir, 'integrations.enc')).includes(dsn), false);
    assert.equal(fs.statSync(path.join(dir, 'integrations.enc')).mode & 0o777, 0o600);
        assert.equal(store.get().sentry.dsn, dsn);
    store.save({ sentry: { reset: true } });
    assert.deepEqual(store.get().sentry, { dsn: '' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legacy integrations store gains sentry defaults without breaking load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-sentry-legacy-'));
  try {
    const legacy = { version: 1, config: integrations.defaults() };
    legacy.config.mcp.key = 'legacy-mcp-key';
    delete legacy.config.sentry;
    fs.writeFileSync(path.join(dir, 'integrations.enc'), Buffer.concat([Buffer.from('b64:'), Buffer.from(Buffer.from(JSON.stringify(legacy)).toString('base64'))]), { mode: 0o600 });
    const config = integrations.openStore(dir, encryption()).get();
    assert.deepEqual(config.sentry, { dsn: '' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no DSN means Sentry stays disabled', () => {
  assert.equal(sentry.initSentry(''), false);
  assert.equal(sentry.enabled(), false);
});

test('sentry UI and lazy main/renderer gating are wired', () => {
  const read = name => fs.readFileSync(path.join(__dirname, '..', 'shell', name), 'utf8');
  const main = read('main.js');
  const preload = read('preload.js');
  const settings = read('settings.html');
  assert.match(main, /if \(activeIntegrations\.sentry\?\.dsn && !sentry\.initSentry\(activeIntegrations\.sentry\.dsn\)\)/);
  assert.match(preload, /sentryEnabled = ipcRenderer\.sendSync\('nekochannel:sentry-flag'\) === true/);
  assert.match(preload, /__SENTRY_IPC__/);
  assert.match(preload, /require\('\@sentry\/electron\/renderer'\)\.init\(\)/);
  assert.match(settings, /sentry: \['dsn'\]/);
  assert.match(settings, /\['key', 'dsn'\]\.includes\(field\)/);
  assert.ok(Object.hasOwn(require('../shell/i18n').STR.id, 'integration_sentry'));
  assert.ok(Object.hasOwn(require('../shell/i18n').STR.en, 'integrationHint_sentry'));
});
