'use strict';
// Main-process capture driver — the Electron replacement for the MV3 service
// worker. Pure Node (no electron imports) so it is unit-testable standalone.
// Durability model: append-before-ack, rotate-on-flush, delete-on-accepted;
// at-least-once is safe because the server dedupes on PRIMARY KEY(account,id).
const fs = require('node:fs');
const path = require('node:path');

const normalizeAccount = value => {
  const match = /^(\d+)(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/i.exec(typeof value === 'string' ? value.trim() : '');
  return match ? `${match[1]}@c.us` : '';
};
const validMessage = message =>
  message && typeof message === 'object' &&
  ['id', 'chat', 'sender', 'text', 'timestamp'].every(key => typeof message[key] === 'string') &&
  message.id.length > 0 && message.id.length <= 1024 && message.chat.length <= 4096 &&
  message.sender.length <= 4096 && message.text.length <= 65536 &&
  typeof message.isGroup === 'boolean' && typeof message.fromMe === 'boolean' &&
  (message.mentionsMe === undefined || typeof message.mentionsMe === 'boolean') &&
  (message.replyToMe === undefined || typeof message.replyToMe === 'boolean') &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(message.timestamp) &&
  Number.isFinite(Date.parse(message.timestamp));

function makeDriver({ queueDir, endpoint = 'http://127.0.0.1:4317', fetchImpl = fetch, autoFlushMs = 30000, log = console.log }) {
  fs.mkdirSync(queueDir, { recursive: true });
  const labels = new Map(); // ponytail: label editing arrives with M1; M0 sends ''
  const status = new Map(); // account → { connected, detail, mode, at }
  let pendingSinceFlush = 0;

  const queueFile = account => path.join(queueDir, `${account}.jsonl`);

  function handle(payload) {
    if (!payload || typeof payload.type !== 'string') return { stored: false, error: 'invalid payload' };
    if (payload.type === 'wa-status') {
      const account = normalizeAccount(payload.account);
      if (account) status.set(account, { connected: Boolean(payload.connected), detail: payload.detail, mode: payload.mode, at: new Date().toISOString() });
      log(`[status] ${account || '(no account)'} connected=${Boolean(payload.connected)} mode=${payload.mode || '?'} ${payload.detail || ''}`);
      return { stored: true };
    }
    if (payload.type === 'messages') {
      const account = normalizeAccount(payload.account);
      if (!account) return { stored: false, error: 'account is required' };
      if (!Array.isArray(payload.messages) || payload.messages.length > 100 ||
          !payload.messages.every(validMessage) ||
          payload.messages.some(item => item.account && normalizeAccount(item.account) !== account)) {
        return { stored: false, error: 'invalid messages' };
      }
      const lines = payload.messages.map(item => JSON.stringify({ ...item, account })).join('\n') + '\n';
      fs.appendFileSync(queueFile(account), lines); // durable before ack
      pendingSinceFlush += payload.messages.length;
      if (pendingSinceFlush >= 100) flushNow().catch(() => {});
      return { stored: true, queued: payload.messages.length };
    }
    // ponytail: unread, group-members and the backfill driver are M1/M2;
    // M0 only guarantees the messages path.
    log(`[skip] ${payload.type} (M1/M2)`);
    return { stored: true, skipped: true };
  }

  async function flushFile(file) {
    const flushing = `${file}.flushing`;
    if (!fs.existsSync(file)) return;
    fs.renameSync(file, flushing); // arrivals during the await go to a fresh file
    let raw;
    try { raw = fs.readFileSync(flushing, 'utf8'); } catch { return; }
    try {
      const byAccount = new Map();
      for (const line of raw.split('\n')) {
        if (!line) continue;
        const item = JSON.parse(line);
        if (!byAccount.has(item.account)) byAccount.set(item.account, []);
        byAccount.get(item.account).push(item);
      }
      for (const [account, items] of byAccount) {
        let i = 0;
        while (i < items.length) {
          const batch = [];
          let bytes = 2;
          while (i < items.length && batch.length < 100) {
            const size = Buffer.byteLength(JSON.stringify(items[i])) + 1;
            if (batch.length && bytes + size > 8 * 1024 * 1024) break;
            batch.push(items[i]); bytes += size; i += 1;
          }
          const response = await fetchImpl(`${endpoint}/ingest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account, label: labels.get(account) || '', messages: batch }),
          });
          if (!response.ok) throw new Error(`server ${response.status}`);
          log(`[flush] ${account}: ${batch.length} messages`);
        }
      }
      fs.unlinkSync(flushing);
    } catch (error) {
      // Keep the data: fold the failed batch back into the live queue file.
      try {
        if (fs.existsSync(file)) fs.appendFileSync(file, raw);
        else fs.renameSync(flushing, file);
      } catch (_) { /* next flush retries from .flushing */ }
      throw error;
    }
  }

  async function flushNow() {
    const files = fs.readdirSync(queueDir).filter(f => f.endsWith('.jsonl'));
    const failed = [];
    for (const f of files) {
      try { await flushFile(path.join(queueDir, f)); } catch (error) { failed.push(`${f}: ${error.message}`); }
    }
    // Retry leftover .flushing files from earlier crashed runs.
    for (const f of fs.readdirSync(queueDir).filter(x => x.endsWith('.flushing'))) {
      try { await flushFile(path.join(queueDir, f.replace(/\.flushing$/, ''))); } catch (error) { failed.push(`${f}: ${error.message}`); }
    }
    if (failed.length) log('[flush] failed:', failed.join('; '));
    if (!failed.length) pendingSinceFlush = 0;
    return failed.length === 0;
  }

  const timer = autoFlushMs ? setInterval(() => { flushNow().catch(() => {}); }, autoFlushMs) : null;
  if (timer && timer.unref) timer.unref();

  return { handle, flushNow, status, dispose: () => timer && clearInterval(timer) };
}

module.exports = { makeDriver, validMessage, normalizeAccount };
