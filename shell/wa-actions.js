'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { validateActionEnvelope, rateAction } = require('../adapters/whatsapp/action');

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

// Aksi chat WA (tool wa_action Agent/MCP + IPC shell). gate(target) dari app:
// null = boleh, string = alasan OFF (saklar Settings > LLM Agent, default OFF).
// Kirim teks biasa bukan di sini — itu send_message (cari baris ketat + verifikasi).
const SEND_TYPES = new Set(['sendImage', 'sendFile', 'reply']);
function createActions({ accounts, gate = () => 'disabled', trustedEvent, locked = () => false, perform, confirm = async () => true, confirmMode = () => 'dialog', logFile, now = Date.now }) {
  const counters = new Map();
  const typing = new Map();
  let busy = false;
  const audit = entry => fs.appendFileSync(logFile, JSON.stringify({ ts: new Date(now()).toISOString(), ...entry }) + '\n', { mode: 0o600 });
  const run = async (input, event) => {
    let target, account, record;
    try {
      if (event && !trustedEvent(event)) return { status: 'failed', detail: 'untrusted sender' };
      target = validateActionEnvelope(input);
      if (target.action === 'send') throw new Error('use send_message for plain text messages');
      if (event && !target.accountId) throw new Error('accountId is required for IPC');
      const matches = accounts().filter(entry => target.accountId ? entry.id === target.accountId : entry.account === target.account);
      if (matches.length !== 1) throw new Error('unknown or ambiguous accountId');
      [account] = matches;
      if (target.account && target.account !== account.account) throw new Error('account mismatch');
      if (!/^\S+@(?:c\.us|s\.whatsapp\.net|g\.us|lid)$/.test(target.chatJid || '')) throw new Error('chatJid is required');
      record = { accountId: account.id, account: account.account, action: target.action, chat: target.chatJid, msgId: target.msgId, source: event ? 'shell' : target.source, confirm: confirmMode() };
      const blocked = gate(target);
      if (blocked) return { status: 'disabled', detail: blocked };
      if (locked() || account.status?.state !== 'connected' || busy) throw new Error('locked, disconnected, or another action is in progress');
      busy = true;
      try {
        if (!await confirm(account, target)) return { status: 'cancelled' };
        if (gate(target) || locked() || !accounts().includes(account) || account.status?.state !== 'connected') throw new Error('permission or account changed');
        let attachment;
        if (target.file) {
          const descriptor = fs.openSync(target.file, 'r');
          try {
            const stat = fs.fstatSync(descriptor);
            if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_BYTES) throw new Error('file must be a nonempty regular file, at most 16 MiB');
            const mime = IMAGE_TYPES[path.extname(target.file).toLowerCase()] || 'application/octet-stream';
            if (target.action === 'sendImage' && !mime.startsWith('image/')) throw new Error('unsupported image extension');
            const buffer = Buffer.alloc(stat.size);
            if (fs.readSync(descriptor, buffer, 0, buffer.length, 0) !== buffer.length) throw new Error('file changed during read');
            attachment = { name: path.basename(target.file), mime, data: buffer.toString('base64') };
          } finally { fs.closeSync(descriptor); }
        }
        const stopped = target.action === 'typingStop' && typing.get(account.id) === target.chatJid;
        const rate = stopped ? { ok: true } : rateAction(counters, account.id, now());
        if (!rate.ok) throw new Error(`rate limited; retry in ${rate.retryAfter}s`);
        audit({ ...record, result: 'attempt' });
        let result;
        try { result = await perform(account, { ...target, ...(attachment ? { file: attachment } : {}) }); }
        catch { result = { ok: false, stage: 'executor', detail: 'page executor failed' }; }
        audit({ ...record, result: result?.ok ? 'dispatched' : 'failed', verified: result?.verified === true, stage: result?.stage });
        if (result?.ok && target.action === 'typing') typing.set(account.id, target.chatJid);
        if (target.action === 'typingStop') typing.delete(account.id);
        return { status: result?.ok ? 'ok' : 'failed', detail: result?.detail || result?.stage || 'page executor failed', verified: result?.verified === true };
      } finally { busy = false; }
    } catch (error) {
      return { status: 'failed', detail: error.message };
    }
  };
  return run;
}

module.exports = { createActions, MAX_FILE_BYTES, SEND_TYPES };
