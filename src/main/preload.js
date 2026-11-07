// Bridge between the renderer and the main process. This is the IPC contract:
//
//   NoteSummary = { id, title, url, dateGathered, siteName, subject, pinnedSubject, userTags, highlights }
//                 (dateGathered: ISO 8601; subject: inferred or pinned; pinnedSubject: '' when automatic;
//                  userTags: the user's own tags; highlights: text of each <mark> in the body)
//   Note        = { id, title, url, dateGathered, siteName, tags, userTags, subject, content }
//                 (tags: from the page, not shown; content: sanitized HTML body, highlights are <mark>)
//
//   notes.list()             -> NoteSummary[]  newest first
//   notes.get(id)            -> Note
//   notes.create(url)        -> Note           scrapes url, saves, returns new note
//   notes.save(id, {title, content}) -> NoteSummary
//   notes.setSubject(id, subject) -> NoteSummary  pin a subject; '' returns it to automatic
//   notes.setTags(id, tags)  -> NoteSummary  replace the user's tags on a note
//   tags.rename(from, to)    -> number         rename/merge a tag on every note; '' removes it
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
    setTags: (id, tags) => ipcRenderer.invoke('notes:setTags', id, tags),
    delete: (id) => ipcRenderer.invoke('notes:delete', id),
  },
  tags: {
    rename: (from, to) => ipcRenderer.invoke('tags:rename', from, to),
  },
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  // Main asks the renderer to save pending edits before the window closes.
  onFlushRequest: (fn) => ipcRenderer.on('app:flush', async () => {
    try { await fn(); } catch { /* close anyway */ } finally { ipcRenderer.send('app:flushed'); }
  }),
});
