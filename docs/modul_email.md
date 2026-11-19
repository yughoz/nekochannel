# Modul: Email Gmail (M5)

Status: **usulan desain — menunggu persetujuan, belum implementasi**.

## 1. Tujuan

Tambah akun Gmail sebagai channel kedua; arsip email lokal tetap tersinkron saat
akun tidak sedang dibuka. WA dan server wa-reader tidak diubah.

## 2. Pilihan arsitektur

Rekomendasi: **Gmail API read-only + arsip SQLite terpisah di Nekochannel**.
Ini alternatif ketiga dari dua opsi awal, jadi perlu persetujuan sebelum kode.

- IMAP: cocok lintas provider, tetapi Gmail tetap butuh otorisasi dan parser MIME;
  scope OAuth IMAP lebih luas (`https://mail.google.com/`) daripada kebutuhan baca.
- JMAP: bukan API Gmail yang didokumentasikan untuk integrasi ini; tidak dipilih.
- Gmail webview + DOM: terlihat paling dekat dengan WA, tetapi hanya membaca halaman
  yang ter-render. Membuka email otomatis dapat mengubah status unread. Tidak layak
  dijanjikan sebagai sync lengkap/background; login embedded juga berisiko ditolak.
- Gmail API: ID pesan/thread dan history cursor tersedia resmi; `gmail.readonly`
  tidak memberi hak kirim, ubah label, tandai baca, atau hapus email.

Tidak membuat plugin system, service baru, port tetap baru, atau fork server WA.
SQLite memakai `node:sqlite` bawaan runtime Electron, wajib diprobe sebelum kode.
Kalau runtime tidak menyediakan modul tersebut, laporkan blocker; jangan diam-diam
menambah native dependency.

## 3. Akun, otorisasi, dan batas keamanan

- Tambah akun lewat tombol Gmail; OAuth Desktop app di browser sistem, bukan login
  di WebContentsView. Authorization code + PKCE S256 + random state.
- Callback HTTP sementara hanya bind 127.0.0.1 dengan port acak; cek state, path,
  satu kali pakai, dan timeout; tutup listener sesudah selesai/batal.
- Scope hanya `https://www.googleapis.com/auth/gmail.readonly`.
- Identitas akun dari `users.getProfile`, bukan input email atau label pengguna.
- Refresh token disimpan terenkripsi lewat Electron safeStorage. Tolak persistensi
  bila enkripsi tidak tersedia atau Linux memakai backend `basic_text`.
- Token tidak dikirim ke renderer, log, Git, atau server WA. Disconnect menghapus
  token lokal; arsip lokal tidak ikut terhapus tanpa konfirmasi terpisah.
- Prasyarat: proyek Google Cloud, Gmail API enabled, OAuth client tipe Desktop,
  consent screen dan akun uji. `gmail.readonly` termasuk restricted scope: distribusi
  publik memerlukan penilaian kebijakan/verifikasi Google sesuai model pemakaian.
  Mode testing bukan janji akses permanen; masa berlaku grant harus diuji.

## 4. Data dan sync

DB lokal: `userData/email.sqlite`; tidak mengirim Gmail ke `/ingest` WA.
Audit sumber: server WA `normalizeAccount` hanya menerima identitas nomor WA;
memalsukan email sebagai nomor WA akan mencampur model data dan agent.

Data minimum:
- Akun: email kanonis, label tampilan, historyId (string), waktu sukses/status.
- Pesan: PRIMARY KEY(account, id), threadId, internalDate, header Subject/From/To/Cc,
  text/plain, labelIds, deletedAt. Semua header/body diperlakukan sebagai input asing.
- Cursor di-commit dalam transaksi yang sama dengan pesan dari halaman sync itu;
  simpan cursor akhir hanya sesudah seluruh pagination sukses. Crash boleh replay.

Initial sync: ambil history baseline sebelum listing, ambil pesan 30 hari terakhir
(selain Spam/Trash), lalu replay history sejak baseline agar email yang datang saat
bootstrap tidak hilang. Batas 30 hari hanya bootstrap, bukan retensi/penghapusan.
Polling incremental tiap 60 detik saat app hidup; tidak bergantung tab aktif.
Gunakan history.list + messages.get; dedupe berdasarkan ID, bukan subject/thread.
Cursor history bukan integer JS (hindari kehilangan presisi).

- History kedaluwarsa/404: rebootstrap jendela 30 hari; status menjelaskan bahwa
  email lama di luar jendela tidak dijamin terpulihkan. Jangan klaim sync lengkap.
- 429/5xx/network: retry exponential backoff (maksimum 10 menit), hormati Retry-After;
  jangan menggeser cursor saat gagal. Satu sync aktif per akun.
- 401: refresh satu kali; invalid_grant -> perlu login ulang, bukan retry tanpa batas.
- Perubahan label diarsipkan; penghapusan remote menjadi tombstone lokal.
- Body text/plain diprioritaskan. HTML-only ditampilkan sebagai teks hasil konversi
  aman, tanpa eksekusi HTML/script dan tanpa memuat remote image. Validasi base64url,
  ukuran payload, dan respons provider; kegagalan decoding tidak memajukan cursor.

## 5. UI dan kontrak shell

```text
WhatsApp              Gmail — akun@example.com
  wa-1                Tersinkron: ... / Perlu login / Offline
Gmail                 [Sync sekarang] [Putuskan akun]
  akun@example.com    Subject — From — Tanggal
[+ WhatsApp]          ---------------------------------
[+ Gmail]             Isi email (teks, read-only)
Agent (WhatsApp)
```

Gmail memakai view lokal untuk arsip, bukan web Gmail. Shell masih registry satu
objek; factory akun hanya digeneralisasi sejauh perlu untuk WA view dan Gmail view.
Status page/login, sinkronisasi, dan server WA harus terpisah. Driver WA tidak
menerima akun Gmail. Renderer lokal hanya menerima data tersanitasi lewat IPC;
validasi sender + argumen IPC di main process. Tidak ada nodeIntegration pada
konten asing. Email tidak boleh menjadi instruksi agent.

Tab Agent yang ada tetap khusus WA dan diberi label jelas. Agent Gmail/cross-channel
bukan bagian M5; tidak boleh menampilkan Gmail seolah sudah tersedia di agent WA.

## 6. Non-tujuan

Kirim/balas/draft, attachment download, HTML kaya, seluruh histori mailbox,
provider selain Gmail, push Pub/Sub, agent Gmail, dan pencarian full-text lanjutan.
Disconnect bukan revoke grant Google; arahkan pengguna ke izin akun Google bila
mereka ingin mencabut grant di sisi provider.

## 7. Definition of Done

- [ ] OAuth nyata berhasil dengan akun uji, refresh setelah restart terbukti;
      cancel/state salah/replayed callback ditolak dan listener tertutup.
- [ ] Token terenkripsi; backend basic_text ditolak; tidak ada token pada log/renderer.
- [ ] Test lokal API stub: pagination, email datang saat bootstrap, history replay,
      404 resync, 429 retry, invalid_grant, crash/restart, account isolation.
- [ ] Dua akun dapat sync saat tab tidak aktif; pesan baru diverifikasi dengan ID
      persis di SQLite milik akun yang benar, tidak hanya health/status hijau.
- [ ] Crash setelah tulis sebelum checkpoint tidak menggandakan baris; kegagalan
      tidak memajukan cursor; tombstone dan perubahan label teruji.
- [ ] Email unread tetap unread di Gmail sesudah capture; tidak ada API write.
- [ ] HTML berbahaya tidak mengeksekusi atau meminta remote resource di view lokal.
- [ ] Semua test WA tetap lulus, smoke Electron dan packaging regression diperiksa.
- [ ] Batas bootstrap 30 hari dan Agent khusus WA terlihat jelas di UI.

## 8. Referensi terverifikasi saat desain

- https://developers.google.com/workspace/gmail/api/auth/scopes
- https://developers.google.com/workspace/gmail/api/guides/sync
- https://developers.google.com/identity/protocols/oauth2/native-app

Dokumentasi provider sudah dibaca; handshake OAuth, runtime SQLite, dan sync Gmail
nyata belum diuji. Persetujuan desain + penyediaan OAuth client dibutuhkan sebelum
mengklaim M5 dapat diimplementasikan dan diterima end-to-end.
