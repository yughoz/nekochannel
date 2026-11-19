const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// Source-level guard: main bounds dan CSS rail tidak boleh beda lebar; menu
// akun native karena overlay renderer tidak bisa menutupi WebContentsView.
test('#23 rail 56px dan menu akun native di atas view WA', () => {
  const html = fs.readFileSync('shell/index.html', 'utf8');
  const main = fs.readFileSync('shell/main.js', 'utf8');
  assert.match(html, /#sidebar\.collapsed\s*\{\s*width:\s*56px;/);
  assert.match(main, /SIDEBAR_W_COLLAPSED\s*=\s*56/);
  assert.match(html, /row\.oncontextmenu = e => \{ e\.preventDefault\(\); if \(e\.target\.tagName !== 'INPUT'\) window\.neko\.accountMenu\(a\.id\); \};/);
  assert.doesNotMatch(html, /#ctx|#emoji|ctxRename|hideCtx/);
  assert.match(main, /ipcMain\.on\('nekochannel:account-menu'/);
  assert.match(main, /\.popup\(\{\s*window:\s*win\s*,\s*callback:/);
});
