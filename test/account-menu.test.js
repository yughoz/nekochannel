const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// #23b: menu akun dibangun main process (di atas WebContentsView), pakai label
// i18n yang sama dan delete dua tahap tetap tersedia lewat klik kedua.
test('native account menu: shell-only sender, icon/reset, delete armed', () => {
  const main = fs.readFileSync('shell/main.js', 'utf8');
  const i18n = fs.readFileSync('shell/i18n.js', 'utf8');
  const html = fs.readFileSync('shell/index.html', 'utf8');
  assert.match(main, /event\.sender !== win\?\.webContents/);
  assert.match(main, /ACCOUNT_EMOJI = \['🚀','🔥','⭐','❤️','👍','🎯','💼','📈','🎧','🛠️','📦','🤖','🐱','🐶','🌿','🌊','☀️','🌙','⚡','🎉','💡','🔒','📱','💬'\]/);
  assert.match(main, /armedDeletes\.has\(id\) \? 'accountDeleteArmed' : 'accountDelete'/);
  assert.match(main, /label: s\('accountIconReset'\), click: \(\) => \{ delete account\.icon/);
  assert.match(html, /action === 'rename'/);
  assert.match(html, /action === 'reload'/);
  assert.match(html, /action === 'delete'/);
  assert.match(html, /window\.neko\.onAccountMenu/);
  for (const key of ['accountRename', 'accountIcon', 'accountIconReset', 'accountReload', 'accountDelete', 'accountDeleteArmed']) {
    assert.ok(i18n.includes(`${key}: '`) && !i18n.includes(`${key}: ''`), key);
  }
  assert.doesNotMatch(main, /ctxRename|ctxIcon|ctxReload|ctxDelete/);
});
