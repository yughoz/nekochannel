# Modul Agent (tab chat)

Tab Agent memuat chat UI internal `backend/chat/ui` melalui WebContentsView; tidak perlu server/repo wa-reader eksternal. Server dimulai oleh lifecycle app sesudah ingest membuka SQLite. Tool SQL read-only dipakai ulang dari `backend/mcp`, function calling dengan fallback stuffing, output SSE. Riwayat percakapan ada di memori halaman chat (hilang saat view dimuat ulang/restart); arsip pesan berada di SQLite lokal, bukan riwayat percakapan provider.

**Sesi per channel (2026-11-20):** tiap akun di sidebar punya sesi chat sendiri. `setActive` mencatat akun terakhir; `syncAgentSession` (dipanggil tiap `broadcast`) mengirim `{ key: id akun, label, account: JID }` ke view lewat hash URL (`#s=whatsapp-1&label=…&account=…`) tanpa reload; `shell/agent.js` membawa hash yang sama saat memuat ulang. UI (`backend/chat/ui/app.js`) menyimpan riwayat + panel DOM per sesi: pindah tab = ganti panel, jawaban yang masih streaming tetap masuk ke sesi asalnya, tombol Bersihkan hanya untuk sesi aktif, header menampilkan label (disamarkan bila privasi label akun aktif). Tab Agent penuh melanjutkan sesi akun terakhir. Request membawa `account`; server menambahkan "Sesi ini untuk akun …" ke prompt hanya bila JID `@c.us` tercatat di tabel `accounts` (label dari arsip), sebagai default akun pencarian/`send_message`. Bukti: `node scripts/agent-session-smoke.js`.

LLM diatur di Settings terenkripsi (Agent, fallback per-field Summary), bukan `.env`; quit dari tray/restart untuk menerapkan. Tanpa provider, UI tersedia dan chat mendapat 503; health `configured:false`. Probe provider hanya saat chat eksplisit pertama. Jika layanan gagal, cek port lokal, bukan menjalankan repo lain. View memantau health dan mencoba kembali setelah crash.

Dock #11: tombol ◫ menempatkan Agent di kanan (45% konten), akun aktif kiri. Klik Agent kembali ke tab penuh; `settings.json:agentDock` persist. Tanpa akun jatuh tab penuh. `splitBounds` di shell/agent.js tetap murni dan teruji.

## WA Engine: tool `send_message`

UI chat berjudul **WA Engine**. Selain tool baca arsip, Agent dan MCP punya `send_message` (`chat` = nama chat persis dari arsip, `text` maks. 2000 karakter, `account` opsional bila chat ada di beberapa akun). Tool hanya terdaftar bila app menyuntik `sendMessage` ke `startBackend`; backend standalone tetap read-only.

- Target di-resolve read-only dari tabel `chats` (JID + nomor WA + nama, lihat [modul backend](modul_backend.md)): `chat` boleh nama persis (nama terbaru atau lama), nomor WA (`62…`/`0…`) atau JID; arsip lama tanpa tabel itu memakai JID dari ID pesan WA (`fromMe_JID_id`). Nomor tersimpan ikut dipakai mencocokkan baris chat dan tampil di dialog. Newsletter/broadcast, chat tanpa ID WA, nama ambigu (beberapa JID) dan chat multi-akun tanpa `account` ditolak sebelum ada dialog.
- **Saklar Settings > LLM Agent "Izinkan Agent & MCP mengirim pesan", default OFF** (`settings.json:sendEnabled`, hanya bisa diubah manual lewat UI Settings; dibaca live). OFF: Agent tidak ditawari tool ini dan prompt menyuruhnya memberi tahu user untuk menyalakannya manual; panggilan yang tetap masuk (Agent/MCP) mendapat `status: disabled` tanpa membaca arsip atau membuka dialog.
- Tiap kirim **wajib dikonfirmasi** lewat dialog native Nekochannel (Dari/Ke/sumber Agent atau MCP/isi). Batal atau tidak dijawab 2 menit = `cancelled`; hanya satu dialog sekaligus, permintaan lain `failed`. Alasan: isi arsip dari pihak lain bisa berisi instruksi (prompt injection), dan server chat lokal tanpa auth.
- Setelah disetujui, kirim memakai primitive `waAction.sendReply` (`adapters/whatsapp/action.js`, input trusted di view akun, verifikasi pesan muncul di koleksi chat). Akun harus terbuka dan terhubung, app tidak terkunci.
- Audit: `action-log.jsonl` (`action:"send"`, `source`, `result` sent/cancelled/error; nama file historis). Isi pesan tidak masuk console.
- Verifikasi: unit `backend/mcp/server.test.js`, `backend/chat/server.test.js`; Electron `node scripts/send-smoke.js` (dialog di-stub; kirim penuh dengan input trusted di DOM WA tiruan tervirtualisasi, target LID di luar layar + kontak pengecoh). Pengiriman ke WhatsApp sungguhan tidak diuji otomatis.

Lifecycle/config/migrasi: [modul backend](modul_backend.md). Backend saat ini WA-only; Gmail/cross-channel belum diimplementasikan.
