# Modul Agent (tab chat)

## Tanggung jawab

Menyediakan UI tanya-jawab ke arsip WA (ringkasan grup, search pesan) di dalam app,
tanpa menulis ulang satu baris pun logika agent.

## Desain

- Tab "Agent" = `WebContentsView` kedua yang load `http://127.0.0.1:4318`
  (chat server wa-reader). Nanti kalau ada channel lain dengan DB sendiri, agent
  tetap satu pintu — tool per channel ditambahkan di chat server. UI asli tetap tanggung jawab wa-reader (milestone M3
  di sana); begitu UI-nya naik, tab ini otomatis ikut bagus.
- Bila chat server mati/belum jalan: tampilkan halaman error statis internal
  ("chat server belum jalan") + tombol retry. Deteksi: gagal load / health 4318.
- Nekochannel tidak memanggil API chat sendiri dan tidak menyimpan riwayat chat —
  semua di sisi chat server.

## Dock kanan (#11)

Tombol ◫ di baris Agent: chat agent nempel di kanan (45% lebar konten), akun
aktif tetap kelihatan di kiri — CS agent bisa lihat lagi buka apa di nomor wa
mana sambil chatting. Klik baris Agent saat dock = balik ke tab penuh. State
persist di `settings.json` (`agentDock`) dan ikut restore-on-boot. Tanpa akun
terdaftar, dock otomatis jatuh ke tab penuh. Perhitungan
bounds murni (`splitBounds` di `shell/agent.js`) + toggle di main
(`setAgentDock`) + tombol di sidebar renderer.

## Syarat jalan

- Chat server hidup: `CHAT_MODE=fc node --experimental-sqlite chat/server.js`
  dari repo wa-reader (sampai unit `wa-reader-chat.service` dibuat di sana — M5).

## Ponytail

Jika nanti butuh agent yang sadar-konteks app (mis. "akun mana yang unread
paling banyak" digabung status app), baru tambahkan tool kecil di chat server.
Sekarang tidak.
