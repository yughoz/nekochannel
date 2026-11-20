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

// Script baca-only (async): kandidat judul dari koleksi internal (formattedTitle,
// name, contact.name — pola page-main, tidak pernah panggil WA action API) +
// HINT (nama chat di arsip), nomor dari contact.phoneNumber / JID @c.us / HINT.
// Cocok = judul baris PERSIS sama salah satu kandidat, atau digit judul PERSIS
// sama nomor. Tidak ada pencocokan sebagian: salah baris = salah penerima.
// Chat list WA tervirtualisasi (hanya baris terlihat ada di DOM) → bila belum
// ketemu, scroll kontainer list dari atas sampai ketemu/habis.
const findRowScript = (jid, hint = '', knownPhone = '') => `(async () => {
  const key = id => typeof id === 'string' ? id : id?._serialized || (id?.user && id?.server ? \`$\{id.user}@$\{id.server}\` : '');
  const JID = ${JSON.stringify(String(jid))};
  const HINT = ${JSON.stringify(String(hint || ''))};
  const KNOWN_PHONE = ${JSON.stringify(String(knownPhone || '').replace(/\D/g, ''))}; // nomor WA tersimpan di arsip
  const clean = s => String(s || '').replace(/[\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]/g, '').replace(/\\s+/g, ' ').trim();
  // judul baris bisa diawali badge unread ("1 unread messageX") — buang
  const norm = t => clean(t).replace(/^\\d+\\s*unread\\s+messages?\\s*/i, '');
  const digits = s => String(s || '').replace(/\\D/g, '');
  const names = new Set();
  let phone = '';
  try {
    const cands = [globalThis.Store];
    if (typeof globalThis.require === 'function') {
      for (const n of ['WAWebCollections', 'WAWebChatCollection', 'WAWebContactCollection']) {
        try { cands.push(globalThis.require(n)); } catch (_) {}
      }
    }
    let Chat = null;
    for (const c of cands) for (const e of [c, c?.default]) {
      if (!e || typeof e !== 'object') continue;
      Chat ||= e.Chat || e.ChatCollection;
    }
    const chat = Chat?.get?.(key(JID)) ||
      (() => { const arr = typeof Chat?.getModelsArray === 'function' ? Chat.getModelsArray() : Chat?.models || [];
               return arr.find(ch => key(ch.id) === key(JID)); })();
    for (const v of [chat?.formattedTitle, chat?.name, chat?.contact?.name, chat?.contact?.formattedName]) if (clean(v)) names.add(clean(v));
    phone = digits(chat?.contact?.phoneNumber?.user || chat?.contact?.phoneNumber?._serialized || '');
  } catch (_) {}
  if (clean(HINT)) names.add(clean(HINT));
  if (!phone) phone = KNOWN_PHONE;
  if (!phone && /@(c\\.us|s\\.whatsapp\\.net)$/.test(JID)) phone = digits(JID.split('@')[0]);
  if (!phone && /^[+\\d\\s().-]+$/.test(clean(HINT))) phone = digits(HINT);
  if (phone.length < 8) phone = '';
  const list = document.querySelector('${SEL.list}');
  if (!list) return null;
  const scan = () => {
    let byDigits = null;
    for (const row of list.querySelectorAll('${SEL.row}')) {
      const title = norm(row.querySelector('${SEL.rowTitle}')?.textContent);
      if (!title) continue;
      if (names.has(title)) return { row, title, strategy: 'name' };
      if (!byDigits && phone && digits(title) === phone) byDigits = { row, title, strategy: 'digits' };
    }
    return byDigits;
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let scroller = null;
  for (let el = list; el && el !== document.body; el = el.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) { scroller = el; break; }
  }
  let hit = scan();
  let steps = 0;
  if (!hit && scroller) {
    scroller.scrollTop = 0;
    await wait(200);
    hit = scan();
    while (!hit && steps < 300 && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 2) {
      scroller.scrollTop += Math.max(100, Math.floor(scroller.clientHeight * 0.8));
      steps++;
      await wait(150);
      hit = scan();
    }
  }
  if (!hit) return null;
  // Baris di tengah viewport; list virtual bisa me-recycle elemen → scan ulang.
  hit.row.scrollIntoView({ block: 'center' });
  await wait(200);
  hit = scan() || hit;
  const cell = hit.row.querySelector('${SEL.cell}') || hit.row;
  const b = cell.getBoundingClientRect();
  if (b.bottom <= 0 || b.top >= innerHeight) return null;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, title: hit.title, strategy: hit.strategy, steps, name: [...names][0] || '' };
})()`;

// Pasca-klik: verifikasi chat yang kebuka benar (judul header = judul baris)
// + rect compose buat klik caret. Read-only.
const openChatScript = expectTitle => `(() => {
  const clean = s => String(s || '').replace(/[\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]/g, '').replace(/\\s+/g, ' ').trim();
  const hdr = document.querySelector('${SEL.header}');
  const title = clean(document.querySelector('${SEL.headerTitle}')?.textContent || hdr?.innerText?.split('\\n')[0] || '');
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
// hint = nama chat yang diketahui (arsip/normalize) → kandidat judul; phone = nomor WA tersimpan.
async function sendReply(wc, jid, text, log = () => {}, { hint = '', phone = '' } = {}) {
  if (!wc || wc.isDestroyed?.()) return { ok: false, stage: 'view', detail: 'view tidak tersedia' };
  let hit;
  try { hit = await wc.executeJavaScript(findRowScript(jid, hint, phone)); }
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
