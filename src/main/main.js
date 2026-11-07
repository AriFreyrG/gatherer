const { app, BrowserWindow, ipcMain, shell, protocol, net } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const storage = require('./storage');
const { scrape, normalizeUrl } = require('./scraper');
const images = require('./images');

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
  handle('notes:setTags', (id, tags) => storage.setTags(id, tags));
  handle('tags:rename', (from, to) => storage.renameTag(from, to));
  handle('notes:delete', (id) => storage.remove(id));
  handle('app:openExternal', async (url) => {
    if (!isHttp(url)) throw new Error('Only http and https links can be opened');
    await shell.openExternal(url);
    return true;
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
