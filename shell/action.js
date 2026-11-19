'use strict';
// Action engine (M6) — main process. Auto-reply DALAM BATAS, default OFF:
// master switch + per-akun, dua-duanya mati bawaan. Capture path tidak disentuh;
// engine cuma konsumen kedua callback onMessages driver (bukan instance baru).
// Murni Node (node --test) — Electron-nya disuntik lewat `send` dan `busy`.
const fs = require('node:fs');

const QUIET_MS = 8000;        // tunggu chat hening sebelum membalas (burst coalesce)
const STALE_MS = 10 * 60000;  // pesan masuk lebih tua dari ini tidak dijawab
const SPACING_MS = 30000;     // jeda minimum antar kirim per akun (anti-ban)
const MAX_PER_HOUR = 20;
const MAX_PER_DAY = 100;
const BUSY_RETRY_MS = 20000;  // human lagi aktif → tunda, bukan buang
const MAX_BUSY_TRIES = 5;
const MAX_TAIL = 30;          // pesan tersimpan per chat
const MAX_CHATS = 50;         // chat diingat per akun (LRU)
const CONTEXT_MAX = 12;       // pesan yang dikirim ke LLM

const dayKey = ts => new Date(ts).toISOString().slice(0, 10);
const hourKey = ts => new Date(ts).toISOString().slice(0, 13);

const envLookup = (envPath, keys) => {
  const map = {};
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) map[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* .env belum ada */ }
  for (const key of keys) if (map[key]) return map[key].replace(/\/+$/, '');
  return '';
};

// Text-only: tanpa attachment/media/link otomatis — URL di balasan LLM dibuang
// utuh; balasan yang isinya cuma link jadi kosong → di-skip, bukan dikirim.
const sanitizeReply = text => String(text || '')
  .replace(/\[([^\]]+)\]\((?:https?:\/\/|www\.)[^)]*\)/gi, '$1')
  .replace(/(?:https?:\/\/|www\.)\S+/gi, '')
  .replace(/[ \t]{2,}/g, ' ') // bekas URL yang dibuang
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  .trim().slice(0, 800);

// Target sah: pesan TERAKHIR di chat itu incoming + ada teks + belum basi;
// grup cuma kalau menyebut kita. Tidak ada cold-contact.
const pickTarget = (tail, now = Date.now()) => {
  const last = tail && tail[tail.length - 1];
  if (!last || last.fromMe || !last.text) return null;
  if (last.isGroup && last.mentionsMe !== true) return null;
  if (!Number.isFinite(Date.parse(last.timestamp)) || now - Date.parse(last.timestamp) > STALE_MS) return null;
  return last;
};

// Rate limit per akun: spacing, 20/jam, 100/hari.
const rateCheck = (counters, now = Date.now()) => {
  const day = dayKey(now), hour = hourKey(now);
  if (counters.day !== day) { counters.day = day; counters.sentDay = 0; }
  if (counters.hour !== hour) { counters.hour = hour; counters.sentHour = 0; }
  if (now - (counters.lastSentAt || 0) < SPACING_MS) return { ok: false, reason: 'spacing' };
  if (counters.sentHour >= MAX_PER_HOUR) return { ok: false, reason: 'jam' };
  if (counters.sentDay >= MAX_PER_DAY) return { ok: false, reason: 'hari' };
  return { ok: true };
};

function makeEngine({ logFile, settings, envFile, busy = () => false, send, log = () => {}, onEvent = () => {}, fetchImpl = fetch, now = Date.now, timings = {}, enabled: enabledFn }) {
  const QUIET = timings.quietMs ?? QUIET_MS;         // override buat test
  const BUSY_RETRY = timings.busyRetryMs ?? BUSY_RETRY_MS;
  // Default cocok settings.action.accounts[account]; main.js bisa menyuntik
  // resolver (settings menyimpan toggle per sidebar-id, driver kirim nomor WA).
  const enabled = enabledFn || (account => !!settings.action?.master && !!settings.action?.accounts?.[account]);
  const tails = new Map();   // account → Map(chat → items[])
  const pending = new Map(); // `${account}|${chat}` → { timer, tries }
  const counters = new Map(); // account → rate counters
  const events = [];         // ring buat tab Action
  let seq = 0;

  const emit = (kind, account, chat, detail, extra = {}) => {
    const ev = { seq: ++seq, ts: new Date(now()).toISOString(), kind, account, chat, detail: detail || '', ...extra };
    events.push(ev);
    if (events.length > 100) events.splice(0, events.length - 100);
    try { onEvent(ev); } catch (_) {}
  };
  const audit = entry => {
    try { fs.appendFileSync(logFile, JSON.stringify({ ts: new Date(now()).toISOString(), ...entry }) + '\n'); }
    catch (e) { log(`audit log gagal: ${e.message}`); }
  };

  const dropPending = key => { const p = pending.get(key); if (p) clearTimeout(p.timer); pending.delete(key); };
  const clearPending = account => { for (const key of [...pending.keys()]) if (!account || key.startsWith(`${account}|`)) dropPending(key); };

  const llmConfig = () => {
    const url = envLookup(envFile, ['CHAT_MODEL_URL', 'SUMMARY_MODEL_URL']);
    const name = envLookup(envFile, ['CHAT_MODEL_NAME', 'SUMMARY_MODEL_NAME']);
    const key = envLookup(envFile, ['CHAT_MODEL_KEY', 'SUMMARY_MODEL_KEY']);
    return { url, name, key, ok: Boolean(url && name) };
  };

  const attempt = async (account, chat) => {
    const key = `${account}|${chat}`;
    const tries = pending.get(key)?.tries || 0;
    dropPending(key);
    if (!enabled(account)) return; // kill switch / akun off → antrean dibuang
    const chats = tails.get(account);
    const target = pickTarget(chats?.get(chat), now());
    if (!target) return;
    if (!llmConfig().ok) {
      emit('skip', account, chat, 'config LLM kosong (Settings 10.1)');
      audit({ account, chat, action: 'reply', result: 'skipped', detail: 'llm-unconfigured' });
      return;
    }
    if (!counters.has(account)) counters.set(account, {});
    const c = counters.get(account);
    const rate = rateCheck(c, now());
    if (!rate.ok) {
      emit('skip', account, chat, `rate limit (${rate.reason})`);
      audit({ account, chat, action: 'reply', result: 'skipped', detail: `rate-${rate.reason}` });
      return;
    }
    if (busy(account)) {
      if (tries > MAX_BUSY_TRIES) { // tries = counter antrean yang dibaca sebelum drop
        emit('skip', account, chat, 'human aktif terus — dibatalkan');
        audit({ account, chat, action: 'reply', result: 'skipped', detail: 'busy-giveup' });
        return;
      }
      emit('defer', account, chat, `human aktif; tunda ke-${tries + 1}`);
      const t = setTimeout(() => { attempt(account, chat).catch(() => {}); }, BUSY_RETRY);
      if (t.unref) t.unref();
      pending.set(key, { timer: t, tries: tries + 1 });
      return;
    }
    const history = (chats.get(chat) || []).slice(-CONTEXT_MAX)
      .map(m => ({ role: m.fromMe ? 'assistant' : 'user', content: String(m.text).slice(0, 4000) }));
    const cfg = llmConfig();
    let reply = '';
    try {
      const res = await fetchImpl(`${cfg.url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}) },
        body: JSON.stringify({
          model: cfg.name,
          messages: [
            { role: 'system', content: 'Kamu asisten balasan chat WhatsApp. Balas SINGKAT, bahasa mengikuti pesan masuk, gaya santai-profesional. Hanya teks biasa: tanpa tautan/URL, tanpa markdown rumit. Jangan mengaku AI kecuali ditanya.' },
            ...history,
          ],
          temperature: 0.4, max_tokens: 300,
        }),
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok) throw new Error(`llm ${res.status}`);
      const data = await res.json();
      reply = sanitizeReply(data?.choices?.[0]?.message?.content);
    } catch (e) {
      emit('error', account, chat, `LLM gagal: ${String(e.message || e).slice(0, 120)}`);
      audit({ account, chat, action: 'reply', result: 'error', detail: 'llm-call', error: String(e.message || e).slice(0, 200) });
      return;
    }
    if (!reply) {
      emit('skip', account, chat, 'balasan LLM kosong/abis sanitasi');
      audit({ account, chat, action: 'reply', result: 'skipped', detail: 'empty-reply' });
      return;
    }
    emit('reply', account, chat, 'mengirim…', { text: reply });
    let result;
    try { result = await send(account, chat, reply); }
    catch (e) { result = { ok: false, stage: 'send', detail: String(e.message || e).slice(0, 200) }; }
    if (result.ok) {
      c.lastSentAt = now(); c.sentHour += 1; c.sentDay += 1;
      emit('sent', account, chat, result.title ? `terkirim: ${result.title}` : 'terkirim', { text: reply });
    } else {
      emit('error', account, chat, `gagal ${result.stage}: ${result.detail || ''}`.slice(0, 180));
    }
    // isi pesan tidak masuk console (privasi) — hanya audit file + event UI.
    audit({ account, chat, action: 'reply', text: reply, result: result.ok ? 'sent' : 'error', detail: result.stage || '', target: result.title || '' });
    log(`action ${result.ok ? 'sent' : `error(${result.stage})`} account=${account}`);
  };

  return {
    onMessages(account, items) {
      if (!Array.isArray(items) || !items.length) return;
      let chats = tails.get(account);
      if (!chats) { chats = new Map(); tails.set(account, chats); }
      for (const item of items) {
        if (!item?.chat) continue;
        const arr = chats.get(item.chat);
        if (arr) {
          chats.delete(item.chat); // sisip ulang = posisi LRU paling baru
          arr.push(item);
          if (arr.length > MAX_TAIL) arr.splice(0, arr.length - MAX_TAIL);
          chats.set(item.chat, arr);
        }
        else {
          chats.set(item.chat, [item]);
          if (chats.size > MAX_CHATS) { const oldest = chats.keys().next().value; chats.delete(oldest); dropPending(`${account}|${oldest}`); }
        }
        const triggers = !item.fromMe && item.text && (!item.isGroup || item.mentionsMe === true);
        if (!triggers || !enabled(account)) continue;
        const key = `${account}|${item.chat}`;
        dropPending(key);
        const t = setTimeout(() => { attempt(account, item.chat).catch(() => {}); }, QUIET);
        if (t.unref) t.unref();
        pending.set(key, { timer: t, tries: 0 });
      }
    },
    setMaster(on) { if (!on) clearPending(); emit('info', '', '', `master ${on ? 'ON' : 'OFF'}`); },
    setAccount(account, on) { if (!on) clearPending(account); emit('info', account, '', `akun ${on ? 'ON' : 'OFF'}`); },
    snapshot() {
      const cfg = llmConfig();
      return {
        master: !!settings.action?.master,
        accounts: { ...(settings.action?.accounts || {}) },
        events,
        llm: { url: cfg.url, name: cfg.name, keySet: Boolean(cfg.key) },
        pending: pending.size,
      };
    },
    _test: { tails, pending, counters, attempt },
  };
}

module.exports = { makeEngine, pickTarget, rateCheck, sanitizeReply, envLookup, QUIET_MS, STALE_MS, SPACING_MS, MAX_PER_HOUR, MAX_PER_DAY };
