'use strict';
// #14 quick switcher: logika murni (item + filter) — DOM overlay-nya di index.html.
// Dicoba dua sisi: require() untuk node --test, globalThis untuk <script src> renderer.
const items = accounts => [
  ...accounts.map(a => ({ type: 'account', id: a.id, label: a.label, channel: a.channel, icon: a.icon || null })),
  { type: 'agent', id: 'agent', label: 'Agent' },
];

// Substring case-insensitive di label + channel; tanpa query = urutan sidebar (#8).
const filter = (items, query) => {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return items;
  return items.filter(it => `${it.label} ${it.channel || ''}`.toLowerCase().includes(q));
};

const api = { items, filter };
if (typeof module !== 'undefined') module.exports = api; else globalThis.nekoSwitcher = api;
