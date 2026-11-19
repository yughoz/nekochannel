// ponytail: patch Info.plist Electron dev (menu bar/dock macOS baca nama dari bundle,
// bukan package.json) — saat rilis electron-builder membuat bundle sendiri, script ini
// tak dipanggil. Upgrade path: hapus kalau dev via build packaged.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app');
const plist = path.join(app, 'Contents', 'Info.plist');
if (process.platform !== 'darwin' || !fs.existsSync(plist)) return void 0;

const pb = (cmd) => `/usr/libexec/PlistBuddy -c '${cmd}' '${plist}'`;
const set = (k, v) => execSync(`${pb(`Set :${k} ${v}`)} 2>/dev/null || ${pb(`Add :${k} string ${v}`)}`);
set('CFBundleName', 'Nekochannel');
set('CFBundleDisplayName', 'Nekochannel');
// plist berubah = seal signature rusak → re-sign ad-hoc (wajib di Apple Silicon)
execSync(`codesign --force --deep --sign - '${app}' 2>/dev/null`);
console.log('[fix-mac-appname] Info.plist → Nekochannel');
