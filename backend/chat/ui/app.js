'use strict';
// WA Reader chat UI — vanilla, tanpa build step (docs/modul_ui.md). Riwayat
// dipegang klien (server stateless, dikirim balik per request). Isi arsip WA =
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

// ===== wiring browser (di-skip saat di-run via vm tanpa DOM) =====
if (typeof document !== 'undefined' && document.getElementById('log')) {
  const $ = id => document.getElementById(id);
  const log = $('log'), input = $('input'), send = $('send'), dot = $('dot'),
    banner = $('banner'), modelinfo = $('modelinfo');
  const history = [];
  let streaming = false;

  const scroll = () => { log.scrollTop = log.scrollHeight; };
  const bubble = cls => {
    const el = document.createElement('div');
    el.className = `row ${cls}`;
    log.appendChild(el);
    scroll();
    return el;
  };
  const chip = ev => {
    const d = document.createElement('details');
    d.className = 'chip';
    const s = document.createElement('summary');
    s.textContent = `${ev.name} · ${ev.summary || 0} baris`;
    const pre = document.createElement('pre');
    pre.textContent = formatArgs(ev.args);
    d.appendChild(s);
    d.appendChild(pre);
    log.appendChild(d);
    scroll();
  };

  async function checkHealth() {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      const res = await fetch('/api/health', { signal: ctl.signal });
      clearTimeout(timer);
      const h = await res.json();
      dot.className = h.ok ? 'ok' : 'err';
      banner.style.display = 'none';
      modelinfo.textContent = h.ok ? `${h.model || '?'} · ${(h.messages || 0).toLocaleString('id-ID')} pesan` : '';
    } catch {
      dot.className = 'err';
      banner.style.display = 'block';
      modelinfo.textContent = '';
    }
  }

  async function ask() {
    const text = input.value.trim();
    if (!text || streaming) return;
    input.value = '';
    input.style.height = '';
    history.push({ role: 'user', content: text });
    bubble('user').innerHTML = renderRich(text);
    const agentEl = bubble('agent');
    const cur = document.createElement('span');
    cur.className = 'cursor';
    agentEl.appendChild(cur);
    streaming = true;
    send.disabled = true;
    let acc = '';
    let done = false;
    const paint = () => { agentEl.innerHTML = renderRich(acc); agentEl.appendChild(cur); scroll(); };
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: history }),
      });
      if (!res.ok || !res.body) throw new Error(`http ${res.status}`);
      const parse = sseParser();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        for (const ev of parse(dec.decode(value, { stream: true }))) {
          if (ev.event === 'tool') { cur.remove(); chip(ev.data); agentEl.appendChild(cur); }
          else if (ev.event === 'delta') { acc += typeof ev.data.text === 'string' ? ev.data.text : ''; paint(); }
          else if (ev.event === 'error') { agentEl.classList.add('err'); acc += `${acc ? '\n' : ''}${ev.data.message || 'error'}`; paint(); }
          else if (ev.event === 'done') done = true;
        }
      }
      if (!acc && !agentEl.classList.contains('err')) { acc = '(tanpa jawaban)'; paint(); }
      if (done && acc && !agentEl.classList.contains('err')) history.push({ role: 'assistant', content: acc });
    } catch (error) {
      agentEl.classList.add('err');
      agentEl.innerHTML = renderRich(`gagal: ${error.message || error}`);
      checkHealth(); // koneksi mati → indikator + banner langsung diperbarui
    } finally {
      cur.remove();
      streaming = false;
      send.disabled = false;
      scroll();
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
  $('clear').onclick = () => { history.length = 0; log.textContent = ''; };

  checkHealth(); // langsung di boot, bukan nunggu interval pertama
  setInterval(checkHealth, 30000);
}
