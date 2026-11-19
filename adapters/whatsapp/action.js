'use strict';
// Action primitive WhatsApp — BUKAN capture code (bridge/driver tetap read-only).
// Membangun script DOM (read-only probe) + orkestrasi kirim yang harus lewat
// input trusted: WA Web 2026 mengabaikan click() sintetis di chat list
// (tervalidasi live via CDP 2026-11-19 — element.click()/MouseEvent sintetis
// tidak membuka chat; Input.dispatchMouseEvent asli membuka). Di Electron,
// padanannya wc.sendInputEvent + wc.insertText, bukan executeJavaScript event.
// Semua fungsi murni kecuali sendReply (butuh wc-like: executeJavaScript,
// sendInputEvent, insertText — mockable untuk test).
const SEL = {
  list: '[data-testid="chat-list"]',
  row: 'div[role="row"][data-testid^="list-item"]',
  rowTitle: '[data-testid="cell-frame-title"]',
  cell: 'div[role="gridcell"][tabindex="0"]',
  header: '[data-testid="conversation-header"]',
  headerTitle: '[data-testid="conversation-info-header-chat-title-name"]',
  compose: 'footer div[contenteditable="true"]',
  sendBtn: 'footer button[aria-label="Send"]',
};

const digitsOf = s => String(s || '').replace(/\D/g, '');

// Script baca-only: resolve nama chat lewat koleksi internal (pola yang sama
// dengan page-main — tidak pernah inject chunk / panggil WA action API), lalu
// cari baris chat list: judul === nama, atau 8 digit terakhir jid muncul di
// baris. Balik pusat gridcell + judul baris untuk verifikasi post-klik.
const findRowScript = jid => `(() => {
  const key = id => typeof id === 'string' ? id : id?._serialized || (id?.user && id?.server ? \`$\{id.user}@$\{id.server}\` : '');
  const JID = ${JSON.stringify(String(jid))};
  const digits = s => String(s || '').replace(/\\D/g, '');
  let name = '', phone = '';
  try {
    const cands = [globalThis.Store];
    if (typeof globalThis.require === 'function') {
      for (const n of ['WAWebCollections', 'WAWebChatCollection', 'WAWebContactCollection']) {
        try { cands.push(globalThis.require(n)); } catch (_) {}
      }
    }
    let Chat = null, Contact = null;
    for (const c of cands) for (const e of [c, c?.default]) {
      if (!e || typeof e !== 'object') continue;
      Chat ||= e.Chat || e.ChatCollection; Contact ||= e.Contact || e.ContactCollection;
    }
    const chat = Chat?.get?.(key(JID)) ||
      (() => { const arr = typeof Chat?.getModelsArray === 'function' ? Chat.getModelsArray() : Chat?.models || [];
               return arr.find(ch => key(ch.id) === key(JID)); })();
    name = String(chat?.name || chat?.contact?.name || chat?.contact?.pushname || '');
    phone = String(chat?.contact?.phoneNumber?.user || chat?.contact?.phoneNumber?._serialized || '').replace(/\\D/g, '');
  } catch (_) {}
  const rows = [...document.querySelectorAll('${SEL.list} ${SEL.row}')];
  const tail = digits(JID).slice(-8);
  // judul baris bisa diawali badge unread ("1 unread messageX") — buang
  const norm = t => String(t || '').replace(/^\\d+\\s*unread\\s+messages?\\s*/i, '').trim();
  let byName = null, byDigits = null;
  for (const row of rows) {
    const title = norm(row.querySelector('${SEL.rowTitle}')?.textContent);
    if (!byName && name && title && (title === name || (name.length >= 5 && title.includes(name)))) {
      byName = { row, title, strategy: 'name' };
    }
    if (!byDigits && tail.length >= 8) {
      const text = digits(row.textContent);
      if (text.endsWith(tail) || (phone && text.endsWith(phone.slice(-8)))) {
        byDigits = { row, title: title || name || JID, strategy: 'digits' };
      }
    }
    if (byName) break;
  }
  const hit = byName || byDigits;
  if (!hit) return null;
  const cell = hit.row.querySelector('${SEL.cell}') || hit.row;
  const b = cell.getBoundingClientRect();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, title: hit.title, strategy: hit.strategy, name };
})()`;

// Pasca-klik: verifikasi chat yang kebuka benar (judul header = judul baris)
// + rect compose buat klik caret. Read-only.
const openChatScript = expectTitle => `(() => {
  const hdr = document.querySelector('${SEL.header}');
  const title = (document.querySelector('${SEL.headerTitle}')?.textContent || hdr?.innerText?.split('\\n')[0] || '').trim();
  const compose = document.querySelector('${SEL.compose}');
  const b = compose ? compose.getBoundingClientRect() : null;
  return {
    open: !!hdr,
    title,
    match: !!hdr && title === ${JSON.stringify(String(expectTitle || ''))},
    composeRect: b ? { x: b.x + Math.min(b.width / 2, 200), y: b.y + Math.min(b.height / 2, 20) } : null,
  };
})()`;

const stateScript = `(() => {
  const compose = document.querySelector('${SEL.compose}');
  const send = document.querySelector('${SEL.sendBtn}');
  const b = send ? send.getBoundingClientRect() : null;
  return { composeText: compose?.textContent || '', sendRect: b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null };
})()`;

// Verifikasi kirim BENER: baca koleksi chat (read-only) — pesan keluar harus
// muncul sebagai model. "Compose kosong" doang gak cukup (view tersembunyi
// bisa kosong karena insertText gak nempel, bukan karena terkirim).
const verifySentScript = (jid, text) => `(() => {
  const key = id => typeof id === 'string' ? id : id?._serialized || '';
  const JID = ${JSON.stringify(String(jid))};
  const NEEDLE = ${JSON.stringify(String(text).slice(0, 80))};
  let Chat = null;
  const cands = [globalThis.Store];
  if (typeof globalThis.require === 'function') {
    for (const n of ['WAWebCollections', 'WAWebChatCollection']) {
      try { cands.push(globalThis.require(n)); } catch (_) {}
    }
  }
  for (const c of cands) for (const e of [c, c?.default]) {
    if (!e || typeof e !== 'object') continue;
    Chat ||= e.Chat || e.ChatCollection;
  }
  const arr = Chat?.getModelsArray ? Chat.getModelsArray() : Chat?.models || [];
  const chat = arr.find(ch => key(ch.id) === key(JID));
  const msgs = chat?.msgs?.models || chat?.msgs?.getModelsArray?.() || [];
  // fromMe di model WA sering undefined (ada di id.fromMe) — cocokkan body saja,
  // needle-nya sudah spesifik (teks balasan LLM).
  const hit = msgs.filter(m => String(m.body || '').includes(NEEDLE)).pop();
  return { found: !!hit, t: hit?.t || 0 };
})()`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Klik trusted via sendInputEvent (bukan dispatchEvent — WA Web memblok sintetis).
const click = (wc, p) => {
  wc.sendInputEvent({ type: 'mouseDown', x: Math.round(p.x), y: Math.round(p.y), button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: Math.round(p.x), y: Math.round(p.y), button: 'left', clickCount: 1 });
};
const esc = wc => {
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
};

// Urutan kirim: cari baris → klik trusted → verifikasi chat → klik compose →
// insertText → Enter → cek compose kosong; fallback klik tombol Send.
async function sendReply(wc, jid, text, log = () => {}) {
  if (!wc || wc.isDestroyed?.()) return { ok: false, stage: 'view', detail: 'view tidak tersedia' };
  let hit;
  try { hit = await wc.executeJavaScript(findRowScript(jid)); }
  catch (e) { return { ok: false, stage: 'find-row', detail: String(e).slice(0, 200) }; }
  if (!hit) return { ok: false, stage: 'find-row', detail: 'baris chat tidak ketemu di list' };
  click(wc, hit);
  await sleep(900);
  let open;
  try { open = await wc.executeJavaScript(openChatScript(hit.title)); }
  catch (e) { return { ok: false, stage: 'verify-chat', detail: String(e).slice(0, 200) }; }
  if (!open.open || !open.match) {
    esc(wc);
    return { ok: false, stage: 'verify-chat', detail: `chat kebuka "${open.title || '?'}" ≠ target "${hit.title}"` };
  }
  if (!open.composeRect) return { ok: false, stage: 'compose', detail: 'compose box tidak ketemu' };
  click(wc, open.composeRect);
  await sleep(300);
  wc.insertText(String(text));
  await sleep(500);
  const verify = async () => {
    try { return await wc.executeJavaScript(verifySentScript(jid, text)); }
    catch (_) { return { found: false }; }
  };
  const confirmed = async tries => {
    for (let i = 0; i < tries; i += 1) {
      await sleep(900);
      const v = await verify();
      if (v.found) return true;
    }
    return false;
  };
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await sleep(1200);
  if (await confirmed(2)) { log(`terkirim ke "${hit.title}" (${hit.strategy})`); return { ok: true, title: hit.title, strategy: hit.strategy }; }
  const st = await wc.executeJavaScript(stateScript).catch(() => null);
  if (st?.sendRect) {
    log('Enter tidak mengirim; fallback klik tombol Send');
    click(wc, st.sendRect);
    if (await confirmed(3)) { log(`terkirim ke "${hit.title}" (${hit.strategy}, fallback Send)`); return { ok: true, title: hit.title, strategy: hit.strategy }; }
  }
  esc(wc);
  return { ok: false, stage: 'verify-send', detail: 'pesan tidak terkonfirmasi di koleksi chat (kirim gagal / view gak pegang fokus)' };
}

module.exports = { SEL, digitsOf, findRowScript, openChatScript, stateScript, sendReply };
