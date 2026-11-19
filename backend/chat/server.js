#!/usr/bin/env node
'use strict';
// WA Reader chat agent: agent loop function-calling di atas arsip read-only,
// hasil dialirkan ke klien via SSE. Zero dependency (node:http + node:sqlite + fetch).
// Ref: docs/modul_server.md. Tool SQL reuse dari mcp/server.js (sudah teruji).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { TOOL_DEFS, clip, clean, loadDotEnv, makeTools, openArchive } = require('../mcp/server.js');

const DEFAULT_PORT = 4318;
const MODEL_TIMEOUT_MS = 60_000;
const MAX_BODY_BYTES = 256 * 1024;
const RESULT_TEXT_MAX = 8000;
const STUFFING_SEARCH_LIMIT = 25;
const CHAT_TOOL_NAMES = ['search_messages', 'get_chat_messages', 'list_chats', 'unread_summary', 'db_overview'];
const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' };
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const parseDate = value => {
  if (value === undefined || value === null || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};

// limit dari model tidak dipercaya: bukan integer >= 1 jatuh ke fallback, lalu di-clamp.
const limitValue = (value, fallback, max) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
};

const compact = (value, limit) => {
  const text = JSON.stringify(value ?? {});
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
};

const rowsOf = out => {
  if (!out) return 0;
  for (const key of ['messages', 'chats', 'accounts']) if (Array.isArray(out[key])) return out[key].length;
  return 0;
};

function makeConfig(env = process.env, cwd = path.resolve(__dirname, '..')) {
  const int = (value, fallback) => { const n = Number(String(value ?? '').trim()); return Number.isInteger(n) && n >= 1 ? n : fallback; };
  const host = String(env.CHAT_HOST || '127.0.0.1').trim();
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('CHAT_HOST harus loopback (127.0.0.1) — server ini tanpa auth');
  const mode = String(env.CHAT_MODE || '').trim().toLowerCase();
  const dataDir = env.CHAT_DATA_DIR || path.resolve(cwd, 'data');
  return {
    host,
    port: int(env.CHAT_PORT, DEFAULT_PORT),
    modelUrl: String(env.CHAT_MODEL_URL || env.SUMMARY_MODEL_URL || '').trim().replace(/\/+$/, ''),
    modelName: String(env.CHAT_MODEL_NAME || env.SUMMARY_MODEL_NAME || '').trim(),
    modelKey: String(env.CHAT_MODEL_KEY || env.SUMMARY_MODEL_KEY || '').trim(),
    dataDir,
    dbPath: path.join(dataDir, 'wa.sqlite'),
    // 'fc' = langsung function calling (skip probe), 'stuffing' = paksa konteks,
    // selain itu 'auto': probe sekali saat startup (M1: nekopro dukung fc).
    mode: mode === 'fc' || mode === 'stuffing' ? mode : 'auto',
    maxToolRounds: Math.min(int(env.CHAT_MAX_TOOL_ROUNDS, 6), 12),
    maxHistory: Math.min(int(env.CHAT_MAX_HISTORY, 24), 100),
  };
}

function makeChatTools(db) {
  const base = makeTools(db);
  // Spesifikasi modul: get_chat_messages mencocokkan nama chat PERSIS, urut waktu naik.
  const getExact = args => {
    const chat = clean(args.chat);
    if (!chat) throw new Error('chat is required');
    const limit = limitValue(args.limit, 50, 200);
    const since = parseDate(args.since);
    const until = parseDate(args.until);
    if (since === undefined || until === undefined) throw new Error('since/until must be ISO dates');
    const filters = ['chat = ?'];
    const params = [chat];
    if (since) { filters.push('timestamp >= ?'); params.push(since); }
    if (until) { filters.push('timestamp <= ?'); params.push(until); }
    params.push(limit);
    const rows = db.prepare(`SELECT account, chat, isGroup, sender, text, timestamp, fromMe, mentionsMe, replyToMe FROM messages WHERE ${filters.join(' AND ')} ORDER BY timestamp ASC LIMIT ?`).all(...params);
    return { chat, count: rows.length, messages: rows.map(row => ({ ...row, text: clip(row.text) })) };
  };
  const withLimit = (fn, fallback, max) => args => fn({ ...args, limit: limitValue(args?.limit, fallback, max) });
  return {
    search_messages: withLimit(base.search_messages, 25, 50),
    get_chat_messages: getExact,
    list_chats: withLimit(base.list_chats, 50, 100),
    unread_summary: base.unread_summary,
    db_overview: base.db_overview,
  };
}

function toolDefs() {
  const overrides = { get_chat_messages: 'Recent messages of one chat (exact chat name — call list_chats first when unsure), oldest first.' };
  return TOOL_DEFS
    .filter(def => CHAT_TOOL_NAMES.includes(def.name))
    .map(def => ({ type: 'function', function: { name: def.name, description: overrides[def.name] || def.description, parameters: def.inputSchema } }));
}

function buildSystemPrompt(archive) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  let accounts = [];
  try { accounts = archive.prepare('SELECT account, label FROM accounts ORDER BY account').all(); } catch { /* db kosong */ }
  const accountList = accounts.length
    ? accounts.map(row => `- ${clean(row.account)}${row.label ? ` (${clean(row.label)})` : ''}`).join('\n')
    : '- (belum ada akun tercatat)';
  return [
    'Kamu asisten di atas arsip WhatsApp lokal (read-only). Jawab HANYA dari data yang dikembalikan tools; jangan mengarul.',
    'Aturan: periksa dulu pakai tools sebelum menjawab; sebut rentang waktu data kalau relevan; kalau nama chat tidak pasti, panggil list_chats dulu; timestamp DB dalam UTC ISO; jawab dengan bahasa santai.',
    'Skema ringkas: messages(account, id, chat, isGroup, sender, text, timestamp, fromMe, mentionsMe, replyToMe) · chat_unread(account, chat, chatId, unread, isGroup, updatedAt) · accounts(account, label) · messages_fts (FTS5: text, chat, sender, account).',
    `Hari ini: ${today} (Asia/Jakarta).`,
    `Akun terdaftar:\n${accountList}`,
  ].join('\n');
}

async function callModel({ config, messages, tools, fetchImpl, timeoutMs = MODEL_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`model timeout after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${config.modelUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(config.modelKey ? { authorization: `Bearer ${config.modelKey}` } : {}) },
      body: JSON.stringify({ model: config.modelName, messages, stream: false, ...(tools ? { tools } : {}) }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`model http ${response.status}`);
    const data = await response.json();
    const choice = data?.choices?.[0];
    if (!choice?.message) throw new Error('model response malformed');
    return choice;
  } finally { clearTimeout(timer); }
}

async function runAgent({ config, mode, history, tools, defs, archive, emit, fetchImpl, timeoutMs }) {
  if (mode === 'stuffing') {
    // Tanpa tool-calls: hasil search atas pertanyaan user + overview disuntik ke prompt.
    const lastUser = [...history].reverse().find(m => m.role === 'user');
    const blocks = [];
    let summary = 0;
    let query = '';
    try { blocks.push(`[OVERVIEW] ${compact(tools.db_overview(), 4000)}`); } catch { /* best-effort */ }
    if (lastUser) {
      try {
        query = String(lastUser.content).slice(0, 200);
        const found = tools.search_messages({ query, limit: STUFFING_SEARCH_LIMIT });
        summary = rowsOf(found);
        blocks.push(`[SEARCH] ${compact(found, 8000)}`);
      } catch { /* best-effort */ }
    }
    const context = blocks.length ? `\n\nKONTEKS ARSIP (mode stuffing — data terlampir, jawab dari konteks ini):\n${blocks.join('\n')}` : '';
    emit('tool', { name: 'search_messages', args: compact({ query }, 200), summary });
    const choice = await callModel({ config, messages: [{ role: 'system', content: buildSystemPrompt(archive) + context }, ...history], fetchImpl, timeoutMs });
    emit('delta', { text: typeof choice.message.content === 'string' ? choice.message.content : '' });
    emit('done', { finishReason: choice.finish_reason || 'stop', rounds: 1 });
    return;
  }
  const messages = [{ role: 'system', content: buildSystemPrompt(archive) }, ...history];
  let rounds = 0;
  while (rounds < config.maxToolRounds) {
    rounds++;
    const choice = await callModel({ config, messages, tools: defs, fetchImpl, timeoutMs });
    const rawCalls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [];
    const calls = rawCalls.filter(call => call?.function?.name);
    if (!calls.length) {
      emit('delta', { text: typeof choice.message.content === 'string' ? choice.message.content : '' });
      emit('done', { finishReason: choice.finish_reason || 'stop', rounds });
      return;
    }
    messages.push({ role: 'assistant', content: choice.message.content || null, tool_calls: rawCalls });
    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
        if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
      } catch { args = {}; }
      let summary = 0;
      let resultText;
      try {
        const fn = tools[call.function.name];
        if (!fn) throw new Error(`unknown tool: ${call.function.name}`);
        const out = fn(args);
        summary = rowsOf(out);
        resultText = JSON.stringify(out).slice(0, RESULT_TEXT_MAX);
      } catch (error) {
        resultText = `tool error: ${String(error?.message || error).slice(0, 300)}`;
      }
      emit('tool', { name: call.function.name, args: compact(args, 200), summary });
      messages.push({ role: 'tool', tool_call_id: call.id || call.function.name, content: resultText });
    }
  }
  // Budget round habis: satu panggilan terakhir TANPA tools untuk memaksa jawaban teks.
  const choice = await callModel({ config, messages, fetchImpl, timeoutMs });
  const text = typeof choice.message.content === 'string' && choice.message.content
    ? choice.message.content
    : '(model gak ngasih jawaban setelah batas round tool)';
  emit('delta', { text });
  emit('done', { finishReason: 'max_rounds', rounds });
}

function parseChatBody(raw, maxHistory) {
  let body;
  try { body = JSON.parse(raw); } catch { return null; }
  if (!body || !Array.isArray(body.messages) || !body.messages.length) return null;
  const history = [];
  for (const item of body.messages.slice(-maxHistory)) {
    const content = item && typeof item.content === 'string' ? item.content.trim() : '';
    if ((item?.role === 'user' || item?.role === 'assistant') && content) history.push({ role: item.role, content });
  }
  return history.length ? history : null;
}

function serveStatic(res, url, uiDir) {
  const notFound = () => { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); };
  if (url === '/' || url === '') url = '/index.html';
  let rel;
  try { rel = decodeURIComponent(url); } catch { rel = url; }
  const file = path.resolve(uiDir, rel.replace(/^\/+/, ''));
  if (file !== uiDir && !file.startsWith(uiDir + path.sep)) return notFound();
  let data;
  try { data = fs.readFileSync(file); } catch { return notFound(); }
  res.writeHead(200, { 'content-type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(data);
}

async function handleChat({ config, tools, defs, archive, logger, fetchImpl, timeoutMs, state, req, res }) {
  let body = '';
  let size = 0;
  let exceeded = false;
  req.setEncoding('utf8');
  req.on('data', chunk => {
    if (exceeded) return;
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY_BYTES) {
      exceeded = true;
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'body too large' }));
      return;
    }
    body += chunk;
  });
  req.on('error', () => { try { res.destroy(); } catch { /* closed */ } });
  req.on('end', async () => {
    if (exceeded) return;
    const history = parseChatBody(body, config.maxHistory);
    if (!history) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'body harus { messages: [{ role: "user"|"assistant", content: string }] }' }));
    }
    if (state.mode === 'auto' && state.probe) await state.probe.catch(() => { /* probe gagal = stuffing */ });
    res.writeHead(200, SSE_HEADERS);
    const toolLog = [];
    const emit = (event, data) => {
      if (res.destroyed) throw new Error('client disconnected');
      if (event === 'tool') toolLog.push(`${data.name}:${data.summary}`);
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      await runAgent({ config, mode: state.mode, history, tools, defs, archive, emit, fetchImpl, timeoutMs });
      logger.info(`chat rounds ok tools=${toolLog.join(',') || '-'}`);
    } catch (error) {
      const message = String(error?.message || error || 'error').slice(0, 300);
      logger.warn(`chat failed: ${message}`);
      if (!res.destroyed && !res.writableEnded) {
        try { res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`); } catch { /* socket gone */ }
      }
    }
    res.end();
  });
}

function makeHandler({ config, tools, defs, archive, uiDir, logger = console, fetchImpl = fetch, timeoutMs, state }) {
  return function handle(req, res) {
    const url = String(req.url || '/').split('?')[0];
    if (req.method === 'GET' && url === '/api/health') {
      let total = 0;
      try { total = archive.prepare('SELECT COUNT(*) AS n FROM messages').get().n; } catch { /* db kosong */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, configured: Boolean(config.modelUrl && config.modelName), model: config.modelName, mode: state.mode, tools: defs.length, messages: total }));
    }
    if (req.method === 'POST' && url === '/api/chat' && (!config.modelUrl || !config.modelName)) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Configure an LLM in Settings, then restart Nekochannel.' }));
    }
    if (req.method === 'POST' && url === '/api/chat') return handleChat({ config, tools, defs, archive, logger, fetchImpl, timeoutMs, state, req, res });
    if (req.method === 'GET') return serveStatic(res, url, uiDir);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  };
}

// Probe sekali saat startup (mode auto): satu panggilan dengan satu tool dummy.
// FC terpakai bila model memanggil tool; selain itu / gagal jaringan → stuffing.
async function probeMode({ config, fetchImpl, timeoutMs, logger }) {
  const probeTools = [{ type: 'function', function: { name: 'archive_probe', description: 'Panggil tool ini untuk memeriksa dukungan function calling.', parameters: { type: 'object', properties: {} } } }];
  try {
    const choice = await callModel({
      config,
      messages: [{ role: 'user', content: 'Panggil tool archive_probe sekarang. Jangan jawab dengan teks.' }],
      tools: probeTools,
      fetchImpl,
      timeoutMs,
    });
    const used = Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length > 0;
    logger.info(`chat probe: function calling ${used ? 'didukung' : 'TIDAK dipakai'} → mode=${used ? 'fc' : 'stuffing'}`);
    return used ? 'fc' : 'stuffing';
  } catch (error) {
    logger.warn(`chat probe gagal (${String(error?.message || error).slice(0, 120)}) → mode=stuffing`);
    return 'stuffing';
  }
}

async function startServer({ config = makeConfig(), logger = console, fetchImpl = fetch, db, uiDir, timeoutMs = MODEL_TIMEOUT_MS } = {}) {
  const configured = Boolean(config.modelUrl && config.modelName);
  const archive = db || openArchive(config.dbPath);
  const tools = makeChatTools(archive);
  const defs = toolDefs();
  const state = { mode: config.mode, probe: null };
  if (configured && config.mode === 'auto') state.probe = probeMode({ config, fetchImpl, timeoutMs, logger }).then(mode => { state.mode = mode; });
  const server = http.createServer(makeHandler({ config, tools, defs, archive, uiDir: uiDir || path.resolve(__dirname, 'ui'), logger, fetchImpl, timeoutMs, state }));
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  } catch (error) { archive.close(); throw error; }
  logger.info(`chat agent ready on http://${config.host}:${server.address().port} (mode=${config.mode}, model=${config.modelName})`);
  const close = async () => {
    await new Promise(resolve => server.close(resolve));
    if (state.probe) await state.probe.catch(() => {});
    try { archive.close(); } catch { /* sudah tutup */ }
  };
  return { server, config, state, tools, close };
}

if (require.main === module) {
  loadDotEnv(path.resolve(__dirname, '..', '.env'));
  try {
    startServer({ config: makeConfig(process.env, path.resolve(__dirname, '..')) }).catch(error => {
      console.error(error.message || error);
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

module.exports = { makeConfig, makeChatTools, startServer, toolDefs, buildSystemPrompt, parseChatBody };
