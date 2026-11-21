'use strict';
// Persistensi sesi chat WA Engine (#30). Koneksi TULIS terpisah ke wa.sqlite —
// koneksi arsip untuk tool tetap read-only (query_only). Satu baris per sesi
// (tabKey = sesi tab/akun dari UI); isi = riwayat tampilan + cache ringkasan
// compaction. Tanpa secret. Bersihkan = salin ke backup lalu hapus.
const { DatabaseSync } = require('node:sqlite');

const MAX_STORED_MESSAGES = 200; // riwayat tampilan yang disimpan per sesi
const MAX_BACKUPS = 20;
const KEY_RE = /^[\w.:@-]{1,64}$/;

const validKey = key => typeof key === 'string' && KEY_RE.test(key);

function openSessions(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS chat_sessions (
    tabKey TEXT PRIMARY KEY, account TEXT NOT NULL DEFAULT '', updatedAt INTEGER NOT NULL,
    history TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '', summarizedCount INTEGER NOT NULL DEFAULT 0, summaryHash TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS chat_session_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tabKey TEXT NOT NULL, account TEXT NOT NULL DEFAULT '', clearedAt INTEGER NOT NULL, history TEXT NOT NULL, summary TEXT NOT NULL DEFAULT ''
  );`);
  const getStmt = db.prepare('SELECT tabKey, account, updatedAt, history, summary, summarizedCount, summaryHash FROM chat_sessions WHERE tabKey = ?');
  const upsert = db.prepare(`INSERT INTO chat_sessions (tabKey, account, updatedAt, history, summary, summarizedCount, summaryHash) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tabKey) DO UPDATE SET account = excluded.account, updatedAt = excluded.updatedAt, history = excluded.history,
      summary = excluded.summary, summarizedCount = excluded.summarizedCount, summaryHash = excluded.summaryHash`);
  const backup = db.prepare('INSERT INTO chat_session_backups (tabKey, account, clearedAt, history, summary) SELECT tabKey, account, ?, history, summary FROM chat_sessions WHERE tabKey = ?');
  const prune = db.prepare(`DELETE FROM chat_session_backups WHERE id NOT IN (SELECT id FROM chat_session_backups ORDER BY id DESC LIMIT ${MAX_BACKUPS})`);
  const remove = db.prepare('DELETE FROM chat_sessions WHERE tabKey = ?');
  const parse = text => { try { const value = JSON.parse(text); return Array.isArray(value) ? value : []; } catch { return []; } };
  return {
    get(key) {
      if (!validKey(key)) return null;
      const row = getStmt.get(key);
      return row ? { ...row, history: parse(row.history) } : null;
    },
    save(key, { account = '', history = [], summary = '', summarizedCount = 0, summaryHash = '' } = {}, now = Date.now()) {
      if (!validKey(key)) return false;
      const kept = history.filter(item => (item?.role === 'user' || item?.role === 'assistant') && typeof item.content === 'string')
        .slice(-MAX_STORED_MESSAGES).map(({ role, content }) => ({ role, content }));
      upsert.run(key, String(account).slice(0, 64), now, JSON.stringify(kept), String(summary), Math.max(0, summarizedCount | 0), String(summaryHash));
      return true;
    },
    clear(key, now = Date.now()) {
      if (!validKey(key)) return false;
      backup.run(now, key);
      prune.run();
      return remove.run(key).changes > 0;
    },
    backups(key) { return validKey(key) ? db.prepare('SELECT id, clearedAt FROM chat_session_backups WHERE tabKey = ? ORDER BY id DESC').all(key) : []; },
    close() { try { db.close(); } catch { /* sudah tutup */ } },
  };
}

module.exports = { openSessions, validKey, MAX_STORED_MESSAGES, MAX_BACKUPS };
