'use strict';
// #13: backup file config ke <dir>/backup, rotasi KEEP terakhir.
// Murni Node agar node --test jalan tanpa Electron.
const fs = require('node:fs');
const path = require('node:path');

const KEEP = 5;

const backup = (src, dir, keep = KEEP) => {
  const base = path.basename(src);
  fs.mkdirSync(dir, { recursive: true });
  // timestamp ms 13 digit → sort lexical = kronologis. ponytail: dua save dalam
  // satu ms menimpa nama sama (isi akhir tetap benar); tambah counter jika pernah perlu.
  fs.copyFileSync(src, path.join(dir, `${base}.${Date.now()}`));
  const old = fs.readdirSync(dir).filter(f => f.startsWith(`${base}.`)).sort().slice(0, -keep);
  for (const f of old) fs.rmSync(path.join(dir, f));
};

module.exports = { backup, KEEP };
