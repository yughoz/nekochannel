#!/usr/bin/env node
// Menyalin modul AI Pack dari repo privat (../nekochannel-private/aipack) → ./aipack
// sebelum electron-builder mengemas. Folder privat tidak ada → build publik murni (BYO saja).
// Dipanggil otomatis oleh `npm run dist`.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const src = path.resolve(__dirname, '../../nekochannel-private/aipack');
const dest = path.resolve(__dirname, '..', 'aipack');

fs.rmSync(dest, { recursive: true, force: true });
if (!fs.existsSync(src)) {
  console.log('[aipack] modul privat tidak ditemukan → build tanpa AI Pack (mode BYO)');
  process.exit(0);
}
fs.cpSync(src, dest, {
  recursive: true,
  filter: entry => !/(^|\/)(test|node_modules)(\/|$)/.test(entry) && !entry.endsWith('.test.js'),
});
console.log('[aipack] injected →', dest);
