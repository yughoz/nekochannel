# Modul Capture

## Tanggung jawab

Menjalankan reader wa-reader di dalam tiap WebContentsView dan memastikan pesan
sampai ke server `/ingest` dengan jaminan at-least-once + dedupe di sisi server.

## Komponen

### 1. Injection reader (reuse dari wa-reader)

- Source awal wa-reader; engine dimiliki repo ini di `adapters/whatsapp/vendor/`.
  Bundle reader mengikuti master switch lokal; normalizer tetap dipakai tanpa sync eksternal.
- Inject: `wc.executeJavaScript(src)` pada `dom-ready`. Guard `window.__waReaderLoaded`
  di awal source supaya tidak double-inject (SPA soft-nav tidak me-reinject, dan
  memang tidak perlu — hook bertahan di memori halaman).
- Reader emit event yang sama seperti di Chrome: `wa-reader-message`,
  `wa-reader-unread`, dan bridge `wa-reader-backfill-request/response`.

### 2. Bridge (pengganti content.js)

- Preload script per view: listen CustomEvent di `window`, forward ke main process
  via `ipcRenderer.invoke('capture:<view-id>', payload)`. Validasi payload, sender view,
  dan main frame sebelum driver menerima event (trust boundary: halaman web).

### 3. Queue + flush (pengganti background.js)

- Main process: queue JSONL per akun di `userData/queue/<account>.jsonl`,
  append sebelum ack — durable terhadap crash.
- Flush `POST /ingest {account, label?, messages[]}` tiap 30s atau saat batch ≥ 100.
  Retry dengan backoff kalau server down; file baru di-truncate setelah flush
  diterima (at-least-once aman: server dedupe `PRIMARY KEY(account,id)`).
- Backfill driver: checkpoint per akun (posisi walk per chat) disimpan di
  `userData/state.json`; halaman menjalankan `loadEarlierMsgs`, lalu meminta ack
  batch/checkpoint melalui bridge. Jarak antar-load minimal 1,5 detik.
- Footer hanya menampilkan Reader terhubung/terputus/nonaktif (atau padanan Inggris),
  tanpa alamat IP/port. Terhubung membutuhkan backend sehat dan status reader segar.

## Master switch dan backfill

- Settings > WA Reader: switch berlaku untuk semua akun, termasuk view tersembunyi
  dan reader yang sudah diinjeksi. Default ON untuk settings lama; perubahan
  tersimpan di `settings.json` melalui backup settings yang sudah ada.
- OFF menolak capture baru di driver dan menghentikan capture serta history walk
  di halaman. Native history load yang sudah berjalan tidak bisa dibatalkan;
  hasilnya menunggu ON sebelum diproses. Queue durable tetap di-flush; arsip dan
  checkpoint tidak dihapus. WhatsApp, backend, dan Agent arsip tetap tersedia.
- Koneksi authenticated pertama dengan Reader ON otomatis memuat hingga 100 pesan
  terbaru per chat yang tersedia, atau semua jika lebih sedikit. Akun lama tanpa
  checkpoint backfill juga memenuhi syarat pada koneksi berikutnya. Checkpoint
  tersimpan dilanjutkan setelah restart / OFF lalu ON, tanpa sesi paralel;
  sesi initial yang selesai tidak dimulai ulang pada status koneksi berulang.
  Capture pesan live setelahnya tidak dibatasi 100 pesan.
- Reconnect dapat memulai backfill setelah offline >= 1 jam, dengan cooldown
  >= 6 jam. Mengaktifkan kembali switch tidak memperlakukan waktu OFF sengaja
  sebagai offline yang memicu backfill baru; checkpoint berjalan dapat dilanjutkan.
- Untuk meminta history: aktifkan Reader, tunggu akun terhubung, pilih akun di
  Settings > WA Reader, tekan Start / resume backfill dan konfirmasi. Pause backfill
  menghentikan walk tanpa membuang checkpoint. Batas default 100 pesan terbaru per chat;
  history yang tersedia di linked device/API internal WhatsApp dapat lebih sedikit.
  Ini bukan jaminan arsip lengkap dan tidak membuka chat atau menandai pesan dibaca.
- Arsip legacy tanpa kolom account tidak diimpor; atribusi akun tidak boleh ditebak.

## Aturan yang tidak boleh dilanggar

- Kode capture **read-only**: tidak ada send/type/click openChat/sendSeen/markRead
  dari kode kita. Interaksi manusia lewat embedded WA Web tidak termasuk larangan ini.
- Tidak pernah print token/nilai `.env` ke log.

## Verifikasi

- `curl -s 127.0.0.1:4317/health` → count per akun baru naik saat pesan masuk.
- Baca `userData/data/wa.sqlite` via SQLite read-only; filter account yang diuji.
- Server sekarang milik lifecycle internal; lihat [modul backend](modul_backend.md).
- `npm test` menguji settings/backup, driver multi-akun, queue, eligibility initial
  akun baru/lama, resume checkpoint, batas/urutan terbaru, dan history pendek.
- `node scripts/reader-smoke.js` menjalankan Electron dengan fixture lokal, userData
  sementara dan port ephemeral: toggle live, history in-flight, view tersembunyi,
  IPC, sesi initial otomatis, footer, queue drain, Agent/MCP, dan restart OFF.
  Fixture bukan bukti API history WhatsApp live; tidak memakai akun WhatsApp
  atau backend aplikasi yang sedang berjalan.
