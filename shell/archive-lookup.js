'use strict';
// Lookup arsip READ-ONLY untuk Settings (Jadwal Agent): akun yang pernah terekam dan daftar
// grup (nama persis seperti dipakai tool get_chat_messages), urut aktivitas terbaru.
// Koneksi read-only terpisah; ingest tetap pemilik tulis (WAL → aman dibaca bersamaan).
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const GROUP_LIMIT = 300;
const MESSAGE_LIMIT = 500; // per grup per run jadwal (#33)
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
    // #33: pesan satu grup untuk run jadwal — nama PERSIS, filter akun (kosong = semua akun),
    // rentang [since, until], khusus grup. Urut lama→baru; truncated = ada lebih dari limit.
    groupMessages({ chat, account = '', since, until, limit = MESSAGE_LIMIT }) {
      const conn = open();
      if (!conn || !chat) return { messages: [], total: 0, truncated: false };
      const where = 'chat = ? AND isGroup = 1 AND timestamp >= ? AND timestamp <= ?' + (account ? ' AND account = ?' : '');
      const params = [chat, since, until, ...(account ? [account] : [])];
      const total = Number(conn.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where}`).get(...params).n) || 0;
      const rows = conn.prepare(`SELECT sender, text, timestamp, fromMe, mentionsMe, replyToMe FROM messages WHERE ${where} ORDER BY timestamp DESC LIMIT ?`).all(...params, limit);
      return {
        messages: rows.reverse().map(row => ({ sender: String(row.sender || ''), text: String(row.text || ''), timestamp: row.timestamp, fromMe: !!row.fromMe, mentionsMe: !!row.mentionsMe, replyToMe: !!row.replyToMe })),
        total, truncated: total > rows.length,
      };
    },
    close() { try { db?.close(); } catch { /* sudah tutup */ } db = null; },
  };
}

module.exports = { createArchiveLookup, GROUP_LIMIT, MESSAGE_LIMIT };
