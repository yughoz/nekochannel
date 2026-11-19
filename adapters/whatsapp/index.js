'use strict';
// Adapter WhatsApp: tahu cara load WA Web (partition + UA spoof per platform)
// dan menyuntikkan reader wa-reader (engine lokal di vendor/).
const fs = require('node:fs');
const path = require('node:path');

const VENDOR = path.join(__dirname, 'vendor');
const BUNDLE = path.join(VENDOR, 'page-main.bundle.js'); // normalize + page-main + guard __waReaderLoaded

module.exports = {
  name: 'whatsapp',
  short: 'wa',
  url: 'https://web.whatsapp.com/',
  partition: n => `persist:whatsapp-${n}`,
  // WA Web merespons beda ke UA Electron → spoof Chrome penuh. Platform-aware:
  // target rilis Linux/macOS/Windows (PRD: satu engine Chromium di 3 OS).
  userAgent(chromeVersion) {
    const platform = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
      : 'X11; Linux x86_64';
    return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  },
  // Inject di main world; guard __waReaderLoaded sudah di dalam bundle
  // (dom-ready tiap navigasi baru butuh re-inject dan guard-nya mencegah double-hook).
  async inject(webContents, enabled = true) {
    return webContents.executeJavaScript(`globalThis.__nekoReaderEnabled = ${enabled === true};\n` + fs.readFileSync(BUNDLE, 'utf8'), true);
  },
  // Probe status ringan (PRD: sekali per 30s per akun, bukan scraping berat).
  // Fallback pre-login saja; status otoritatif tetap dari event wa-reader-status
  // (deteksi internal reader). Chat-list selector tervalidasi live di WA Web
  // 2026-11; selector QR (data-ref/qrcode) belum terverifikasi live.
  // ponytail: kalau WA Web ubah DOM login-nya, re-validate via CDP saat QR tampil.
  async status(webContents) {
    return webContents.executeJavaScript(`(() => {
      const q = s => document.querySelector(s);
      if (q('#side, [data-testid="chat-list"]')) return 'chat';
      if (q('div[data-ref], [data-testid="qrcode"], .landing-wrapper')) return 'qr';
      return 'loading';
    })()`, true);
  },
};
