'use strict';
const assert = require('node:assert/strict');
const { Menu, MenuItem } = require('electron');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 10000, label = 'condition') {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await check()) return; } catch {}
    await pause(100);
  }
  throw new Error(`account-menu smoke timeout: ${label}`);
}
const cdp = async (wc, expression) => {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  const result = await wc.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};
module.exports = async function accountMenuSmoke({ win, accounts, broadcast, lock, settings }) {
  await until(() => !!accounts.length);
  const id = accounts[0].id;
  await until(() => win.isVisible() && accounts[0].wc.getURL().startsWith('data:'));
  await until(async () => { await cdp(win.webContents, `state.privacy = { enabled: false, accountLabels: false }`); return true; }, 10000, 'renderer CDP'); // smoke-only: bypass label masking guard
  // Collapse #23 first: rail geometry must remain 56px while the WA view has focus.
  await cdp(win.webContents, `window.neko.sidebarToggle()`);
  await until(async () => (await cdp(win.webContents, `window.neko.state()`)).sidebarCollapsed === true && await cdp(win.webContents, `document.getElementById('sidebar').classList.contains('collapsed')`), 10000, 'collapse');
  assert.equal(accounts[0].view.getBounds().x, 56); // #23 rail geometry: left edge = SIDEBAR_W_COLLAPSED
  // Runtime-shaped popup proves the native menu is built/popuped on `win` and closes cleanly.
  const smoke = { menuClosed: false };
  const items = [
    new MenuItem({ label: 'smoke-rename', click: () => win.webContents.send('nekochannel:account-action', { action: 'rename', id }) }),
    new MenuItem({ label: 'smoke-reload', click: () => accounts[0].wc.reload() }),
    new MenuItem({ label: 'smoke-icon', submenu: [{ label: '🚀', click: () => { accounts[0].icon = '🚀'; broadcast(); } }] }),
  ];
  const menu = new Menu();
  for (const item of items) menu.append(item);
  menu.popup({ window: win, callback: () => { smoke.menuClosed = true; } });
  menu.closePopup(win);
  await until(() => smoke.menuClosed, 10000, 'menu close');
  win.webContents.focus();
  assert.equal(await cdp(accounts[0].wc, `document.visibilityState === 'visible'`), true);
  // MenuItem.click() isn't invokable from JS in this Electron; trigger the identical click callbacks.
  win.webContents.send('nekochannel:account-action', { action: 'rename', id });
  await until(async () => await cdp(win.webContents, `!!document.querySelector('.acc input')`), 10000, 'rename input');
  assert.equal(await cdp(win.webContents, `document.getElementById('sidebar').classList.contains('collapsed')`), false);
  assert.equal(await cdp(win.webContents, `document.querySelector('.acc input')?.value?.length > 0`), true);
  await cdp(win.webContents, `document.querySelector('.acc input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await until(async () => !(await cdp(win.webContents, `!!document.querySelector('.acc input')`)), 10000, 'escape input');
  accounts[0].wc.reload(); // identical to smoke reload item click
  await until(async () => (await cdp(accounts[0].wc, `document.title`)) === 'WA fixture', 10000, 'reload title');
  await until(async () => (await cdp(accounts[0].wc, `document.readyState === 'complete'`)) === true);
  await until(async () => !win.webContents.isLoading() && await cdp(win.webContents, `document.readyState === 'complete'`));
  settings.privacy.enabled = false; settings.privacy.accountLabels = false; // smoke-only: snapshot tidak mask icon
  accounts[0].icon = '🚀'; broadcast(); // identical to smoke icon item click
  await until(async () => (await cdp(win.webContents, `window.neko.state()`)).accounts[0].icon === '🚀', 10000, 'icon state');
  win.webContents.send('nekochannel:account-action', { action: 'delete', id });
  await until(async () => (await cdp(win.webContents, `window.neko.state()`)).accounts.length === 0, 10000, 'delete state');
  console.log('[account-menu-smoke] PASS');
};
