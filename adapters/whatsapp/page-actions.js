'use strict';

function install() {
  const visible = element => !!element && element.getClientRects().length > 0;
  const unique = elements => {
    const matches = [...new Set(elements)].filter(visible);
    if (matches.length !== 1) throw new Error(`expected one visible target, found ${matches.length}`);
    return matches[0];
  };
  const point = element => {
    element.scrollIntoView({ block: 'nearest' });
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  };
  // Tombol emoji reaksi WA 2026 cuma berisi <img alt="👍"> (tanpa aria-label/teks) → ikutkan alt.
  const labels = element => [element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent, element.querySelector('img')?.getAttribute('alt')].filter(Boolean).map(value => value.trim().toLowerCase());
  const named = (scope, selector, names) => unique([...scope.querySelectorAll(selector)].filter(element => labels(element).some(label => names.map(name => name.toLowerCase()).includes(label))));
  const composer = () => unique(document.querySelectorAll('footer [contenteditable="true"][role="textbox"], footer div[contenteditable="true"]'));
  const dialog = () => unique(document.querySelectorAll('[role="dialog"]'));
  // msgId dari arsip = id serial penuh "true_<chat>_<KEY>[_<participant>]"; DOM WA 2026 hanya
  // memuat KEY di data-id (tervalidasi live 2026-11-21). Cocokkan keduanya; unique() menolak ganda.
  const message = id => {
    const key = String(id).split('_')[2] || String(id);
    return unique([...document.querySelectorAll('[data-id]')].filter(element => [id, key].includes(element.getAttribute('data-id'))));
  };
  const noVs = value => String(value || '').replace(/\uFE0F/g, '');
  const cleanComposer = () => {
    const element = composer();
    if (element.textContent.trim()) throw new Error('composer contains a draft; refusing to overwrite it');
    // quoted-message juga ada di bubble balasan di percakapan → batasi ke footer (area compose);
    // tombol batal-balas hanya ada saat draf balasan aktif, jadi aman dicek global.
    if (document.querySelector('footer [data-testid="quoted-message"], footer [data-testid="quoted-message-preview"], [aria-label="Cancel reply"], [aria-label="Batalkan balasan"]')) throw new Error('existing quote; cancel it first');
    return element;
  };
  globalThis.__nekoWAAction = (operation, args = {}) => {
    try {
      switch (operation) {
        case 'ready': return { ok: true };
        case 'message': {
          const element = message(args.msgId);
          const outgoing = /^true_/.test(String(args.msgId)) || element.matches('.message-out') || !!element.querySelector('.message-out') || !!element.closest('.message-out');
          if (args.own && !outgoing) throw new Error('edit requires an outgoing message');
          return point(element);
        }
        case 'menu': return point(named(document, '[role="menuitem"]', args.names));
        case 'button': return point(named(document, 'button, [role="button"]', args.names));
        case 'compose': return point(args.empty ? cleanComposer() : composer());
        case 'composeText': return { text: composer().textContent };
        case 'quote': {
          unique(document.querySelectorAll('[data-testid="quoted-message"], [data-testid="quoted-message-preview"], [aria-label="Cancel reply"], [aria-label="Batalkan balasan"]'));
          return point(composer());
        }
        case 'emoji': {
          const want = noVs(args.emoji).toLowerCase();
          return point(unique([...dialog().querySelectorAll('button, [role="button"], [role="gridcell"]')].filter(element => labels(element).some(label => noVs(label) === want))));
        }
        case 'attach': {
          // Input file "Photos & videos"/"Document" baru dibuat WA saat item menunya diklik, lalu
          // WA memanggil input.click() → file picker native. Pasang hook sekali-pakai: isi file di
          // situ (tanpa dialog OS). JANGAN isi input yang sudah ada di DOM: input image/* yang
          // selalu ada milik "New sticker" (tervalidasi live 2026-11-21) → gambar terkirim sbg stiker.
          const bytes = Uint8Array.from(atob(args.file.data), character => character.charCodeAt(0));
          const transfer = new DataTransfer();
          transfer.items.add(new File([bytes], args.file.name, { type: args.file.mime }));
          const proto = HTMLInputElement.prototype, originalClick = proto.click, originalPicker = proto.showPicker;
          const restore = () => { proto.click = originalClick; proto.showPicker = originalPicker; };
          globalThis.__nekoAttachHit = null;
          const fill = element => {
            restore();
            const accept = element.accept || '';
            if (args.image ? !/image\//.test(accept) : /image\//.test(accept)) { globalThis.__nekoAttachHit = { ok: false, accept }; return; } // salah item menu → jangan isi
            element.files = transfer.files;
            element.dispatchEvent(new Event('change', { bubbles: true }));
            globalThis.__nekoAttachHit = { ok: true, accept };
          };
          proto.click = function () { return this.type === 'file' ? fill(this) : originalClick.call(this); };
          proto.showPicker = function () { return this.type === 'file' ? fill(this) : originalPicker.call(this); };
          setTimeout(restore, 5000);
          return { ok: true };
        }
        case 'attached': {
          const hit = globalThis.__nekoAttachHit;
          if (!hit) throw new Error('file picker was not opened by the menu item');
          if (!hit.ok) throw new Error(`unexpected file input (${hit.accept})`);
          if (!document.querySelector('[data-testid="media-editor-canvas"], [data-testid="media-caption-input-container"]')) throw new Error('media preview did not open');
          return { ok: true };
        }
        // Preview media WA 2026 = drawer (bukan [role=dialog]); tombol kirim berlabel "Send N selected".
        case 'caption': return point(unique(document.querySelectorAll('[data-testid="media-caption-input-container"][contenteditable="true"], [data-testid="media-caption-input-container"] [contenteditable="true"]')));
        case 'captionText': return { text: unique(document.querySelectorAll('[data-testid="media-caption-input-container"][contenteditable="true"], [data-testid="media-caption-input-container"] [contenteditable="true"]')).textContent };
        case 'previewSend': return point(unique([...document.querySelectorAll('[data-testid="drawer-middle"] [role="button"], [data-testid="drawer-middle"] button')].filter(element => /^(send|kirim)\b/i.test((element.getAttribute('aria-label') || '').trim()))));
        case 'discard': return point(named(document, '[role="dialog"] button, [data-animate-modal-popup] button', ['Discard', 'Buang']));
        case 'selectEdit': {
          const element = unique(dialog().querySelectorAll('[contenteditable="true"]'));
          element.focus();
          const selection = document.getSelection();
          const range = document.createRange();
          range.selectNodeContents(element);
          selection.removeAllRanges();
          selection.addRange(range);
          return { ok: true };
        }
        case 'edit': return point(unique(dialog().querySelectorAll('[contenteditable="true"]')));
        case 'editText': return { text: unique(dialog().querySelectorAll('[contenteditable="true"]')).textContent };
        case 'saveEdit': return point(named(dialog(), 'button, [role="button"]', ['Save', 'Simpan', 'Send', 'Kirim']));
        case 'pinConfirm': return point(named(dialog(), 'button, [role="button"]', ['Pin', 'Sematkan']));
        case 'blur': composer().blur(); return { ok: true };
        default: throw new Error('unknown page action operation');
      }
    } catch (error) { return { ok: false, stage: operation, detail: error.message }; }
  };
}

module.exports = { injection: `(${install.toString()})()` };
