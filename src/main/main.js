const { app, BrowserWindow, ipcMain, shell, protocol, net, dialog } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const storage = require('./storage');
const { scrape, normalizeUrl } = require('./scraper');
const images = require('./images');
const exporter = require('./export');
const syncService = require('./sync-service');

protocol.registerSchemesAsPrivileged([{ scheme: images.SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let quitting = false;
app.on('before-quit', () => { quitting = true; });

const isHttp = (u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };

function createWindow() {
  const win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 800, title: 'Gatherer',
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
}

// Wrap handlers so the renderer always gets a readable message. Any notes:* call other than
// a read changes the notes folder, so it queues a sync.
const READS = new Set(['notes:list', 'notes:get']);
const handle = (channel, fn) => ipcMain.handle(channel, async (e, ...args) => {
  try {
    const result = await fn(...args, e);
    if (channel.startsWith('notes:') && !READS.has(channel)) syncService.schedule();
    return result;
  } catch (err) { console.error(`[${channel}]`, err); throw new Error((err && err.message) || 'Something went wrong'); }
});
const winOf = (e) => (e && BrowserWindow.fromWebContents(e.sender)) || undefined;
const notesDir = () => path.dirname(storage.assetsRoot());

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
  handle('export:note', async (id, format, e) => {
    const note = storage.get(id);
    const subject = (storage.list().find((n) => n.id === id) || {}).subject;
    const full = { ...note, subject: note.subject || (subject !== 'Other' ? subject : '') };
    if (format === 'pdf') {
      const res = await dialog.showSaveDialog(winOf(e), {
        title: 'Export as PDF', defaultPath: path.join(app.getPath('documents'), exporter.fileName(note.title) + '.pdf'),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (res.canceled || !res.filePath) return null;
      fs.writeFileSync(res.filePath, await exporter.renderPdf(full, { assetsRoot: storage.assetsRoot() }));
      return { path: res.filePath };
    }
    if (format === 'markdown') {
      // A folder, not a file: the note's images are copied next to it, and the sandbox only
      // lets the app write inside what the user picked.
      const dir = await chooseFolder(winOf(e), 'Export as Markdown');
      if (!dir) return null;
      return { path: exporter.writeMarkdown(full, dir, { assetsRoot: storage.assetsRoot() }) };
    }
    throw new Error('Unknown export format');
  });
  handle('export:all', async (e) => {
    const list = storage.list();
    if (!list.length) throw new Error('There are no notes to export');
    const dir = await chooseFolder(winOf(e), `Export ${list.length} notes as Markdown`);
    if (!dir) return null;
    const notes = list.map((s) => ({ ...s, subject: s.subject !== 'Other' ? s.subject : '' }));
    const get = (id) => { const n = storage.get(id); return { ...n, subject: n.subject || notes.find((x) => x.id === id).subject }; };
    return { path: dir, count: exporter.writeAllMarkdown(notes, get, dir, { assetsRoot: storage.assetsRoot() }) };
  });
  handle('export:reveal', (p) => { if (typeof p === 'string' && path.isAbsolute(p)) shell.showItemInFolder(p); return true; });
  handle('sync:status', () => syncService.status());
  handle('sync:choose', (e) => syncService.choose(winOf(e)));
  handle('sync:now', () => syncService.run());
  handle('sync:disable', () => syncService.disable());
  handle('app:openExternal', async (url) => {
    if (!isHttp(url)) throw new Error('Only http and https links can be opened');
    await shell.openExternal(url);
    return true;
  });

  syncService.init(notesDir, (ids) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('notes:changed', ids);
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

async function chooseFolder(win, title) {
  const res = await dialog.showOpenDialog(win, {
    title, buttonLabel: 'Export', defaultPath: app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
}

// Push the last edits to the sync folder before the app goes away. Windows are already
// closed (and their edits saved) by now; app.quit() is ignored this late, so exit directly.
app.on('will-quit', (e) => {
  if (!syncService.status().enabled) return;
  e.preventDefault();
  syncService.finish().finally(() => app.exit(0));
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
