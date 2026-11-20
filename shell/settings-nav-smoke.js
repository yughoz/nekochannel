'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const shotDir = process.env.NEKOCHANNEL_SETTINGS_SHOT_DIR;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 15000, label = 'condition') {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await check()) return; } catch {}
    await pause(100);
  }
  throw new Error(`settings-nav smoke timeout: ${label}`);
}
async function evaluate(wc, expression) {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  const result = await wc.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
const sections = ['general', 'reader', 'privacy', 'integrations', 'llm', 'about'];
module.exports = async function settingsNavSmoke({ app, win, openSettings, setAgentDock, settingsView, closeSettings }) {
  await until(() => !!win && !win.isDestroyed() && win.isVisible(), 15000, 'main window');
  const bounds = () => settingsView.view.getBounds();
  const rendered = () => evaluate(settingsView.wc, '!!window.neko && document.querySelectorAll("#settings-nav button").length === 6');
  await until(rendered, 15000, 'settings renderer');
  const wc = settingsView.wc;
  const visible = () => evaluate(wc, `Array.from(document.querySelectorAll('main > section')).filter(x => !x.hidden).map(x => x.id.replace('panel-',''))[0]`);
  // #27 v2: dock open/closed dipulihkan persis setelah Settings ditutup.
  const restoreCheck = async dock => {
    setAgentDock(dock);
    await until(() => settingsView.view.getVisible() === false, 5000, 'settings ready');
    openSettings();
    await until(() => settingsView.view.getVisible(), 5000, 'settings open');
    const content = win.contentView.getBounds();
    const expected = { x: 232, y: 0, width: content.width - 232, height: content.height };
    assert.deepEqual(bounds(), expected, `bounds ${JSON.stringify(bounds())} != ${JSON.stringify(expected)}`);
    assert.equal(win.contentView.children.indexOf(settingsView.view), win.contentView.children.length - 1);
    await until(rendered, 15000, 'settings renderer');
    await evaluate(settingsView.wc, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await until(() => !settingsView.view.getVisible(), 5000, 'Escape close');
    assert.ok(win.contentView.children.includes(settingsView.view));
    // Shell sidebar bukan BaseView: visibility aktif dilihat dari class renderer.
    const restored = await evaluate(win.webContents, `({ active: document.querySelector('#channels .acc.active')?.dataset.id || null, dock: document.getElementById('agent-tab').classList.contains('active') })`);
    assert.equal(restored.dock, dock);
  };
  await restoreCheck(true);
  await restoreCheck(false);
  for (const key of sections) {
    await evaluate(wc, `document.getElementById('nav-${key}').click()`);
    await until(async () => (await visible()) === key, 5000, `show ${key}`);
    assert.equal(await evaluate(wc, `document.getElementById('nav-${key}').classList.contains('active')`), true);
    assert.equal(await evaluate(wc, `document.querySelectorAll('main > section:not([hidden])').length`), 1);
  }
  // Panel panjang (Integrasi) harus scroll di dalam <main>; dulu .layout ikut memanjang dan body overflow:hidden memotongnya.
  const size = win.getContentSize();
  openSettings();
  await until(() => settingsView.view.getVisible(), 5000, 'settings open (small)');
  win.setContentSize(size[0], 420);
  await until(() => bounds().height <= 420, 5000, 'settings resize');
  await evaluate(wc, `document.getElementById('nav-integrations').click()`);
  await until(async () => (await visible()) === 'integrations', 5000, 'show integrations (small)');
  const scroll = await evaluate(wc, `(async () => {
    const main = document.querySelector('main');
    main.scrollTop = main.scrollHeight;
    await new Promise(requestAnimationFrame);
    const save = document.getElementById('integrations-save').getBoundingClientRect();
    return { view: innerHeight, client: main.clientHeight, height: main.scrollHeight, top: main.scrollTop, saveBottom: save.bottom };
  })()`);
  assert.ok(scroll.height > scroll.client, `integrations should overflow at 420px: ${JSON.stringify(scroll)}`);
  assert.ok(scroll.client <= scroll.view && scroll.top > 0, `main must scroll inside viewport: ${JSON.stringify(scroll)}`);
  assert.ok(scroll.saveBottom <= scroll.view, `save button unreachable: ${JSON.stringify(scroll)}`);
  win.setContentSize(size[0], size[1]);
  await until(() => bounds().height === size[1], 5000, 'settings restore size');
  await evaluate(wc, `document.querySelector('main').scrollTop = 0`);
  await evaluate(wc, `document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Digit2', altKey: true, bubbles: true }))`);
  await until(async () => (await visible()) === 'reader', 5000, 'Alt+2');
  assert.equal(await evaluate(wc, `document.getElementById('nav-reader').textContent`), 'WA Reader');
  await evaluate(wc, `document.getElementById('nav-general').focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
  await until(async () => (await visible()) === 'reader', 5000, 'ArrowDown');
  const idLabels = await evaluate(wc, `Array.from(document.querySelectorAll('#settings-nav button')).map(x => x.textContent)`);
  await evaluate(wc, `document.getElementById('lang').value='id'; document.getElementById('lang').dispatchEvent(new Event('change',{bubbles:true}))`);
  await until(async () => (await evaluate(wc, `document.getElementById('nav-general').textContent`)) === 'Umum', 10000, 'language switch');
  const idLabelsAfter = await evaluate(wc, `Array.from(document.querySelectorAll('#settings-nav button')).map(x => x.textContent)`);
  assert.deepEqual(idLabelsAfter, ['Umum', 'WA Reader', 'Privasi', 'Integrasi', 'LLM Agent', 'Tentang']);
  await until(async () => (await evaluate(wc, `window.neko.getSettings()`)).settingsSection === 'reader', 10000, 'persist');
  if (shotDir) {
    fs.mkdirSync(shotDir, { recursive: true });
    const key = idLabelsAfter[0] === 'Umum' ? { '01-general': 'nav-general', '02-reader': 'nav-reader', '03-privacy': 'nav-privacy', '04-integrations': 'nav-integrations', '05-llm': 'nav-llm', '06-about': 'nav-about' } : { '01-umum': 'nav-general', '02-reader': 'nav-reader', '03-privasi': 'nav-privacy', '04-integrasi': 'nav-integrations', '05-llm': 'nav-llm', '06-tentang': 'nav-about' };
    for (const [name, id] of Object.entries(key)) {
      await evaluate(wc, `document.getElementById('${id}').click()`);
      await until(async () => (await visible()) === id.replace('nav-', ''), 5000, `shot ${name}`);
      fs.writeFileSync(path.join(shotDir, `${name}.png`), (await wc.capturePage()).toPNG());
    }
  }
  await evaluate(wc, `document.getElementById('nav-reader').click()`);
  await until(async () => (await evaluate(wc, `window.neko.getSettings()`)).settingsSection === 'reader', 10000, 'settle reader');
  await evaluate(wc, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await until(() => !settingsView.view.getVisible(), 10000, 'Escape close');
  const settings = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
  assert.equal(settings.settingsSection, 'reader');
  console.log(`[settings-nav-smoke] PASS contentBounds=${JSON.stringify(win.contentView.getBounds())} settingsBounds=${JSON.stringify(bounds())} nav=${JSON.stringify(idLabelsAfter)} persisted=${settings.settingsSection}`);
};
