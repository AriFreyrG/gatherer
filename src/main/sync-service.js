// Runs folder sync in the background: remembers the chosen iCloud Drive folder (with a
// security-scoped bookmark in the Mac App Store build), syncs on start, after local edits,
// when the folder changes, when the app regains focus and once a minute.
const fs = require('fs');
const path = require('path');
const { app, dialog, BrowserWindow } = require('electron');
const sync = require('./sync');

const POLL_MS = 60 * 1000;
const LOCAL_DEBOUNCE_MS = 2500;
const WATCH_DEBOUNCE_MS = 1500;

let localDir = null;
let onLocalChange = () => {};
let settings = { folder: '', bookmark: '' };
let state = null;
let status = { enabled: false, folder: '', syncing: false, lastSync: '', error: '', pending: 0, conflicts: 0 };
let stopAccess = null;
let watcher = null;
let poll = null;
let debounce = null;
let running = null;
let again = false;

const userFile = (name) => path.join(app.getPath('userData'), name);
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, data) => { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, file); };

// Where the folder picker opens: iCloud Drive's own folder. The real home folder, not the
// sandbox container's; the app can't look inside it until the user picks it, but the picker can.
function iCloudDrive() {
  if (process.platform !== 'darwin') return '';
  return path.join(require('os').userInfo().homedir, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
}

function broadcast() {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('sync:status', getStatus());
}
const set = (patch) => { status = { ...status, ...patch }; broadcast(); };
const getStatus = () => ({ ...status });

function startAccess() {
  if (stopAccess) { try { stopAccess(); } catch {} stopAccess = null; }
  if (process.mas && settings.bookmark) {
    try { stopAccess = app.startAccessingSecurityScopedResource(settings.bookmark); }
    catch (e) { console.warn('[sync] bookmark access failed:', e.message); }
  }
}

function watch() {
  if (watcher) { watcher.close(); watcher = null; }
  if (!settings.folder) return;
  try {
    watcher = fs.watch(settings.folder, { recursive: true }, (_ev, name) => {
      if (name && /(^|[/\\])\.gatherer-sync$|\.tmp$/.test(String(name))) return;
      schedule(WATCH_DEBOUNCE_MS);
    });
    watcher.on('error', () => {});
  } catch (e) { console.warn('[sync] cannot watch folder:', e.message); }
}

function run() {
  if (!settings.folder) return Promise.resolve(getStatus());
  if (running) { again = true; return running; }
  set({ syncing: true });
  running = Promise.resolve().then(async () => { // async hop: `running` is set before the work starts
    try {
      const r = sync.syncOnce({ local: localDir(), remote: settings.folder, state });
      state = r.state;
      writeJson(userFile('sync-state.json'), state);
      set({ lastSync: new Date().toISOString(), error: '', pending: r.pending, conflicts: status.conflicts + r.conflicts.length });
      if (r.changedLocal.length) onLocalChange(sync.idsOf(r.changedLocal));
    } catch (e) {
      console.warn('[sync]', e.message);
      set({ error: e.code === 'EPERM' || e.code === 'EACCES' ? 'Gatherer lost permission to the sync folder. Choose it again to continue.' : e.message });
    } finally {
      running = null;
      set({ syncing: false });
      if (again) { again = false; schedule(500); }
    }
    return getStatus();
  });
  return running;
}

function schedule(ms = LOCAL_DEBOUNCE_MS) {
  if (!settings.folder) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => { debounce = null; run(); }, ms);
}

function enable(folder, bookmark) {
  settings = { folder, bookmark: bookmark || '' };
  writeJson(userFile('sync.json'), settings);
  state = readJson(userFile('sync-state.json'), null);
  set({ enabled: true, folder, error: '', conflicts: 0 });
  watch();
  clearInterval(poll); poll = setInterval(run, POLL_MS);
  return run();
}

// localDirFn: () => the notes folder. changed(ids): called after sync changed local notes.
function init(localDirFn, changed) {
  localDir = localDirFn;
  onLocalChange = changed;
  settings = { folder: '', bookmark: '', ...readJson(userFile('sync.json'), {}) };
  app.on('browser-window-focus', () => schedule(300));
  if (!settings.folder) return;
  startAccess();
  enable(settings.folder, settings.bookmark);
}

async function choose(win) {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a folder to sync with',
    message: 'Pick a folder in iCloud Drive. Gatherer keeps its notes in a “Gatherer” folder there, so every Mac signed in to the same iCloud account sees them.',
    buttonLabel: 'Sync Here',
    defaultPath: settings.folder || iCloudDrive() || app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
    securityScopedBookmarks: !!process.mas,
  });
  if (res.canceled || !res.filePaths.length) return getStatus();
  const chosen = res.filePaths[0];
  const bookmark = res.bookmarks && res.bookmarks[0];
  settings.bookmark = bookmark || '';
  startAccess();
  let root;
  try { root = sync.prepareRoot(chosen); }
  catch (e) { set({ error: `Couldn't use that folder: ${e.message}` }); return getStatus(); }
  // A Gatherer folder made inside the chosen one is covered by the chosen folder's bookmark.
  return enable(root, settings.bookmark);
}

function disable() {
  clearInterval(poll); poll = null; clearTimeout(debounce);
  if (watcher) { watcher.close(); watcher = null; }
  if (stopAccess) { try { stopAccess(); } catch {} stopAccess = null; }
  settings = { folder: '', bookmark: '' };
  try { fs.rmSync(userFile('sync.json'), { force: true }); fs.rmSync(userFile('sync-state.json'), { force: true }); } catch {}
  state = null;
  set({ enabled: false, folder: '', error: '', lastSync: '', pending: 0, conflicts: 0 });
  return getStatus();
}

// Wait for an in-flight sync (and one last pass if edits are queued) before quitting.
async function finish(timeoutMs = 5000) {
  if (!settings.folder) return;
  const pending = !!debounce;
  clearTimeout(debounce); debounce = null;
  const work = (async () => { if (running) await running; if (pending) await run(); })();
  await Promise.race([work, new Promise((r) => setTimeout(r, timeoutMs))]);
}

module.exports = { init, choose, disable, run, schedule, finish, status: getStatus };
