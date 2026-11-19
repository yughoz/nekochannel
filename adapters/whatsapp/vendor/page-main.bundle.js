if (!window.__waReaderLoaded) {
window.__waReaderLoaded = true;
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WAR1Normalize = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const first = (object, names) => {
    for (const name of names) if (object?.[name] !== undefined && object[name] !== null && object[name] !== '') return object[name];
  };
  function serializeId(id) {
    if (typeof id === 'string' || typeof id === 'number') return String(id);
    if (!id) return '';
    if (id._serialized || id.serialized) return String(id._serialized || id.serialized);
    if (id.user && id.server) return `${id.user}@${id.server}`;
    if (id.id && id.remote) return `${Boolean(id.fromMe)}_${serializeId(id.remote)}_${id.id}${id.participant ? `_${serializeId(id.participant)}` : ''}`;
    return typeof id.id === 'string' ? id.id : '';
  }
  // WhatsApp exposes the signed-in identity through several WID shapes. Keep
  // the server key stable across device suffixes and domain aliases.
  function normalizeAccount(value, depth = 0) {
    if (depth > 4 || value === undefined || value === null) return '';
    if (typeof value === 'object') {
      for (const candidate of [value._serialized, value.serialized, value.wid, value.id, value.userId]) {
        const normalized = normalizeAccount(candidate, depth + 1);
        if (normalized) return normalized;
      }
      if (value.user !== undefined) {
        const normalized = normalizeAccount(`${value.user}@${value.server || 'c.us'}`, depth + 1);
        if (normalized) return normalized;
      }
      return '';
    }
    let text = String(value).trim();
    if (!text) return '';
    if (text[0] === '{' || text[0] === '"') {
      try {
        const parsed = JSON.parse(text);
        if (parsed !== text) return normalizeAccount(parsed, depth + 1);
      } catch (_) {}
    }
    const match = /^(\d+)(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/i.exec(text);
    if (match) return `${match[1]}@c.us`;
    return '';
  }
  function name(value) {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    return String(first(value, ['name', 'pushname', 'formattedName', 'notifyName', 'number', 'user']) || serializeId(value?.id || value));
  }
  function timestamp(raw, now) {
    const candidate = first(raw, ['timestamp', 't', 'time', 'ts']);
    const numeric = typeof candidate === 'number' || (typeof candidate === 'string' && /^\d+(\.\d+)?$/.test(candidate));
    const date = numeric ? new Date(Number(candidate) < 1e12 ? Number(candidate) * 1000 : Number(candidate)) : new Date(candidate);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
    return new Date(now || Date.now()).toISOString();
  }
  const FUTURE_SKEW_MS = 15 * 60 * 1000;
  function validCalendarDate(year, month, day, hour, minute, second) {
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(year, month - 1, day, hour, minute, second);
    if (Number.isNaN(date.getTime()) || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return date;
  }
  // WhatsApp data-pre-plain-text dates are localized (DD/MM or MM/DD). Never let
  // an out-of-range month overflow through the Date constructor (10/30 as
  // day=10, month=30 becomes June of year+2). Prefer an unambiguous side, then
  // the non-future reading closer to "now" (DOM fallback sees recent messages).
  function parsePlainTextDate(pre, options = {}) {
    const now = options.now != null ? new Date(options.now) : new Date();
    const fallback = () => (Number.isNaN(now.getTime()) ? new Date() : now).toISOString();
    const match = String(pre || '').match(/\[(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AP]M))?,?\s+(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\]/i);
    if (!match) return fallback();
    let [, hour, minute, second, meridiem, a, b, year] = match;
    if (year.length === 2) year = `20${year}`;
    year = Number(year);
    a = Number(a);
    b = Number(b);
    hour = Number(hour);
    if (meridiem) hour = (hour % 12) + (/PM/i.test(meridiem) ? 12 : 0);
    const minuteN = Number(minute);
    const secondN = Number(second || 0);
    const dmy = validCalendarDate(year, b, a, hour, minuteN, secondN);
    const mdy = validCalendarDate(year, a, b, hour, minuteN, secondN);
    const skew = options.skewMs != null ? options.skewMs : FUTURE_SKEW_MS;
    const notFuture = date => date && date.getTime() <= now.getTime() + skew;
    const unique = [];
    if (dmy) unique.push(dmy);
    if (mdy && (!dmy || mdy.getTime() !== dmy.getTime())) unique.push(mdy);
    const plausible = unique.filter(notFuture);
    if (plausible.length === 1) return plausible[0].toISOString();
    if (plausible.length > 1) {
      const locale = options.locale || 'id';
      const preferMdy = /^en(-US)?$/i.test(locale);
      plausible.sort((x, y) => {
        const delta = Math.abs(now.getTime() - x.getTime()) - Math.abs(now.getTime() - y.getTime());
        if (delta !== 0) return delta;
        if (preferMdy) return (y === mdy ? 1 : 0) - (x === mdy ? 1 : 0);
        return (y === dmy ? 1 : 0) - (x === dmy ? 1 : 0);
      });
      return plausible[0].toISOString();
    }
    return fallback();
  }
  function canonicalizeJid(value, depth = 0) {
    if (depth > 4 || value === undefined || value === null) return '';
    if (typeof value === 'object') {
      for (const candidate of [value._serialized, value.serialized, value.wid, value.lid, value.id, value.userId, value.phoneNumber]) {
        const result = canonicalizeJid(candidate, depth + 1);
        if (result) return result;
      }
      if (value.user !== undefined) return canonicalizeJid(`${value.user}@${value.server || 'c.us'}`, depth + 1);
      return '';
    }
    let text = String(value).trim();
    if (!text) return '';
    if (text[0] === '{' || text[0] === '"') {
      try {
        const parsed = JSON.parse(text);
        if (parsed !== text) return canonicalizeJid(parsed, depth + 1);
      } catch (_) {}
    }
    const phone = /^(\d+)(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/i.exec(text);
    if (phone) return `${phone[1]}@c.us`;
    const lid = /^(\d+)(?::\d+)?@lid$/i.exec(text);
    if (lid) return `${lid[1]}@lid`;
    return '';
  }
  function collectOwnJids(sources) {
    const jids = new Set();
    const visit = (value, depth = 0) => {
      if (depth > 5 || value == null || typeof value === 'function') return;
      const canon = canonicalizeJid(value);
      if (canon) jids.add(canon);
      if (typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
      for (const key of ['lid', 'wid', 'me', 'userId', '_serialized', 'serialized', 'phoneNumber', 'pnUser', 'lidUser']) {
        if (value[key] !== undefined) visit(value[key], depth + 1);
      }
    };
    for (const source of sources || []) visit(source);
    return [...jids];
  }
  function isOwnJid(value, ownJids) {
    const canon = canonicalizeJid(value);
    if (!canon || !Array.isArray(ownJids) || !ownJids.length) return false;
    return ownJids.some((item) => canonicalizeJid(item) === canon);
  }
  function mentionedJidList(raw) {
    const data = raw?._data || raw?.__x_data || {};
    const lists = [raw?.mentionedJidList, raw?.mentionedIds, raw?.mentionedJid, raw?.mentionedJids, raw?.mentions,
      data.mentionedJidList, data.mentionedIds, data.mentionedJid, data.mentionedJids];
    const result = [];
    const seen = new Set();
    for (const list of lists) {
      if (list == null) continue;
      for (const item of (Array.isArray(list) ? list : [list])) {
        const canon = canonicalizeJid(item);
        if (canon && !seen.has(canon)) { seen.add(canon); result.push(canon); }
      }
    }
    return result;
  }
  function quotedFromMe(raw, ownJids) {
    const data = raw?._data || raw?.__x_data || {};
    const quoted = raw?.quotedMsg || raw?.quotedMsgObj || raw?.quoted || data.quotedMsg || data.quotedMsgObj;
    if (quoted && (quoted.fromMe || quoted.id?.fromMe || quoted.__x_isSentByMe)) return true;
    if (raw?.quotedFromMe || data.quotedFromMe) return true;
    const participant = raw?.quotedParticipant || data.quotedParticipant || quoted?.author || quoted?.participant || quoted?.from || quoted?.id?.participant;
    return Boolean(ownJids && isOwnJid(participant, ownJids));
  }
  function flagsFromDom({ mentionJids = [], quotedFromMe = false, quotedParticipant = '' } = {}, ownJids) {
    return {
      mentionsMe: (mentionJids || []).some((jid) => isOwnJid(jid, ownJids)),
      replyToMe: Boolean(quotedFromMe) || isOwnJid(quotedParticipant, ownJids),
    };
  }
  function mentionFlags(raw, ownJids, extras = {}) {
    return {
      mentionsMe: Boolean(extras.mentionsMe) || mentionedJidList(raw).some((jid) => isOwnJid(jid, ownJids)),
      replyToMe: Boolean(extras.replyToMe) || quotedFromMe(raw, ownJids),
    };
  }
  function mediaPlaceholder(raw) {
    const kind = String(first(raw, ['type', 'mediaType', 'mimetype']) || '').toLowerCase();
    if (kind.includes('image') || raw.isImage) return '[gambar]';
    if (kind.includes('video') || raw.isVideo) return '[video]';
    if (kind.includes('audio') || kind === 'ptt' || raw.isAudio) return '[audio]';
    if (kind.includes('document') || raw.isDocument) return '[dokumen]';
    if (kind.includes('sticker') || raw.isSticker) return '[stiker]';
    if (kind.includes('location')) return '[lokasi]';
    if (kind.includes('vcard') || kind.includes('contact')) return '[kontak]';
    return '[media]';
  }
  function normalizeMessage(raw, chat = {}, options = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const id = serializeId(raw.id || raw._id || raw.__x_id);
    if (!id) return null;
    const fromMe = Boolean(raw.fromMe || raw.id?.fromMe || raw.__x_isSentByMe || /^true_/.test(id));
    const chatId = chat.id || raw.id?.remote || raw.chatId || (fromMe ? raw.to : raw.from);
    const isGroup = Boolean(chat.isGroup || chat.__x_isGroup || raw.isGroup || serializeId(chatId).endsWith('@g.us') || chatId?.server === 'g.us');
    const chatName = name(first(chat, ['name', 'formattedTitle', 'displayName', 'subject', 'contact'])) || serializeId(chatId) || 'unknown';
    const senderId = raw.author || raw.id?.participant || raw.from;
    let contact;
    try { contact = options.lookupContact?.(senderId); } catch (_) {}
    // LID senders: prefer a mapped phone number, then the peer name in private chats,
    // so sender never degrades to a raw @lid JID (new WA Web shows LIDs for `from`).
    const phoneOf = (value) => {
      const jid = canonicalizeJid(value?.phoneNumber || value?.phoneNumberJid);
      return jid && !jid.endsWith('@lid') ? jid.split('@')[0] : '';
    };
    const sender = fromMe ? 'me' : name(first(raw, ['notifyName', 'senderName', 'authorName'])) || name(raw.sender) || name(contact) || phoneOf(contact) || (!isGroup ? chatName : '') || name(senderId) || 'unknown';
    let text = first(raw, ['body', 'text', 'caption', 'content']);
    if (text && typeof text === 'object') text = text.text || text.body || '';
    if (typeof text !== 'string') text = text == null ? '' : String(text);
    const media = raw.isMedia || raw.mediaData || raw.mimetype || ['image', 'video', 'audio', 'ptt', 'document', 'sticker', 'location', 'vcard', 'multi_vcard'].includes(raw.type);
    if (!text.trim() && media) text = mediaPlaceholder(raw);
    const flags = mentionFlags(raw, options.ownJids, options);
    return { id, chat: chatName, isGroup, sender, text, timestamp: timestamp(raw, options.now), fromMe, mentionsMe: flags.mentionsMe, replyToMe: flags.replyToMe };
  }
  return { normalizeMessage, normalizeAccount, serializeId, parsePlainTextDate, canonicalizeJid, collectOwnJids, isOwnJid, mentionedJidList, flagsFromDom, mentionFlags, idString: raw => serializeId(raw?.id || raw?._id || raw?.__x_id) };
});

(function () {
  'use strict';
  const normalizer = globalThis.WAR1Normalize;
  if (!normalizer) return;
  const seen = new Set();
  const subscribed = new WeakSet();
  let current;
  let ready = false;
  let warned = false;
  let account = '';
  let ownJids = [];
  const BACKFILL_MAX_PER_CHAT = 100;
  const BACKFILL_DELAY_MS = 1500;
  let backfillRun = null;
  let backfillState;
  let backfillPaused = false;
  let readerEnabled = globalThis.__nekoReaderEnabled !== false;
  let loadingHistory = false;
  const deferredEmits = [];
  let lastHistoryLoad = 0;
  let requestSequence = 0;
  const bridgeRequests = new Map();
  const status = (connected, detail) => globalThis.dispatchEvent(new CustomEvent('wa-reader-status', { detail: { connected, detail, account, ownJids, mode: connected ? 'internal' : 'dom' } }));
  const backfillStatus = detail => globalThis.dispatchEvent(new CustomEvent('wa-reader-backfill-status', { detail: { ...detail, account: detail?.account || account } }));
  const key = id => typeof id === 'string' ? id : id?._serialized || (id?.user && id?.server ? `${id.user}@${id.server}` : '');

  function detectAccount() {
    const store = globalThis.Store;
    const sources = [store?.Conn, store?.User, store?.UserPrefsMeUser];
    if (typeof globalThis.require === 'function') {
      for (const name of ['WAWebUserPrefsMeUser', 'WAWebConnModel']) {
        try { sources.push(globalThis.require(name)); } catch (_) {}
      }
    }
    for (const source of sources) for (const item of [source, source?.default, source?.Conn]) {
      if (!item) continue;
      for (const candidate of [item.wid, item.me, item.userId]) {
        const result = normalizer.normalizeAccount(candidate);
        if (result) return result;
      }
      // These getters only return the logged-in user; never inspect arbitrary
      // contacts, message senders, or chat participants to guess ownership.
      for (const getter of ['getMaybeMePnUser', 'getMaybeMeUser', 'getMeUser']) {
        try {
          if (typeof item[getter] !== 'function') continue;
          const result = normalizer.normalizeAccount(item[getter]());
          if (result) return result;
        } catch (_) {}
      }
    }
    for (const name of ['last-wid-md', 'last-wid']) {
      try {
        const result = normalizer.normalizeAccount(globalThis.localStorage?.getItem(name));
        if (result) return result;
      } catch (_) { /* Storage may be unavailable until WhatsApp finishes login. */ }
    }
    return '';
  }

  function detectOwnJids() {
    const store = globalThis.Store;
    const sources = [account, store?.Conn, store?.User, store?.UserPrefsMeUser];
    if (typeof globalThis.require === 'function') {
      for (const name of ['WAWebUserPrefsMeUser', 'WAWebConnModel']) {
        try { sources.push(globalThis.require(name)); } catch (_) {}
      }
    }
    const collected = [...sources];
    for (const source of sources) for (const item of [source, source?.default, source?.Conn]) {
      if (!item) continue;
      for (const candidate of [item.wid, item.me, item.lid, item.userId, item.lidUser, item.pnUser]) collected.push(candidate);
      for (const getter of ['getMaybeMePnUser', 'getMaybeMeUser', 'getMeUser', 'getMaybeMeLidUser', 'getMeLidUser', 'getMaybeMeLid']) {
        try { if (typeof item[getter] === 'function') collected.push(item[getter]()); } catch (_) {}
      }
    }
    return normalizer.collectOwnJids(collected);
  }

  function refreshAccount() {
    const next = detectAccount();
    const changed = next !== account;
    if (changed) { seen.clear(); account = next; }
    ownJids = detectOwnJids();
    if (changed) status(false, account ? 'Nomor WhatsApp terdeteksi' : 'Nomor WhatsApp belum terdeteksi; menunggu login');
    return account;
  }

  function requireBackfillAccount() {
    if (!refreshAccount() || account !== backfillState.account) throw new Error('Nomor WhatsApp berubah atau belum terdeteksi; mulai backfill untuk akun ini');
  }

  function models(collection) {
    try {
      const result = typeof collection?.getModelsArray === 'function' ? collection.getModelsArray() :
        typeof collection?.getModels === 'function' ? collection.getModels() : collection?.models || collection?._models || [];
      return Array.isArray(result) ? result.slice() : Object.values(result);
    } catch (_) { return []; }
  }

  function collections() {
    const candidates = [globalThis.Store];
    // Read only known collection exports. Never inject a webpack chunk, inspect
    // factory source, execute arbitrary factories, or call WA action APIs.
    if (typeof globalThis.require === 'function') {
      for (const name of ['WAWebCollections', 'WAWebChatCollection', 'WAWebMsgCollection', 'WAWebContactCollection', 'WAWebGroupMetadataCollection', 'WAWebChatLoadMessages']) {
        try { candidates.push(globalThis.require(name)); } catch (_) {}
      }
    }
    // Older builds can expose their already-loaded webpack exports directly.
    for (const runtime of [globalThis.__webpack_require__, globalThis.webpackRequire]) {
      try { for (const cached of Object.values(runtime?.c || {})) candidates.push(cached?.exports); } catch (_) {}
    }
    const result = {};
    for (const candidate of candidates) {
      for (const entry of [candidate, candidate?.default]) {
        if (!entry || typeof entry !== 'object') continue;
        result.Chat ||= entry.Chat || entry.ChatCollection;
        result.Msg ||= entry.Msg || entry.MsgCollection;
        result.Contact ||= entry.Contact || entry.ContactCollection;
        result.GroupMetadata ||= entry.GroupMetadata || entry.GroupMetadataCollection;
        result.ChatLoadMessages ||= entry.ChatLoadMessages || (typeof entry.loadEarlierMsgs === 'function' ? entry : null);
      }
    }
    return result;
  }

  function findChat(raw) {
    const id = raw?.id?.remote || raw?.chatId || (raw?.fromMe || raw?.id?.fromMe ? raw?.to : raw?.from);
    try {
      return raw?.chat || current.Chat?.get?.(id) || current.Chat?.get?.(key(id)) ||
        models(current.Chat).find(chat => key(chat.id) === key(id));
    } catch (_) { return null; }
  }

  function emit(raw, chat) {
    if (!readerEnabled) return;
    if (loadingHistory) { deferredEmits.push([raw, chat]); return; }
    try {
      if (!refreshAccount()) return;
      const message = normalizer.normalizeMessage(raw, chat || findChat(raw), {
        lookupContact(id) { return current.Contact?.get?.(id) || current.Contact?.get?.(key(id)); },
        ownJids,
      });
      if (!message || seen.has(message.id)) return;
      // An evicted id can safely replay: the local server deduplicates by id.
      if (seen.size >= 100000) seen.delete(seen.values().next().value);
      seen.add(message.id);
      globalThis.dispatchEvent(new CustomEvent('wa-reader-message', { detail: { ...message, account } }));
    } catch (_) { /* Ignore incompatible models; preserve the other messages. */ }
  }

  function subscribe(collection, handler) {
    if (!collection || typeof collection !== 'object' || subscribed.has(collection)) return;
    if (typeof collection.on === 'function') {
      try { collection.on('add', handler); subscribed.add(collection); } catch (_) {}
    }
  }

  function readChat(chat) {
    if (!readerEnabled) return;
    const messages = models(chat?.msgs || chat?.messages);
    messages.sort((a, b) => Number(a.t || a.timestamp || 0) - Number(b.t || b.timestamp || 0));
    for (const raw of messages.slice(-50)) emit(raw, chat);
    subscribe(chat?.msgs || chat?.messages, raw => emit(raw, chat));
  }

  function normalize(raw, chat) {
    return normalizer.normalizeMessage(raw, chat, {
      lookupContact(id) { return current.Contact?.get?.(id) || current.Contact?.get?.(key(id)); },
      ownJids,
    });
  }

  function earlierLoader(chat) {
    if (typeof chat?.loadEarlierMsgs === 'function') return () => chat.loadEarlierMsgs();
    const messages = chat?.msgs || chat?.messages;
    if (typeof messages?.loadEarlierMsgs === 'function') return () => messages.loadEarlierMsgs();
    if (typeof current?.ChatLoadMessages?.loadEarlierMsgs === 'function') {
      return () => current.ChatLoadMessages.loadEarlierMsgs({ chat });
    }
    return null;
  }

  async function bridgeRequest(kind, payload) {
    await waitForResume();
    if (kind === 'batch') requireBackfillAccount();
    try {
      return await new Promise((resolve, reject) => {
        const requestId = `${backfillState.session}:${++requestSequence}`;
        const timer = setTimeout(() => {
          bridgeRequests.delete(requestId);
          reject(new Error('Penyimpanan backfill tidak merespons; lanjutkan untuk mencoba lagi'));
        }, 30000);
        bridgeRequests.set(requestId, { resolve, reject, timer });
        globalThis.dispatchEvent(new CustomEvent('wa-reader-backfill-request', {
          detail: { requestId, kind, account: backfillState.account, session: backfillState.session, ...payload }
        }));
      });
    } catch (error) {
      if (error.message === 'reader off') return bridgeRequest(kind, payload);
      throw error;
    }
  }

  globalThis.addEventListener('wa-reader-backfill-response', event => {
    const response = event.detail;
    const pending = bridgeRequests.get(response?.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    bridgeRequests.delete(response.requestId);
    if (response.stored || response.ok) pending.resolve(response);
    else pending.reject(new Error(response.error || 'Penyimpanan backfill gagal; lanjutkan untuk mencoba lagi'));
  });

  async function checkpoint(status = 'running', detail = '') {
    backfillState.status = status;
    backfillState.detail = detail;
    const response = await bridgeRequest('checkpoint', { progress: backfillState });
    // The worker owns pause state: a checkpoint in flight must not undo Pause.
    if (response.progress?.status === 'paused') backfillPaused = true;
    backfillStatus({ ...backfillState, status: backfillPaused && status === 'running' ? 'paused' : status });
  }

  async function waitForResume() {
    while (!readerEnabled || backfillPaused) await new Promise(resolve => setTimeout(resolve, 250));
    requireBackfillAccount();
  }

  async function capture(messages, chat) {
    await waitForResume();
    const ids = new Set(backfillState.current.ids);
    const remaining = backfillState.maxPerChat - ids.size;
    if (remaining <= 0) return;
    const candidates = new Map();
    for (const raw of messages) {
      try {
        const message = normalize(raw, chat);
        if (message && !ids.has(message.id)) candidates.set(message.id, message);
      } catch (_) { /* Preserve compatible messages if a model changed shape. */ }
    }
    const batchItems = [...candidates.values()].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, remaining);
    for (let offset = 0; offset < batchItems.length; offset += 100) {
      await waitForResume();
      const batch = batchItems.slice(offset, offset + 100);
      await bridgeRequest('batch', { messages: batch });
      // Count/checkpoint only after the durable queue has acknowledged the batch.
      for (const message of batch) ids.add(message.id);
      backfillState.messageCount += batch.length;
      backfillState.current.ids = [...ids];
      backfillState.current.oldestId = [...batch].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))[0]?.id || backfillState.current.oldestId;
      await checkpoint('running', `Chat ke-${backfillState.chatIndex + 1} dari ${backfillState.chatIds.length}; ${backfillState.messageCount} pesan`);
    }
  }

  async function runBackfill(progress) {
    if (!readerEnabled) return;
    if (backfillRun) return;
    if (!progress || typeof progress.session !== 'string') return;
    if (backfillState?.session === progress.session && backfillState.status === 'done') return;
    backfillState = { ...progress, maxPerChat: Number.isSafeInteger(progress.maxPerChat) && progress.maxPerChat > 0 ? progress.maxPerChat : BACKFILL_MAX_PER_CHAT };
    refreshAccount();
    if (!account) {
      backfillStatus({ ...backfillState, status: 'idle', detail: 'Nomor WhatsApp belum terdeteksi; menunggu login' });
      return;
    }
    if (backfillState.account && backfillState.account !== account) {
      backfillStatus({ ...backfillState, status: 'error', detail: 'Backfill milik nomor WhatsApp lain; mulai ulang untuk akun ini' });
      return;
    }
    backfillState.account = account;
    backfillPaused = false;
    backfillRun = (async () => {
      try {
        requireBackfillAccount();
        current = collections();
        const chats = models(current.Chat);
        const byId = new Map(chats.map(chat => [key(chat.id), chat]).filter(([id]) => id));
        if (!backfillState.chatIds?.length) {
          backfillState.chatIds = [...byId.keys()];
          backfillState.chatIndex = 0;
          backfillState.messageCount = 0;
          backfillState.current = null;
        }
        backfillState.total = backfillState.chatIds.length;
        if (!backfillState.chatIds.length) {
          await checkpoint('unsupported', 'backfill tidak didukung versi WA ini');
          return;
        }
        while (backfillState.chatIndex < backfillState.chatIds.length) {
          await waitForResume();
          const id = backfillState.chatIds[backfillState.chatIndex];
          const chat = byId.get(id);
          if (!chat) throw new Error('Chat belum tersedia; lanjutkan setelah koleksi WhatsApp dimuat');
          const load = earlierLoader(chat);
          if (backfillState.current?.id !== id) backfillState.current = { id, ids: [], oldestId: null };
          await checkpoint('running');
          await capture(models(chat.msgs || chat.messages), chat);
          const inspected = new Set(models(chat.msgs || chat.messages).map(normalizer.idString).filter(Boolean));
          while (load && backfillState.current.ids.length < backfillState.maxPerChat) {
            await waitForResume();
            // Space every call, including transitions between chats. Loading only
            // fetches history; never activate/open a chat or acknowledge messages.
            const delay = Math.max(0, BACKFILL_DELAY_MS - (Date.now() - lastHistoryLoad));
            if (delay) await new Promise(resolve => setTimeout(resolve, delay));
            await waitForResume();
            let returned;
            try {
              loadingHistory = true;
              returned = await load();
            } catch (error) {
              loadingHistory = false;
              for (const [raw, sourceChat] of deferredEmits.splice(0)) emit(raw, sourceChat);
              throw error;
            } finally { loadingHistory = false; lastHistoryLoad = Date.now(); }
            await waitForResume();
            const loaded = Array.isArray(returned) ? returned : Array.isArray(returned?.messages) ? returned.messages : [];
            const history = [...loaded, ...models(chat.msgs || chat.messages)];
            const historyIds = new Set(history.map(normalizer.idString));
            // Collection add events from historical loads use the durable path;
            // preserve simultaneous live events in all other chats as usual.
            for (const [raw, sourceChat] of deferredEmits.splice(0)) if (!historyIds.has(normalizer.idString(raw))) emit(raw, sourceChat);
            const fresh = history.filter(raw => {
              const messageId = normalizer.idString(raw);
              if (!messageId || inspected.has(messageId)) return false;
              inspected.add(messageId);
              return true;
            });
            await capture(history, chat);
            // Some WA versions return models, others hydrate the collection. An
            // unchanged set means this read-only loader has no earlier history.
            if (!fresh.length || returned === false || (Array.isArray(returned) && !returned.length)) break;
          }
          backfillState.current = null;
          // Persist the completed chat before moving on; chat IDs keep resume
          // stable even when WhatsApp changes its chat collection ordering.
          // ponytail: if a reload loses WA's server anchor, rewalk the cached
          // range and dedupe by stored IDs; add a cursor adapter only when the
          // version exposes a stable read-only message key.
          backfillState.chatIndex++;
          await checkpoint('running');
        }
        await checkpoint('done', `Backfill selesai: ${backfillState.chatIds.length} chat, ${backfillState.messageCount} pesan`);
      } catch (error) {
        try { await checkpoint('error', error.message || 'Backfill gagal; lanjutkan untuk mencoba lagi'); }
        catch (_) { backfillStatus({ ...backfillState, status: 'error', detail: 'Penyimpanan backfill gagal; lanjutkan untuk mencoba lagi' }); }
      } finally { backfillRun = null; }
    })();
    await backfillRun;
  }

  globalThis.addEventListener('wa-reader-backfill-command', event => {
    const command = event.detail || {};
    if (command.action === 'pause') { backfillPaused = true; return; }
    if (!readerEnabled) return;
    if (command.action === 'resume') backfillPaused = false;
    if (command.action === 'resume' || command.action === 'start') void runBackfill(command.progress);
  });

  function chatDisplayName(chat) {
    return String(chat?.name || chat?.formattedTitle || chat?.formattedName || chat?.displayName || chat?.subject || key(chat?.id) || 'unknown');
  }

  function collectUnread() {
    if (!current?.Chat) return [];
    const list = [];
    for (const chat of models(current.Chat)) {
      const raw = chat.unreadCount ?? chat.__x_unreadCount;
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      const id = key(chat.id);
      const isGroup = Boolean(chat.isGroup || chat.__x_isGroup || String(id).endsWith('@g.us'));
      list.push({ chat: chatDisplayName(chat), chatId: id, unread: raw < 0 ? -1 : Math.floor(raw), isGroup });
    }
    return list;
  }

  function emitUnread() {
    if (!account) return;
    globalThis.dispatchEvent(new CustomEvent('wa-reader-unread', { detail: { account, chats: collectUnread() } }));
  }

  // Group members: read-only snapshot of participants + contact names/numbers, refreshed
  // at most once per day per group so Contact lookups never run on every scan tick.
  const GROUP_MEMBERS_TTL = 24 * 60 * 60 * 1000;
  const GROUP_MEMBERS_BATCH = 20;
  const membersSentAt = new Map();
  const contactName = contact => {
    for (const field of ['name', 'pushname', 'notifyName', 'verifiedName', 'formattedName']) {
      const value = contact?.[field];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };
  async function readGroupMembers(chat) {
    const chatId = key(chat.id);
    let meta = chat.groupMetadata?.participants ? chat.groupMetadata : null;
    if (!meta) { try { meta = current.GroupMetadata?.get?.(chatId); } catch (_) {} }
    if (!meta?.participants && typeof chat.getGroupMetadata === 'function') {
      try { meta = await Promise.race([chat.getGroupMetadata(), new Promise(resolve => setTimeout(() => resolve(null), 2500))]); } catch (_) {}
    }
    const participants = models(meta?.participants).map(p => {
      const jid = key(p.id);
      let contact;
      try { contact = current.Contact?.get?.(jid); } catch (_) {}
      const phone = normalizer.canonicalizeJid(contact?.phoneNumber || contact?.phoneNumberJid);
      return { jid, name: contactName(contact), phone: phone && !phone.endsWith('@lid') ? phone.split('@')[0] : '', isAdmin: Boolean(p.isAdmin || p.isSuperAdmin) };
    }).filter(p => p.jid);
    return { chatId, chat: chatDisplayName(chat), participants };
  }
  async function emitGroupMembers() {
    if (!readerEnabled) return;
    if (!account || !current?.Chat) return;
    const now = Date.now();
    const all = models(current.Chat);
    const groups = all.filter(c => String(key(c?.id) || '').endsWith('@g.us'));
    const due = groups.filter(chat => now - (membersSentAt.get(String(key(chat?.id) || '')) || 0) > GROUP_MEMBERS_TTL).slice(0, GROUP_MEMBERS_BATCH);
    if (!due.length) return;
    const dispatchDiag = extra => globalThis.dispatchEvent(new CustomEvent('wa-reader-group-members-diag', { detail: { account, diag: { chatTotal: all.length, groups: groups.length, due: due.length, gmModule: Boolean(current.GroupMetadata), contactModule: Boolean(current.Contact), ...extra } } }));
    dispatchDiag({ phase: 'start' });
    const chats = [];
    let withMeta = 0;
    for (const chat of due) {
      if (!readerEnabled) return;
      const chatId = key(chat.id);
      try {
        const data = await Promise.race([readGroupMembers(chat), new Promise(resolve => setTimeout(() => resolve(null), 3000))]);
        membersSentAt.set(chatId, now);
        if (data) {
          if (data.participants.length) withMeta += 1;
          chats.push(data);
        }
      } catch (_) { membersSentAt.set(chatId, now); }
    }
    if (!readerEnabled) return;
    if (chats.length) globalThis.dispatchEvent(new CustomEvent('wa-reader-group-members', { detail: { account, chats } }));
    dispatchDiag({ phase: 'done', emitted: chats.length, withMeta });
  }

  function scan() {
    if (!readerEnabled || !ready) return;
    try {
      refreshAccount();
      if (!account) {
        status(false, 'Nomor WhatsApp belum terdeteksi; menunggu login');
        return;
      }
      current = collections();
      status(Boolean(current.Chat || current.Msg), current.Chat || current.Msg ? 'Koleksi internal aktif; memantau seluruh chat yang dimuat' : 'Koleksi internal tidak tersedia; fallback DOM');
      if (!current.Chat && !current.Msg) {
        if (!warned) console.warn('[WA Reader] Koleksi internal belum tersedia; memakai fallback DOM read-only.');
        warned = true;
        status(false, 'Koleksi internal tidak tersedia; fallback DOM');
        return;
      }
      const byChat = new Map();
      const collect = (raw, chat) => {
        const chatKey = key(chat?.id || raw?.id?.remote || raw?.chatId || raw?.to || raw?.from);
        if (!byChat.has(chatKey)) byChat.set(chatKey, new Map());
        byChat.get(chatKey).set(normalizer.idString(raw), { raw, chat });
      };
      // Subscribe before backfill so additions during startup are also captured.
      subscribe(current.Msg, raw => emit(raw));
      subscribe(current.Chat, chat => readChat(chat));
      for (const raw of models(current.Msg)) collect(raw);
      for (const chat of models(current.Chat)) {
        subscribe(chat?.msgs || chat?.messages, raw => emit(raw, chat));
        for (const raw of models(chat?.msgs || chat?.messages)) collect(raw, chat);
      }
      for (const messages of byChat.values()) {
        const list = [...messages.values()];
        list.sort((a, b) => Number(a.raw.t || a.raw.timestamp || 0) - Number(b.raw.t || b.raw.timestamp || 0));
        for (const item of list.slice(-50)) emit(item.raw, item.chat);
      }
      status(true, 'Koleksi internal aktif; memantau seluruh chat yang dimuat');
      emitUnread();
      void emitGroupMembers().catch(() => {});
    } catch (_) {
      console.warn('[WA Reader] Struktur internal berubah; memakai fallback DOM read-only.');
      status(false, 'Reader internal gagal; fallback DOM');
    }
  }
  globalThis.addEventListener('neko-reader-control', event => {
    if (typeof event.detail?.enabled !== 'boolean') return;
    readerEnabled = event.detail.enabled;
    globalThis.__nekoReaderEnabled = readerEnabled;
    if (!readerEnabled) deferredEmits.length = 0;
    else scan();
  });
  globalThis.addEventListener('wa-reader-content-ready', () => { ready = true; scan(); });
  // Re-discover after login/module updates, and catch newly hydrated collections.
  setInterval(scan, 30000);
})();

globalThis.dispatchEvent(new Event('wa-reader-content-ready'));
}
