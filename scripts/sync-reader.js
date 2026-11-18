'use strict';
// Copy reader sources from the wa-reader repo (single source of truth) and
// assemble the MAIN-world injection bundle. Never edit vendor/ copies in place.
const fs = require('node:fs');
const path = require('node:path');

const SRC = process.env.READER_SRC || path.resolve(__dirname, '..', '..', 'wa-reader', 'extension');
const OUT = path.join(__dirname, '..', 'adapters', 'whatsapp', 'vendor');

for (const f of ['normalize.js', 'page-main.js']) {
  const src = path.join(SRC, f);
  if (!fs.existsSync(src)) throw new Error(`wa-reader source not found: ${src} (set READER_SRC)`);
}
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(SRC, 'normalize.js'), path.join(OUT, 'normalize.js'));

const normalize = fs.readFileSync(path.join(SRC, 'normalize.js'), 'utf8');
const pageMain = fs.readFileSync(path.join(SRC, 'page-main.js'), 'utf8');
// Guard: dom-ready re-fires on every real navigation; without the flag a
// re-inject re-hooks the page and double-emits messages.
const bundle = `if (!window.__waReaderLoaded) {\nwindow.__waReaderLoaded = true;\n${normalize}\n${pageMain}\nglobalThis.dispatchEvent(new Event('wa-reader-content-ready'));\n}\n`;
fs.writeFileSync(path.join(OUT, 'page-main.bundle.js'), bundle);
console.log('synced reader sources from', SRC, '→', OUT);
