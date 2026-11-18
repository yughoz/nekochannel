'use strict';
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { createAccountView } = require('../adapters/whatsapp/adapter');

app.setName('nekochannel');
app.setPath('userData', path.join(app.getPath('appData'), 'nekochannel'));

const endpoint = process.env.NEKOCHANNEL_SERVER || 'http://127.0.0.1:4317';
const accounts = [];

function fit() {
  const bounds = win.contentView.getBounds();
  for (const a of accounts) a.view.setBounds(bounds);
}

let win;
app.whenReady().then(() => {
  win = new BrowserWindow({ width: 1280, height: 860, title: 'Nekochannel', backgroundColor: '#111b21' });
  win.loadFile(path.join(__dirname, 'index.html'));
  // M0: single WhatsApp account filling the window. Sidebar/multi-account is M1.
  accounts.push(createAccountView({ window: win, index: 1, serverEndpoint: endpoint }));
  win.contentView.addChildView(accounts[0].view);
  win.on('resize', fit);
  fit();
  win.on('closed', () => { for (const a of accounts.splice(0)) a.dispose(); });
  if (process.env.NEKOCHANNEL_SMOKE) require('./smoke')(accounts[0], endpoint);
});

app.on('window-all-closed', () => app.quit());
