'use strict';
// #31 Jadwal Agent — runtime: tick → keputusan (scheduler.decide) → antrean satu run
// sekaligus → POST /api/chat (pipeline agent yang sama, mode readOnly: tanpa tool
// kirim/aksi) → hasil ke deliver() (panel Engine + notifikasi) + state + log.
// Log tanpa isi pesan; hasil terakhir (dibatasi) hanya di file state lokal (0600).
const fs = require('node:fs');
const scheduler = require('./scheduler');

const RESULT_MAX = 8000;
const RUN_TIMEOUT_MS = 180_000;
const LOG_TAIL = 15;

function readState(file) {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
function writeState(file, state) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// SSE dari /api/chat (tool/delta/done/error) → teks jawaban + model yang melayani.
function parseSse(text) {
  const out = { text: '', error: '', done: false, model: '', fallback: false };
  for (const block of String(text).split('\n\n')) {
    let event = 'message'; let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data = line.slice(5).trim();
    }
    let value = {};
    try { value = JSON.parse(data || '{}'); } catch { continue; }
    if (event === 'delta' && typeof value.text === 'string') out.text += value.text;
    else if (event === 'error') out.error = String(value.message || 'error').slice(0, 200);
    else if (event === 'done') { out.done = true; out.model = value.model || ''; out.fallback = value.fallback === true; }
  }
  return out;
}

function createScheduleRunner({ schedules, stateFile, logFile, chatUrl, isLocked = () => false, deliver = () => {}, fetchImpl = fetch, now = Date.now, log = () => {}, timeoutMs = RUN_TIMEOUT_MS }) {
  let state = readState(stateFile);
  let running = null;
  const queue = [];
  const audit = entry => {
    try { fs.appendFileSync(logFile, JSON.stringify({ ts: new Date(now()).toISOString(), ...entry }) + '\n', { mode: 0o600 }); } catch (error) { log(`log failed: ${error.message}`); }
  };
  const save = () => { try { writeState(stateFile, state); } catch (error) { log(`state save failed: ${error.message}`); } };
  const mark = (id, patch) => { state[id] = { ...(state[id] || {}), ...patch }; save(); };

  async function execute(item, manual) {
    const started = now();
    const due = manual ? started : scheduler.dueAt(item.time, started);
    mark(item.id, { lastRun: Math.max(state[item.id]?.lastRun || 0, due), lastStatus: 'running', lastAt: started });
    let result;
    const url = chatUrl();
    if (!url) result = { status: 'failed', detail: 'agent unavailable' };
    else {
      try {
        const prompt = scheduler.buildPrompt(item, state[item.id], started);
        const response = await fetchImpl(`${url}/api/chat`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], readOnly: true, ...(item.account ? { account: item.account } : {}) }),
        });
        if (!response.ok) result = { status: 'failed', detail: `agent http ${response.status}` };
        else {
          const out = parseSse(await response.text());
          result = out.error ? { status: 'failed', detail: out.error }
            : out.text.trim() ? { status: 'ok', text: out.text.trim().slice(0, RESULT_MAX), model: out.model, fallback: out.fallback }
            : { status: 'failed', detail: 'empty answer' };
        }
      } catch (error) {
        result = { status: 'failed', detail: error?.name === 'TimeoutError' ? 'timeout' : String(error?.message || error).slice(0, 200) };
      }
    }
    mark(item.id, result.status === 'ok'
      ? { lastStatus: 'ok', lastAt: now(), lastSuccess: started, lastText: result.text, lastModel: result.model || '', lastDetail: '' }
      : { lastStatus: 'failed', lastAt: now(), lastDetail: result.detail });
    audit({ id: item.id, name: item.name, status: result.status, manual, ...(result.detail ? { detail: result.detail } : {}), ...(result.text ? { chars: result.text.length } : {}), ...(result.fallback ? { fallback: true } : {}) });
    try { deliver(item, result); } catch (error) { log(`deliver failed: ${error.message}`); }
    return result;
  }
  async function drain() {
    if (running) return;
    while (queue.length) {
      const job = queue.shift();
      running = job.item.id;
      try { job.resolve(await execute(job.item, job.manual)); }
      catch (error) { job.resolve({ status: 'failed', detail: String(error?.message || error) }); }
      finally { running = null; }
    }
  }
  const enqueue = (item, manual) => new Promise(resolve => {
    if (running === item.id || queue.some(job => job.item.id === item.id)) return resolve({ status: 'busy' });
    queue.push({ item, manual, resolve });
    drain();
  });

  return {
    // Dipanggil periodik oleh main. Master OFF = tidak ada run otomatis.
    tick() {
      const config = schedules();
      if (!config.enabled) return [];
      const at = now();
      const decisions = [];
      for (const item of config.items) {
        const decision = scheduler.decide(item, state[item.id], at, { locked: isLocked() });
        if (!decision) continue;
        decisions.push([item.id, decision]);
        if (decision === 'missed') {
          mark(item.id, { lastRun: scheduler.dueAt(item.time, at), lastStatus: 'missed', lastAt: at });
          audit({ id: item.id, name: item.name, status: 'missed' });
        } else if (decision === 'run') enqueue(item, false);
        // defer: terkunci → tick berikutnya (decide memutuskan run/missed setelah unlock)
      }
      return decisions;
    },
    // "Jalankan sekarang" dari Settings: aksi eksplisit user, tidak bergantung master.
    runNow(id) {
      const item = schedules().items.find(entry => entry.id === id);
      if (!item) return Promise.resolve({ status: 'failed', detail: 'unknown schedule' });
      if (isLocked()) return Promise.resolve({ status: 'failed', detail: 'locked' });
      return enqueue(item, true);
    },
    state: () => structuredClone(state),
    runs(limit = LOG_TAIL) {
      try { return fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-limit).map(line => JSON.parse(line)).reverse(); } catch { return []; }
    },
    prune(ids) { // jadwal dihapus → buang state-nya (termasuk hasil terakhir)
      let changed = false;
      for (const id of Object.keys(state)) if (!ids.includes(id)) { delete state[id]; changed = true; }
      if (changed) save();
    },
    busy: () => running,
  };
}

module.exports = { createScheduleRunner, parseSse, RESULT_MAX };
