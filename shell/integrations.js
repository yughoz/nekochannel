'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseEnv } = require('node:util');

const defaults = () => ({
  llm: { url: '', name: '', key: '' }, summary: { url: '', name: '', key: '' },
  fallback: { url: '', name: '', key: '' }, // #30 model cadangan runtime Agent (utama gagal → ini)
  jev: { enabled: false, url: '', key: '', name: '', threshold: 0.6 },
  webhook: { enabled: false, url: '', key: '' },
  sentry: { dsn: '' },
  mcp: { enabled: true, port: 4319, key: '', remote: false }, // #32 remote: listener tambahan di IP Tailscale
});
const fields = { llm: ['url', 'name', 'key'], summary: ['url', 'name', 'key'], fallback: ['url', 'name', 'key'], jev: ['enabled', 'url', 'key', 'name', 'threshold'], webhook: ['enabled', 'url', 'key'], sentry: ['dsn'], mcp: ['enabled', 'port', 'key', 'remote'] };
const names = {
  llm: ['CHAT_MODEL_URL', 'CHAT_MODEL_NAME', 'CHAT_MODEL_KEY'],
  summary: ['SUMMARY_MODEL_URL', 'SUMMARY_MODEL_NAME', 'SUMMARY_MODEL_KEY'],
  jev: ['JEV_BASE_URL', 'JEV_MODEL', 'JEV_API_KEY'], webhook: ['WEBHOOK_URL', null, 'WEBHOOK_KEY'],
};
const owned = new Set([...Object.values(names).flat().filter(Boolean), 'JEV_THRESHOLD', 'WAREADER_MCP_PORT', 'WAREADER_MCP_KEY', 'NEKOCHANNEL_MCP_KEY']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function validate(patch) {
  if (!object(patch) || Object.keys(patch).some(section => !Object.hasOwn(fields, section))) throw new Error('Invalid integration settings');
  for (const [section, values] of Object.entries(patch)) {
    if (!object(values) || Object.keys(values).some(field => !fields[section].includes(field) && field !== 'reset')) throw new Error('Invalid integration fields');
    for (const [field, value] of Object.entries(values)) {
      if (field === 'enabled' || field === 'reset' || field === 'remote') { if (typeof value !== 'boolean') throw new Error('Invalid toggle'); }
      else if (field === 'port') { if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Invalid listen port'); }
      else if (field === 'threshold') { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('Invalid threshold'); }
      else {
        if (typeof value !== 'string' || value.length > (field === 'key' ? 4096 : field === 'url' ? 2048 : 200) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid text');
        if (field === 'key' && value && !value.trim()) throw new Error('Invalid key');
        if (field === 'url' && value) {
          let url; try { url = new URL(value); } catch { throw new Error('Invalid URL'); }
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) URL without credentials, query or fragment');
        }
      }
    }
  }
}
function patchConfig(current, patch) {
  validate(patch);
  const next = structuredClone(current);
  for (const [section, values] of Object.entries(patch)) {
    if (values.reset) next[section] = defaults()[section];
    for (const [field, value] of Object.entries(values)) {
      if (field === 'reset' || (['dsn', 'key'].includes(field) && value === '')) continue;
      next[section][field] = field === 'key' ? value : typeof value === 'string' ? value.trim() : value;
    }
    if (section === 'mcp' && !next.mcp.key) next.mcp.key = crypto.randomBytes(32).toString('hex');
    if (next[section].enabled && section !== 'mcp' && (!next[section].url || !next[section].key || (section === 'jev' && !next.jev.name))) throw new Error('Incomplete integration');
  }
  return next;
}
function publicConfig(config) {
  return Object.fromEntries(Object.entries(config).map(([section, { key, dsn, ...values }]) => [section, { ...values, keySet: Boolean(key), ...(dsn === undefined ? {} : { dsnSet: Boolean(dsn) }) }]));
}
function atomic(file, data) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' });
    const descriptor = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function openStore(dir, safeStorage, env = process.env) {
  const file = path.join(dir, 'integrations.enc');
  const secure = () => {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Secure storage unavailable; integrations are disabled');
  };
  const read = target => { secure(); const value = JSON.parse(safeStorage.decryptString(fs.readFileSync(target))); fs.chmodSync(target, 0o600); return value; };
  const write = (target, value) => { secure(); atomic(target, safeStorage.encryptString(JSON.stringify(value))); };
  secure();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const envFile = path.join(dir, '.env');
  const keyFile = path.join(dir, 'mcp-key');
  const source = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const parsed = parseEnv(source);
  if (Object.entries(parsed).some(([key, value]) => owned.has(key) && /[\r\n]/.test(value))) throw new Error('Multiline integration migration requires manual recovery');
  const legacy = { ...env, ...parsed };
  let config;
  if (fs.existsSync(file)) {
    const stored = read(file);
    if (stored.version !== 1 || !object(stored.config)) throw new Error('Unsupported integration settings');
    for (const [section, keys] of Object.entries(fields)) {
      stored.config[section] ??= defaults()[section];
      for (const field of keys) stored.config[section][field] ??= defaults()[section][field];
    }
    validate(stored.config);
    if (Object.keys(fields).some(section => !object(stored.config[section]) || fields[section].some(field => !Object.hasOwn(stored.config[section], field))) || !stored.config.mcp.key) throw new Error('Incomplete stored settings');
    config = stored.config;
  } else {
    config = defaults();
    for (const [section, keys] of Object.entries(names)) for (const [index, field] of ['url', 'name', 'key'].entries()) if (keys[index] && legacy[keys[index]]) config[section][field] = legacy[keys[index]];
    if (legacy.JEV_THRESHOLD !== undefined) config.jev.threshold = Number(legacy.JEV_THRESHOLD);
    config.mcp.port = Number(legacy.WAREADER_MCP_PORT || legacy.NEKOCHANNEL_MCP_PORT || 4319);
    if (config.mcp.port === 0) config.mcp.port = 4319;
    config.mcp.key = legacy.NEKOCHANNEL_MCP_KEY || legacy.WAREADER_MCP_KEY || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '') || crypto.randomBytes(32).toString('hex');
    validate(config);
    write(file, { version: 1, config });
  }
  const stripped = source.split(/(?<=\n)/).filter(line => !owned.has(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])).join('');
  if (stripped !== source || fs.existsSync(keyFile)) {
    const recovery = path.join(dir, 'integrations-migration.enc');
    const snapshot = { env: source, mcpKey: fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : null };
    const previous = fs.existsSync(recovery) ? read(recovery) : { version: 2, snapshots: [] };
    const snapshots = previous.version === 1 ? [{ env: previous.env, mcpKey: previous.mcpKey }] : previous.snapshots;
    if (!Array.isArray(snapshots)) throw new Error('Invalid encrypted recovery');
    if (previous.version !== 2 || !snapshots.some(value => value.env === snapshot.env && value.mcpKey === snapshot.mcpKey)) write(recovery, { version: 2, snapshots: snapshots.some(value => value.env === snapshot.env && value.mcpKey === snapshot.mcpKey) ? snapshots : [...snapshots, snapshot] });
    if (!read(recovery).snapshots.some(value => value.env === snapshot.env && value.mcpKey === snapshot.mcpKey)) throw new Error('Recovery verification failed');
    if (stripped !== source) atomic(envFile, stripped);
    if (fs.existsSync(keyFile)) fs.unlinkSync(keyFile);
  }
  return {
    get: () => structuredClone(config),
    public: () => publicConfig(config),
    save(patch) {
      const next = patchConfig(config, patch);
      write(file, { version: 1, config: next });
      config = next;
    },
  };
}
async function testWebhook(config, fetchImpl = fetch) {
  if (!config.webhook.url || !config.webhook.key) return { ok: false };
  try {
    const response = await fetchImpl(config.webhook.url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', Authorization: config.webhook.key },
      body: JSON.stringify({ type: 'ringkasan', test: true, periode: { dari: '2000-01-01T00:00:00.000Z', sampai: '2000-01-01T00:00:00.000Z' }, teks: 'Nekochannel synthetic connection test (no archive data)', text: 'Nekochannel synthetic connection test (no archive data)', grup: [] }),
    });
    void response.body?.cancel()?.catch(() => {});
    return { ok: response.status >= 200 && response.status < 300, status: response.status };
  } catch { return { ok: false }; }
}
function modelConfig(config) {
  const values = config.llm;
  const fallback = config.summary;
  const url = (values.url || fallback.url).replace(/\/+$/, '');
  const name = values.name || fallback.name;
  const key = values.key || fallback.key;
  return { url, name, key, ok: Boolean(url && name) };
}
// #30 model cadangan runtime: utuh (url+name) atau tidak dipakai; key boleh kosong (endpoint lokal).
function fallbackConfig(config) {
  const values = config.fallback || defaults().fallback;
  const url = String(values.url || '').replace(/\/+$/, '');
  return { url, name: values.name || '', key: values.key || '', ok: Boolean(url && values.name) };
}
module.exports = { defaults, validate, patchConfig, publicConfig, openStore, testWebhook, modelConfig, fallbackConfig };
