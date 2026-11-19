# Provenance and publication gates

## Imported source

- `backend/server/`, `backend/chat/` (including UI), `backend/mcp/` copied from first-party `yughoz/wa-reader`, source commit `daa7b5b61d2ae806755000519ccfbf5c9a4f47a4` (including its regression tests). Integration edits cover lifecycle/config, unconfigured chat and startup cleanup. No source checkout edits.
- Existing `adapters/whatsapp/vendor/normalize.js` and `page-main.bundle.js` originated from that project's extension engine. They are now maintained in this repository, with no external sync dependency.
- Neither inspected repository contains a tracked LICENSE/COPYING grant. Nekochannel remains `private:true`, `license:UNLICENSED`. Repository history lists Lele, Nekoding and Yughoz as author labels; labels alone do not establish legal ownership. Owner must confirm rights to all contributions and imported code before selecting a license.
- Ferdium is an architectural reference, not a fork or imported implementation. WhatsApp Web itself is loaded remotely; its code/assets are not licensed by this project. Confirm icon/assets provenance separately.
- Electron and electron-builder bring third-party dependencies/licenses. Retain their notices in distributed installers and audit the packaged dependency tree, not just these zero-runtime-dependency JS services.

## Audit performed / limits

Inspected tracked file inventory, source commit and author labels, license files and current staged/current source for accidental env/database files and private deployment references. Imported only server/chat/MCP JS, chat UI and their tests; never copied source `.env`, database, service units or credentials. General README/config/module docs use generic paths and loopback/example addresses.

This is **not** a clean bill for the full private git object history: earlier commits may contain deployment information or secrets even when absent from the current tree. Before publication: scan every reachable historical blob and release artifact with a secret scanner, review findings privately, rotate any exposed credentials, verify contribution/assets rights, inventory bundled licenses, and obtain an explicit license/publication decision from the owner. No license selection, visibility change, push, publication or history rewrite is authorized by #22.
