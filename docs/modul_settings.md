# Modul Settings (#10)

Menu pengaturan Nekochannel: LLM custom, notifikasi, bahasa, dan About.

## Prinsip

- **LLM custom tanpa ubah server**: chat server wa-reader membaca
  `CHAT_MODEL_URL/NAME/KEY` (fallback `SUMMARY_MODEL_*`) dari `.env` wa-reader
  saat start. Settings hanya **menulis file itu** — server tidak pernah disentuh
  (boundary PRD). Path default `~/Projects/wa-reader/.env`, override lewat env
  `NEKOCHANNEL_WAREADER_ENV` (dipakai juga untuk E2E terisolasi).
- Efek baru terasa setelah **restart chat server** (env dibaca saat start);
  UI menampilkan model aktif dari `/api/health` 4318 sebagai konfirmasi.

## Struktur

- `shell/settings.js` — murni Node: store `userData/settings.json`
  (hanya `notif` + `lang`; nilai LLM tidak pernah persist di sini) dan
  baca/tulis baris `CHAT_MODEL_*` di `.env` (baris/urutan lain utuh;
  `null` = hapus baris; API key tidak pernah dibalikkan, hanya tanda keySet).
- `shell/i18n.js` — kamus copy UI id/en satu tempat; `t(lang, key)`.
  Main process (tray, detail status, halaman error agent) + renderer
  (sidebar, jendela settings) memakai kamus yang sama (preload `sendSync`
  sekali saat load).
- `shell/settings.html` — jendela settings (BrowserWindow modal-ish, preload sama,
  sender ikut daftar tepercaya). Link GitHub dibuka via `shell.openExternal`.
- Sidebar: baris ⚙ Pengaturan di bawah tab Agent; tray dapat item Pengaturan.

## Semantik form LLM

- URL/model kosong saat simpan → baris dihapus → fallback `SUMMARY_MODEL_*`.
- API key write-only: kosong = tetap pakai yang tersimpan; "Pakai bawaan
  wa-reader" (dua klik) menghapus ketiga baris `CHAT_MODEL_*`.

## Verifikasi

- `npm test` (test/settings.test.js, test/i18n.test.js, agent lang).
- E2E instance terisolasi (`XDG_CONFIG_HOME` + `NEKOCHANNEL_WAREADER_ENV`
  menunjuk file sementara): simpan/reset LLM, ganti bahasa, toggle notif,
  About menampilkan versi + link.
