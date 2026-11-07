(() => {
  const api = window.gatherer;
  const $ = (id) => document.getElementById(id);
  const el = {
    list: $('list'), listEmpty: $('list-empty'), filter: $('filter'),
    empty: $('empty-state'), view: $('note-view'), title: $('title'), editor: $('editor'),
    date: $('meta-date'), url: $('meta-url'), status: $('save-status'),
    block: $('block-select'), toolbar: $('toolbar'),
    modal: $('modal'), form: $('modal-form'), urlInput: $('url-input'),
    err: $('modal-error'), busy: $('modal-busy'), go: $('modal-go'), cancel: $('modal-cancel'),
    linkPop: $('link-pop'), linkInput: $('link-input'),
    delBtn: $('delete-btn'), delConfirm: $('delete-confirm'),
    organize: $('organize'), chip: $('subject-chip'), subjForm: $('subject-form'),
    subjInput: $('subject-input'), subjOptions: $('subject-options'),
    copyBm: $('copy-bookmarklet'),
  };

  let notes = [];
  let current = null; // { id, ... }
  let dirty = false;
  let timer = null;
  let saving = Promise.resolve();
  let savedRange = null;

  const fmtDate = (iso, opts) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString(undefined, opts); };
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u || ''; } };

  /* ---------- organizing ---------- */
  // Small per-device preferences: which grouping is active and which groups are collapsed.
  const prefs = (() => {
    let p = {};
    try { p = JSON.parse(localStorage.getItem('gatherer:organize') || '{}') || {}; } catch {}
    if (!['subject', 'source', 'date'].includes(p.mode)) p.mode = 'subject';
    if (!p.collapsed || typeof p.collapsed !== 'object') p.collapsed = {};
    return p;
  })();
  const savePrefs = () => { try { localStorage.setItem('gatherer:organize', JSON.stringify(prefs)); } catch {} };
  const OTHER = 'Other';

  function dateBucket(iso, now) {
    const d = new Date(iso);
    if (isNaN(d)) return { key: 'z', label: 'Undated' };
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff <= 0) return { key: '0', label: 'Today' };
    if (diff === 1) return { key: '1', label: 'Yesterday' };
    if (diff < 7) return { key: '2', label: 'Previous 7 days' };
    if (diff < 30) return { key: '3', label: 'Previous 30 days' };
    const label = d.toLocaleDateString(undefined, { month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
    return { key: `4-${9999 - d.getFullYear()}-${String(99 - d.getMonth()).padStart(2, '0')}`, label };
  }

  // -> [{ key, label, notes }] in display order. `notes` is already newest first.
  function groupNotes(list, mode) {
    const groups = new Map();
    const add = (key, label, n) => {
      let g = groups.get(key); if (!g) groups.set(key, (g = { key, label, notes: [] }));
      g.notes.push(n);
    };
    const now = new Date();
    if (mode === 'date') {
      for (const n of list) { const b = dateBucket(n.dateGathered, now); add(b.key, b.label, n); }
      return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
    }
    if (mode === 'source') {
      // Prefer the site's own name ("The Verge") over its host when the page declared one.
      const names = new Map();
      for (const n of list) {
        const h = host(n.url) || '';
        if (n.siteName) { const m = names.get(h) || new Map(); m.set(n.siteName, (m.get(n.siteName) || 0) + 1); names.set(h, m); }
      }
      for (const n of list) {
        const h = host(n.url);
        const m = names.get(h);
        const label = h ? (m ? [...m].sort((a, b) => b[1] - a[1])[0][0] : h) : 'No source';
        add(h || '~', label, n);
      }
    } else {
      for (const n of list) { const s = n.subject || OTHER; add(s.toLowerCase(), s, n); }
    }
    const last = (g) => (g.label === OTHER || g.key === '~' ? 1 : 0);
    return [...groups.values()].sort((a, b) => last(a) - last(b) || b.notes.length - a.notes.length || a.label.localeCompare(b.label));
  }

  const collapsedKey = (g) => `${prefs.mode}:${g.key}`;

  function setMode(mode) {
    prefs.mode = mode; savePrefs();
    el.organize.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
    renderList();
    const sel = el.list.querySelector('li.note.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
  el.organize.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); });

  /* ---------- list ---------- */
  function noteItem(n) {
    const li = document.createElement('li');
    li.className = 'note'; li.dataset.id = n.id;
    if (current && current.id === n.id) li.classList.add('selected');
    if (prefs.mode === 'subject') li.draggable = true;
    const t = document.createElement('div'); t.className = 't'; t.textContent = n.title || 'Untitled';
    const s = document.createElement('div'); s.className = 's';
    const a = document.createElement('span');
    const b = document.createElement('span');
    // Show whatever the grouping doesn't already say.
    if (prefs.mode === 'source') { a.textContent = n.subject && n.subject !== OTHER ? n.subject : ''; }
    else a.textContent = n.siteName || host(n.url);
    b.textContent = prefs.mode === 'date' ? fmtDate(n.dateGathered, { timeStyle: 'short' }) : fmtDate(n.dateGathered, { dateStyle: 'short' });
    if (prefs.mode === 'date' && !/^[0-1]$/.test(dateBucket(n.dateGathered, new Date()).key)) b.textContent = fmtDate(n.dateGathered, { month: 'short', day: 'numeric' });
    s.append(a, b); li.append(t, s);
    return li;
  }

  function renderList() {
    const q = el.filter.value.trim().toLowerCase();
    const match = (n) => !q || [n.title, n.url, n.siteName, n.subject].some((v) => (v || '').toLowerCase().includes(q));
    const shown = notes.filter(match);
    const scroll = el.list.scrollTop;
    el.list.textContent = '';
    for (const g of groupNotes(shown, prefs.mode)) {
      const open = !!q || !prefs.collapsed[collapsedKey(g)];
      const li = document.createElement('li');
      li.className = 'group' + (open ? ' open' : '');
      li.dataset.key = g.key; li.dataset.label = g.label;
      const btn = document.createElement('button');
      btn.className = 'gh'; btn.type = 'button'; btn.setAttribute('aria-expanded', String(open));
      btn.innerHTML = '<span class="chev">&#9654;</span><span class="name"></span><span class="n"></span>';
      btn.querySelector('.name').textContent = g.label;
      btn.querySelector('.n').textContent = g.notes.length;
      btn.title = g.label;
      li.appendChild(btn);
      el.list.appendChild(li);
      if (open) for (const n of g.notes) el.list.appendChild(noteItem(n));
    }
    el.list.scrollTop = scroll;
    el.listEmpty.hidden = shown.length > 0;
    el.listEmpty.textContent = notes.length ? 'No matching notes.' : 'No notes yet.';
    renderSubjectChip();
  }

  async function refreshList() { notes = await api.notes.list(); renderList(); }

  /* ---------- saving ---------- */
  function setStatus(s) { el.status.textContent = s; }
  function markDirty() {
    if (!current) return;
    dirty = true; setStatus('Saving…');
    clearTimeout(timer); timer = setTimeout(flush, 800);
  }
  function flush() {
    clearTimeout(timer); timer = null;
    if (!dirty || !current) return saving;
    dirty = false;
    const id = current.id;
    const data = { title: el.title.textContent.trim(), content: el.editor.innerHTML };
    saving = saving.then(() => api.notes.save(id, data)).then((sum) => {
      const i = notes.findIndex((n) => n.id === id);
      if (i >= 0 && sum) notes[i] = { ...notes[i], ...sum }; else if (i >= 0) notes[i].title = data.title;
      renderList();
      if (!dirty) setStatus('Saved');
    }).catch((e) => { dirty = true; setStatus('Save failed: ' + (e && e.message || e)); });
    return saving;
  }

  /* ---------- open note ---------- */
  async function openNote(id) {
    await flush();
    let note;
    try { note = await api.notes.get(id); } catch (e) { setStatus(String(e.message || e)); return; }
    current = note; dirty = false;
    el.empty.hidden = true; el.view.hidden = false;
    el.title.textContent = note.title || '';
    el.editor.innerHTML = note.content || '';
    el.date.textContent = fmtDate(note.dateGathered);
    el.url.textContent = note.url || ''; el.url.dataset.url = note.url || '';
    el.url.title = note.url || '';
    setStatus(''); cancelDelete(); hideLink(); hideSubjectEdit();
    revealCurrent();
    document.getElementById('scroller').scrollTop = 0;
    renderList();
  }

  // Expand the group that holds the open note so the selection is never hidden.
  function revealCurrent() {
    if (!current) return;
    const n = notes.find((x) => x.id === current.id);
    if (!n) return;
    const g = groupNotes([n], prefs.mode)[0];
    if (g && prefs.collapsed[collapsedKey(g)]) { delete prefs.collapsed[collapsedKey(g)]; savePrefs(); }
  }

  /* ---------- subject chip ---------- */
  function renderSubjectChip() {
    if (!current) return;
    const n = notes.find((x) => x.id === current.id);
    const subject = (n && n.subject) || OTHER;
    const pinned = !!(n && n.pinnedSubject);
    el.chip.textContent = subject;
    if (!pinned) { const s = document.createElement('span'); s.className = 'auto'; s.textContent = 'auto'; el.chip.appendChild(s); }
    el.chip.title = pinned ? 'You chose this subject. Click to change, or clear it to let Gatherer decide.' : 'Gatherer picked this subject automatically. Click to choose your own.';
  }
  function showSubjectEdit() {
    const n = notes.find((x) => x.id === current.id);
    el.subjOptions.textContent = '';
    for (const s of [...new Set(notes.map((x) => x.subject).filter((s) => s && s !== OTHER))].sort()) {
      const o = document.createElement('option'); o.value = s; el.subjOptions.appendChild(o);
    }
    el.subjInput.value = (n && n.pinnedSubject) || '';
    el.subjInput.placeholder = n && !n.pinnedSubject && n.subject !== OTHER ? `Automatic (${n.subject})` : 'Automatic';
    el.chip.hidden = true; el.subjForm.hidden = false; el.subjInput.focus(); el.subjInput.select();
  }
  function hideSubjectEdit() { el.subjForm.hidden = true; el.chip.hidden = false; }
  async function setSubject(id, subject) {
    try {
      await flush();
      await api.notes.setSubject(id, subject);
      await refreshList();
    } catch (e) { setStatus(String(e.message || e)); }
  }
  let subjCommitting = false;
  async function commitSubject() {
    if (subjCommitting || el.subjForm.hidden || !current) return;
    subjCommitting = true;
    const val = el.subjInput.value.trim();
    const n = notes.find((x) => x.id === current.id);
    hideSubjectEdit();
    if (n && val !== (n.pinnedSubject || '')) { await setSubject(current.id, val === OTHER ? '' : val); revealCurrent(); renderList(); }
    subjCommitting = false;
  }
  el.chip.addEventListener('click', showSubjectEdit);
  el.subjForm.addEventListener('submit', (e) => { e.preventDefault(); commitSubject(); });
  el.subjInput.addEventListener('blur', commitSubject);
  el.subjInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); hideSubjectEdit(); } });

  function showEmpty() {
    current = null; el.view.hidden = true; el.empty.hidden = false; renderList();
  }

  /* ---------- editor / toolbar ---------- */
  el.title.addEventListener('input', markDirty);
  el.title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.editor.focus(); } });
  el.editor.addEventListener('input', markDirty);
  el.editor.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });
  el.title.addEventListener('paste', (e) => {
    e.preventDefault();
    document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').replace(/\s+/g, ' '));
  });
  el.editor.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    if ((e.metaKey || e.ctrlKey) && a.href) api.openExternal(a.href);
  });
  el.url.addEventListener('click', (e) => { e.preventDefault(); if (el.url.dataset.url) api.openExternal(el.url.dataset.url); });

  function exec(cmd, val) { el.editor.focus(); document.execCommand(cmd, false, val); markDirty(); updateState(); }

  const inEditor = () => { const s = getSelection(); return s.rangeCount && el.editor.contains(s.anchorNode); };

  function toggleBlock(tag) {
    const cur = (document.queryCommandValue('formatBlock') || '').toLowerCase().replace(/[<>]/g, '');
    exec('formatBlock', cur === tag ? 'p' : tag);
  }

  el.toolbar.addEventListener('mousedown', (e) => {
    // keep editor selection when clicking buttons
    if (e.target.closest('button') && !e.target.closest('#link-pop')) e.preventDefault();
  });
  el.toolbar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.cmd) return exec(b.dataset.cmd);
    switch (b.dataset.act) {
      case 'blockquote': return toggleBlock('blockquote');
      case 'code': return toggleBlock('pre');
      case 'link': return showLink();
    }
  });
  el.block.addEventListener('change', () => {
    exec('formatBlock', el.block.value);
  });

  function updateState() {
    if (el.view.hidden || !inEditor()) return;
    el.toolbar.querySelectorAll('[data-cmd]').forEach((b) => {
      let on = false;
      try { on = document.queryCommandState(b.dataset.cmd); } catch {}
      if (['unlink', 'removeFormat', 'undo', 'redo'].includes(b.dataset.cmd)) on = false;
      b.classList.toggle('active', on);
    });
    const v = (document.queryCommandValue('formatBlock') || '').toLowerCase().replace(/[<>]/g, '');
    el.block.value = ['h1', 'h2', 'h3'].includes(v) ? v : 'p';
    toolbarBlock('blockquote', v === 'blockquote'); toolbarBlock('code', v === 'pre');
    const a = getSelection().anchorNode;
    document.getElementById('link-btn').classList.toggle('active', !!(a && (a.nodeType === 1 ? a : a.parentElement).closest('#editor a')));
  }
  function toolbarBlock(act, on) { el.toolbar.querySelector(`[data-act="${act}"]`).classList.toggle('active', on); }
  document.addEventListener('selectionchange', updateState);

  /* link popover */
  function showLink() {
    if (!inEditor()) el.editor.focus();
    const s = getSelection();
    savedRange = s.rangeCount ? s.getRangeAt(0).cloneRange() : null;
    const a = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement).closest('a');
    el.linkInput.value = a ? a.getAttribute('href') : '';
    el.linkPop.hidden = false; el.linkInput.focus(); el.linkInput.select();
  }
  function hideLink() { el.linkPop.hidden = true; }
  el.linkPop.addEventListener('submit', (e) => {
    e.preventDefault();
    let u = el.linkInput.value.trim();
    hideLink();
    el.editor.focus();
    if (savedRange) { const s = getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
    if (!u) return;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
    if (getSelection().isCollapsed) document.execCommand('insertHTML', false, `<a href="${u.replace(/"/g, '&quot;')}">${u.replace(/</g, '&lt;')}</a>`);
    else document.execCommand('createLink', false, u);
    markDirty();
  });
  $('link-cancel').addEventListener('click', () => { hideLink(); el.editor.focus(); });
  el.linkInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideLink(); el.editor.focus(); } });

  /* delete */
  function cancelDelete() { el.delConfirm.hidden = true; el.delBtn.hidden = false; }
  el.delBtn.addEventListener('click', () => { el.delBtn.hidden = true; el.delConfirm.hidden = false; });
  $('delete-no').addEventListener('click', cancelDelete);
  $('delete-yes').addEventListener('click', async () => {
    if (!current) return;
    const id = current.id;
    clearTimeout(timer); dirty = false;
    try { await saving; await api.notes.delete(id); } catch (e) { setStatus(String(e.message || e)); cancelDelete(); return; }
    notes = notes.filter((n) => n.id !== id);
    cancelDelete(); current = null;
    if (notes.length) openNote(notes[0].id); else showEmpty();
  });

  /* ---------- list interactions ---------- */
  el.list.addEventListener('click', (e) => {
    const gh = e.target.closest('.gh');
    if (gh) {
      const k = `${prefs.mode}:${gh.parentElement.dataset.key}`;
      if (gh.parentElement.classList.contains('open')) prefs.collapsed[k] = true; else delete prefs.collapsed[k];
      savePrefs(); renderList(); return;
    }
    const li = e.target.closest('li.note');
    if (li && !(current && current.id === li.dataset.id)) openNote(li.dataset.id);
  });

  // Up/Down moves between visible notes, wherever focus is in the sidebar (except the filter box).
  document.getElementById('sidebar').addEventListener('keydown', (e) => {
    if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.target === el.filter) return;
    const items = [...el.list.querySelectorAll('li.note')];
    if (!items.length) return;
    e.preventDefault();
    const i = items.findIndex((x) => x.classList.contains('selected'));
    const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next && next.dataset.id !== (current && current.id)) { openNote(next.dataset.id).then(() => { const s = el.list.querySelector('li.note.selected'); if (s) s.scrollIntoView({ block: 'nearest' }); }); }
  });

  // In Subject view, drag a note onto another subject's header to move it there.
  let dragId = null;
  el.list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li.note');
    if (!li || prefs.mode !== 'subject') return;
    dragId = li.dataset.id; li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId);
  });
  el.list.addEventListener('dragend', () => {
    dragId = null;
    el.list.querySelectorAll('.dragging,.drop').forEach((x) => x.classList.remove('dragging', 'drop'));
  });
  const dropTarget = (e) => {
    if (!dragId) return null;
    const li = e.target.closest('li');
    if (!li) return null;
    if (li.classList.contains('group')) return li;
    // Dropping onto any note inside a group counts as dropping onto that group.
    let p = li.previousElementSibling;
    while (p && !p.classList.contains('group')) p = p.previousElementSibling;
    return p;
  };
  el.list.addEventListener('dragover', (e) => {
    const g = dropTarget(e);
    el.list.querySelectorAll('.drop').forEach((x) => x !== g && x.classList.remove('drop'));
    if (!g) return;
    e.preventDefault(); g.classList.add('drop');
  });
  el.list.addEventListener('drop', async (e) => {
    const g = dropTarget(e);
    if (!g) return;
    e.preventDefault();
    const id = dragId; dragId = null;
    const n = notes.find((x) => x.id === id);
    if (!n || (n.subject || OTHER) === g.dataset.label) { renderList(); return; }
    await setSubject(id, g.dataset.label === OTHER ? '' : g.dataset.label);
  });
  el.filter.addEventListener('input', renderList);

  /* ---------- modal ---------- */
  let busy = false;
  function openModal() {
    el.err.hidden = true; el.busy.hidden = true; el.urlInput.value = '';
    el.urlInput.disabled = el.go.disabled = false;
    el.modal.hidden = false; el.urlInput.focus();
  }
  function closeModal() { if (!busy) el.modal.hidden = true; }
  $('new-btn').addEventListener('click', openModal);
  $('empty-new').addEventListener('click', openModal);
  el.cancel.addEventListener('click', closeModal);
  el.modal.addEventListener('mousedown', (e) => { if (e.target === el.modal) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.modal.hidden) closeModal(); });
  // Gather a page through the modal so progress and errors show in one place.
  async function gather(u) {
    if (busy) return false;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
    el.modal.hidden = false; el.urlInput.value = u;
    busy = true; el.err.hidden = true; el.busy.hidden = false;
    el.urlInput.disabled = el.go.disabled = true;
    try {
      await flush();
      const note = await api.notes.create(u);
      busy = false; el.modal.hidden = true;
      await refreshList();
      await openNote(note.id);
      return true;
    } catch (err) {
      busy = false;
      el.busy.hidden = true; el.urlInput.disabled = el.go.disabled = false;
      el.err.textContent = String((err && err.message) || err).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
      el.err.hidden = false; el.urlInput.focus();
      return false;
    } finally {
      setTimeout(nextCapture, 0);
    }
  }
  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const u = el.urlInput.value.trim();
    if (u) gather(u);
  });

  /* ---------- one-click capture ---------- */
  // Pages arrive from the browser extension or bookmarklet (gatherer://add?url=…),
  // or by dropping a link from a browser onto the window.
  const captureQueue = [];
  const sameUrl = (a, b) => { try { return new URL(a).href === new URL(b).href; } catch { return a === b; } };
  function captureUrl(url) {
    if (!url || captureQueue.some((u) => sameUrl(u, url))) return;
    captureQueue.push(url);
    nextCapture();
  }
  async function nextCapture() {
    if (busy || !captureQueue.length) return;
    const url = captureQueue.shift();
    const existing = notes.find((n) => sameUrl(n.url, url));
    if (existing) {
      el.modal.hidden = true;
      await openNote(existing.id);
      setStatus('Already gathered');
      nextCapture();
      return;
    }
    gather(url);
  }

  const droppedUrl = (dt) => {
    const list = (dt.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
    const raw = (list || dt.getData('text/plain') || '').trim();
    return /^https?:\/\/\S+$/i.test(raw) ? raw : null;
  };
  const isLinkDrag = (e) => !dragId && !el.editor.contains(e.target) && !e.target.closest('input, [contenteditable="true"]')
    && [...e.dataTransfer.types].includes('text/uri-list');
  document.addEventListener('dragover', (e) => {
    if (!isLinkDrag(e)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    document.body.classList.add('link-drop');
  });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('link-drop'); });
  document.addEventListener('drop', (e) => {
    document.body.classList.remove('link-drop');
    if (!isLinkDrag(e)) return;
    e.preventDefault();
    const url = droppedUrl(e.dataTransfer);
    if (url) captureUrl(url);
  });

  let bookmarklet = '';
  el.copyBm.addEventListener('click', async () => {
    if (!bookmarklet) return;
    try { await navigator.clipboard.writeText(bookmarklet); el.copyBm.textContent = 'Copied'; }
    catch { el.copyBm.textContent = 'Could not copy'; }
    setTimeout(() => { el.copyBm.textContent = 'Copy bookmarklet'; }, 2000);
  });

  /* ---------- lifecycle ---------- */
  window.addEventListener('beforeunload', () => { flush(); });
  api.onFlushRequest(() => flush());
  window.addEventListener('blur', () => { if (dirty) flush(); });

  (async () => {
    setMode(prefs.mode);
    try { await refreshList(); } catch (e) { el.listEmpty.textContent = String(e.message || e); el.listEmpty.hidden = false; }
    if (notes.length) openNote(notes[0].id); else showEmpty();
    try {
      const info = await api.capture.listen((item) => captureUrl(item && item.url));
      bookmarklet = (info && info.bookmarklet) || '';
    } catch (e) { console.warn('capture unavailable', e); }
  })();
})();
