'use strict';
// #48: unit test makeScheduleTool — disiplin argumen CRUD Jadwal Agent dari agent.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeScheduleTool, toolDefs, makeChatTools } = require('./server.js');

function api(overrides = {}) {
  const calls = { save: [], delete: [] };
  const state = { enabled: false, items: [{ id: 'j-existing', name: 'lama', enabled: true, time: '07:00', account: '', chats: ['Grup A'], prompt: '', sendSelf: false }] };
  return {
    calls, state,
    list: overrides.list || (() => state),
    accounts: overrides.accounts || (() => ['6282219533061@c.us']),
    groups: overrides.groups || (() => [{ name: 'Grup A' }, { name: 'Grup B' }]),
    save: overrides.save || (async item => { calls.save.push(item); state.items = state.items.filter(x => x.id !== item.id).concat(item); }),
    delete: overrides.delete || (async id => { calls.delete.push(id); state.items = state.items.filter(x => x.id !== id); }),
  };
}

test('list: kembalikan definisi + catatan master', async () => {
  const tool = makeScheduleTool(api());
  const out = await tool({ action: 'list' });
  assert.equal(out.ok, true);
  assert.equal(out.items.length, 1);
  assert.match(out.note, /Settings/);
});

test('save: buat baru → enabled dipaksa false, id baru, save terpanggil', async () => {
  const a = api();
  const tool = makeScheduleTool(a);
  const out = await tool({ action: 'save', time: '07:00', account: '6282219533061@c.us', chats: ['Grup A'], prompt: 'rangkum', name: 'pagi' });
  assert.equal(out.ok, true);
  assert.equal(out.saved.enabled, false);
  assert.equal(a.calls.save.length, 1);
  assert.equal(a.state.items.length, 2);
  assert.match(out.id, /^j-agent-/);
});

test('save: update pakai id existing → replace, id tetap', async () => {
  const a = api();
  const tool = makeScheduleTool(a);
  const out = await tool({ action: 'save', id: 'j-existing', time: '08:30', chats: ['Grup B'], prompt: 'x' });
  assert.equal(out.ok, true);
  assert.equal(out.id, 'j-existing');
  assert.equal(a.state.items.length, 1);
  assert.equal(a.state.items[0].time, '08:30');
});

test('save: enabled=true ditolak (aktifkan hanya lewat Settings)', async () => {
  const tool = makeScheduleTool(api());
  const out = await tool({ action: 'save', time: '07:00', chats: ['Grup A'], prompt: 'x', enabled: true });
  assert.equal(out.ok, false);
  assert.match(out.error, /Settings/);
});

test('save: grup tidak dikenal ditolak', async () => {
  const tool = makeScheduleTool(api());
  const out = await tool({ action: 'save', time: '07:00', chats: ['Grup Zombi'], prompt: 'x' });
  assert.equal(out.ok, false);
  assert.match(out.error, /Grup Zombi/);
});

test('save: account tidak terdaftar ditolak', async () => {
  const tool = makeScheduleTool(api());
  const out = await tool({ action: 'save', time: '07:00', account: '629999999@c.us', chats: ['Grup A'], prompt: 'x' });
  assert.equal(out.ok, false);
  assert.match(out.error, /account tidak dikenal/);
});

test('save: time bukan HH:MM ditolak', async () => {
  const tool = makeScheduleTool(api());
  const out = await tool({ action: 'save', time: '7 pagi', chats: ['Grup A'], prompt: 'x' });
  assert.equal(out.ok, false);
  assert.match(out.error, /HH:MM/);
});

test('save: tanpa chats tanpa prompt ditolak', async () => {
  const tool = makeScheduleTool(api());
  const out = await tool({ action: 'save', time: '07:00' });
  assert.equal(out.ok, false);
  assert.match(out.error, /prompt wajib/);
});

test('save: id tidak ada ditolak', async () => {
  const tool = makeScheduleTool(api());
  const out = await tool({ action: 'save', id: 'j-hantu', time: '07:00', chats: ['Grup A'], prompt: 'x' });
  assert.equal(out.ok, false);
  assert.match(out.error, /j-hantu/);
});

test('save: item invalid ditolak scheduler.validate lewat api (error diteruskan)', async () => {
  const tool = makeScheduleTool(api({ save: async () => { throw new TypeError('At most 20 schedules'); } }));
  const out = await tool({ action: 'save', time: '07:00', chats: ['Grup A'], prompt: 'x' });
  assert.equal(out.ok, false);
  assert.match(out.error, /20 schedules/);
});

test('delete: butuh id, id harus ada, sukses → terpanggil', async () => {
  const tool = makeScheduleTool(api());
  assert.equal((await tool({ action: 'delete' })).ok, false);
  assert.equal((await tool({ action: 'delete', id: 'j-hantu' })).ok, false);
  const out = await tool({ action: 'delete', id: 'j-existing' });
  assert.equal(out.ok, true);
  assert.equal(out.deleted, 'j-existing');
});

test('action liar ditolak', async () => {
  const tool = makeScheduleTool(api());
  assert.equal((await tool({ action: 'hack' })).ok, false);
});

test('wiring: defs & tools hanya ada saat schedules disuntik; termasuk WRITE_TOOLS run terjadwal', () => {
  const names = defs => defs.map(def => def.function.name);
  assert.ok(!names(toolDefs()).includes('manage_schedules'));
  assert.ok(names(toolDefs({ schedules: true })).includes('manage_schedules'));
  const emptyDb = { prepare: () => { throw new Error('no db'); } };
  const tools = makeChatTools(emptyDb, null, false, null, false, { list: () => ({}) });
  assert.ok(typeof tools.manage_schedules === 'function');
  const noSched = makeChatTools(emptyDb, null, false, null, false);
  assert.ok(!('manage_schedules' in noSched));
});
