'use strict';
// Registry akun persist (userData/accounts.json). Index partition per channel
// harus stabil antar-restart — QR cuma sekali per partition (PRD M1).
const fs = require('node:fs');
const path = require('node:path');
const { backup } = require('./backup');

const load = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } };
const save = (file, list) => {
  fs.writeFileSync(file, JSON.stringify(list, null, 2) + '\n');
  backup(file, path.join(path.dirname(file), 'backup')); // #13: snapshot tiap perubahan
};

const nextIndex = (list, channel) => {
  const used = new Set(list.filter(a => a.channel === channel).map(a => a.n));
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
};

function add(file, list, channel, short) {
  const n = nextIndex(list, channel);
  const account = { channel, n, label: `${short || channel}-${n}` };
  list.push(account);
  save(file, list);
  return account;
}

module.exports = { load, save, add, nextIndex };
