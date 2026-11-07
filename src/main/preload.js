// Bridge between the renderer and the main process. This is the IPC contract:
//
//   NoteSummary = { id, title, url, dateGathered, siteName, subject, pinnedSubject }
//                 (dateGathered: ISO 8601; subject: inferred or pinned; pinnedSubject: '' when automatic)
//   Note        = { id, title, url, dateGathered, siteName, tags, subject, content } (content: sanitized HTML body)
//
//   notes.list()             -> NoteSummary[]  newest first
//   notes.get(id)            -> Note
//   notes.create(url)        -> Note           scrapes url, saves, returns new note
//   notes.save(id, {title, content}) -> NoteSummary
//   notes.setSubject(id, subject) -> NoteSummary  pin a subject; '' returns it to automatic
//   notes.delete(id)         -> true
//   onNotesChanged(fn)       fn(ids) after sync changed, added or removed notes on disk
//
//   exports.note(id, 'markdown' | 'pdf') -> { path } | null (cancelled)
//   exports.all()            -> { path, count } | null   every note as Markdown into a chosen folder
//   exports.reveal(path)     shows an exported file in Finder
//
//   SyncStatus = { enabled, folder, syncing, lastSync, error, pending, conflicts }
//   sync.status() / sync.choose() / sync.now() / sync.disable() -> SyncStatus
//   sync.onStatus(fn)        fn(SyncStatus) whenever it changes
//
// Failures reject with an Error whose message is shown to the user.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gatherer', {
  notes: {
    list: () => ipcRenderer.invoke('notes:list'),
    get: (id) => ipcRenderer.invoke('notes:get', id),
    create: (url) => ipcRenderer.invoke('notes:create', url),
    save: (id, data) => ipcRenderer.invoke('notes:save', id, data),
    setSubject: (id, subject) => ipcRenderer.invoke('notes:setSubject', id, subject),
    delete: (id) => ipcRenderer.invoke('notes:delete', id),
  },
  onNotesChanged: (fn) => ipcRenderer.on('notes:changed', (_e, ids) => fn(ids)),
  exports: {
    note: (id, format) => ipcRenderer.invoke('export:note', id, format),
    all: () => ipcRenderer.invoke('export:all'),
    reveal: (p) => ipcRenderer.invoke('export:reveal', p),
  },
  sync: {
    status: () => ipcRenderer.invoke('sync:status'),
    choose: () => ipcRenderer.invoke('sync:choose'),
    now: () => ipcRenderer.invoke('sync:now'),
    disable: () => ipcRenderer.invoke('sync:disable'),
    onStatus: (fn) => ipcRenderer.on('sync:status', (_e, s) => fn(s)),
  },
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  // Main asks the renderer to save pending edits before the window closes.
  onFlushRequest: (fn) => ipcRenderer.on('app:flush', async () => {
    try { await fn(); } catch { /* close anyway */ } finally { ipcRenderer.send('app:flushed'); }
  }),
});
