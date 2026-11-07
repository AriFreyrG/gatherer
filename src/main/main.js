const { app, BrowserWindow, ipcMain, shell, protocol, net } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const storage = require('./storage');
const { scrape, normalizeUrl } = require('./scraper');
const images = require('./images');
const settings = require('./settings');
const ai = require('./ai');

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
  protocol.handle(images.SCHEME, (req) => {
    const file = images.resolveAsset(req.url, storage.assetsRoot());
    if (!file) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  handle('notes:list', () => storage.list());
  handle('notes:get', (id) => storage.get(id));
  handle('notes:search', (query) => storage.search(typeof query === 'string' ? query : ''));
  handle('notes:create', async (url) => {
    const normalized = normalizeUrl(url);
    const { title, content, siteName, tags } = await scrape(normalized);
    const note = storage.create({ title, url: normalized, dateGathered: new Date().toISOString(), content, siteName, tags });
    try {
      const local = await images.localize(note.content, { id: note.id, dir: storage.assetDir(note.id), referer: normalized });
      if (local !== note.content) storage.save(note.id, { content: local });
    } catch (e) { console.warn('[images] could not save images locally:', e.message); }
    // The AI summary arrives in the background; the note opens right away with a local one.
    if (settings.apiKey() && settings.publicSettings().autoSummarize) enrich(note.id).catch(() => {});
    return storage.get(note.id);
  });
  handle('notes:save', (id, data) => storage.save(id, data));
  handle('notes:setSubject', (id, subject) => storage.setSubject(id, subject));
  handle('notes:delete', (id) => storage.remove(id));
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
  handle('app:openExternal', async (url) => {
    if (!isHttp(url)) throw new Error('Only http and https links can be opened');
    await shell.openExternal(url);
    return true;
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
