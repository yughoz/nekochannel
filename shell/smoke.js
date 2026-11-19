'use strict';
// M1 end-to-end smoke: dispatch one synthetic message per account view through
// each REAL bridge path (MAIN-world CustomEvent → preload validation → shared
// driver queue → real /ingest) while only the FIRST view is active — hidden
// views must capture too (backgroundThrottling:false). Real 2-account capture
// needs two logged-in partitions; this smoke proves the multi-view mechanics.
// Run: NEKOCHANNEL_SMOKE=1 npm start
const wait = ms => new Promise(r => setTimeout(r, ms));
const PHONE = '123456@c.us'; // synthetic identity; never use a personal number

module.exports = function smoke(accounts, driver, endpoint) {
  (async () => {
    try {
      if (accounts.length < 2) throw new Error(`need ≥2 accounts for the M1 smoke, got ${accounts.length}`);
      const ready = await Promise.all(accounts.map(a => Promise.race([a.injected, wait(20000).then(() => false)])));
      const failed = ready.map((ok, i) => ok ? '' : accounts[i].id).filter(Boolean);
      if (failed.length) throw new Error(`reader injection never completed on: ${failed.join(', ')}`);
      await wait(3000); // preload listeners are live from load; give the SPA a beat
      const ids = [];
      for (const [i, a] of accounts.entries()) {
        const id = `smoke-m1-${Date.now()}-${i}`;
        ids.push(id);
        await a.wc.executeJavaScript(`(() => {
          globalThis.dispatchEvent(new CustomEvent('wa-reader-message', { detail: {
            id: ${JSON.stringify(id)}, account: ${JSON.stringify(PHONE)},
            chat: '[smoke] M1 multi-account', sender: 'smoke',
            text: 'nekochannel M1 e2e from ${a.id} (hidden=${i > 0})',
            timestamp: new Date().toISOString(), isGroup: false, fromMe: true } }));
          return 'dispatched';
        })()`, true);
        await wait(1000); // let the preload batcher drain into the driver
      }
      const flushed = await driver.flushNow();
      const health = await (await fetch(`${endpoint}/health`)).json();
      const hit = (health.accounts || []).some(x => x.account === PHONE);
      console.log(`SMOKE ${flushed && hit ? 'OK' : 'FAILED'} views=${accounts.length} ids=${ids.join(',')} server_messages=${health.messages} accounts=${JSON.stringify((health.accounts || []).map(a => a.account))}`);
      process.exit(flushed && hit ? 0 : 1);
    } catch (error) {
      console.error('SMOKE FAILED:', error.message);
      process.exit(1);
    }
  })();
};
