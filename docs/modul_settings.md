# Modul Settings (#10, standalone #22)

Preferences disimpan di `userData/settings.json`: notifikasi, bahasa, dock/sidebar dan action master/per-account (default OFF). LLM disimpan terpisah di `userData/.env`, tidak lagi membaca/menulis checkout lain. File private 0600, bukan keychain/encrypted storage. Nilai key write-only di UI (hanya keySet).

`CHAT_MODEL_URL/NAME/KEY` dengan fallback opsional `SUMMARY_MODEL_*`. Restart aplikasi (quit dari tray) untuk menerapkan chat config. Form URL/model kosong mengosongkan override; key kosong menjaga yang lama. Reset menghapus ketiga CHAT_MODEL_* lokal. Environment proses tetap paling tinggi; file pilihan eksplisit via NEKOCHANNEL_ENV paling rendah setelah app-data `.env`.

`settings.js` tetap pure Node; UI di settings.html dengan trusted-sender IPC, i18n dari preload dan About versi/repo. Tidak ada kredensial yang dikirim balik ke renderer. Action memakai config lokal yang sama, capture tetap read-only.

Verifikasi: settings/i18n tests + backend config precedence; lifecycle dan real Electron smoke di [modul backend](modul_backend.md).
