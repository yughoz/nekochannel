'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

const DEFAULTS = Object.freeze({
  enabled: true, names: true, photos: true, previews: true, messages: true,
  media: true, compose: true, accountLabels: true, hoverReveal: false, autoLockMinutes: 0, passwordHash: null,
});
const SELECTORS = Object.freeze({
  names: ['#pane-side [title]', '#main header [title]', '#main header [dir="auto"]',
    '[data-testid="conversation-info-header-chat-title"]', '[data-testid="author"]',
    '.message-in [data-pre-plain-text] > div:first-child [dir="auto"]', '[data-testid="contact-info-drawer"] [dir="auto"]'],
  photos: ['#pane-side img', '#main header img', '[data-testid="chat-avatar"]',
    '[data-testid="user-avatar"]', '[data-icon="default-user"]', '[data-icon="default-group"]',
    '[data-testid="contact-info-drawer"] img'],
  previews: ['#pane-side [data-testid="cell-frame-secondary"]', '#pane-side [data-testid="last-msg-status"]',
    '#pane-side [role="row"] [dir="ltr"]', '#pane-side [role="row"] [data-testid="selectable-text"]'],
  messages: ['#main .message-in', '#main .message-out', '#main [data-testid="msg-container"]',
    '#main [data-testid="conversation-panel-messages"] [data-id]'],
  media: ['#main .message-in img', '#main .message-out img', '#main video', '#main canvas',
    '[data-testid="media-viewer"]', '[data-testid="media-preview"]', '[data-testid="sticker"]'],
  compose: ['#main footer [contenteditable="true"]', '#main footer textarea',
    '[data-testid="conversation-compose-box-input"]', '[data-testid="media-caption-input-container"] [contenteditable="true"]'],
});
const validHash = value => typeof value === 'string' && /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(value);
function normalize(value) {
  const result = { ...DEFAULTS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const key of Object.keys(DEFAULTS)) {
    if (typeof DEFAULTS[key] === 'boolean' && typeof value[key] === 'boolean') result[key] = value[key];
  }
  if (Number.isInteger(value.autoLockMinutes) && value.autoLockMinutes >= 0 && value.autoLockMinutes <= 1440) result.autoLockMinutes = value.autoLockMinutes;
  if (validHash(value.passwordHash)) result.passwordHash = value.passwordHash;
  return result;
}
function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Invalid privacy settings');
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'password') {
      if (typeof value !== 'string' || value.length < 8 || value.length > 256) throw new TypeError('Invalid password length');
    } else if (key === 'autoLockMinutes') {
      if (!Number.isInteger(value) || value < 0 || value > 1440) throw new TypeError('Invalid idle minutes');
    } else if (!Object.hasOwn(DEFAULTS, key) || typeof DEFAULTS[key] !== 'boolean' || typeof value !== 'boolean') {
      throw new TypeError('Invalid privacy target');
    }
  }
  return patch;
}
async function hashPassword(password) {
  validatePatch({ password });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}
async function verifyPassword(password, record) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 256 || !validHash(record)) return false;
  const [, salt, hash] = record.split('$');
  return crypto.timingSafeEqual(await scrypt(password, salt, 64), Buffer.from(hash, 'hex'));
}
const publicSettings = value => {
  const { passwordHash, ...rest } = normalize(value);
  return { ...rest, passwordSet: !!passwordHash };
};
const cssFor = value => {
  const settings = normalize(value);
  if (!settings.enabled) return '';
  // #49 hoverReveal: blur saat idle, jelas saat kursor di atas elemennya. CATATAN SEMANTIK CSS:
  // `A, B:hover { x }` berarti x berlaku untuk A SELALU — :hover wajib ditempel di SETIAP selector,
  // bukan hanya di akhir list.
  const hover = settings.hoverReveal;
  return Object.entries(SELECTORS).filter(([key]) => settings[key]).map(([, selectors]) => {
    const rule = `${selectors.join(',\n')} { filter: blur(7px) !important; -webkit-user-select: none !important; user-select: none !important;${hover ? ' transition: filter 0.12s ease !important;' : ''} }`;
    return hover ? `${rule}\n${selectors.map(selector => `${selector}:hover`).join(',\n')} { filter: none !important; }` : rule;
  }).join('\n');
};
function createInjector(getSettings, onError = () => {}) {
  const views = new Map();
  function attach(wc) {
    if (views.has(wc)) return;
    const state = { css: null, epoch: 0, pending: Promise.resolve() };
    const apply = () => {
      state.pending = state.pending.then(async () => {
        if (wc.isDestroyed()) return;
        const css = cssFor(getSettings());
        if (state.css === css) return;
        const epoch = state.epoch;
        // ponytail: style-node via executeJavaScript, bukan insertCSS — cssOrigin user/author
        // insertCSS terbukti tak berlaku di web.whatsapp.com login (computed tetap none) sedangkan
        // <style> page-side bekerja; node id 'nekochannel-privacy' idempoten dan ganti textContent.
        const result = await wc.executeJavaScript(`(() => {
          let el = document.getElementById('nekochannel-privacy');
          if (${css ? 'true' : 'false'}) {
            if (!el) { el = document.createElement('style'); el.id = 'nekochannel-privacy'; (document.head || document.documentElement).appendChild(el); }
            el.textContent = ${JSON.stringify(css)};
            return 'on';
          }
          if (el) el.remove();
          return 'off';
        })()`);
        if (wc.isDestroyed()) return;
        if (epoch !== state.epoch) return; // navigasi penuh terjadi saat exec; event berikutnya apply ulang
        state.css = css;
        return result;
      }).catch(error => { state.css = null; onError(error); });
      return state.pending;
    };
    views.set(wc, apply);
    wc.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) { state.epoch++; state.css = null; }
    });
    for (const event of ['dom-ready', 'did-finish-load', 'did-navigate-in-page']) wc.on(event, apply);
    wc.once('destroyed', () => views.delete(wc));
    return apply();
  }
  return { attach, apply: () => Promise.all([...views.values()].map(apply => apply())) };
}

module.exports = { DEFAULTS, SELECTORS, normalize, validatePatch, validHash, hashPassword, verifyPassword, publicSettings, cssFor, createInjector };
