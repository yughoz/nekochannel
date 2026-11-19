# Modul Capture

## Tanggung jawab

Menjalankan reader wa-reader di dalam tiap WebContentsView dan memastikan pesan
sampai ke server `/ingest` dengan jaminan at-least-once + dedupe di sisi server.

## Komponen

### 1. Injection reader (reuse dari wa-reader)

- Source awal wa-reader; engine dimiliki repo ini di `adapters/whatsapp/vendor/`.
  Bundle reader dan normalizer dipertahankan tanpa perubahan logika baca; tidak ada sync eksternal.
- Inject: `wc.executeJavaScript(src)` pada `dom-ready`. Guard `window.__waReaderLoaded`
  di awal source supaya tidak double-inject (SPA soft-nav tidak me-reinject, dan
  memang tidak perlu — hook bertahan di memori halaman).
- Reader emit event yang sama seperti di Chrome: `wa-reader-message`,
  `wa-reader-unread`, dan bridge `wa-reader-backfill-request/response`.

### 2. Bridge (pengganti content.js)

- Preload script per view: listen CustomEvent di `window`, forward ke main process
  via `ipcRenderer.send('reader-event', account, payload)`. Validasi bentuk payload
  di sini (trust boundary: payload berasal dari halaman web).

### 3. Queue + flush (pengganti background.js)

- Main process: queue JSONL per akun di `userData/queue/<account>.jsonl`,
  append sebelum ack — durable terhadap crash.
- Flush `POST /ingest {account, label?, messages[]}` tiap 30s atau saat batch ≥ 100.
  Retry dengan backoff kalau server down; file baru di-truncate setelah flush
  diterima (at-least-once aman: server dedupe `PRIMARY KEY(account,id)`).
- Backfill driver: checkpoint per akun (posisi walk per chat) disimpan di
  `userData/state.json`; request `loadEarlierMsgs` dikirim ke halaman lewat
  executeJavaScript yang memicu event response balik — spacing 1,5s dan aturan
  cooldown/auto-restart mengikuti perilaku extension sekarang.
- Health poll `/health` tiap 60s → status badge sidebar.

## Aturan yang tidak boleh dilanggar

- Kode capture **read-only**: tidak ada send/type/click openChat/sendSeen/markRead
  dari kode kita. Interaksi manusia lewat embedded WA Web tidak termasuk larangan ini.
- Tidak pernah print token/nilai `.env` ke log.

## Verifikasi

- `curl -s 127.0.0.1:4317/health` → count per akun baru naik saat pesan masuk.
- Baca `userData/data/wa.sqlite` via SQLite read-only; filter account yang diuji.
- Server sekarang milik lifecycle internal; lihat [modul backend](modul_backend.md).
- Tes queue: kill server, kirim pesan, nyalakan server → ter-flush tanpa duplikat.
