# Modul Agent (tab chat)

Tab Agent memuat chat UI internal `backend/chat/ui` melalui WebContentsView; tidak perlu server/repo wa-reader eksternal. Server dimulai oleh lifecycle app sesudah ingest membuka SQLite. Tool SQL read-only dipakai ulang dari `backend/mcp`, function calling dengan fallback stuffing, output SSE. Riwayat percakapan UI berada di localStorage view; arsip pesan berada di SQLite lokal, bukan riwayat percakapan provider.

LLM diatur di Settings terenkripsi (Agent, fallback per-field Summary), bukan `.env`; quit dari tray/restart untuk menerapkan. Tanpa provider, UI tersedia dan chat mendapat 503; health `configured:false`. Probe provider hanya saat chat eksplisit pertama. Jika layanan gagal, cek port lokal, bukan menjalankan repo lain. View memantau health dan mencoba kembali setelah crash.

Dock #11: tombol ◫ menempatkan Agent di kanan (45% konten), akun aktif kiri. Klik Agent kembali ke tab penuh; `settings.json:agentDock` persist. Tanpa akun jatuh tab penuh. `splitBounds` di shell/agent.js tetap murni dan teruji.

Lifecycle/config/migrasi: [modul backend](modul_backend.md). Backend saat ini WA-only; Gmail/cross-channel belum diimplementasikan.
