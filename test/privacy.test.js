'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const privacy = require('../shell/privacy');
const store = require('../shell/settings');

test('privacy defaults, independent objects, normalization and strict boundary validation', () => {
  assert.equal(privacy.DEFAULTS.enabled, true);
  assert.equal(privacy.DEFAULTS.autoLockMinutes, 0);
  const first = privacy.normalize(); first.enabled = false;
  assert.equal(privacy.normalize().enabled, true);
  assert.deepEqual(privacy.normalize({ enabled: 'false', autoLockMinutes: -1, passwordHash: 'plaintext' }), privacy.DEFAULTS);
  for (const patch of [null, [], { enabled: 1 }, { unknown: true }, { passwordHash: null }, { autoLockMinutes: 1.5 }, { autoLockMinutes: 1441 }, { password: 'short' }, { password: 'x'.repeat(257) }]) assert.throws(() => privacy.validatePatch(patch));
  assert.doesNotThrow(() => privacy.validatePatch({ enabled: false, media: true, compose: false, autoLockMinutes: 1440, password: 'abcdefgh' }));
});

test('salted scrypt verification, write-only projection, persistence and settings backups', async context => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'neko-privacy-unit-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const password = 'unit-disposable-only';
  const hash = await privacy.hashPassword(password);
  assert.notEqual(hash, await privacy.hashPassword(password));
  assert.equal(await privacy.verifyPassword(password, hash), true);
  assert.equal(await privacy.verifyPassword('incorrect-password', hash), false);
  assert.equal(await privacy.verifyPassword({}, hash), false);
  assert.equal(await privacy.verifyPassword(password, 'corrupt'), false);
  store.save(dir, { ...store.DEFAULTS, privacy: { ...privacy.DEFAULTS, enabled: false, autoLockMinutes: 2, passwordHash: hash } });
  const restored = store.load(dir);
  assert.equal(restored.privacy.enabled, false);
  assert.equal(restored.privacy.autoLockMinutes, 2);
  assert.equal(await privacy.verifyPassword(password, restored.privacy.passwordHash), true);
  assert.equal(privacy.publicSettings(restored.privacy).passwordSet, true);
  assert.equal('passwordHash' in privacy.publicSettings(restored.privacy), false);
  for (const file of [store.file(dir), ...fs.readdirSync(path.join(dir, 'backup')).map(name => path.join(dir, 'backup', name))]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.includes(password), false);
    assert.equal(JSON.parse(text).privacy.passwordHash, hash);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test('every CSS target is independently switchable; master off removes all rules', () => {
  const allOff = Object.fromEntries(Object.keys(privacy.SELECTORS).map(key => [key, false]));
  assert.equal(privacy.cssFor({ enabled: false }), '');
  for (const [target, selectors] of Object.entries(privacy.SELECTORS)) {
    assert.ok(selectors.length >= 2);
    const css = privacy.cssFor({ ...allOff, [target]: true });
    for (const selector of selectors) assert.ok(css.includes(selector));
    assert.match(css, /blur\(7px\) !important/);
    assert.equal(privacy.cssFor({ ...allOff, [target]: false }), '');
  }
});

test('injector: all views, duplicate guard, serial rapid toggles, reload/navigation and destroyed views', async () => {
  let settings = privacy.normalize();
  const injector = privacy.createInjector(() => settings);
  const makeView = () => {
    const wc = new EventEmitter();
    wc.dead = false; wc.insertions = []; wc.removals = [];
    wc.isDestroyed = () => wc.dead;
    wc.insertCSS = async css => { wc.insertions.push(css); return String(wc.insertions.length); };
    wc.removeInsertedCSS = async key => wc.removals.push(key);
    return wc;
  };
  const views = [makeView(), makeView()];
  for (const wc of views) { await injector.attach(wc); injector.attach(wc); wc.emit('dom-ready'); wc.emit('did-finish-load'); }
  await injector.apply();
  assert.deepEqual(views.map(wc => wc.insertions.length), [1, 1]);
  settings = { ...settings, enabled: false }; await injector.apply();
  assert.deepEqual(views.map(wc => wc.removals.length), [1, 1]);
  settings.enabled = true; await Promise.all([injector.apply(), injector.apply()]);
  for (const wc of views) {
    wc.emit('did-start-navigation', {}, 'https://web.whatsapp.com', false, true);
    wc.emit('dom-ready'); wc.emit('did-finish-load'); wc.emit('did-navigate-in-page');
  }
  await injector.apply();
  assert.deepEqual(views.map(wc => wc.insertions.length), [3, 3]);
  views[0].dead = true; views[0].emit('destroyed');
  settings.enabled = false; await injector.apply();
  assert.equal(views[0].removals.length, 1);
  assert.equal(views[1].removals.length, 2);
});

test('injector removes an insertion that races a full navigation', async () => {
  const wc = new EventEmitter();
  let finish, count = 0;
  const removed = [];
  wc.isDestroyed = () => false;
  wc.insertCSS = () => ++count === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve('current');
  wc.removeInsertedCSS = async key => removed.push(key);
  const injector = privacy.createInjector(() => privacy.DEFAULTS);
  const first = injector.attach(wc);
  await Promise.resolve();
  wc.emit('did-start-navigation', {}, 'https://web.whatsapp.com', false, true);
  wc.emit('dom-ready');
  finish('stale');
  await first;
  await injector.apply();
  assert.deepEqual(removed, ['stale']);
  assert.equal(count, 2);
});
