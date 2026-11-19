'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(wc, expression) {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  const result = await wc.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error('Fixture renderer evaluation failed');
  return result.result.value;
}
module.exports = async ({ app, backend, openSettings, views }) => {
  assert.ok(app.getPath('userData').startsWith(path.join(process.env.TMPDIR, 'neko-sentry-electron-')));
  assert.ok(/127\.0\.0\.1:\d+/.test(process.env.NEKOCHANNEL_SENTRY_DSN));
  const phase = process.env.NEKOCHANNEL_SENTRY_SMOKE;
  openSettings();
  const wc = views().settingsView.wc;
  for (let attempt = 0; attempt < 150 && !(await evaluate(wc, '!!window.neko && !!document.getElementById("sentry-dsn")')); attempt++) await pause(100);
  const call = expression => evaluate(wc, expression);
  const get = () => call('window.neko.getSettings()');
  const state = () => call('window.neko.state()');
  assert.equal((await fetch(backend.ingestUrl + '/health')).ok, true);
  if (phase === 'first') {
    assert.equal((await state()).sentry, false);
    const input = await call('(() => { const input = document.getElementById("sentry-dsn"); return { type: input.type, value: input.value }; })()');
    assert.deepEqual(input, { type: 'password', value: '' });
    const saved = await call(`window.neko.saveSettings({ integrations: { sentry: { dsn: ${JSON.stringify(process.env.NEKOCHANNEL_SENTRY_DSN)} } } })`);
    assert.equal(saved.integrations.sentry.dsn, undefined);
    assert.equal(saved.integrations.sentry.dsnSet, true);
    assert.equal(saved.integrationStatus.restartRequired, true);
    assert.equal((await state()).sentry, false);
    const bytes = fs.readFileSync(path.join(app.getPath('userData'), 'integrations.enc'));
    assert.equal(bytes.includes(process.env.NEKOCHANNEL_SENTRY_DSN), false);
    assert.equal(fs.statSync(path.join(app.getPath('userData'), 'integrations.enc')).mode & 0o777, 0o600);
    console.log('[sentry-smoke] PASS first: no init without DSN, write-only Settings save, no local event');
  } else {
    assert.equal((await state()).sentry, true);
    assert.equal(await call('!!window.__SENTRY_IPC__ || !!window.__SENTRY__RENDERER_INIT__'), true);
    assert.equal((await get()).integrationStatus.restartRequired, false);
    const Sentry = require('@sentry/core');
    const NodeClient = require('@sentry/node-core').NodeClient;
    const { makeElectronTransport } = require('@sentry/electron/main');
    const { makeOfflineTransport } = require('@sentry/core');
    const { makeElectronOfflineTransport } = require('@sentry/electron/main');
    const client = new NodeClient({
      dsn: process.env.NEKOCHANNEL_SENTRY_DSN,
      transport: makeElectronOfflineTransport(),
      ipcMode: 0,
      sendClientReports: false,
      skipOpenTelemetrySetup: true,
      includeServerName: false,
      integrations: [],
    });
    client.init();
    let envelope = null;
    client.on('beforeEnvelope', sent => { envelope = Sentry.serializeEnvelope(sent); });
    const event = { event_id: Sentry.uuid4(), message: 'nekochannel synthetic sentry smoke', timestamp: Date.now() / 1000, platform: 'node' };
    client.sendEnvelope(Sentry.createEventEnvelope(event, client.getDsn(), client.getSdkMetadata()));
    for (let attempt = 0; attempt < 30 && !envelope; attempt++) { await pause(100); await client.flush(200); }
    assert.ok(envelope, 'synthetic envelope prepared locally');
    assert.ok(envelope.includes('nekochannel synthetic sentry smoke'), 'synthetic envelope prepared locally');
    assert.equal(envelope.includes('fixturepublic'), false, 'fixture envelope excludes DSN public key');
    console.log(`[sentry-smoke] envelope:${envelope}`);
    console.log('[sentry-smoke] PASS restart: main+renderer bridge initialized, synthetic event local only');
  }
};
