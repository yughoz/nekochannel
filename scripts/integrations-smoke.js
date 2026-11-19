'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
async function main() {
  assert.ok(process.env.TMPDIR, 'TMPDIR required');
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'neko-integrations-electron-'));
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text || '{}');
    requests.push({ url: request.url, authorization: request.headers.authorization, body });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/systemone' ? { answers: { is_promo: { noul: 0.1 }, needs_reply: { noul: 0.9 } } } : { choices: [{ message: { role: 'assistant', content: 'Local fixture response.' }, finish_reason: 'stop' }] }));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify([{ channel: 'whatsapp', n: 1, label: 'Local fixture' }]));
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ lang: 'en', notif: false }));
    for (const phase of ['first', 'restart']) {
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/^(JEV_|SUMMARY_MODEL_|CHAT_MODEL_|WEBHOOK_|WAREADER_|NEKOCHANNEL_)/.test(key)) delete env[key];
      Object.assign(env, { NEKOCHANNEL_USER_DATA: dir, NEKOCHANNEL_INTEGRATIONS_SMOKE: phase, NEKOCHANNEL_FIXTURE_URL: url,
        NEKOCHANNEL_INGEST_PORT: '0', NEKOCHANNEL_CHAT_PORT: '0', NEKOCHANNEL_MCP_PORT: '0', ELECTRON_RUN_AS_NODE: '' });
      let output = '';
      const child = spawn(require('electron'), [root], { cwd: root, env });
      child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
      child.stderr.on('data', chunk => process.stderr.write(chunk));
      const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
      const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      clearTimeout(timer);
      assert.equal(status, 0, `Electron ${phase} failed`);
      assert.ok(output.includes(`[integrations-smoke] PASS ${phase}`));
      if (phase === 'first') assert.equal(requests.length, 1, 'only explicit synthetic test before restart');
    }
    assert.ok(requests.some(request => request.url === '/systemone' && request.authorization === 'Bearer fixture-jev-key'));
    assert.ok(requests.some(request => request.body.model === 'fixture-summary' && request.authorization === 'Bearer fixture-summary-key'));
    assert.ok(requests.some(request => request.body.model === 'fixture-agent' && request.authorization === 'Bearer fixture-agent-key'));
    assert.equal(requests.filter(request => request.url === '/webhook').length, 1);
    assert.equal(requests.find(request => request.url === '/webhook').authorization, 'fixture-webhook-key');
    assert.equal(requests.find(request => request.url === '/webhook').body.test, true);
    console.log('[integrations-smoke] PASS local HTTP auth, synthetic-only webhook, JEV, Summary, Agent');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(() => { console.error('[integrations-smoke] isolated smoke failed'); process.exitCode = 1; });
