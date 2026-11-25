'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { BrowserWindow, powerMonitor } = require('electron');
const { SELECTORS, verifyPassword } = require('./privacy');
const store = require('./settings');
const { STR } = require('./i18n');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
// Smoke runs on an otherwise idle host; pin real idle time so explicit injected ticks remain deterministic.
const systemIdleTime = powerMonitor.getSystemIdleTime;
powerMonitor.getSystemIdleTime = () => 0;
process.on('exit', () => { powerMonitor.getSystemIdleTime = systemIdleTime; });
async function until(check, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await check()) return; } catch {}
    await pause(100);
  }
  throw new Error('Smoke condition timed out');
}
async function cdp(wc, expression) {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  const result = await wc.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
module.exports = async ({ app, win, accounts, lock, openSettings, settings, blur, globalShortcut, settingsView }) => {
  assert.ok(process.env.NEKOCHANNEL_USER_DATA, 'never smoke against real userData');
  const password = 'disposable-smoke-password';
  await until(() => cdp(win.webContents, '!!window.neko'));
  assert.equal(globalShortcut.isRegistered('Alt+Z'), true);
  assert.equal(globalShortcut.isRegistered('Alt+X'), true);
  if (process.env.NEKOCHANNEL_PRIVACY_SMOKE === 'restart') {
    assert.equal(settings.privacy.enabled, false);
    assert.equal(settings.privacy.autoLockMinutes, 1);
    assert.equal(settings.lang, 'en');
    assert.equal(await verifyPassword(password, settings.privacy.passwordHash), true);
    console.log('[privacy-smoke] PASS restart: persisted blur, idle, locale, salted hash');
    return;
  }
  assert.equal(settings.privacy.enabled, true);
  assert.equal(lock.lock(), false);
  openSettings();

  await until(() => cdp(settingsView.wc, '!!window.neko && document.querySelectorAll("#privacy-targets input").length === 9'));
  const save = patch => cdp(settingsView.wc, `window.neko.saveSettings(${JSON.stringify(patch)})`);
  const before = JSON.stringify(settings);
  assert.equal((await save({ privacy: { password: 'short' } })).error, 'invalid-settings');
  assert.equal((await save({ privacy: { autoLockMinutes: -1 } })).error, 'invalid-settings');
  assert.equal((await save({ privacy: { passwordHash: 'malicious' } })).error, 'invalid-settings');
  assert.equal((await save(null)).error, 'invalid-settings');
  assert.equal(JSON.stringify(settings), before);
  assert.equal(await cdp(settingsView.wc, 'document.documentElement.lang'), 'id');
  const targetLabels = ['privacyBlur', 'privacyNames', 'privacyPhotos', 'privacyPreviews', 'privacyMessages', 'privacyMedia', 'privacyCompose', 'privacyAccountLabels', 'privacyHoverReveal'];
  const visibleLabels = () => cdp(settingsView.wc, '[...document.querySelectorAll("#privacy-targets label")].map(label => label.textContent)');
  assert.deepEqual(await visibleLabels(), targetLabels.map(key => STR.id[key]));
  await save({ lang: 'en' });
  await until(() => cdp(settingsView.wc, 'document.documentElement.lang === "en"'));
  assert.equal(await cdp(settingsView.wc, 'document.getElementById("h-privacy").textContent'), STR.en.secPrivacy);
  assert.deepEqual(await visibleLabels(), targetLabels.map(key => STR.en[key]));
  await cdp(settingsView.wc, `document.getElementById('lock-password').value = ${JSON.stringify(password)}; document.getElementById('auto-lock').value = '1'; document.getElementById('privacy-save').click()`);
  await until(() => !!settings.privacy.passwordHash);
  await until(() => cdp(settingsView.wc, 'document.getElementById("lock-password").value === ""'));
  const payload = await cdp(settingsView.wc, 'window.neko.getSettings()');
  assert.equal(payload.privacy.passwordSet, true);
  assert.equal('passwordHash' in payload.privacy, false);
  assert.equal((await cdp(win.webContents, 'window.neko.saveSettings({privacy:{enabled:false}})')).error, 'untrusted settings sender');
  const untrusted = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  await untrusted.loadURL('data:text/html,<h1>untrusted</h1>');
  assert.equal((await cdp(untrusted.webContents, 'window.neko.saveSettings({privacy:{enabled:false}})')).error, 'untrusted sender');
  untrusted.destroy();
  await cdp(win.webContents, 'window.neko.add("whatsapp")');
  assert.equal(accounts.length, 2);
  const observations = [];
  for (const account of accounts) {
    await until(async () => await cdp(account.wc, 'document.readyState !== "loading" && !!document.body'), 45000);
    await until(() => cdp(account.wc, `!!document.querySelector('#pane-side, canvas, [data-ref]')`), 45000).catch(() => {});
    observations.push(await cdp(account.wc, `JSON.stringify({url: location.origin, chat: !!document.querySelector('#pane-side'), qr: !!document.querySelector('canvas, [data-ref]'), bodyExcerpt: document.body.innerText.slice(0, 400), counts: Object.fromEntries(Object.entries(${JSON.stringify(SELECTORS)}).map(([key, selectors]) => [key, selectors.map(selector => ({selector, count: document.querySelectorAll(selector).length}))]))})`));
  }
  console.log('[privacy-smoke] REAL WA CDP observations:', JSON.stringify(observations.map(value => JSON.parse(value))));
  if (observations.some(value => !JSON.parse(value).chat)) console.log('[privacy-smoke] BLOCKED: no authenticated WA chat DOM in isolated sessions; see QR/body observations. Fixtures below do not prove live chat coverage.');
  const fixture = `<!doctype html><div id="pane-side"><div role="row"><span id="names" title="contact">Contact</span><img id="photos" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><div id="previews" data-testid="cell-frame-secondary">Last message</div></div></div><div id="main"><div class="message-in" id="messages">Message <img id="media"></div><footer><div contenteditable="true" id="compose">Draft</div></footer></div>`;
  for (const account of accounts) await account.wc.loadURL(`data:text/html,${encodeURIComponent(fixture)}`);
  await blur.apply();
  const filters = account => cdp(account.wc, `Object.fromEntries(${JSON.stringify(Object.keys(SELECTORS))}.map(key => [key, getComputedStyle(document.getElementById(key)).filter]))`);
  for (const account of accounts) for (const value of Object.values(await filters(account))) assert.equal(value, 'blur(7px)');
  await save({ privacy: { enabled: false } });
  for (const account of accounts) for (const value of Object.values(await filters(account))) assert.equal(value, 'none');
  const off = Object.fromEntries(Object.keys(SELECTORS).map(key => [key, false]));
  for (const target of Object.keys(SELECTORS)) {
    await save({ privacy: { enabled: true, ...off, [target]: true } });
    for (const account of accounts) {
      const values = await filters(account);
      for (const [key, value] of Object.entries(values)) assert.equal(value, key === target ? 'blur(7px)' : 'none', `${target}/${key}`);
    }
  }
  await save({ privacy: { enabled: true, ...Object.fromEntries(Object.keys(SELECTORS).map(key => [key, true])) } });
  const original = accounts[0].wc.getURL();
  accounts[0].wc.reload();
  await until(async () => (await filters(accounts[0])).messages === 'blur(7px)');
  await accounts[0].wc.loadURL(original + '#route');
  await blur.apply();
  assert.equal((await filters(accounts[0])).messages, 'blur(7px)');
  const state = await cdp(win.webContents, 'window.neko.state()');
  assert.equal(state.accounts[0].label, 'WA 1');
  await save({ privacy: { enabled: false } });
  assert.equal((await cdp(win.webContents, 'window.neko.state()')).accounts[0].label, accounts[0].label);
  // #58: kunci = overlay di DALAM jendela utama (bukan jendela fullscreen per monitor).
  const windowsBefore = BrowserWindow.getAllWindows().length;
  assert.equal(lock.lock(), true);
  const shield = lock.view;
  await until(() => cdp(shield.webContents, '!!window.lock && !!document.getElementById("password")'));
  assert.equal(win.contentView.children.at(-1), shield); // paling atas di jendela Nekochannel
  const content = win.getContentBounds();
  assert.deepEqual(shield.getBounds(), { x: 0, y: 0, width: content.width, height: content.height });
  assert.equal(shield.getVisible(), true);
  assert.equal(accounts.every(account => !account.view.getVisible()), true); // isi WA tersembunyi
  assert.equal(BrowserWindow.getAllWindows().length, windowsBefore); // tidak ada jendela baru
  assert.equal(BrowserWindow.getAllWindows().some(window => window.isFullScreen() || window.isSimpleFullScreen() || window.isAlwaysOnTop()), false);
  console.log('[privacy-smoke] in-window lock shield', JSON.stringify({ shield: shield.getBounds(), mainContent: content }));
  // Tata letak menaikkan view WA (setActive) → overlay naik lagi & view WA tetap tersembunyi.
  win.emit('focus');
  accounts[0].view.setVisible(true); win.contentView.addChildView(accounts[0].view); lock.cover();
  assert.equal(win.contentView.children.at(-1), shield);
  assert.equal(accounts[0].view.getVisible(), false);
  // Resize jendela → overlay ikut ukuran.
  const size = win.getContentSize();
  win.setContentSize(size[0] - 40, size[1] - 30);
  await until(() => shield.getBounds().width === win.getContentBounds().width && shield.getBounds().height === win.getContentBounds().height);
  win.setContentSize(size[0], size[1]);
  // Reload / navigasi keluar diblokir.
  const url = shield.webContents.getURL();
  let reloads = 0;
  const loading = () => reloads++;
  shield.webContents.on('did-start-loading', loading);
  shield.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F5' });
  shield.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F5' });
  shield.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
  shield.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'R' });
  await pause(200);
  assert.equal(reloads, 0);
  shield.webContents.removeListener('did-start-loading', loading);
  await cdp(shield.webContents, `location.href = 'data:text/html,escape'; true`);
  await pause(200);
  assert.equal(shield.webContents.getURL(), url);
  win.hide(); assert.equal(lock.isLocked(), true); win.show();
  app.quit();
  assert.equal(lock.isLocked(), true);
  assert.equal(shield.webContents.isDestroyed(), false);
  assert.equal(win.isVisible(), true); // quit saat terkunci → jendela tampil dengan overlay
  assert.equal(win.contentView.children.at(-1), shield);
  assert.equal((await save({ privacy: { enabled: true } })).error, 'locked');
  const outsider = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'lock-preload.js') } });
  await outsider.loadURL('data:text/html,untrusted-unlock');
  assert.equal((await cdp(outsider.webContents, `window.lock.unlock(${JSON.stringify(password)})`)).ok, false);
  outsider.destroy();
  assert.equal(await cdp(shield.webContents, 'document.getElementById("title").textContent'), STR.en.lockTitle);
  assert.equal((await cdp(shield.webContents, 'window.lock.unlock("incorrect-password")')).ok, false);
  assert.equal((await cdp(shield.webContents, `window.lock.unlock(${JSON.stringify(password)})`)).ok, false);
  await pause(1100);
  await cdp(shield.webContents, `document.getElementById('password').value = ${JSON.stringify(password)}; document.getElementById('unlock').requestSubmit()`);
  await until(() => !lock.isLocked());
  assert.equal(win.contentView.children.includes(shield), false); // overlay dilepas
  await until(() => accounts.some(account => account.view.getVisible())); // tata letak tab aktif dipulihkan
  lock.tick(59); assert.equal(lock.isLocked(), false);
  lock.tick(60); assert.equal(lock.isLocked(), true);
  assert.equal(win.contentView.children.at(-1), lock.view); // auto-lock idle → overlay di jendela
  const disk = store.load(app.getPath('userData'));
  assert.equal(disk.privacy.enabled, false);
  assert.equal(disk.privacy.autoLockMinutes, 1);
  assert.equal(await verifyPassword(password, disk.privacy.passwordHash), true);
  assert.equal(fs.readFileSync(store.file(app.getPath('userData')), 'utf8').includes(password), false);
  assert.ok(fs.readdirSync(path.join(app.getPath('userData'), 'backup')).some(name => name.startsWith('settings.json.')));
  console.log('[privacy-smoke] PASS first: real Electron/CDP; 2 views, 6 CSS targets on/off, reload/SPA, i18n, write-only UI, IPC denial, in-window lock shield (no fullscreen), incorrect/correct unlock, rate limit, hide/show, idle threshold (injected idle seconds)');
};
