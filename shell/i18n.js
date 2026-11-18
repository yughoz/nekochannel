'use strict';
// Semua copy UI shell (id/en) di satu tempat — dipakai main process (tray,
// detail status, halaman error agent) dan renderer (sidebar, jendela settings)
// lewat require / preload sendSync. Fallback: en→id→kunci.
const STR = {
  id: {
    addAccount: '+ Add akun',
    ctxRename: 'Rename label', ctxReload: 'Reload halaman',
    ctxDelete: 'Delete akun', ctxDeleteArmed: 'Klik lagi untuk hapus',
    settingsTab: '⚙ Pengaturan', settingsTitle: 'Pengaturan',
    secLlm: 'LLM Agent',
    llmHint: 'Disimpan ke .env wa-reader (CHAT_MODEL_*). Restart chat server untuk menerapkan. Kosongkan URL/model = pakai bawaan .env; kosongkan API key = tetap pakai yang tersimpan.',
    llmUrl: 'Base URL', llmName: 'Nama model', llmKey: 'API key',
    llmKeyStored: 'tersimpan — kosongkan biar tetap',
    llmSave: 'Simpan', llmReset: 'Pakai bawaan wa-reader', llmResetArmed: 'Klik lagi untuk reset',
    llmLive: 'Model aktif', llmLiveOff: '(chat server mati)',
    llmSaved: 'Tersimpan ✓ — restart chat server untuk menerapkan.',
    secNotif: 'Notifikasi desktop', secLang: 'Bahasa', secAbout: 'Tentang',
    aboutVersion: 'Versi', aboutRepo: 'Repo GitHub',
    trayShow: 'Tampilkan', traySettings: 'Pengaturan…', trayTheme: 'Tema',
    trayThemeSys: 'Ikuti sistem', trayLight: 'Terang', trayDark: 'Gelap', trayQuit: 'Keluar',
    stLoading: 'memuat…', stChat: 'chat list terdeteksi', stQr: 'menunggu scan QR', stLoadingPage: 'memuat halaman…',
    errTitle: 'Chat server mati', errHead: 'Chat server belum jalan',
    errStart: 'Nyalakan dari repo wa-reader:', errRetry: 'Retry',
    agentDockTip: 'Dock kanan: chat agent di kanan, akun tetap kelihatan di kiri',
    swPlaceholder: 'Lompat ke akun atau Agent…', swEmpty: 'Tidak ada yang cocok',
  },
  en: {
    addAccount: '+ Add account',
    ctxRename: 'Rename', ctxReload: 'Reload page',
    ctxDelete: 'Delete account', ctxDeleteArmed: 'Click again to delete',
    settingsTab: '⚙ Settings', settingsTitle: 'Settings',
    secLlm: 'Agent LLM',
    llmHint: 'Saved to the wa-reader .env (CHAT_MODEL_*). Restart the chat server to apply. Empty URL/model = use the .env defaults; empty API key = keep the stored one.',
    llmUrl: 'Base URL', llmName: 'Model name', llmKey: 'API key',
    llmKeyStored: 'stored — leave empty to keep',
    llmSave: 'Save', llmReset: 'Use wa-reader defaults', llmResetArmed: 'Click again to reset',
    llmLive: 'Live model', llmLiveOff: '(chat server down)',
    llmSaved: 'Saved ✓ — restart the chat server to apply.',
    secNotif: 'Desktop notifications', secLang: 'Language', secAbout: 'About',
    aboutVersion: 'Version', aboutRepo: 'GitHub repo',
    trayShow: 'Show', traySettings: 'Settings…', trayTheme: 'Theme',
    trayThemeSys: 'Follow system', trayLight: 'Light', trayDark: 'Dark', trayQuit: 'Quit',
    stLoading: 'loading…', stChat: 'chat list detected', stQr: 'waiting for QR scan', stLoadingPage: 'loading page…',
    errTitle: 'Chat server down', errHead: 'Chat server is not running',
    errStart: 'Start it from the wa-reader repo:', errRetry: 'Retry',
    agentDockTip: 'Right dock: agent chat on the right, account stays visible on the left',
    swPlaceholder: 'Jump to an account or Agent…', swEmpty: 'No matches',
  },
};

const t = (lang, key) => (STR[lang] && STR[lang][key]) ?? STR.id[key] ?? key;

module.exports = { STR, t };
