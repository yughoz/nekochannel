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
  const labels = element => [element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent].filter(Boolean).map(value => value.trim().toLowerCase());
  const named = (scope, selector, names) => unique([...scope.querySelectorAll(selector)].filter(element => labels(element).some(label => names.map(name => name.toLowerCase()).includes(label))));
  const composer = () => unique(document.querySelectorAll('footer [contenteditable="true"][role="textbox"], footer div[contenteditable="true"]'));
  const dialog = () => unique(document.querySelectorAll('[role="dialog"]'));
  const message = id => unique([...document.querySelectorAll('[data-id]')].filter(element => element.getAttribute('data-id') === id));
  const cleanComposer = () => {
    const element = composer();
    if (element.textContent.trim()) throw new Error('composer contains a draft; refusing to overwrite it');
    if (document.querySelector('[data-testid="quoted-message"], [data-testid="quoted-message-preview"], [aria-label="Cancel reply"], [aria-label="Batalkan balasan"]')) throw new Error('existing quote; cancel it first');
    return element;
  };
  globalThis.__nekoWAAction = (operation, args = {}) => {
    try {
      switch (operation) {
        case 'ready': return { ok: true };
        case 'message': {
          const element = message(args.msgId);
          if (args.own && !element.matches('.message-out') && !element.querySelector('.message-out') && !element.closest('.message-out')) throw new Error('edit requires an outgoing message');
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
        case 'emoji': return point(named(document, 'button, [role="button"], [role="gridcell"]', [args.emoji]));
        case 'attach': {
          const inputs = [...document.querySelectorAll('input[type="file"]')].filter(element => args.image ? /image/.test(element.accept) && !/application/.test(element.accept) : !element.accept || element.accept === '*');
          if (inputs.length !== 1) throw new Error(`ambiguous attachment input (${inputs.length})`);
          const bytes = Uint8Array.from(atob(args.file.data), character => character.charCodeAt(0));
          const transfer = new DataTransfer();
          transfer.items.add(new File([bytes], args.file.name, { type: args.file.mime }));
          inputs[0].files = transfer.files;
          inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true };
        }
        case 'caption': return point(unique(dialog().querySelectorAll('[contenteditable="true"]')));
        case 'previewSend': return point(named(dialog(), 'button, [role="button"]', ['Send', 'Kirim']));
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
