const { app, BrowserWindow, ipcMain, shell, protocol, net, dialog, Menu } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const storage = require('./storage');
const { scrape, normalizeUrl } = require('./scraper');
const images = require('./images');
const migrate = require('./migrate');

const ICON = path.join(__dirname, '..', 'renderer', 'icon.png');

protocol.registerSchemesAsPrivileged([{ scheme: images.SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let quitting = false;
app.on('before-quit', () => { quitting = true; });

const isHttp = (u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };

function createWindow() {
  const win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 800, title: 'Gatherer',
    ...(process.platform === 'darwin' ? {} : { icon: ICON }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttp(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Give the renderer a chance to save pending edits before the window goes away.
  let closing = false;
  win.on('close', (e) => {
    if (closing) return;
    e.preventDefault();
    closing = true;
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      ipcMain.removeListener('app:flushed', onFlushed);
      if (quitting) app.quit(); else if (!win.isDestroyed()) win.close();
    };
    const onFlushed = (ev) => { if (ev.sender === win.webContents) finish(); };
    ipcMain.on('app:flushed', onFlushed);
    setTimeout(finish, 3000);
    win.webContents.send('app:flush');
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => offerLegacyImport(win).catch((e) => console.error('[migrate]', e)));
}

// Importing notes from another Gatherer notes folder. The Mac App Store build is sandboxed and
// can't see the notes earlier builds saved, so the user picks that folder once in an Open dialog.
let importing = false;
async function importNotes(win, { intro = false } = {}) {
  if (importing) return;
  importing = true;
  try {
    const legacy = migrate.legacyNotesDir('Gatherer'); // the name earlier builds stored notes under
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Import Notes',
      message: intro ? 'Gatherer found no notes yet. Select the "notes" folder from your earlier version, then click Import.'
        : 'Select a Gatherer "notes" folder to import, then click Import.',
      buttonLabel: 'Import',
      defaultPath: legacy,
      properties: ['openDirectory'],
    });
    if (canceled || !filePaths.length) return;
    const { imported, skipped, failed } = migrate.importFolder(filePaths[0]);
    if (!win.isDestroyed()) win.webContents.send('notes:changed');
    const parts = [`Imported ${imported.length} note${imported.length === 1 ? '' : 's'}.`];
    if (skipped) parts.push(`${skipped} ${skipped === 1 ? 'was' : 'were'} already here.`);
    if (failed) parts.push(`${failed} file${failed === 1 ? '' : 's'} could not be read.`);
    if (!imported.length && !skipped && !failed) parts.splice(0, 1, 'That folder has no Gatherer notes in it.');
    await dialog.showMessageBox(win, { type: 'info', message: parts.join(' '), buttons: ['OK'] });
    // Older notes may still point at images on the web; save them locally so they work offline.
    for (const id of imported) {
      const note = storage.get(id);
      if (!/<img[^>]+src="https?:/i.test(note.content)) continue;
      try {
        const local = await images.localize(note.content, { id, dir: storage.assetDir(id), referer: note.url || undefined });
        if (local !== note.content) storage.save(id, { content: local });
      } catch (e) { console.warn(`[migrate] images for ${id}:`, e.message); }
    }
    if (imported.length && !win.isDestroyed()) win.webContents.send('notes:changed');
  } catch (e) {
    console.error('[migrate]', e);
    if (!win.isDestroyed()) dialog.showMessageBox(win, { type: 'error', message: 'Could not import notes', detail: e.message, buttons: ['OK'] });
  } finally { importing = false; }
}

// On the first launch of the sandboxed build with an empty library, offer to bring old notes over.
async function offerLegacyImport(win) {
  if (!process.mas) return;
  const marker = path.join(app.getPath('userData'), '.legacy-import-offered');
  if (fs.existsSync(marker) || storage.list().length) return;
  fs.writeFileSync(marker, new Date().toISOString());
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    message: 'Bring over notes from an earlier version?',
    detail: 'If you used Gatherer before installing it from the App Store, macOS needs you to point to that notes folder once. ' +
      'You can also do this later with File > Import Notes.',
    buttons: ['Import Notes…', 'Not Now'], defaultId: 0, cancelId: 1,
  });
  if (response === 0) await importNotes(win, { intro: true });
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  const focused = () => BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Import Notes…', click: () => { const w = focused(); if (w) importNotes(w); } },
      { type: 'separator' },
      mac ? { role: 'close' } : { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}

// Wrap handlers so the renderer always gets a readable message.
const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
  try { return await fn(...args); }
  catch (err) { console.error(`[${channel}]`, err); throw new Error((err && err.message) || 'Something went wrong'); }
});

app.whenReady().then(() => {
  protocol.handle(images.SCHEME, (req) => {
    const file = images.resolveAsset(req.url, storage.assetsRoot());
    if (!file) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  handle('notes:list', () => storage.list());
  handle('notes:get', (id) => storage.get(id));
  handle('notes:create', async (url) => {
    const normalized = normalizeUrl(url);
    const { title, content, siteName, tags } = await scrape(normalized);
    const note = storage.create({ title, url: normalized, dateGathered: new Date().toISOString(), content, siteName, tags });
    try {
      const local = await images.localize(note.content, { id: note.id, dir: storage.assetDir(note.id), referer: normalized });
      if (local !== note.content) { storage.save(note.id, { content: local }); return storage.get(note.id); }
    } catch (e) { console.warn('[images] could not save images locally:', e.message); }
    return note;
  });
  handle('notes:save', (id, data) => storage.save(id, data));
  handle('notes:setSubject', (id, subject) => storage.setSubject(id, subject));
  handle('notes:delete', (id) => storage.remove(id));
  handle('app:openExternal', async (url) => {
    if (!isHttp(url)) throw new Error('Only http and https links can be opened');
    await shell.openExternal(url);
    return true;
  });

  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(ICON); // packaged builds use icon.icns
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
