'use strict';
// Preload bridge (ISOLATED world) — the Electron replacement for content.js.
// Listens to the same CustomEvents the reader emits in the MAIN world, validates,
// dedupes, and forwards to the main-process driver via IPC. Ack only after the
// driver confirms durable storage, same contract as the Chrome version.
const { ipcRenderer } = require('electron');
const normalizer = require('./vendor/normalize.js');
globalThis.WAR1Normalize = normalizer;

const channel = (process.argv.find(a => a.startsWith('--capture-channel=')) || '--capture-channel=capture').slice(18);
const callWorker = payload => ipcRenderer.invoke(channel, payload);

(function () {
  const seen = new Set();
  const pending = [];
  let sending = false;
  let timer;
  let internalActive = false;
  let account = '';
  let ownJids = [];
  const normalizeAccount = value => {
    const match = /^(\d+)(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/i.exec(typeof value === 'string' ? value.trim() : '');
    return match ? `${match[1]}@c.us` : '';
  };
  const scheduleSend = (delay = 250) => { clearTimeout(timer); timer = setTimeout(send, delay); };
  async function send() {
    if (sending || !pending.length) return;
    sending = true;
    try {
      const batchAccount = normalizeAccount(pending[0]?.account);
      if (!batchAccount) return;
      const batch = [];
      for (const item of pending.slice(0, 100)) {
        if (item.account !== batchAccount) break;
        batch.push(item);
      }
      const response = await callWorker({ type: 'messages', account: batchAccount, messages: batch });
      if (!response?.stored) throw new Error('queue not persisted');
      pending.splice(0, batch.length);
    } catch (_) { /* Keep the batch until the driver acknowledges storage. */ }
    finally { sending = false; if (pending.length) scheduleSend(5000); }
  }
  function validMessage(message) {
    return message && typeof message === 'object' &&
      ['id', 'chat', 'sender', 'text', 'timestamp'].every(key => typeof message[key] === 'string') &&
      message.id.length > 0 && message.id.length <= 1024 && message.chat.length <= 4096 &&
      message.sender.length <= 4096 && message.text.length <= 65536 &&
      typeof message.isGroup === 'boolean' && typeof message.fromMe === 'boolean' &&
      (message.mentionsMe === undefined || typeof message.mentionsMe === 'boolean') &&
      (message.replyToMe === undefined || typeof message.replyToMe === 'boolean') &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(message.timestamp) &&
      Number.isFinite(Date.parse(message.timestamp));
  }
  function enqueue(message) {
    const messageAccount = normalizeAccount(message?.account);
    if (!validMessage(message) || !messageAccount || (account && messageAccount !== account)) return;
    message = { ...message, account: messageAccount };
    const seenKey = `${messageAccount}:${message.id}`;
    if (seen.has(seenKey)) return;
    if (seen.size >= 100000) seen.delete(seen.values().next().value);
    seen.add(seenKey); pending.push(message); scheduleSend();
  }
  const report = data => callWorker({ type: 'wa-status', ...data }).catch(() => {});
  globalThis.addEventListener('wa-reader-message', event => enqueue(event.detail));
  globalThis.addEventListener('wa-reader-unread', event => {
    const unreadAccount = normalizeAccount(event.detail?.account || account);
    const chats = event.detail?.chats;
    if (!unreadAccount || !Array.isArray(chats)) return;
    callWorker({ type: 'unread', account: unreadAccount, chats }).catch(() => {});
  });
  globalThis.addEventListener('wa-reader-status', event => {
    internalActive = event.detail?.mode === 'internal' && event.detail?.connected;
    account = normalizeAccount(event.detail?.account);
    ownJids = Array.isArray(event.detail?.ownJids) && event.detail.ownJids.length ? event.detail.ownJids : (account ? [account] : []);
    report({ connected: Boolean(event.detail?.connected), account, detail: event.detail?.detail, mode: event.detail?.mode });
    if (!internalActive) scan();
  });
  globalThis.addEventListener('wa-reader-backfill-status', event => {
    const progress = { ...event.detail, account: normalizeAccount(event.detail?.account || account) };
    callWorker({ type: 'backfill-status', account: progress.account, progress }).catch(() => {});
  });
  globalThis.addEventListener('wa-reader-group-members', event => {
    const detail = event.detail || {};
    if (!normalizeAccount(detail.account) || !Array.isArray(detail.chats) || !detail.chats.length) return;
    callWorker({ type: 'group-members', account: normalizeAccount(detail.account), chats: detail.chats }).catch(() => {});
  });
  globalThis.addEventListener('wa-reader-group-members-diag', event => {
    const detail = event.detail || {};
    if (!detail.diag) return;
    callWorker({ type: 'group-members-diag', account: normalizeAccount(detail.account) || undefined, diag: detail.diag }).catch(() => {});
  });
  globalThis.addEventListener('wa-reader-backfill-request', async event => {
    const data = event.detail;
    if (!data || typeof data.requestId !== 'string' || typeof data.session !== 'string') return;
    let response;
    try {
      if (data.kind === 'batch') {
        if (!Array.isArray(data.messages) || data.messages.length > 100 || !data.messages.every(validMessage)) throw new Error('Pesan backfill tidak valid');
        const batchAccount = normalizeAccount(data.account || account);
        if (!batchAccount || batchAccount !== account) throw new Error('Nomor WhatsApp berubah atau belum terdeteksi');
        response = await callWorker({ type: 'backfill-batch', account: batchAccount, messages: data.messages.map(item => ({ ...item, account: batchAccount })), session: data.session });
      } else if (data.kind === 'checkpoint') {
        const checkpointAccount = normalizeAccount(data.account || account || data.progress?.account);
        response = await callWorker({ type: 'backfill-checkpoint', account: checkpointAccount, session: data.session, progress: { ...data.progress, account: checkpointAccount } });
      } else return;
    } catch (error) { response = { ok: false, error: error.message }; }
    globalThis.dispatchEvent(new CustomEvent('wa-reader-backfill-response', { detail: { ...response, requestId: data.requestId } }));
  });

  const backfillCommand = command => globalThis.dispatchEvent(new CustomEvent('wa-reader-backfill-command', { detail: command }));
  ipcRenderer.on('reader-command', (_event, message) => {
    if (message?.type !== 'backfill-command') return;
    if (message.action !== 'pause' && (!account || normalizeAccount(message.progress?.account) !== account)) return;
    backfillCommand({ action: message.action, progress: message.progress });
  });

  async function resumeBackfill() {
    try {
      if (!account) return;
      const response = await callWorker({ type: 'backfill-ready', account });
      const progressAccount = normalizeAccount(response?.progress?.account);
      if (response?.progress?.status === 'running' && account && progressAccount === account) backfillCommand({ action: 'start', progress: { ...response.progress, account } });
    } catch (_) { /* Driver reload: retry on the next heartbeat. */ }
  }

  const content = node => (node?.textContent || '').trim();
  const hash = value => {
    let code = 2166136261;
    for (let i = 0; i < value.length; i++) code = Math.imul(code ^ value.charCodeAt(i), 16777619);
    return (code >>> 0).toString(16);
  };
  function mentionFlagsFromNode(node, jids) {
    const root = node || document.createElement('div');
    const mentionJids = [...root.querySelectorAll('[data-jid], [data-mention-jid], [data-mention]')].map((el) =>
      el.getAttribute('data-jid') || el.getAttribute('data-mention-jid') || el.getAttribute('data-mention')
    ).filter(Boolean);
    const quoted = root.querySelector('[data-testid="quoted-message"], [data-testid="quoted-message-wrapper"], .quoted-mention');
    let quotedFromMe = false;
    let quotedParticipant = '';
    if (quoted) {
      quotedParticipant = quoted.getAttribute('data-jid') || quoted.getAttribute('data-quoted-jid') || quoted.getAttribute('data-mention-jid') || '';
      const author = (quoted.querySelector('[data-testid="quoted-message-author"], .quoted-mention-name')?.textContent || '').trim();
      if (/^(You|Anda|Saya)$/i.test(author)) quotedFromMe = true;
      if (quoted.getAttribute('data-quoted-from-me') === 'true' || quoted.getAttribute('data-from-me') === 'true') quotedFromMe = true;
    }
    if (globalThis.WAR1Normalize?.flagsFromDom) return globalThis.WAR1Normalize.flagsFromDom({ mentionJids, quotedFromMe, quotedParticipant }, jids);
    return { mentionsMe: false, replyToMe: quotedFromMe };
  }
  function parseDate(pre) {
    const locale = document.documentElement.lang || navigator.language || 'id';
    if (globalThis.WAR1Normalize?.parsePlainTextDate) return globalThis.WAR1Normalize.parsePlainTextDate(pre, { locale });
    return new Date().toISOString();
  }
  function chatInfo() {
    const header = document.querySelector('#main header, [data-testid="conversation-header"]');
    const title = header?.querySelector('[title]');
    const id = header?.querySelector('[data-id]')?.getAttribute('data-id') || '';
    const groupHint = header?.querySelector('[data-icon="group"], [data-testid="default-group"]');
    return { chat: title?.getAttribute('title') || content(title) || 'unknown', isGroup: id.includes('@g.us') || Boolean(groupHint) };
  }
  function parseMessage(node, chat) {
    const pre = node.getAttribute('data-pre-plain-text');
    if (!pre) return;
    const outer = node.closest('[data-id], .message-in, .message-out') || node;
    const id = outer.getAttribute('data-id') || node.getAttribute('data-id');
    const fromMe = outer.classList.contains('message-out') || /^true_/.test(id || '');
    const textNodes = [...node.querySelectorAll('[data-testid="selectable-text"], .selectable-text')];
    const text = textNodes.map(content).filter(Boolean).join('\n') || (node.querySelector('img, video, audio, [data-testid="media-url-provider"]') ? '[media]' : content(node));
    const sender = fromMe ? 'me' : pre.replace(/^\[[^\]]+\]\s*/, '').replace(/:\s*$/, '').trim() || 'unknown';
    const flags = mentionFlagsFromNode(outer, ownJids.length ? ownJids : (account ? [account] : []));
    enqueue({ id: id || `dom-${hash(`${chat.chat}|${pre}|${text}`)}`, account, chat: chat.chat, isGroup: chat.isGroup || /@g\.us/.test(id || ''), sender, text, timestamp: parseDate(pre), fromMe, mentionsMe: flags.mentionsMe, replyToMe: flags.replyToMe });
  }
  function scanList() {
    const rows = document.querySelectorAll('#pane-side [data-testid="cell-frame-container"], #pane-side [role="listitem"], [aria-label] [data-testid="cell-frame-container"]');
    const counted = new Set();
    for (const row of rows) {
      const title = row.querySelector('[title]');
      const chat = title?.getAttribute('title') || content(title);
      if (!chat || counted.has(chat)) continue;
      counted.add(chat);
      const previewNode = row.querySelector('[data-testid="last-msg-status"]')?.parentElement || row.querySelector('[data-testid="cell-frame-secondary"]');
      const text = content(previewNode);
      if (!text) continue;
      const rowId = row.getAttribute('data-id') || row.querySelector('[data-id]')?.getAttribute('data-id') || '';
      const time = content(row.querySelector('[data-testid="cell-frame-secondary-detail"], time'));
      const fromMe = Boolean(row.querySelector('[data-icon="msg-check"], [data-icon="msg-dblcheck"], [data-icon="msg-dblcheck-ack"]'));
      const isGroup = rowId.includes('@g.us') || Boolean(row.querySelector('[data-icon="group"], [data-testid="default-group"]'));
      // ponytail: DOM previews lack real message IDs/dates; prefer internal
      // collections when available. Synthetic IDs may overlap later backfill.
      enqueue({ id: `dom-list-${hash(`${rowId || chat}|${time}|${text}|${fromMe}`)}`, account, chat, isGroup, sender: fromMe ? 'me' : 'unknown', text, timestamp: new Date().toISOString(), fromMe });
    }
    return counted.size;
  }
  function scan() {
    if (internalActive) return;
    if (!account) {
      report({ connected: false, account: '', detail: 'Nomor WhatsApp belum terdeteksi; menunggu login', mode: 'dom' });
      return;
    }
    const chat = chatInfo();
    const nodes = document.querySelectorAll('[data-pre-plain-text]');
    for (const node of nodes) parseMessage(node, chat);
    const count = scanList();
    report({ connected: count > 0 || nodes.length > 0, account, detail: `Fallback DOM aktif (${count} chat terlihat)`, mode: 'dom' });
  }
  let scanTimer;
  new MutationObserver(() => { clearTimeout(scanTimer); scanTimer = setTimeout(scan, 200); })
    .observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  // Install every listener before the MAIN world emits its startup backfill.
  globalThis.dispatchEvent(new Event('wa-reader-content-ready'));
  void resumeBackfill();
  scan();
  setInterval(() => {
    globalThis.dispatchEvent(new Event('wa-reader-content-ready'));
    void resumeBackfill();
    if (!internalActive) scan();
  }, 30000);
})();
