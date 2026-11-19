#!/usr/bin/env node
'use strict';
// WA Reader MCP server: exposes read-only archive tools over MCP streamable HTTP
// (JSON-RPC 2.0). Zero dependency. Auth: Authorization: Bearer <WAREADER_MCP_KEY>.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_PORT = 4319;
const MAX_BODY_BYTES = 256 * 1024;
const TEXT_LIMIT = 300;
const PROTOCOL_VERSION = '2025-06-18';

function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* .env is optional */ }
}

function makeConfig(env = process.env, cwd = process.cwd()) {
  const port = Number(String(env.WAREADER_MCP_PORT ?? '').trim());
  const key = String(env.WAREADER_MCP_KEY || '');
  const dataDir = env.WAREADER_MCP_DATA_DIR || path.resolve(cwd, 'data');
  return {
    host: '127.0.0.1',
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT,
    key,
    dbPath: path.join(dataDir, 'wa.sqlite'),
  };
}

const clean = value => String(value ?? '').replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').trim();
const clip = (value, limit = TEXT_LIMIT) => {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
};

function openArchive(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA query_only=ON;');
  return db;
}

const parseDate = value => {
  if (value === undefined || value === null || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};

const like = value => String(value ?? '').replace(/[%_\\]/g, ch => `\\${ch}`);
const ftsQuery = value => {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  // Wrap as a quoted phrase unless the caller already uses FTS operators.
  return /["*()]|^AND$|^OR$|^NOT$/.test(text) ? text : `"${text.replace(/"/g, '""')}"`;
};

function makeTools(db) {
  const rows = (sql, ...params) => db.prepare(sql).all(...params);

  const run = {
    search_messages(args) {
      const match = ftsQuery(args.query);
      if (!match) throw new Error('query is required');
      const limit = Math.min(Number(args.limit) || 25, 50);
      const since = parseDate(args.since);
      const until = parseDate(args.until);
      if (since === undefined || until === undefined) throw new Error('since/until must be ISO dates');
      const filters = [];
      const params = [match];
      if (args.chat) { filters.push("m.chat LIKE ? ESCAPE '\\'"); params.push(`%${like(args.chat)}%`); }
      if (since) { filters.push('m.timestamp >= ?'); params.push(since); }
      if (until) { filters.push('m.timestamp <= ?'); params.push(until); }
      const where = filters.length ? ` AND ${filters.join(' AND ')}` : '';
      const sql = `SELECT m.account, m.chat, m.isGroup, m.sender, m.text, m.timestamp, m.fromMe, m.mentionsMe, m.replyToMe
        FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
        WHERE messages_fts MATCH ?${where}
        ORDER BY m.timestamp DESC LIMIT ?`;
      params.push(limit);
      return { query: match, count: 0, messages: [] , _sql: sql, _params: params };
    },
    get_chat_messages(args) {
      if (!clean(args.chat)) throw new Error('chat is required');
      const limit = Math.min(Number(args.limit) || 50, 200);
      const since = parseDate(args.since);
      const until = parseDate(args.until);
      if (since === undefined || until === undefined) throw new Error('since/until must be ISO dates');
      const filters = ["chat LIKE ? ESCAPE '\\'"];
      const params = [`%${like(args.chat)}%`];
      if (since) { filters.push('timestamp >= ?'); params.push(since); }
      if (until) { filters.push('timestamp <= ?'); params.push(until); }
      params.push(limit);
      return { chat: clean(args.chat), count: 0, messages: [], _sql: `SELECT account, chat, isGroup, sender, text, timestamp, fromMe, mentionsMe, replyToMe FROM messages WHERE ${filters.join(' AND ')} ORDER BY timestamp DESC LIMIT ?`, _params: params };
    },
    list_chats(args) {
      const limit = Math.min(Number(args.limit) || 50, 100);
      const since = parseDate(args.since);
      if (since === undefined) throw new Error('since must be an ISO date');
      const filter = since ? 'WHERE MAX(timestamp) >= ?' : '';
      const params = since ? [since, limit] : [limit];
      return { count: 0, chats: [], _sql: `SELECT chat, MAX(isGroup) AS isGroup, COUNT(*) AS messages, MAX(timestamp) AS lastAt FROM messages ${filter} GROUP BY chat ORDER BY lastAt DESC LIMIT ?`, _params: params };
    },
    unread_summary() {
      return { chats: [], _sql: 'SELECT c.account, a.label, c.chat, c.chatId, c.unread, c.isGroup, c.updatedAt FROM chat_unread c LEFT JOIN accounts a ON a.account = c.account WHERE c.unread > 0 ORDER BY c.updatedAt DESC' };
    },
    group_members(args) {
      if (!clean(args.chat)) throw new Error('chat is required');
      return { chat: clean(args.chat), members: [], _sql: "SELECT chatId, chat, jid, name, phone, isAdmin, updatedAt FROM group_members WHERE chat LIKE ? ESCAPE '\\' ORDER BY chat, name LIMIT 500", _params: [`%${like(args.chat)}%`] };
    },
  };

  const runQuery = (definition) => {
    const { _sql, _params = [], ...rest } = definition;
    const rowsOut = rows(_sql, ..._params).map(row => {
      const out = {};
      for (const [key, value] of Object.entries(row)) {
        if (key === 'text') out[key] = clip(value);
        else if (key === 'account' || key === 'chatId') out[key] = clip(value, 60);
        else out[key] = value;
      }
      return out;
    });
    const summary = { ...rest };
    for (const key of ['messages', 'chats', 'members']) if (Array.isArray(summary[key])) { summary[key] = rowsOut; summary.count = rowsOut.length; }
    if (summary.chats === undefined && summary.messages === undefined && summary.members === undefined) return rowsOut;
    return summary;
  };

  return {
    search_messages: args => runQuery(run.search_messages(args)),
    get_chat_messages: args => runQuery(run.get_chat_messages(args)),
    list_chats: args => runQuery(run.list_chats(args)),
    unread_summary: () => runQuery(run.unread_summary()),
    group_members: args => runQuery(run.group_members(args)),
    db_overview: () => {
      const accounts = rows('SELECT m.account, a.label, COUNT(*) AS messages, MIN(m.timestamp) AS firstAt, MAX(m.timestamp) AS lastAt FROM messages m LEFT JOIN accounts a ON a.account = m.account GROUP BY m.account ORDER BY messages DESC');
      const top = rows('SELECT chat, COUNT(*) AS messages, MAX(timestamp) AS lastAt FROM messages GROUP BY chat ORDER BY messages DESC LIMIT 10');
      return { accounts: accounts.map(row => ({ ...row, account: clip(row.account, 40), label: clip(row.label) })), topChats: top.map(row => ({ ...row, chat: clip(row.chat) })) };
    },
  };
}

const TOOL_DEFS = [
  { name: 'search_messages', description: 'Full-text search across the WhatsApp archive (FTS5). Returns newest first.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, chat: { type: 'string', description: 'partial chat name filter' }, since: { type: 'string', description: 'ISO date lower bound' }, until: { type: 'string', description: 'ISO date upper bound' }, limit: { type: 'integer', maximum: 50 } }, required: ['query'] } },
  { name: 'get_chat_messages', description: 'Recent messages of one chat (name matched partially), newest first.', inputSchema: { type: 'object', properties: { chat: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, limit: { type: 'integer', maximum: 200 } }, required: ['chat'] } },
  { name: 'list_chats', description: 'Chats with message counts and last activity, newest activity first.', inputSchema: { type: 'object', properties: { since: { type: 'string' }, limit: { type: 'integer', maximum: 100 } } } },
  { name: 'unread_summary', description: 'Chats currently marked unread per account.', inputSchema: { type: 'object', properties: {} } },
  { name: 'group_members', description: 'Members of one archived group, with phone numbers and contact names captured from WhatsApp.', inputSchema: { type: 'object', properties: { chat: { type: 'string', description: 'partial group name' } }, required: ['chat'] } },
  { name: 'db_overview', description: 'Archive overview: accounts with totals/date ranges and the top chats.', inputSchema: { type: 'object', properties: {} } },
];

function jsonRpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function jsonRpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

function makeHandler({ db, config, logger = console } = {}) {
  const tools = makeTools(db);
  return function handle(req, res) {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, tools: TOOL_DEFS.length }));
    }
    if (req.method !== 'POST' || (req.url !== '/mcp' && req.url !== '/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    const expected = `Bearer ${config.key}`;
    const header = String(req.headers.authorization || '');
    if (!config.key || header.length !== expected.length || !header.startsWith('Bearer ') ||
        !timingSafe(header, expected)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'bearer key required' }));
    }
    let body = '';
    let size = 0;
    let exceeded = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (exceeded) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) { exceeded = true; res.writeHead(413); return res.end(JSON.stringify({ error: 'body too large' })); }
      body += chunk;
    });
    req.on('end', () => {
      if (exceeded) return;
      let rpc;
      try { rpc = JSON.parse(body || '{}'); } catch { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'invalid JSON' })); }
      const reply = payload => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
      const list = Array.isArray(rpc) ? rpc : [rpc];
      const out = [];
      for (const call of list) {
        const { id, method, params } = call || {};
        if (!method) { if (id !== undefined && id !== null) out.push(jsonRpcError(id, -32600, 'method missing')); continue; }
        if (method === 'initialize') {
          out.push(jsonRpcResult(id, { protocolVersion: params?.protocolVersion || PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'wa-reader', version: '1.0.0' } }));
        } else if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
          // notification: no response body entry
        } else if (method === 'tools/list') {
          out.push(jsonRpcResult(id, { tools: TOOL_DEFS }));
        } else if (method === 'tools/call') {
          const name = params?.name;
          const fn = tools[name];
          if (!fn) { out.push(jsonRpcError(id, -32602, `unknown tool: ${name}`)); continue; }
          try {
            const result = fn(params?.arguments || {});
            logger.info(`tool ${name} ok`);
            out.push(jsonRpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false }));
          } catch (error) {
            logger.warn(`tool ${name} failed: ${error.message}`);
            out.push(jsonRpcResult(id, { content: [{ type: 'text', text: error.message }], isError: true }));
          }
        } else {
          out.push(jsonRpcError(id, -32601, `method not found: ${method}`));
        }
      }
      if (!out.length) { res.writeHead(202); return res.end(); }
      reply(list.length > 1 ? out : out[0]);
    });
    req.on('error', () => { try { res.destroy(); } catch { /* closed */ } });
  };
}

function timingSafe(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && cryptoTiming(bufA, bufB);
}
function cryptoTiming(a, b) {
  const { timingSafeEqual } = require('node:crypto');
  return timingSafeEqual(a, b);
}

async function startServer({ config = makeConfig(), logger = console, fetchImpl, db } = {}) {
  if (!config.key) throw new Error('WAREADER_MCP_KEY is required');
  const archive = db || openArchive(config.dbPath);
  const server = http.createServer(makeHandler({ db: archive, config, logger }));
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  } catch (error) { archive.close(); throw error; }
  logger.info(`WA Reader MCP listening on http://${config.host}:${config.port}/mcp`);
  const close = async () => { await new Promise(resolve => server.close(resolve)); try { archive.close(); } catch { /* already closed */ } };
  return { server, config, close };
}

if (require.main === module) {
  loadDotEnv(path.resolve(process.cwd(), '.env'));
  const config = makeConfig(process.env, process.cwd());
  startServer({ config }).catch(error => { console.error(error.message || error); process.exitCode = 1; });
}

module.exports = { makeConfig, makeTools, makeHandler, startServer, openArchive, ftsQuery, clip, clean, TOOL_DEFS, loadDotEnv };
