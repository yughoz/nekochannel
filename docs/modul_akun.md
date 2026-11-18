# Modul Akun & Channel (shell app)

## Tanggung jawab

Window utama: sidebar daftar akun (dikelompokkan per channel), area WebContentsView,
tab agent, status badge. Account selalu punya `channel` (`whatsapp` sekarang; `email`
nanti) dan shell mendelegasikan perilaku ke adapter channel-nya.

## UI

- Sidebar kiri: grup per channel → daftar akun (label + status dot), tombol
  `+ Add akun` per channel, tombol tab Agent.
- Kanan: `WebContentsView` akun aktif, atau tab agent.
- Status per akun: `connected` / `QR pending` / `reconnecting` + dot health server (4317).

## Perilaku kunci

- Add akun → adapter channel menyiapkan partition `persist:<channel>-<n>`
  (n = index akun per channel, stabil) + load URL layanan (WA: `web.whatsapp.com`).
  QR tampil di dalam view sendiri; user scan dari HP.
  Session persist otomatis di partition — QR cuma sekali.
- Channel lain (email nanti): add = isi alamat/akun, tanpa QR — detail di adapter-nya.
- Label akun diedit manual (default `wa-1` dst), dikirim ke `/ingest` sebagai `label`.
- **Semua view live simultan**, bukan destroy saat ganti tab — capture harus jalan
  untuk semua akun. Setiap view: `backgroundThrottling:false` dan timer/rAF-nya
  tidak di-throttle saat hidden.
- Deteksi status: cek presence chat list vs QR screen via `executeJavaScript`
  ringan (sekali per 30s per akun), bukan scraping berat.
- Channel `whatsapp`: ganti UA per session — spoof full Chrome (buang kata
  `Electron`) — WA Web kadang ngerespons beda ke UA Electron. Perilaku UA = bagian
  adapter, bukan shell.

## Tidak ada

- Manajemen proxy, multi-profil OS, enkripsi session ekstra (partition Electron
  sudah di-disk dengan permission user yang sama).
- Import session dari Chrome (QR ulang saja, sekali).

## Kontrak dengan modul lain

- Menyerahkan `WebContentsView` + `account` + `label` ke modul capture.
- Menerima status koneksi/health dari main process untuk badge.
