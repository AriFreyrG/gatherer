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
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  // Main tells the renderer when notes changed outside it (e.g. after File > Import Notes).
  onNotesChanged: (fn) => ipcRenderer.on('notes:changed', () => fn()),
  // Main asks the renderer to save pending edits before the window closes.
  onFlushRequest: (fn) => ipcRenderer.on('app:flush', async () => {
    try { await fn(); } catch { /* close anyway */ } finally { ipcRenderer.send('app:flushed'); }
  }),
});
