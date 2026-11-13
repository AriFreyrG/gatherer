const { app, BrowserWindow, ipcMain, shell, protocol, net, dialog, Menu } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const storage = require('./storage');
const { normalizeUrl } = require('./scraper');
const { gather } = require('./gather');
const { renderPage } = require('./render');
const reddit = require('./reddit');
const images = require('./images');
const exporter = require('./export');
const syncService = require('./sync-service');
const capture = require('./capture');
const archive = require('./archive');
const migrate = require('./migrate');

const ICON = path.join(__dirname, '..', 'renderer', 'icon.png');
const settings = require('./settings');
const ai = require('./ai');

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
    ...(process.platform === 'darwin' ? {} : { icon: ICON }),
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
  // The offline-copy frame may only show offline copies; its links open in the browser instead.
  win.webContents.on('will-frame-navigate', (e) => {
    if (!e.isMainFrame && !e.url.startsWith(`${images.SCHEME}:`)) e.preventDefault();
  });
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
    if (imported.length) syncService.schedule();
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
    if (imported.length) syncService.schedule(); // the images saved above
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

// Wrap handlers so the renderer always gets a readable message. Any notes:*, tags:* or ai:* call
// other than a read changes the notes folder, so it queues a sync.
const READS = new Set(['notes:list', 'notes:get', 'notes:search', 'notes:aiBusy']);
const handle = (channel, fn) => ipcMain.handle(channel, async (e, ...args) => {
  try {
    const result = await fn(...args, e);
    if (/^(notes|tags|ai):/.test(channel) && !READS.has(channel)) syncService.schedule();
    return result;
  } catch (err) { console.error(`[${channel}]`, err); throw new Error((err && err.message) || 'Something went wrong'); }
});
const winOf = (e) => (e && BrowserWindow.fromWebContents(e.sender)) || undefined;
const notesDir = () => path.dirname(storage.assetsRoot());

const broadcast = (channel, payload) => {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
};

// AI summary + subject for one note. Runs once per note at a time; resolves to the updated note.
const inFlight = new Map(); // id -> Promise
function enrich(id) {
  if (inFlight.has(id)) return inFlight.get(id);
  const key = settings.apiKey();
  if (!key) return Promise.reject(new Error('Add an Anthropic API key in Settings to use AI summaries.'));
  broadcast('ai:status', { id, busy: true });
  const p = (async () => {
    const subjects = [...new Set(storage.list().map((n) => n.subject).filter((s) => s && s !== 'Other'))];
    const { summary, topics } = await ai.summarizeNote(key, { ...storage.textOf(id), subjects });
    storage.setAi(id, { summary, topics });
    syncService.schedule();
    return storage.get(id);
  })().then((note) => {
    broadcast('ai:status', { id, busy: false });
    broadcast('notes:changed', { id });
    return note;
  }, (err) => {
    const message = ai.describeError(err);
    console.warn('[ai] summary failed:', err && err.message);
    broadcast('ai:status', { id, busy: false, error: message });
    throw new Error(message);
  }).finally(() => inFlight.delete(id));
  inFlight.set(id, p);
  return p;
}

app.whenReady().then(() => {
  if (isSecondInstance) return;
  protocol.handle(images.SCHEME, (req) => {
    const file = images.resolveAsset(req.url, storage.assetsRoot());
    if (!file) return new Response('Not found', { status: 404 });
    if (path.basename(file) === archive.FILE) {
      // Offline copies are arbitrary web pages: serve them with a policy that blocks scripts and all network.
      return fs.promises.readFile(file).then(
        (buf) => new Response(buf, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': archive.CSP, 'X-Content-Type-Options': 'nosniff' } }),
        () => new Response('Not found', { status: 404 }));
    }
    return net.fetch(pathToFileURL(file).toString());
  });
  // Saves a full offline copy of the page; a failure is logged and never loses the note.
  const saveArchive = async (id, html, url) => {
    try {
      const snap = await archive.snapshot(html, url);
      storage.saveArchive(id, snap.html);
      console.log(`[archive] saved ${id}: ${snap.resources} resources, ${Math.round(snap.html.length / 1024)} KB`);
    } catch (e) { console.warn('[archive] could not save offline copy:', e.message); }
  };
  const gatherPage = (url) => gather(url, { redditCreds: settings.redditCreds, render: renderPage });
  handle('notes:list', () => storage.list());
  handle('notes:get', (id) => storage.get(id));
  handle('notes:search', (query) => storage.search(typeof query === 'string' ? query : ''));
  handle('notes:create', async (url) => {
    const normalized = normalizeUrl(url);
    const { title, content, siteName, tags, html, finalUrl } = await gatherPage(normalized);
    const note = storage.create({ title, url: normalized, dateGathered: new Date().toISOString(), content, siteName, tags });
    await Promise.all([
      images.localize(note.content, { id: note.id, dir: storage.assetDir(note.id), referer: normalized })
        .then((local) => { if (local !== note.content) storage.save(note.id, { content: local }); })
        .catch((e) => console.warn('[images] could not save images locally:', e.message)),
      saveArchive(note.id, html, finalUrl),
    ]);
    // The AI summary arrives in the background; the note opens right away with a local one.
    if (settings.apiKey() && settings.publicSettings().autoSummarize) enrich(note.id).catch(() => {});
    return storage.get(note.id);
  });
  // For notes gathered before offline copies existed, or whose copy failed: fetch the page again now.
  handle('notes:archive', async (id) => {
    const note = storage.get(id);
    if (!note.url) throw new Error('This note has no source page to save');
    // The same reader as a new note, so script-built pages and Reddit posts get a real copy.
    const { html, finalUrl } = await gatherPage(normalizeUrl(note.url));
    const snap = await archive.snapshot(html, finalUrl);
    storage.saveArchive(id, snap.html);
    return storage.get(id);
  });
  handle('notes:save', (id, data) => storage.save(id, data));
  handle('notes:setSubject', (id, subject) => storage.setSubject(id, subject));
  handle('notes:setTags', (id, tags) => storage.setTags(id, tags));
  handle('tags:rename', (from, to) => storage.renameTag(from, to));
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
  handle('notes:aiBusy', () => [...inFlight.keys()]);

  handle('settings:get', () => settings.publicSettings());
  handle('settings:setKey', async (key) => {
    const k = String(key || '').trim();
    if (k) {
      try { await ai.checkKey(k); }
      catch (e) {
        // Only a definite rejection blocks saving; being offline right now should not.
        if (e instanceof require('@anthropic-ai/sdk').AuthenticationError) throw new Error('That API key was rejected by Anthropic.');
        console.warn('[ai] could not verify key:', e && e.message);
      }
    }
    return settings.setApiKey(k);
  });
  handle('settings:setAutoSummarize', (on) => settings.setAutoSummarize(on));
  handle('settings:setReddit', async (creds) => {
    const clientId = String((creds && creds.clientId) || '').trim();
    const secret = String((creds && creds.secret) || '').trim();
    if (clientId) {
      try { await reddit.checkKey({ clientId, secret }); }
      catch (e) {
        // Only a definite rejection blocks saving; being offline right now should not.
        if (e instanceof reddit.RedditAuthError) throw new Error('Reddit rejected that client ID and secret.');
        console.warn('[reddit] could not verify key:', e && e.message);
      }
    }
    return settings.setReddit({ clientId, secret });
  });

  handle('ai:summarize', (id) => enrich(id));
  // Regroup every automatic note by meaning in one pass. Pinned notes keep their subject and
  // lend their labels to the AI.
  handle('ai:organize', async () => {
    const key = settings.apiKey();
    if (!key) throw new Error('Add an Anthropic API key in Settings to group notes by meaning.');
    const all = storage.briefs();
    const pinned = [...new Set(all.map((n) => n.pinned).filter(Boolean))];
    const auto = all.filter((n) => !n.pinned);
    if (!auto.length) return storage.list();
    let map;
    try { map = await ai.organizeNotes(key, auto, pinned); }
    catch (e) { console.warn('[ai] regroup failed:', e && e.message); throw new Error(ai.describeError(e)); }
    for (const n of auto) {
      const s = map.get(n.id);
      if (s) storage.setAi(n.id, { topics: /^other$/i.test(s) ? [] : [s] });
    }
    return storage.list();
  });
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

  syncService.init(notesDir, (ids) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('notes:changed', ids);
  });

  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(ICON); // packaged builds use icon.icns
  buildMenu();
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
