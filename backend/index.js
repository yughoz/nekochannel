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

// sendMessage (opsional, dari app): kirim pesan WA atas nama user setelah konfirmasi.
// sendEnabled: saklar Settings (dibaca live). Tanpa sendMessage, Agent dan MCP read-only.
async function startBackend({ dir, env = process.env, logger = console, integrations, readerEnabled = true, fetchImpl = globalThis.fetch, mcpPort, sendMessage, sendEnabled, actions, actionsEnabled, schedules } = {}) {
  if (!dir) throw new Error('userData directory required');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = loadEnv(dir, env);
  const dataDir = path.join(dir, 'data');
  if (config.NEKOCHANNEL_IMPORT_SQLITE) await migrateArchive(config.NEKOCHANNEL_IMPORT_SQLITE, dataDir);
  const keyFile = path.join(dir, 'mcp-key');
  let key = integrations ? integrations.mcp.key : config.NEKOCHANNEL_MCP_KEY || config.WAREADER_MCP_KEY;
  if (!key && !integrations) {
    try { fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    key = fs.readFileSync(keyFile, 'utf8').trim();
    if (!key) throw new Error('Empty MCP key file');
  }
  const running = [];
  let externalController = new AbortController();
  const readerFetch = (url, options = {}) => {
    if (!readerEnabled) return Promise.reject(new Error('Reader disabled'));
    return fetchImpl(url, { ...options, signal: AbortSignal.any([externalController.signal, ...(options.signal ? [options.signal] : [])]) });
  };
  const close = async () => { externalController.abort(); for (const service of running.splice(0).reverse()) await service.close(); };
  try {
    // No inherited HOST/DATA_DIR or webhook settings: app owns local services.
    const external = {};
    if (integrations) {
      const { jev, webhook, summary } = integrations;
      if (jev.enabled) Object.assign(external, { JEV_BASE_URL: jev.url, JEV_API_KEY: jev.key, JEV_MODEL: jev.name, JEV_THRESHOLD: String(jev.threshold) });
      if (webhook.enabled) Object.assign(external, { WEBHOOK_URL: webhook.url, WEBHOOK_KEY: webhook.key });
      Object.assign(external, { SUMMARY_MODEL_URL: summary.url, SUMMARY_MODEL_KEY: summary.key, SUMMARY_MODEL_NAME: summary.name });
    }
    const writer = await ingest.startServer({ env: { ...external, HOST: '127.0.0.1', PORT: port(config, 'NEKOCHANNEL_INGEST_PORT', 4317), DATA_DIR: dataDir }, logger, fetchImpl: readerFetch, externalAllowed: () => readerEnabled });
    running.push(writer);
    const chatConfig = chat.makeConfig({ ...config, CHAT_HOST: '127.0.0.1', CHAT_DATA_DIR: dataDir });
    if (integrations) {
      const { modelConfig, fallbackConfig } = require('../shell/integrations');
      const model = modelConfig(integrations);
      Object.assign(chatConfig, { modelUrl: model.url, modelName: model.name, modelKey: model.key });
      const fallback = fallbackConfig(integrations); // #30
      if (fallback.ok) Object.assign(chatConfig, { fallbackUrl: fallback.url, fallbackName: fallback.name, fallbackKey: fallback.key });
    }
    // AI Pack (opsional): modul auth+gateway injected di ../aipack saat build privat.
    // #61: dibaca per request (bukan sekali saat boot) → login/logout dari Settings langsung berlaku.
    // Tidak ada / belum login → null → jalur BYO dari Settings dipakai apa adanya.
    let aipack = null;
    try { aipack = require('../aipack'); } catch (error) { if (error?.code !== 'MODULE_NOT_FOUND') logger?.warn?.(`aipack off: ${error?.message || error}`); }
    if (aipack?.getLlmAuth) chatConfig.llmAuth = () => aipack.getLlmAuth() || null;
    chatConfig.port = port(config, 'NEKOCHANNEL_CHAT_PORT', 4318);
    const agent = await chat.startServer({ config: chatConfig, logger, fetchImpl, lazyProbe: true, send: sendMessage, sendEnabled, actions, actionsEnabled, schedules });
    running.push(agent);
    let tools;
    if (!integrations || integrations.mcp.enabled) {
      const listenPort = integrations ? integrations.mcp.port : port(config, 'WAREADER_MCP_PORT', 4319);
      try {
        tools = await mcp.startServer({ config: { host: '127.0.0.1', port: mcpPort ?? (integrations ? listenPort : port(config, 'NEKOCHANNEL_MCP_PORT', listenPort)), key, dbPath: path.join(dataDir, 'wa.sqlite'), remote: integrations?.mcp.remote === true }, logger, send: sendMessage, sendEnabled, actions, actionsEnabled });
        running.push(tools);
      } catch (error) {
        if (!integrations) throw error;
        logger.error('MCP unavailable; archive remains operational. Check the listen port in Settings.');
      }
    }
    const url = service => `http://127.0.0.1:${service.server.address().port}`;
    return { ingestUrl: url(writer), chatUrl: url(agent), mcpUrl: tools ? url(tools) : null, mcpRemote: tools?.remote || null, close,
      setReaderEnabled(enabled) {
        readerEnabled = enabled;
        if (!enabled) { externalController.abort(); externalController = new AbortController(); }
      },
    };
  } catch (e) { await close(); throw e; }
}
module.exports = { startBackend, migrateArchive, loadEnv };
