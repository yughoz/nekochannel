'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const ingest = require('./server');
const chat = require('./chat/server');
const mcp = require('./mcp/server');

function loadEnv(dir, env = process.env, file = env.NEKOCHANNEL_ENV) {
  const read = file => {
    if (!file || !fs.existsSync(file)) return {};
    return require('node:util').parseEnv(fs.readFileSync(file, 'utf8'));
  };
  return { ...read(file), ...read(path.join(dir, '.env')), ...env };
}

// Only an explicit import, before services start. SQLite backup includes committed
// WAL rows; neither the source connection nor its schema is ever writable here.
async function migrateArchive(source, dataDir) {
  source = fs.realpathSync(source);
  const destination = path.resolve(dataDir, 'wa.sqlite');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(destination)) throw new Error('Destination archive already exists; import requires an empty data directory');
  const temporary = path.join(dataDir, `.import-${crypto.randomUUID()}.sqlite`);
  const snapshot = path.join(dataDir, `legacy-backup-${crypto.randomUUID()}.sqlite`);
  let db;
  try {
    db = new DatabaseSync(source, { readOnly: true });
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Source integrity check failed');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get()) throw new Error('Not a message archive');
    await backup(db, temporary);
    fs.chmodSync(temporary, 0o600);
    fs.copyFileSync(temporary, snapshot, fs.constants.COPYFILE_EXCL);
    fs.linkSync(temporary, destination); // atomic no-clobber publication
    return { destination, backup: snapshot };
  } finally { db?.close(); fs.rmSync(temporary, { force: true }); }
}

const port = (env, name, fallback) => {
  if (env[name] === undefined) return fallback;
  const n = Number(env[name]);
  if (!/^\d+$/.test(String(env[name])) || !Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} must be a port (0–65535)`);
  return n;
};

async function startBackend({ dir, env = process.env, logger = console } = {}) {
  if (!dir) throw new Error('userData directory required');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = loadEnv(dir, env);
  const dataDir = path.join(dir, 'data');
  if (config.NEKOCHANNEL_IMPORT_SQLITE) await migrateArchive(config.NEKOCHANNEL_IMPORT_SQLITE, dataDir);
  const keyFile = path.join(dir, 'mcp-key');
  let key = config.NEKOCHANNEL_MCP_KEY;
  if (!key) {
    try { fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    key = fs.readFileSync(keyFile, 'utf8').trim();
    if (!key) throw new Error('Empty MCP key file');
  }
  const running = [];
  const close = async () => { for (const service of running.splice(0).reverse()) await service.close(); };
  try {
    // No inherited HOST/DATA_DIR or webhook settings: app owns local services.
    const writer = await ingest.startServer({ env: { HOST: '127.0.0.1', PORT: port(config, 'NEKOCHANNEL_INGEST_PORT', 4317), DATA_DIR: dataDir }, logger });
    running.push(writer);
    const chatConfig = chat.makeConfig({ ...config, CHAT_HOST: '127.0.0.1', CHAT_DATA_DIR: dataDir });
    chatConfig.port = port(config, 'NEKOCHANNEL_CHAT_PORT', 4318);
    const agent = await chat.startServer({ config: chatConfig, logger });
    running.push(agent);
    const tools = await mcp.startServer({ config: { host: '127.0.0.1', port: port(config, 'NEKOCHANNEL_MCP_PORT', 4319), key, dbPath: path.join(dataDir, 'wa.sqlite') }, logger });
    running.push(tools);
    const url = service => `http://127.0.0.1:${service.server.address().port}`;
    return { ingestUrl: url(writer), chatUrl: url(agent), mcpUrl: url(tools), close };
  } catch (e) { await close(); throw e; }
}
module.exports = { startBackend, migrateArchive, loadEnv };
