'use strict';
// M0 end-to-end smoke: dispatch one synthetic message through the REAL bridge
// path (MAIN-world CustomEvent → preload validation → driver queue → real
// /ingest), then flush and report. Run: NEKOCHANNEL_SMOKE=1 npm start
const wait = ms => new Promise(r => setTimeout(r, ms));

module.exports = function smoke(account, endpoint) {
  const { wc, driver, injected } = account;
  const id = `smoke-m0-${Date.now()}`;
  (async () => {
    try {
      const ok = await Promise.race([injected, wait(20000).then(() => false)]);
      if (!ok) throw new Error('reader injection never completed');
      await wait(3000); // preload listeners are live from load; give the SPA a beat
      await wc.executeJavaScript(`(() => {
        globalThis.dispatchEvent(new CustomEvent('wa-reader-message', { detail: {
          id: ${JSON.stringify(id)}, account: '6285693784939@c.us',
          chat: '[smoke] M0 pipeline', sender: 'smoke',
          text: 'nekochannel M0 end-to-end test', timestamp: new Date().toISOString(),
          isGroup: false, fromMe: true } }));
        return 'dispatched';
      })()`, true);
      await wait(1000); // let the preload batcher drain into the driver
      const flushed = await driver.flushNow();
      const res = await fetch(`${endpoint}/health`);
      const health = await res.json();
      console.log(`SMOKE ${flushed ? 'OK' : 'FLUSH-FAILED'} id=${id} server_messages=${health.messages} accounts=${JSON.stringify(health.accounts?.map(a => a.account))}`);
      process.exit(flushed ? 0 : 1);
    } catch (error) {
      console.error('SMOKE FAILED:', error.message);
      process.exit(1);
    }
  })();
};
