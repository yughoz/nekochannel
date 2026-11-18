'use strict';
// #9: build a desktop-notification payload from one live batch of captured
// messages. Pure Node (no electron imports) so node --test runs it standalone.
// Own sends (fromMe), media-only (text kosong) dan backfill tidak dinotifikasi —
// backfill memang tidak lewat sini (driver only calls this for type 'messages').
// ponytail: kalau terlalu berisik, tambah damping per-account + toggle tray.
const PREVIEW = 80;
const CHATS_MAX = 3;

module.exports = function buildNotif(messages, label = '') {
  const batch = Array.isArray(messages) ? messages : [];
  const incoming = batch.filter(m => m && m.fromMe === false && typeof m.text === 'string' && m.text.trim());
  if (!incoming.length) return null;
  const title = (String(label || incoming[0].account || '').trim() || 'Akun').slice(0, 80);
  const preview = text => {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.slice(0, PREVIEW) + (t.length > PREVIEW ? '…' : '');
  };
  const chats = [...new Set(incoming.map(m => String(m.chat || 'chat')))];
  const body = incoming.length === 1
    ? `${incoming[0].chat} — ${incoming[0].sender}: ${preview(incoming[0].text)}`
    : `${incoming.length} pesan baru — ${chats.slice(0, CHATS_MAX).join(', ')}${chats.length > CHATS_MAX ? '…' : ''}`;
  return { title, body, account: incoming[0].account || '' };
};
