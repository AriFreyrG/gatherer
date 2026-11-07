// Bridge between the renderer and the main process. This is the IPC contract:
//
//   NoteSummary = { id, title, url, dateGathered, siteName, subject, pinnedSubject }
//                 (dateGathered: ISO 8601; subject: inferred or pinned; pinnedSubject: '' when automatic)
//   Note        = { id, title, url, dateGathered, siteName, tags, subject, content, summary, summarySource, topics }
//                 (content: sanitized HTML body; summarySource: 'ai' | 'local' | ''; topics: AI subject labels)
//   Settings    = { hasKey, keySource: 'settings'|'environment'|'', keyHint, autoSummarize }
//
//   notes.list()             -> NoteSummary[]  newest first
//   notes.get(id)            -> Note
//   notes.search(query)      -> SearchResult[] best first; SearchResult = NoteSummary (without subject) +
//                               { score, hits, titleRanges, snippet, snippetRanges }
//                               (ranges: [[start, end], ...] character offsets of matches in title / snippet)
//   notes.create(url)        -> Note           scrapes url, saves, returns new note
//   notes.save(id, {title, content}) -> NoteSummary
//   notes.setSubject(id, subject) -> NoteSummary  pin a subject; '' returns it to automatic
//   notes.delete(id)         -> true
//   notes.aiBusy()           -> id[]           notes whose AI summary is being written
//   ai.summarize(id)         -> Note           (re)write the AI summary and subject labels
//   ai.organize()            -> NoteSummary[]  regroup all automatic notes by meaning
//   settings.get() / setKey(key) / setAutoSummarize(bool) -> Settings   ('' key removes it)
//   onNoteChanged(fn({id}))  main updated a note in the background
//   onAiStatus(fn({id, busy, error?}))
//
// Failures reject with an Error whose message is shown to the user.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gatherer', {
  notes: {
    list: () => ipcRenderer.invoke('notes:list'),
    get: (id) => ipcRenderer.invoke('notes:get', id),
    search: (query) => ipcRenderer.invoke('notes:search', query),
    create: (url) => ipcRenderer.invoke('notes:create', url),
    save: (id, data) => ipcRenderer.invoke('notes:save', id, data),
    setSubject: (id, subject) => ipcRenderer.invoke('notes:setSubject', id, subject),
    delete: (id) => ipcRenderer.invoke('notes:delete', id),
    aiBusy: () => ipcRenderer.invoke('notes:aiBusy'),
  },
  ai: {
    summarize: (id) => ipcRenderer.invoke('ai:summarize', id),
    organize: () => ipcRenderer.invoke('ai:organize'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    setKey: (key) => ipcRenderer.invoke('settings:setKey', key),
    setAutoSummarize: (on) => ipcRenderer.invoke('settings:setAutoSummarize', on),
  },
  onNoteChanged: (fn) => ipcRenderer.on('notes:changed', (_e, p) => fn(p)),
  onAiStatus: (fn) => ipcRenderer.on('ai:status', (_e, p) => fn(p)),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  // Main asks the renderer to save pending edits before the window closes.
  onFlushRequest: (fn) => ipcRenderer.on('app:flush', async () => {
    try { await fn(); } catch { /* close anyway */ } finally { ipcRenderer.send('app:flushed'); }
  }),
});
