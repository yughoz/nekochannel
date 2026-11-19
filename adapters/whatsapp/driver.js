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

function makeDriver({ queueDir, endpoint = 'http://127.0.0.1:4317', fetchImpl = fetch, autoFlushMs = 30000, log = console.log, stateFile, onAutoBackfill, onMessages, enabled = true }) {
  fs.mkdirSync(queueDir, { recursive: true });
  const labels = new Map(); // account → label, sent with every flush
  const status = new Map(); // account → { connected, detail, mode, at }
  let pendingSinceFlush = 0;

  // Backfill orchestration state, ported from the wa-reader extension
  // background.js (multi-account: state keyed per account, no owner tab).
  // ponytail: offline/cooldown thresholds hardcoded (1h / 6h) like upstream.
  const BACKFILL_MAX_PER_CHAT = 100;
  const BACKFILL_LIMIT = 1000000;
  const AUTO_BACKFILL_OFFLINE_MS = 3600000;
  const AUTO_BACKFILL_COOLDOWN_MS = 6 * 3600000;
  const BACKFILL_STATUSES = new Set(['idle', 'running', 'paused', 'done', 'unsupported', 'error']);
  const emptyBackfill = account => ({ account, session: null, status: 'idle', chatIds: [], chatIndex: 0, total: 0, messageCount: 0, maxPerChat: BACKFILL_MAX_PER_CHAT, current: null, detail: '' });
  const validBackfill = value => value && typeof value === 'object' && !Array.isArray(value) &&
    (!value.account || normalizeAccount(value.account) === value.account) &&
    (value.session === null || typeof value.session === 'string') &&
    BACKFILL_STATUSES.has(value.status) &&
    Array.isArray(value.chatIds) && value.chatIds.every(id => typeof id === 'string') && new Set(value.chatIds).size === value.chatIds.length &&
    Number.isInteger(value.chatIndex) && value.chatIndex >= 0 && value.chatIndex <= value.chatIds.length && value.total === value.chatIds.length &&
    Number.isSafeInteger(value.messageCount) && value.messageCount >= 0 && Number.isInteger(value.maxPerChat) && value.maxPerChat > 0 && value.maxPerChat <= BACKFILL_LIMIT &&
    (value.current === null || (typeof value.current === 'object' && typeof value.current.id === 'string' &&
    Array.isArray(value.current.ids) && value.current.ids.length <= value.maxPerChat && value.current.ids.every(id => typeof id === 'string') && new Set(value.current.ids).size === value.current.ids.length));

  let state = { accounts: {}, backfills: {} };
  if (stateFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (parsed && typeof parsed === 'object') state = { accounts: parsed.accounts || {}, backfills: parsed.backfills || {} };
    } catch (_) { /* fresh state */ }
  }
  const persist = () => {
    if (!stateFile) return;
    try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); }
    catch (error) { log(`[state] write failed: ${error.message}`); }
  };

  const queueFile = account => path.join(queueDir, `${account}.jsonl`);
  // Dedupe a backfill batch against the not-yet-flushed queue (extension kept
  // this at queue level; live messages already dedupe in the bridge `seen` set
  // and the server dedupes everything by PRIMARY KEY(account,id) anyway).
  const queuedIds = account => {
    try {
      return new Set(fs.readFileSync(queueFile(account), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).id));
    } catch { return new Set(); }
  };

  function handle(payload) {
    if (!payload || typeof payload.type !== 'string') return { stored: false, error: 'invalid payload' };
    if (payload.type === 'reader-state') return { enabled };
    if (!enabled) return { stored: false, ok: false, error: 'reader off' };
    if (payload.type === 'wa-status') {
      const account = normalizeAccount(payload.account);
      if (account) status.set(account, { connected: Boolean(payload.connected), detail: payload.detail, mode: payload.mode, at: new Date().toISOString() });
      log(`[status] ${account || '(no account)'} connected=${Boolean(payload.connected)} mode=${payload.mode || '?'} ${payload.detail || ''}`);
      let auto = null;
      if (account) {
        const accounts = state.accounts;
        const previousSeen = Date.parse(accounts[account]?.seenAt || '');
        const entry = accounts[account] ||= {};
        entry.seenAt = new Date().toISOString();
        const lastAuto = Date.parse(entry.lastAutoBackfillAt || '');
        const saved = state.backfills[account];
        const priorBackfill = saved && validBackfill(saved) && saved.session;
        const offline = Number.isFinite(previousSeen) && Date.now() - previousSeen > AUTO_BACKFILL_OFFLINE_MS &&
          (!Number.isFinite(lastAuto) || Date.now() - lastAuto > AUTO_BACKFILL_COOLDOWN_MS);
        if (payload.connected && (!priorBackfill || (offline && saved.status === 'done'))) {
          state.backfills[account] = { ...emptyBackfill(account), session: require('node:crypto').randomUUID(), status: 'running', detail: 'Backfill otomatis: 100 pesan terbaru per chat' };
          entry.lastAutoBackfillAt = entry.seenAt;
          auto = state.backfills[account];
        }
        persist();
        if (auto && onAutoBackfill) { try { onAutoBackfill(account, auto); } catch (_) {} }
      }
      return { stored: true };
    }
    if (payload.type === 'backfill-ready') {
      const account = normalizeAccount(payload.account);
      const saved = account ? state.backfills[account] : null;
      return { ok: true, progress: saved && validBackfill(saved) ? saved : null };
    }
    if (payload.type === 'backfill-checkpoint') {
      const account = normalizeAccount(payload.account);
      const progress = payload.progress;
      if (!account || !validBackfill(progress) || progress.session !== payload.session || normalizeAccount(progress.account) !== account ||
          (state.backfills[account] && state.backfills[account].session !== payload.session)) {
        return { stored: false, error: 'invalid backfill checkpoint' };
      }
      const paused = state.backfills[account]?.status === 'paused';
      // The page engine owns pause: a checkpoint in flight must not undo Pause.
      state.backfills[account] = { ...progress, account, status: paused && progress.status === 'running' ? 'paused' : progress.status };
      persist();
      return { stored: true, progress: state.backfills[account] };
    }
    if (payload.type === 'backfill-status') {
      // Only failed storage can bypass a checkpoint; it never advances counts.
      const account = normalizeAccount(payload.account);
      const progress = payload.progress || {};
      const saved = account ? state.backfills[account] : null;
      if (progress.status === 'error' && saved && saved.session === progress.session) {
        saved.status = 'error';
        saved.detail = String(progress.detail || 'Penyimpanan backfill gagal');
        persist();
      }
      return { ok: true };
    }
    if (payload.type === 'messages' || payload.type === 'backfill-batch') {
      const account = normalizeAccount(payload.account);
      if (!account) return { stored: false, error: 'account is required' };
      if (payload.type === 'backfill-batch') {
        const saved = state.backfills[account];
        if (!saved || saved.session !== payload.session) return { stored: false, error: 'backfill session mismatch' };
      }
      if (!Array.isArray(payload.messages) || payload.messages.length > 100 ||
          !payload.messages.every(validMessage) ||
          payload.messages.some(item => item.account && normalizeAccount(item.account) !== account)) {
        return { stored: false, error: 'invalid messages' };
      }
      const seen = payload.type === 'backfill-batch' ? queuedIds(account) : null;
      const items = seen ? payload.messages.filter(item => !seen.has(item.id)) : payload.messages;
      if (items.length) {
        const lines = items.map(item => JSON.stringify({ ...item, account })).join('\n') + '\n';
        fs.appendFileSync(queueFile(account), lines); // durable before ack
        pendingSinceFlush += items.length;
        // #9 live capture only — backfill batches stay silent (reconnect would flood).
        if (payload.type === 'messages' && onMessages) { try { onMessages(account, items); } catch (error) { log(`[onMessages] consumer error: ${error.message}`); } }
        if (autoFlushMs && pendingSinceFlush >= 100) flushNow().catch(() => {});
      }
      return { stored: true, queued: items.length, duplicates: payload.messages.length - items.length };
    }
    // ponytail: unread, group-members and label-sync-by-ingest are later M's;
    // ok:false makes the reader's loops stop cleanly instead of retrying.
    log(`[skip] ${payload.type}`);
    if (payload.type.startsWith('backfill')) return { stored: true, skipped: true, ok: false };
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

  let flushingNow = false;
  async function flushNow() {
    if (flushingNow) return true; // reentrant calls (timer + volume trigger) wait for the next tick
    flushingNow = true;
    try {
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
      if (!failed.length) {
        pendingSinceFlush = 0;
        flushFailures = 0; // server is back — drop any accumulated backoff
        flushDelay = autoFlushMs;
      }
      return failed.length === 0;
    } finally { flushingNow = false; }
  }

  // Retry with exponential backoff while the server is down (30s → … → 10min);
  // any fully-successful flush round resets to the base interval.
  let flushFailures = 0;
  let flushDelay = autoFlushMs;
  let flushTimer = null;
  const scheduleFlush = () => {
    flushTimer = setTimeout(async () => {
      const ok = await flushNow().catch(() => false);
      flushFailures = ok ? 0 : flushFailures + 1;
      flushDelay = Math.min((autoFlushMs || 30000) * 2 ** flushFailures, 600000);
      scheduleFlush();
    }, flushDelay);
    if (flushTimer.unref) flushTimer.unref();
  };
  if (autoFlushMs) scheduleFlush();

  const setLabel = (account, label) => {
    const a = normalizeAccount(account);
    if (a) labels.set(a, String(label || '').slice(0, 200));
  };

  const setEnabled = value => {
    if (typeof value !== 'boolean') throw new TypeError('Invalid reader switch');
    if (value && !enabled) {
      for (const entry of Object.values(state.accounts)) entry.seenAt = new Date().toISOString();
      persist();
    }
    enabled = value;
    status.clear();
  };
  const backfill = (account, action) => {
    if (!enabled || normalizeAccount(account) !== account || !account || !['start', 'pause'].includes(action)) throw new TypeError('Invalid backfill command or reader off');
    let progress = state.backfills[account];
    if (action === 'start' && (!progress || !validBackfill(progress) || ['done', 'unsupported'].includes(progress.status))) {
      progress = { ...emptyBackfill(account), session: require('node:crypto').randomUUID() };
    }
    if (!progress) throw new Error('No backfill to pause');
    progress = { ...progress, status: action === 'pause' ? 'paused' : 'running' };
    state.backfills[account] = progress;
    persist();
    return progress;
  };
  return { handle, flushNow, setLabel, status, setEnabled, backfill, isEnabled: () => enabled, nextFlushMs: () => flushDelay, dispose: () => flushTimer && clearTimeout(flushTimer) };
}

module.exports = { makeDriver, validMessage, normalizeAccount };
