// Bridge between the renderer and the main process. This is the IPC contract:
//
//   NoteSummary = { id, title, url, dateGathered, siteName, subject, pinnedSubject, userTags, highlights }
//                 (dateGathered: ISO 8601; subject: inferred or pinned; pinnedSubject: '' when automatic;
//                  userTags: the user's own tags; highlights: text of each <mark> in the body)
//   Note        = { id, title, url, dateGathered, siteName, tags, userTags, subject, content, archive, summary, summarySource, topics }
//                 (tags: from the page, not shown; content: sanitized HTML body, highlights are <mark>;
//                  archive: { savedAt, bytes } or null when there is no offline copy;
//                  summarySource: 'ai' | 'local' | ''; topics: AI subject labels)
//   The offline copy of a note is served at gatherer-asset://<id>/page.html (scripts and network blocked).
//   Settings    = { hasKey, keySource: 'settings'|'environment'|'', keyHint, autoSummarize,
//                   reddit: { hasKey, source: 'settings'|'environment'|'', hint } }
//
//   notes.list()             -> NoteSummary[]  newest first
//   notes.get(id)            -> Note
//   notes.search(query)      -> SearchResult[] best first; SearchResult = NoteSummary (without subject) +
//                               { score, hits, titleRanges, snippet, snippetRanges }
//                               (ranges: [[start, end], ...] character offsets of matches in title / snippet)
//   notes.create(url)        -> Note           scrapes url, saves, returns new note
//   notes.save(id, {title, content}) -> NoteSummary
//   notes.setSubject(id, subject) -> NoteSummary  pin a subject; '' returns it to automatic
//   notes.archive(id)        -> Note           fetches the source again and saves a fresh offline copy
//   notes.setTags(id, tags)  -> NoteSummary  replace the user's tags on a note
//   tags.rename(from, to)    -> number         rename/merge a tag on every note; '' removes it
//   notes.delete(id)         -> true
//   capture.listen(fn)       -> Promise<{ bookmarklet }>  fn({ url, title }) is called for each page
//                               sent from the browser (gatherer://add?url=…), including ones that
//                               arrived before the window loaded
//   notes.aiBusy()           -> id[]           notes whose AI summary is being written
//   ai.summarize(id)         -> Note           (re)write the AI summary and subject labels
//   ai.organize()            -> NoteSummary[]  regroup all automatic notes by meaning
//   settings.get() / setKey(key) / setAutoSummarize(bool) -> Settings   ('' key removes it)
//   settings.setReddit({ clientId, secret }) -> Settings   ('' clientId removes it)
//   onNoteChanged(fn({id}))  the AI updated one note in the background
//   onAiStatus(fn({id, busy, error?}))
//   onNotesChanged(fn)       fn(ids) after sync or File > Import Notes changed, added or removed notes
//                            (ids may be empty when the import doesn't say which)
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
    search: (query) => ipcRenderer.invoke('notes:search', query),
    create: (url) => ipcRenderer.invoke('notes:create', url),
    save: (id, data) => ipcRenderer.invoke('notes:save', id, data),
    setSubject: (id, subject) => ipcRenderer.invoke('notes:setSubject', id, subject),
    archive: (id) => ipcRenderer.invoke('notes:archive', id),
    setTags: (id, tags) => ipcRenderer.invoke('notes:setTags', id, tags),
    delete: (id) => ipcRenderer.invoke('notes:delete', id),
    aiBusy: () => ipcRenderer.invoke('notes:aiBusy'),
  },
  capture: {
    listen: (fn) => {
      ipcRenderer.on('capture:page', (_e, item) => fn(item));
      return ipcRenderer.invoke('capture:ready');
    },
  },
  tags: {
    rename: (from, to) => ipcRenderer.invoke('tags:rename', from, to),
  },
  ai: {
    summarize: (id) => ipcRenderer.invoke('ai:summarize', id),
    organize: () => ipcRenderer.invoke('ai:organize'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    setKey: (key) => ipcRenderer.invoke('settings:setKey', key),
    setAutoSummarize: (on) => ipcRenderer.invoke('settings:setAutoSummarize', on),
    setReddit: (creds) => ipcRenderer.invoke('settings:setReddit', creds),
  },
  // notes:changed carries { id } from the AI, an id[] from sync, and nothing from an import.
  onNoteChanged: (fn) => ipcRenderer.on('notes:changed', (_e, p) => { if (p && !Array.isArray(p) && p.id) fn(p); }),
  onNotesChanged: (fn) => ipcRenderer.on('notes:changed', (_e, p) => { if (!p || Array.isArray(p)) fn(p || []); }),
  onAiStatus: (fn) => ipcRenderer.on('ai:status', (_e, p) => fn(p)),
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
