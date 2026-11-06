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
  };

  let notes = [];
  let current = null; // { id, ... }
  let dirty = false;
  let timer = null;
  let saving = Promise.resolve();
  let savedRange = null;

  const fmtDate = (iso, opts) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString(undefined, opts); };
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u || ''; } };

  /* ---------- list ---------- */
  function renderList() {
    const q = el.filter.value.trim().toLowerCase();
    const shown = notes.filter((n) => !q || (n.title || '').toLowerCase().includes(q) || (n.url || '').toLowerCase().includes(q));
    el.list.textContent = '';
    for (const n of shown) {
      const li = document.createElement('li');
      li.dataset.id = n.id;
      if (current && current.id === n.id) li.className = 'selected';
      const t = document.createElement('div'); t.className = 't'; t.textContent = n.title || 'Untitled';
      const s = document.createElement('div'); s.className = 's';
      const a = document.createElement('span'); a.textContent = host(n.url);
      const b = document.createElement('span'); b.textContent = fmtDate(n.dateGathered, { dateStyle: 'short' });
      s.append(a, b); li.append(t, s);
      el.list.appendChild(li);
    }
    el.listEmpty.hidden = shown.length > 0;
    el.listEmpty.textContent = notes.length ? 'No matching notes.' : 'No notes yet.';
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
    setStatus(''); cancelDelete(); hideLink();
    document.getElementById('scroller').scrollTop = 0;
    renderList();
  }

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
    const li = e.target.closest('li');
    if (li && !(current && current.id === li.dataset.id)) openNote(li.dataset.id);
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
  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let u = el.urlInput.value.trim();
    if (!u || busy) return;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
    busy = true; el.err.hidden = true; el.busy.hidden = false;
    el.urlInput.disabled = el.go.disabled = true;
    try {
      await flush();
      const note = await api.notes.create(u);
      busy = false; el.modal.hidden = true;
      await refreshList();
      await openNote(note.id);
    } catch (err) {
      busy = false;
      el.busy.hidden = true; el.urlInput.disabled = el.go.disabled = false;
      el.err.textContent = String((err && err.message) || err).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
      el.err.hidden = false; el.urlInput.focus();
    }
  });

  /* ---------- lifecycle ---------- */
  window.addEventListener('beforeunload', () => { flush(); });
  window.addEventListener('blur', () => { if (dirty) flush(); });

  (async () => {
    try { await refreshList(); } catch (e) { el.listEmpty.textContent = String(e.message || e); el.listEmpty.hidden = false; }
    if (notes.length) openNote(notes[0].id); else showEmpty();
  })();
})();
