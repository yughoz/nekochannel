# Modul Action — agent auto-reply dalam batas (M6, Kaneo #16)

> Status: **DIHAPUS 2026-11-20** atas permintaan user (fitur belum dibutuhkan):
> engine `shell/action.js`, tab ⚡ Action (`action.html`), bagian Settings, centang
> tray, IPC `action-get`/`action-master`, setting `action` dan tesnya. Yang tetap:
> primitive kirim `adapters/whatsapp/action.js` (`sendReply`, tes di
> `test/wa-send.test.js`) untuk tool `send_message` ([modul agent](modul_agent.md)).
> Kode lama ada di git history (commit `9be368b` dan sebelumnya). Dokumen di
> bawah adalah catatan historis.

## Ringkasan

Agent nekochannel bisa membalas pesan masuk secara otomatis (contoh: balas WA)
dalam batasan ketat. Semua switch default **OFF**: master switch + toggle per
akun, dua-duanya mati bawaan. Jalur capture (bridge/driver/reader inject) tidak
disentuh dan tetap read-only.

## Arsitektur

- `shell/action.js` — engine di main process: gating, antrean reply per chat,
  rate limit, pemanggilan LLM (loop sendiri), audit log, event ke UI.
- `adapters/whatsapp/action.js` — primitive kirim khusus WA: satu script
  `executeJavaScript` yang (1) validasi selector compose live di halaman,
  (2) buka chat target, (3) isi compose via native setter + input event
  (pola sama dengan login HP), (4) kirim. Bukan capture code — bridge/driver
  tidak diubah.
- Context chat: **tidak** lewat API chat server 4318 (itu loop agent lengkap,
  bukan API baca) dan **tidak** baca sqlite wa-reader (tidak ada endpoint baca
  di 4317; membuka DB dari luar menambah coupling). Engine menaruh rolling
  tail per chat dari stream `onMessages` yang sudah ada (hydrasi boot ≈ 50
  pesan/chat + live) — konsumen baru lewat callback yang sama, bukan instance
  driver kedua.
- Tab **Action** di sidebar samping tab Agent: WebContentsView lokal
  (`shell/action.html`) menampilkan status switch, transkrip, dan log eksekusi
  real-time (push IPC), tanpa pernah mem-block jalur capture.
- Config LLM memakai snapshot Agent Settings terenkripsi (fallback per-field Summary),
  diterapkan setelah restart manual; bukan `.env` wa-reader. Checkout legacy tidak diubah.

## Mode (disetujui 2026-11-18)

- AUTO dalam batas — tanpa approval per pesan.
- Text-only: tidak ada attachment/media/link otomatis (URL di balasan LLM
  dipangkas).
- Hanya reply ke chat dengan pesan masuk **terbaru** (pesan terakhir di chat
  itu incoming, `fromMe=false`), maksimal 10 menit setelah pesan masuk. Tidak
  ada cold-contact / nomor baru.
- Coalesce: chat yang dikirimi beberapa pesan beruntun dijawab sekali setelah
  hening 8 detik.
- Rate limit per akun: jeda antar kirim ≥ 30 detik, maks 20/jam, maks
  100/hari. (ponytail: angka hardcoded — cukup selama satu akun CS; jadikan
  setting kalau kebutuhan beda-beda.)
- View-busy: human aktif di akun itu (tab aktif + window fokus, atau ada
  ketikan keyboard di view akun ≤ 90 detik) → kirim ditunda, diulang dengan
  backoff, bukan dibuang.
- Audit log JSONL di `userData/action-log.jsonl`: waktu, akun, chat, aksi,
  isi, hasil.

## Keamanan

- Master switch default OFF; toggle per akun di Settings; kill switch cepat =
  checkbox tray (dan toggle di tab Action). Kill switch membatalkan antrean
  pending, bukan cuma berhenti menerima trigger baru.
- Verifikasi LLM gagal/konfig kosong → tidak ada kirim, hanya log.
- Selector compose WA Web tervalidasi live via CDP sebelum dipakai (lihat
  catatan verifikasi di bawah); script kirim selalu re-validasi selector saat
  eksekusi dan gagal aman kalau DOM berubah.

## Verifikasi (2026-11-19)

- Unit: `npm test` → **69/69 hijau** (engine gating/coalesce/rate/busy-give-up/
  sanitasi/audit + primitive sendReply via wc palsu).
- E2E di instance real (nomor bisnis 6282213009300, partisi asli, akun WA
  Business live):
  - **Master OFF (default)**: pesan masuk disintesis via CDP → nol action,
    nol audit. Settings.json tanpa key `action` = semua mati.
  - **Enable via IPC jalur Settings asli** (`saveSettings`) → persist.
  - **Kirim nyata**: trigger sintetis dari device sendiri (chat linked
    "iPad Yughoz", `156659720663213@lid`) → LLM (`glm-5.3-flash` via config
    Settings #10.1) → trusted input di WA Web → **terkirim & terverifikasi di
    koleksi chat** (`target: "iPad Yughoz"`), audit `result: sent`.
  - **Rate limit**: trigger kedua 10 detik kemudian → `skipped: rate-spacing`.
  - **Kill switch**: master OFF → trigger baru → audit tidak bertambah,
    antrean bersih. Settings direstore default OFF.
- Temuan E2E yang membentuk desain final:
  - WA Web memblok klik sintetis (guard `isTrusted`) → kirim wajib input
    trusted (`sendInputEvent`/`insertText`), tervalidasi via CDP.
  - `insertText` tidak menempel di view tersembunyi → saat kirim, tab akun
    diaktifkan dulu, dikembalikan setelah selesai (sekalian transparan).
  - Verifikasi kirim = pesan muncul di koleksi chat (read-only), bukan
    "compose kosong" (bisa false-positive).
  - Judul baris chat bisa berprefiks badge unread (`1 unread messageX`) →
    dinormalisasi saat pencocokan.
  - **Perbaikan 2026-11-20 — target kirim = JID**: E2E di atas memakai pesan
    sintetis yang `chat`-nya sudah JID. Pesan nyata dari normalize membawa
    NAMA chat ("Budi"), sehingga `sendReply` (cari baris lewat JID) gagal di
    `find-row` untuk kontak tersimpan. Engine kini mengambil JID dari ID pesan
    target (`fromMe_JID_id`, sama dengan resolver `send_message`), fallback ke
    `chat` yang sudah berbentuk JID; tanpa JID → `skipped: no-jid` sebelum LLM.
    Event/audit tetap memakai nama chat. Diuji unit (`test/action.test.js`),
    belum diuji ulang kirim nyata.
  - **Perbaikan 2026-11-20 — pencarian baris chat** (laporan: kirim ke
    `+62 856-9378-4939`, JID `…@lid`, gagal `find-row`): (1) judul kontak tak
    tersimpan = `formattedTitle` yang tidak pernah dicek; (2) fallback digit
    memakai digit LID dan `endsWith` pada seluruh teks baris; (3) chat list WA
    tervirtualisasi, baris di luar layar tidak ada di DOM; (4) `includes(pushname)`
    bisa memilih chat LAIN (salah penerima). Kini: judul baris harus PERSIS sama
    `formattedTitle`/`name`/`contact.name` atau nama chat arsip (hint), atau digit
    judul PERSIS sama nomor (`contact.phoneNumber`/JID `@c.us`/hint); tanpa
    pencocokan sebagian; bila belum terlihat, kontainer list di-scroll dari atas
    sampai ketemu (maks. 300 langkah). Bukti: `node scripts/send-smoke.js` kirim
    penuh dengan input trusted di DOM WA tiruan tervirtualisasi (target LID di
    posisi 121 + pengecoh); versi lama membuka chat pengecoh.
  - **Limitasi wa-reader (di luar scope M6)**: pesan keluar hasil action belum
    ter-capture ke DB wa-reader (watcher internal tidak memantau collection
    yang baru dibuat saat chat dibuka). Klaim "outgoing ter-capture otomatis"
    di task card belum berlaku; audit log engine = sumber kebenaran. Perlu
    task wa-reader terpisah kalau mau sinkron.
