# PRD — Nekochannel

Desktop **channel hub**: banyak akun dari banyak layanan pesan (channel) dalam satu
app — WhatsApp duluan, berikutnya email, dst — dengan reader + agent terpasang.
Pengganti total Chrome+extension wa-reader sebagai capture front-end untuk WA.
Server wa-reader tetap jalan apa adanya; app ini cuma ngereplace jalur Chrome.

Referensi pattern: Ferdium (github.com/ferdium/ferdium-app) — satu window Electron,
tiap akun = webview + session partition `persist:` terpisah. Ferdium cuma embed
webview; beda kita: ada **lapisan data** (reader → SQLite) + **agent** per channel.
Ambil pattern-nya saja — bukan fork (codebase React+MobX+recipes+sync server,
mayoritas tidak relevan).

## Konsep channel & adapter

- **Channel** = satu jenis layanan: `whatsapp`, nanti `email` (Gmail), dst.
- **Adapter per channel** = modul yang tahu cara: (1) load URL layanan di
  WebContentsView + partition, (2) inject reader, (3) deteksi status koneksi,
  (4) arahkan data ke target ingest masing-masing.
- Kontrak adapter sengaja **tidak** diformalkan jadi plugin system. Struktur kode:
  `adapters/whatsapp/` + registry satu objek JS. Bentuk final interface baru
  dirancang saat adapter kedua dikerjakan — jangan over-engineer sebelum ada
  pemakai kedua.
- Email adapter M5: [usulan desain Gmail](modul_email.md) merekomendasikan Gmail
  API read-only + SQLite lokal terpisah. Belum disetujui atau diimplementasikan;
  perbandingan IMAP/JMAP vs webview dan batas penerimaan ada di modul tersebut.

## Latar belakang

Sekarang capture WA lewat Chrome + extension MV3. Pain point yang sudah dibuktikan:

- Service worker MV3 bisa jalan kode lama walau browser sudah restart (cache SW) —
  debugging-nya mahal (kasus group-members 2026-11-17).
- Chrome harus jalan terus dengan tab WA Web terbuka, per akun = satu profile Chrome.
- Nggak ada UI terpusat untuk banyak akun.

## Tujuan

1. Bisa add 2–5 akun WA, tiap akun session persist (QR sekali, selamanya).
2. Reader jalan di semua akun secara simultan (bukan cuma akun yang aktif dilihat),
   data masuk ke SQLite wa-reader yang sama lewat `/ingest` yang sama.
3. Nol Chrome: Chromium-nya dibawa Electron.
4. Tab agent chat (tanya ringkasan grup / search) langsung di dalam app.
5. Queue + backfill checkpoint pindah ke main process Node — hilangkan kelas bug MV3.
6. Struktur siap nambah channel baru tanpa refactor besar (tanpa plugin system).

## Non-tujuan

- Fork atau modify server wa-reader, MCP, chat server (tetap upstream).
- Kode capture bisa kirim pesan / auto-reply (aturan read-only wa-reader tetap berlaku;
  user manusia tetap boleh chat manual via embedded WA Web — itu bukan kode capture).
- Plugin marketplace ala Ferdium recipes.
- Headless/VPS 24/7 (app desktop; dev + pemakaian harian di lelevo).
- 20+ akun (kalau nanti perlu, baru pikirkan memory management serius).
- Agent Gmail/cross-channel, pengiriman email, dan full-mailbox sync (di luar M5).
- Action di luar balasan teks WA (attachment/media/link, cold-contact, chat grup
  tanpa mention) — M6 sengaja text-only reply ke pesan masuk terbaru.

## Arsitektur

```
┌─ Nekochannel (Electron, satu window) ─────────────────────────┐
│ sidebar akun  │ WebContentsView akun aktif (per channel)      │
│               │ tab agent (webview → 127.0.0.1:4318)          │
│                                                               │
│ main process: adapters/whatsapp + queue durable + flush       │
└──────────────────────────────┬─────────────────────────────────┘
                               ▼
server wa-reader 127.0.0.1:4317 → data/wa.sqlite → chat 4318 / MCP 4319 (unchanged)
```

- Reader WA: `page-main.js` + `normalize.js` wa-reader dipakai ulang hampir mentah,
  inject via `webContents.executeJavaScript` (main world, setara MAIN world Chrome).
- `content.js` + `background.js` **tidak dibawa** — perannya diganti preload IPC +
  main process (queue, flush, backfill driver). Ini yang mematikan kelas bug SW cache.
- Kontrak ingest tetap: `POST /ingest {account, label?, messages[]}`,
  dedupe `PRIMARY KEY(account,id)` → replay aman. Loopback = trusted tanpa token.

## Stack

- Electron (Chromium pinned versi stabil), repo `~/Projects/nekochannel`.
- **Target rilis 3 OS: Linux, macOS, Windows** — packaging electron-builder (masuk M4).
  Chromium di-pin per rilis: engine sama persis di semua OS, versi dikontrol kita.
- Kenapa Electron, bukan Tauri v2: Tauri = 3 engine berbeda (Windows WebView2,
  macOS WKWebView, Linux WebKitGTK) yang versinya auto-update ngikut OS dan gak
  bisa dipin → reader hook harus tervalidasi 3× dan bisa rusak beda-beda per OS
  saat engine ikut berubah. Electron: validasi sekali, jalan di mana-mana, CDP
  debugging sama di semua platform. Trade-off yang diterima: binary ~150MB lebih
  besar; RAM 2–5 webview tetap aman untuk desktop.
- Vanilla JS, Node ≥22. Tanpa framework UI (sidebar + tab itu UI kecil).
- Struktur: `adapters/<channel>/` + `shell/` (window, sidebar, tab agent) + registry
  satu objek.
- Sync reader source: script copy dari `~/Projects/wa-reader` (`npm run sync-reader`)
  — satu sumber kebenaran tetap wa-reader; kalau drift menyakitkan, naikkan ke submodule.
- Queue durable: file JSONL per akun di userData (ponytail: cukup sampai 5 akun;
  naik ke `node:sqlite` kalau queue sering jutaan baris).

## Milestone

| M | Isi | Verifikasi |
|---|-----|------------|
| M0 | Scaffold Electron + adapters/whatsapp: 1 akun + inject reader + flush `/ingest` | count sqlite `messages` naik; `/health` per-account count muncul |
| M1 | Multi-akun: sidebar per channel, add via QR, partition persist, semua view live + `backgroundThrottling:false` | 2 akun paralel dua-duanya ke-capture saat tidak aktif |
| M2 | Queue durable JSONL + retry + backfill driver (checkpoint main process) + badge health | matikan server → queue menumpuk → nyalakan → ter-flush tanpa duplikat |
| M3 | Tab agent: webview ke `127.0.0.1:4318`, fallback error + retry kalau server mati | tanya ringkasan grup dari UI, jawaban datang dari DB sync |
| M4 | Tray (capture tetap jalan), autostart login, dark mode, packaging electron-builder Linux/macOS/Windows | reboot → app hidup sendiri → capture jalan tanpa sentuhan; installer 3 OS ter-build |
| M5 | Adapter email Gmail — [desain usulan](modul_email.md), menunggu persetujuan sebelum kode | OAuth nyata, sync background dua akun, cursor crash-safe, unread tetap, regresi WA |
| M6 | Agent action: auto-reply WA dalam batas, default OFF — [modul action](modul_action.md) | E2E di atas: kirim nyata terverifikasi koleksi, rate limit, kill switch, settings balik OFF |

## Risiko

- WA Web update nama module internal (`WAWebCollections` dll) → reader hook rusak.
  Risiko yang sama dengan wa-reader sekarang; path fix sama (sinkron dari repo wa-reader).
- WA Web bisa rewel terhadap UA Electron → spoof UA ke Chrome penuh per session.
- Generalisasi prematur → plugin system yang gak terpakai. Mitigasi: registry satu
  objek + folder adapter; interface final menyusul saat email adapter dikerjakan.
- Ban risk setara wa-reader di Chrome: ini tetap linked-device WA Web yang di-read-only.
- Memory: 2–5 WebContentsView ≈ 1–1,5 GB. Aman untuk lelevo.

## Keputusan terbuka

- Nama **Nekochannel** — fix (usulan user).
- M5: setujui/revisi rekomendasi Gmail API read-only; OAuth client dan akun uji
  belum diverifikasi. Lihat [modul email](modul_email.md).
- Chrome lama + extension: setelah M2 stabil, extension dimatikan untuk akun yang
  sudah pindah supaya tidak double-capture (dedupe bikin aman sih, tapi redundant).
