'use strict';
// Lookup arsip READ-ONLY untuk Settings (Jadwal Agent): akun yang pernah terekam dan daftar
// grup (nama persis seperti dipakai tool get_chat_messages), urut aktivitas terbaru.
// Koneksi read-only terpisah; ingest tetap pemilik tulis (WAL → aman dibaca bersamaan).
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const GROUP_LIMIT = 300;
const CACHE_MS = 30_000;

function createArchiveLookup(dbPath, { now = Date.now } = {}) {
  let db = null;
  let cache = null;
  const open = () => {
    if (db) return db;
    if (!fs.existsSync(dbPath)) return null;
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000;');
    return db;
  };
  const read = () => {
    const conn = open();
    if (!conn) return { accounts: [], groups: [] };
    let accounts = [];
    try { accounts = conn.prepare("SELECT account, label FROM accounts WHERE account <> '' ORDER BY account").all(); } catch { /* arsip lama */ }
    let groups = [];
    try {
      groups = conn.prepare(`SELECT account, chat AS name, COUNT(*) AS messages, MAX(timestamp) AS last FROM messages
        WHERE isGroup = 1 AND chat IS NOT NULL AND chat <> '' GROUP BY account, chat ORDER BY last DESC LIMIT ${GROUP_LIMIT}`).all();
    } catch { /* arsip kosong */ }
    return {
      accounts: accounts.map(row => ({ account: String(row.account), label: String(row.label || '') })),
      groups: groups.map(row => ({ account: String(row.account), name: String(row.name), messages: Number(row.messages) || 0, last: row.last || null })),
    };
  };
  return {
    snapshot() {
      if (cache && now() - cache.at < CACHE_MS) return cache.value;
      let value;
      try { value = read(); } catch { value = { accounts: [], groups: [] }; }
      cache = { at: now(), value };
      return value;
    },
    invalidate() { cache = null; },
    close() { try { db?.close(); } catch { /* sudah tutup */ } db = null; },
  };
}

module.exports = { createArchiveLookup, GROUP_LIMIT };
