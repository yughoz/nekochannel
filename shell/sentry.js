'use strict';
let started = false;
function initSentry(dsn) {
  if (started || !dsn) return false;
  try {
    const Sentry = require('@sentry/electron/main');
    Sentry.init({ dsn, ipcMode: Sentry.IPCMode.Classic, skipOpenTelemetrySetup: true, sendClientReports: false });
    started = true;
  } catch (error) { console.error('[sentry] init failed:', error.message); }
  return started;
}
module.exports = { initSentry, enabled: () => started };
