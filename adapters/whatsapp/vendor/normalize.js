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
    // Identitas chat untuk arsip/kirim: JID (stabil) + nomor WA (chat LID: dari kontak).
    const chatJid = canonicalizeJid(chatId) || serializeId(chatId);
    let chatContact = chat.contact;
    if (!chatContact && !isGroup && chatJid) { try { chatContact = options.lookupContact?.(chatJid); } catch (_) {} }
    const chatPhone = isGroup ? '' : /@c\.us$/.test(chatJid) ? chatJid.split('@')[0] : phoneOf(chatContact) || phoneOf(chat);
    return { id, chat: chatName, chatId: chatJid, chatPhone, isGroup, sender, text, timestamp: timestamp(raw, options.now), fromMe, mentionsMe: flags.mentionsMe, replyToMe: flags.replyToMe };
  }
  return { normalizeMessage, normalizeAccount, serializeId, parsePlainTextDate, canonicalizeJid, collectOwnJids, isOwnJid, mentionedJidList, flagsFromDom, mentionFlags, idString: raw => serializeId(raw?.id || raw?._id || raw?.__x_id) };
});
