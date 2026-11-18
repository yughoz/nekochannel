'use strict';
// Registry satu objek (PRD: jangan formalisasi jadi plugin system sampai ada
// adapter kedua — bentuk final interface dirancang saat email adapter dikerjakan).
module.exports = { whatsapp: require('./whatsapp') };
