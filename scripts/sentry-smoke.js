'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
async function main() {
  assert.ok(process.env.TMPDIR, 'TMPDIR required');
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'neko-sentry-electron-'));
  let envelope = null;
  const server = http.createServer((request, response) => {
    let text = ''; request.on('data', chunk => { text += chunk; });
    request.on('end', () => { envelope = text; response.setHeader('content-type', 'application/json'); response.end('{}'); });
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const dsn = `http://fixturepublic@127.0.0.1:${server.address().port}/1`;
    fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify([{ channel: 'whatsapp', n: 1, label: 'Local fixture' }]));
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ lang: 'en', notif: false }));
    for (const phase of ['first', 'restart']) {
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/^(JEV_|SUMMARY_MODEL_|CHAT_MODEL_|WEBHOOK_|WAREADER_|NEKOCHANNEL_)/.test(key)) delete env[key];
      Object.assign(env, { NEKOCHANNEL_USER_DATA: dir, NEKOCHANNEL_SENTRY_SMOKE: phase, NEKOCHANNEL_SENTRY_DSN: dsn,
        NEKOCHANNEL_INGEST_PORT: '0', NEKOCHANNEL_CHAT_PORT: '0', NEKOCHANNEL_MCP_PORT: '0', ELECTRON_RUN_AS_NODE: '' });
      let output = '';
      const child = spawn(require('electron'), [root], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.on('data', chunk => {
        output += chunk;
        const lines = String(chunk).split(/\r?\n/).filter(Boolean);
        console.log(lines.join('\n'));
        for (const line of lines) if (line.includes('[sentry-smoke] envelope:')) envelope = line.slice('[sentry-smoke] envelope:'.length);
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
      const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      clearTimeout(timer);
      assert.equal(status, 0, `Electron ${phase} failed`);
      assert.ok(output.includes(`[sentry-smoke] PASS ${phase}`), `missing PASS ${phase}`);
    }
    assert.ok(envelope);
    assert.equal(envelope.includes('fixturepublic'), false);
    console.log('[sentry-smoke] PASS isolated two-phase smoke: local fixture only');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error('[sentry-smoke] isolated smoke failed', error); process.exitCode = 1; });
