'use strict';
// WA Engine chat UI — vanilla, tanpa build step (docs/modul_ui.md). Riwayat
// dipegang klien dan dikirim balik per request; server menyimpannya per sesi
// (#30: pulih setelah restart, ringkasan otomatis untuk riwayat panjang). Isi arsip WA =
// input tak terpercaya: escape HTML SELALU jalan dulu sebelum markdown-lite
// (**bold**, `code`, `- bullet`) — tidak ada innerHTML mentah.

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const inline = esc => esc
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

// Escape dulu, baru markdown-lite; bullet berurutan jadi satu <ul>.
const renderRich = text => {
  let out = '';
  let inList = false;
  for (const line of escapeHtml(text).split('\n')) {
    const bullet = line.match(/^- +(.*)$/);
    if (bullet && !inList) { out += '<ul>'; inList = true; }
    else if (!bullet && inList) { out += '</ul>'; inList = false; }
    if (bullet) out += `<li>${inline(bullet[1])}</li>`;
    else if (line.trim()) out += `<div>${inline(line)}</div>`;
  }
  if (inList) out += '</ul>';
  return out;
};

// Parser SSE incremental: feed(chunk) → daftar event yang sudah lengkap.
// Chunk terpotong di tengah baris tetap benar (sisa di-buffer).
const sseParser = () => {
  let buf = '';
  return chunk => {
    buf += chunk;
    const events = [];
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = { event: 'message', data: '' };
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) ev.event = line.slice(6).trim();
        else if (line.startsWith('data:')) ev.data = line.slice(5).trim();
      }
      try { ev.data = JSON.parse(ev.data); } catch { /* biarkan mentah */ }
      events.push(ev);
    }
    return events;
  };
};

// Args dari server = string JSON (bisa terpotong "…") → pretty bila valid, mentah bila tidak.
const formatArgs = args => {
  const raw = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
};

const chatUI = { escapeHtml, renderRich, sseParser, formatArgs };
globalThis.chatUI = chatUI;
if (typeof module !== 'undefined' && module.exports) module.exports = chatUI;

// Sesi dari hash URL (#s=<id>&label=<nama>&account=<jid>), diset Nekochannel
// saat pindah tab akun: tiap channel punya percakapan sendiri.
const parseSession = hash => {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const key = (params.get('s') || 'default').slice(0, 64);
  return { key, label: (params.get('label') || '').slice(0, 100), account: (params.get('account') || '').slice(0, 64) };
};
chatUI.parseSession = parseSession;

// ===== wiring browser (di-skip saat di-run via vm tanpa DOM) =====
if (typeof document !== 'undefined' && document.getElementById('log')) {
  const $ = id => document.getElementById(id);
  const log = $('log'), input = $('input'), send = $('send'), dot = $('dot'),
    banner = $('banner'), modelinfo = $('modelinfo'), sessionEl = $('session');
  // Satu entri per sesi: riwayat + panel DOM sendiri. Jawaban yang masih
  // streaming tetap ditulis ke panel sesinya walau user sudah pindah tab.
  const sessions = new Map();
  let S = null; // sesi aktif

  const sessionFor = info => {
    let session = sessions.get(info.key);
    if (!session) {
      const pane = document.createElement('div');
      pane.className = 'pane';
      pane.dataset.session = info.key;
      session = { key: info.key, label: '', account: '', history: [], pane, streaming: false, loaded: false };
      sessions.set(info.key, session);
      restore(session);
    }
    session.label = info.label || session.label;
    session.account = info.account || session.account;
    return session;
  };
  const activate = info => {
    const next = sessionFor(info);
    if (S !== next) {
      S = next;
      log.replaceChildren(S.pane);
      input.value = '';
      input.style.height = '';
    }
    sessionEl.textContent = S.label ? `· ${S.label}` : '';
    send.disabled = S.streaming;
    document.title = S.label ? `WA Engine · ${S.label}` : 'WA Engine';
    log.scrollTop = log.scrollHeight;
  };

  const scrollIf = session => { if (session === S) log.scrollTop = log.scrollHeight; };
  const bubble = (session, cls) => {
    const el = document.createElement('div');
    el.className = `row ${cls}`;
    session.pane.appendChild(el);
    scrollIf(session);
    return el;
  };
  const chip = (session, ev) => {
    const d = document.createElement('details');
    d.className = 'chip';
    const s = document.createElement('summary');
    s.textContent = typeof ev.summary === 'string' ? `${ev.name} · ${ev.summary}` : `${ev.name} · ${ev.summary || 0} baris`;
    const pre = document.createElement('pre');
    pre.textContent = formatArgs(ev.args);
    d.appendChild(s);
    d.appendChild(pre);
    session.pane.appendChild(d);
    scrollIf(session);
  };

  // #30: pulihkan riwayat sesi dari server (sekali per sesi). Gagal = mulai kosong, tidak memblokir.
  async function restore(session) {
    session.streaming = true;
    if (session === S) send.disabled = true;
    try {
      const res = await fetch(`/api/session?key=${encodeURIComponent(session.key)}`);
      const data = res.ok ? await res.json() : null;
      if (Array.isArray(data?.history) && data.history.length) {
        // Disisipkan DI DEPAN: entri yang masuk selama restore (mis. hasil jadwal) tetap di bawahnya.
        const restored = [];
        const fragment = document.createDocumentFragment();
        for (const item of data.history) {
          if (item?.role !== 'user' && item?.role !== 'assistant') continue;
          restored.push({ role: item.role, content: String(item.content) });
          const el = document.createElement('div');
          el.className = `row ${item.role === 'user' ? 'user' : 'agent'}`;
          el.innerHTML = renderRich(item.content);
          fragment.appendChild(el);
        }
        session.pane.prepend(fragment);
        session.history.unshift(...restored);
      }
    } catch { /* store tidak ada / offline → sesi kosong */ }
    finally {
      session.loaded = true;
      session.streaming = false;
      if (session === S) send.disabled = false;
      scrollIf(session);
    }
  }
  let served = null; // model yang terakhir melayani (utama/cadangan), dari event done

  async function checkHealth() {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      const res = await fetch('/api/health', { signal: ctl.signal });
      clearTimeout(timer);
      const h = await res.json();
      dot.className = h.ok ? 'ok' : 'err';
      banner.style.display = 'none';
      const via = served?.fallback ? ` → cadangan ${served.model}` : '';
      modelinfo.textContent = h.ok ? `${h.model || '?'}${via} · ${(h.messages || 0).toLocaleString('id-ID')} pesan` : '';
    } catch {
      dot.className = 'err';
      banner.style.display = 'block';
      modelinfo.textContent = '';
    }
  }

  async function ask() {
    const session = S; // terkunci ke sesi saat bertanya, bukan sesi yang aktif nanti
    const text = input.value.trim();
    if (!text || session.streaming) return;
    input.value = '';
    input.style.height = '';
    session.history.push({ role: 'user', content: text });
    bubble(session, 'user').innerHTML = renderRich(text);
    const agentEl = bubble(session, 'agent');
    const cur = document.createElement('span');
    cur.className = 'cursor';
    agentEl.appendChild(cur);
    session.streaming = true;
    if (session === S) send.disabled = true;
    let acc = '';
    let done = false;
    const paint = () => { agentEl.innerHTML = renderRich(acc); agentEl.appendChild(cur); scrollIf(session); };
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: session.history, session: session.key, ...(session.account ? { account: session.account } : {}) }),
      });
      if (!res.ok || !res.body) throw new Error(`http ${res.status}`);
      const parse = sseParser();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        for (const ev of parse(dec.decode(value, { stream: true }))) {
          if (ev.event === 'tool') { cur.remove(); chip(session, ev.data); agentEl.appendChild(cur); }
          else if (ev.event === 'delta') { acc += typeof ev.data.text === 'string' ? ev.data.text : ''; paint(); }
          else if (ev.event === 'error') { agentEl.classList.add('err'); acc += `${acc ? '\n' : ''}${ev.data.message || 'error'}`; paint(); }
          else if (ev.event === 'done') {
            done = true;
            if (ev.data?.model) { served = { model: ev.data.model, fallback: ev.data.fallback === true }; checkHealth(); }
            if (ev.data?.compacted) { cur.remove(); chip(session, { name: 'ringkasan', summary: `${ev.data.compacted} pesan lama diringkas`, args: '{}' }); agentEl.appendChild(cur); }
          }
        }
      }
      if (!acc && !agentEl.classList.contains('err')) { acc = '(tanpa jawaban)'; paint(); }
      if (done && acc && !agentEl.classList.contains('err')) session.history.push({ role: 'assistant', content: acc });
    } catch (error) {
      agentEl.classList.add('err');
      agentEl.innerHTML = renderRich(`gagal: ${error.message || error}`);
      checkHealth(); // koneksi mati → indikator + banner langsung diperbarui
    } finally {
      cur.remove();
      session.streaming = false;
      if (session === S) send.disabled = false;
      scrollIf(session);
    }
  }

  send.onclick = ask;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  });
  $('clear').onclick = () => {
    if (S.streaming) return;
    S.history.length = 0;
    S.pane.textContent = '';
    fetch(`/api/session?key=${encodeURIComponent(S.key)}`, { method: 'DELETE' }).catch(() => {}); // server menyimpan backup
  };
  // #31 Jadwal Agent: Nekochannel menyuntik hasil run terjadwal ke sesi akun target.
  // Masuk riwayat sebagai jawaban asisten → bisa ditanya lanjut; tersimpan di request berikutnya.
  globalThis.__nekoScheduled = ({ key, name, status, text, detail } = {}) => {
    const session = sessionFor({ key: String(key || 'default').slice(0, 64) });
    const body = status === 'ok' ? String(text || '') : `gagal: ${String(detail || 'error')}`;
    const content = `⏰ Jadwal · ${String(name || '').slice(0, 80)}\n${body}`;
    const el = bubble(session, 'agent');
    if (status !== 'ok') el.classList.add('err');
    el.innerHTML = renderRich(content);
    if (status === 'ok') session.history.push({ role: 'assistant', content });
    return true;
  };
  addEventListener('hashchange', () => activate(parseSession(location.hash)));
  activate(parseSession(location.hash));
  globalThis.__nekoSessions = sessions; // diagnosa/smoke: baca-saja

  checkHealth(); // langsung di boot, bukan nunggu interval pertama
  setInterval(checkHealth, 30000);
}
