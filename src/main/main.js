const { app, BrowserWindow, ipcMain, shell, protocol, net } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const storage = require('./storage');
const { scrape, normalizeUrl } = require('./scraper');
const images = require('./images');
const capture = require('./capture');

protocol.registerSchemesAsPrivileged([{ scheme: images.SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

/* ---------- one-click capture (gatherer:// links) ---------- */
// The Mac App Store build gets the scheme from Info.plist (electron-builder "protocols").
// Other builds, and `npm start`, register it at run time.
if (process.defaultApp) {
  if (process.argv.length >= 2) app.setAsDefaultProtocolClient(capture.SCHEME, process.execPath, [path.resolve(process.argv[1])]);
} else if (!process.mas) {
  app.setAsDefaultProtocolClient(capture.SCHEME);
}

// Windows and Linux start a second copy of the app for each link; hand it to the first one.
// macOS (including the sandboxed MAS build) delivers links through 'open-url' instead.
const isSecondInstance = process.platform !== 'darwin' && !app.requestSingleInstanceLock();
if (isSecondInstance) app.quit();

let mainWin = null;
let rendererReady = false;
const pendingCaptures = [];
const recentCaptures = new Map(); // url -> time, to ignore double clicks

function deliverCaptures() {
  if (!rendererReady || !mainWin || mainWin.isDestroyed()) return;
  while (pendingCaptures.length) mainWin.webContents.send('capture:page', pendingCaptures.shift());
}

function receiveCaptureLink(raw) {
  const item = capture.parseCaptureLink(raw);
  if (!item) { console.warn('[capture] ignored link:', String(raw).slice(0, 200)); return; }
  const now = Date.now();
  for (const [u, t] of recentCaptures) if (now - t > 5000) recentCaptures.delete(u);
  if (recentCaptures.has(item.url)) return;
  recentCaptures.set(item.url, now);
  pendingCaptures.push(item);
  if (app.isReady()) {
    if (!mainWin || mainWin.isDestroyed()) createWindow();
    else { if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus(); }
  }
  deliverCaptures();
}

app.on('open-url', (e, url) => { e.preventDefault(); receiveCaptureLink(url); });
app.on('second-instance', (_e, argv) => {
  const links = capture.linksFromArgv(argv);
  links.forEach(receiveCaptureLink);
  if (!links.length && mainWin && !mainWin.isDestroyed()) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); }
});
if (!isSecondInstance) capture.linksFromArgv(process.argv).forEach(receiveCaptureLink);

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
  mainWin = win;
  rendererReady = false;
  win.webContents.on('did-start-loading', () => { if (mainWin === win) rendererReady = false; });
  win.on('closed', () => { if (mainWin === win) { mainWin = null; rendererReady = false; } });
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
  if (isSecondInstance) return;
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
  // The renderer is listening for captured pages; send any that arrived before it loaded.
  ipcMain.handle('capture:ready', (e) => {
    if (mainWin && e.sender === mainWin.webContents) { rendererReady = true; setImmediate(deliverCaptures); }
    return { bookmarklet: capture.BOOKMARKLET };
  });
  handle('app:openExternal', async (url) => {
    if (!isHttp(url)) throw new Error('Only http and https links can be opened');
    await shell.openExternal(url);
    return true;
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
