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
    tagList: $('tag-list'), tagInput: $('tag-input'), tagOptions: $('tag-options'),
    hlWrap: $('hl-wrap'), hlCount: $('hl-count'), hlPanel: $('hl-panel'),
    bubble: $('hl-bubble'), bubbleBtn: $('hl-bubble-btn'), hlBtn: $('hl-btn'),
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
    if (!['subject', 'source', 'date', 'tag'].includes(p.mode)) p.mode = 'subject';
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
    if (mode === 'tag') {
      // A note with several tags shows under each of them.
      const UNTAGGED = '~untagged';
      for (const n of list) {
        const tags = n.userTags || [];
        if (!tags.length) add(UNTAGGED, 'Untagged', n);
        for (const t of tags) add('tag:' + t.toLowerCase(), t, n);
      }
      const label = new Map();
      // Use the most common spelling of a tag as its label.
      for (const g of groups.values()) {
        if (g.key === UNTAGGED) continue;
        const c = new Map();
        for (const n of g.notes) for (const t of n.userTags) if ('tag:' + t.toLowerCase() === g.key) c.set(t, (c.get(t) || 0) + 1);
        label.set(g.key, [...c].sort((a, b) => b[1] - a[1])[0][0]);
      }
      for (const g of groups.values()) if (label.has(g.key)) g.label = label.get(g.key);
      return [...groups.values()].sort((a, b) => (a.key === UNTAGGED) - (b.key === UNTAGGED) || b.notes.length - a.notes.length || a.label.localeCompare(b.label));
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
    if (prefs.mode === 'subject' || prefs.mode === 'tag') li.draggable = true;
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
    if (n.userTags && n.userTags.length) {
      const tg = document.createElement('div'); tg.className = 'tg';
      tg.textContent = n.userTags.map((x) => '#' + x).join('  ');
      li.appendChild(tg);
    }
    return li;
  }

  function renderList() {
    const q = el.filter.value.trim().toLowerCase();
    // "#tag" words must match one of the note's tags; other words match title, source, subject, tags or highlights.
    const words = q.split(/\s+/).filter(Boolean);
    const tagWords = words.filter((w) => w.startsWith('#') && w.length > 1).map((w) => w.slice(1));
    const text = words.filter((w) => !w.startsWith('#')).join(' ');
    const match = (n) => {
      const tags = (n.userTags || []).map((t) => t.toLowerCase());
      if (!tagWords.every((w) => tags.some((t) => t === w || t.replace(/\s+/g, '-') === w))) return false;
      return !text || [n.title, n.url, n.siteName, n.subject, ...(n.userTags || []), ...(n.highlights || [])].some((v) => (v || '').toLowerCase().includes(text));
    };
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
      if (prefs.mode === 'tag' && g.key.startsWith('tag:')) {
        const ren = document.createElement('span');
        ren.className = 'ren'; ren.textContent = '✎'; ren.title = `Rename ${g.label} on every note`;
        btn.insertBefore(ren, btn.querySelector('.n'));
      }
      li.appendChild(btn);
      el.list.appendChild(li);
      if (open) for (const n of g.notes) el.list.appendChild(noteItem(n));
    }
    el.list.scrollTop = scroll;
    el.listEmpty.hidden = shown.length > 0;
    el.listEmpty.textContent = notes.length ? 'No matching notes.' : 'No notes yet.';
    renderSubjectChip();
    renderTags();
  }

  async function refreshList() { notes = await api.notes.list(); renderList(); }

  /* ---------- saving ---------- */
  function setStatus(s) { el.status.textContent = s; }
  function markDirty() {
    if (!current) return;
    dirty = true; setStatus('Saving…');
    scheduleHighlights();
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
    setStatus(''); cancelDelete(); hideLink(); hideSubjectEdit(); hideBubble();
    el.tagInput.value = ''; el.hlPanel.hidden = true;
    renderHighlights();
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

  /* ---------- tags ---------- */
  const currentSummary = () => current && notes.find((x) => x.id === current.id);
  const allTags = () => {
    const m = new Map();
    for (const n of notes) for (const t of n.userTags || []) { const k = t.toLowerCase(); if (!m.has(k)) m.set(k, t); }
    return [...m.values()].sort((a, b) => a.localeCompare(b));
  };
  const tagFilterWord = (t) => '#' + t.toLowerCase().replace(/\s+/g, '-');

  function renderTags() {
    if (!current) return;
    const n = currentSummary();
    const tags = (n && n.userTags) || [];
    el.tagList.textContent = '';
    for (const t of tags) {
      const chip = document.createElement('span'); chip.className = 'tag';
      const name = document.createElement('button'); name.type = 'button'; name.className = 'tag-name';
      name.textContent = t; name.title = `Show notes tagged ${t}`; name.dataset.tag = t;
      const x = document.createElement('button'); x.type = 'button'; x.className = 'tag-x';
      x.textContent = '×'; x.title = `Remove ${t}`; x.setAttribute('aria-label', `Remove tag ${t}`); x.dataset.remove = t;
      chip.append(name, x); el.tagList.appendChild(chip);
    }
    el.tagInput.placeholder = tags.length ? '+' : 'Add tag…';
    const have = new Set(tags.map((t) => t.toLowerCase()));
    el.tagOptions.textContent = '';
    for (const t of allTags()) if (!have.has(t.toLowerCase())) { const o = document.createElement('option'); o.value = t; el.tagOptions.appendChild(o); }
  }

  async function setTags(id, tags) {
    try {
      await flush();
      saving = saving.then(() => api.notes.setTags(id, tags));
      await saving;
      await refreshList();
    } catch (e) { setStatus(String(e.message || e)); saving = Promise.resolve(); }
  }
  // Reuse an existing tag's spelling so "ML" and "ml" don't become two tags.
  function addTags(raw) {
    const n = currentSummary();
    if (!n) return;
    const known = new Map(allTags().map((t) => [t.toLowerCase(), t]));
    const cur = [...(n.userTags || [])];
    const have = new Set(cur.map((t) => t.toLowerCase()));
    for (let t of String(raw).split(',')) {
      t = t.replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!t || have.has(t.toLowerCase())) continue;
      t = known.get(t.toLowerCase()) || t;
      have.add(t.toLowerCase()); cur.push(t);
    }
    if (cur.length !== (n.userTags || []).length) return setTags(n.id, cur);
  }
  function removeTag(tag) {
    const n = currentSummary();
    if (n) return setTags(n.id, (n.userTags || []).filter((t) => t !== tag));
  }
  function commitTagInput() {
    const v = el.tagInput.value;
    el.tagInput.value = '';
    if (v.trim()) addTags(v);
  }
  el.tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || (e.key === ',' && !e.isComposing)) { e.preventDefault(); commitTagInput(); }
    else if (e.key === 'Backspace' && !el.tagInput.value) {
      const n = currentSummary();
      if (n && n.userTags && n.userTags.length) { e.preventDefault(); removeTag(n.userTags[n.userTags.length - 1]); }
    } else if (e.key === 'Escape') { el.tagInput.value = ''; el.tagInput.blur(); }
  });
  // Picking a suggestion from the list adds it straight away.
  el.tagInput.addEventListener('input', (e) => {
    if (e.inputType === 'insertReplacementText' || (!e.inputType && [...el.tagOptions.options].some((o) => o.value === el.tagInput.value))) commitTagInput();
  });
  el.tagInput.addEventListener('blur', commitTagInput);
  el.tagList.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.remove) return removeTag(b.dataset.remove);
    if (b.dataset.tag) { el.filter.value = tagFilterWord(b.dataset.tag); renderList(); }
  });

  // Tags view: the pencil on a tag's header renames it on every note (or merges it into another tag).
  function renameTagAt(gh) {
    const li = gh.parentElement;
    const from = li.dataset.label;
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'rename'; input.value = from; input.maxLength = 40;
    gh.hidden = true; li.appendChild(input); input.focus(); input.select();
    let done = false;
    const finish = async (commit) => {
      if (done) return; done = true;
      const to = input.value.replace(/^#+/, '').replace(/\s+/g, ' ').trim();
      input.remove(); gh.hidden = false;
      if (!commit || !to || to === from) return;
      const existing = allTags().find((t) => t.toLowerCase() === to.toLowerCase() && t.toLowerCase() !== from.toLowerCase());
      try {
        await flush();
        await api.tags.rename(from, existing || to);
        const k = `tag:tag:${from.toLowerCase()}`;
        if (prefs.collapsed[k]) { delete prefs.collapsed[k]; savePrefs(); }
        await refreshList();
      } catch (err) { setStatus(String(err.message || err)); }
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (ev) => ev.stopPropagation());
  }

  /* ---------- highlights ---------- */
  // Highlights are <mark> elements around the passage. Selecting text shows a small
  // "Highlight" button; clicking a highlight offers to remove it.
  const BLOCKISH = /^(UL|OL|LI|TABLE|THEAD|TBODY|TFOOT|TR|DL|DIV|SECTION|ARTICLE|BLOCKQUOTE|FIGURE)$/;
  const markOf = (node) => { const e = node && (node.nodeType === 1 ? node : node.parentElement); return e && el.editor.contains(e) ? e.closest('mark') : null; };

  // Text nodes the range touches, each with the part of it that is selected.
  function selectedTextParts(range) {
    const parts = [];
    const root = range.commonAncestorContainer;
    const push = (t) => {
      const start = t === range.startContainer ? range.startOffset : 0;
      const end = t === range.endContainer ? range.endOffset : t.data.length;
      if (end <= start) return;
      // Whitespace between blocks (e.g. between list items) must not be wrapped.
      if (!t.data.slice(start, end).trim() && t.parentElement && (t.parentElement === el.editor || BLOCKISH.test(t.parentElement.tagName))) return;
      parts.push({ t, start, end });
    };
    if (root.nodeType === 3) { push(root); return parts; }
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) if (range.intersectsNode(t)) push(t);
    return parts;
  }

  function unwrap(m) {
    const p = m.parentNode;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    m.remove(); p.normalize();
  }

  function mergeAdjacentMarks() {
    for (const m of [...el.editor.querySelectorAll('mark')]) {
      if (!m.isConnected) continue;
      let next = m.nextSibling;
      while (next && next.nodeType === 1 && next.tagName === 'MARK') {
        while (next.firstChild) m.appendChild(next.firstChild);
        const gone = next; next = next.nextSibling; gone.remove();
      }
      m.normalize();
    }
  }

  // Toggle: if everything selected is already highlighted, remove those highlights; otherwise highlight it all.
  function toggleHighlight() {
    const sel = getSelection();
    if (!sel.rangeCount || !inEditor()) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) {
      const m = markOf(range.startContainer);
      if (m) { unwrap(m); afterHighlightChange(); }
      return;
    }
    const parts = selectedTextParts(range).filter((p) => p.t.data.slice(p.start, p.end).trim() || !markOf(p.t));
    if (!parts.length) return;
    const allMarked = parts.every((p) => !p.t.data.slice(p.start, p.end).trim() || markOf(p.t));
    if (allMarked) {
      new Set(parts.map((p) => markOf(p.t)).filter(Boolean)).forEach(unwrap);
    } else {
      let last = null;
      for (const { t, start, end } of parts) {
        if (markOf(t)) { last = markOf(t); continue; }
        let node = t;
        if (end < node.data.length) node.splitText(end);
        if (start > 0) node = node.splitText(start);
        const m = document.createElement('mark');
        node.parentNode.insertBefore(m, node); m.appendChild(node);
        last = m;
      }
      mergeAdjacentMarks();
      if (last && last.isConnected) { const r = document.createRange(); r.setStartAfter(last); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
    }
    afterHighlightChange();
  }
  function afterHighlightChange() { hideBubble(); markDirty(); renderHighlights(); updateState(); }

  // Highlight list under the note's details; click one to jump to it.
  function renderHighlights() {
    const marks = [...el.editor.querySelectorAll('mark')].filter((m) => m.textContent.trim());
    el.hlWrap.hidden = !marks.length;
    el.hlCount.textContent = marks.length;
    if (!marks.length) el.hlPanel.hidden = true;
    el.hlCount.setAttribute('aria-expanded', String(!el.hlPanel.hidden));
    if (el.hlPanel.hidden) return;
    el.hlPanel.textContent = '';
    marks.forEach((m, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button'); b.type = 'button'; b.dataset.i = i;
      const txt = m.textContent.replace(/\s+/g, ' ').trim();
      b.textContent = txt.length > 220 ? txt.slice(0, 219) + '…' : txt;
      li.appendChild(b); el.hlPanel.appendChild(li);
    });
  }
  let hlTimer = null;
  function scheduleHighlights() { clearTimeout(hlTimer); hlTimer = setTimeout(renderHighlights, 300); }
  el.hlCount.addEventListener('click', () => { el.hlPanel.hidden = !el.hlPanel.hidden; renderHighlights(); });
  el.hlPanel.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const m = [...el.editor.querySelectorAll('mark')].filter((x) => x.textContent.trim())[+b.dataset.i];
    if (!m) return;
    m.scrollIntoView({ block: 'center', behavior: 'smooth' });
    m.classList.add('flash');
    setTimeout(() => { m.classList.remove('flash'); if (!m.classList.length) m.removeAttribute('class'); }, 1200);
  });

  // Floating button by the selection.
  let pointerDown = false, fromPointer = false;
  function hideBubble() { el.bubble.hidden = true; }
  function placeBubble() {
    if (el.view.hidden || pointerDown || !inEditor()) return hideBubble();
    const sel = getSelection();
    const range = sel.getRangeAt(0);
    let label;
    let rect;
    if (!range.collapsed) {
      if (!range.toString().trim()) return hideBubble();
      const parts = selectedTextParts(range).filter((p) => p.t.data.slice(p.start, p.end).trim());
      label = parts.length && parts.every((p) => markOf(p.t)) ? 'Remove highlight' : 'Highlight';
      const rects = [...range.getClientRects()].filter((r) => r.width);
      rect = rects[0] || range.getBoundingClientRect();
    } else {
      const m = fromPointer && markOf(range.startContainer);
      if (!m) return hideBubble();
      label = 'Remove highlight';
      rect = m.getClientRects()[0] || m.getBoundingClientRect();
    }
    el.bubbleBtn.textContent = label;
    el.bubble.hidden = false;
    const bw = el.bubble.offsetWidth, bh = el.bubble.offsetHeight;
    const scroller = document.getElementById('scroller').getBoundingClientRect();
    let top = rect.top - bh - 6;
    if (top < scroller.top + 4) top = rect.bottom + 6;
    const left = Math.max(scroller.left + 4, Math.min(rect.left + rect.width / 2 - bw / 2, scroller.right - bw - 4));
    el.bubble.style.top = `${Math.round(top)}px`; el.bubble.style.left = `${Math.round(left)}px`;
  }
  el.editor.addEventListener('mousedown', () => { pointerDown = true; fromPointer = true; hideBubble(); });
  document.addEventListener('mouseup', () => { if (pointerDown) { pointerDown = false; setTimeout(placeBubble, 0); } });
  el.editor.addEventListener('keydown', (e) => {
    fromPointer = false;
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'h') { e.preventDefault(); toggleHighlight(); }
  });
  el.editor.addEventListener('keyup', (e) => { if (e.shiftKey || e.key.startsWith('Arrow')) placeBubble(); });
  document.addEventListener('selectionchange', () => { if (!el.bubble.hidden && !pointerDown) placeBubble(); });
  document.getElementById('scroller').addEventListener('scroll', () => { if (!el.bubble.hidden) placeBubble(); });
  el.bubble.addEventListener('mousedown', (e) => e.preventDefault());
  el.bubbleBtn.addEventListener('click', toggleHighlight);

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
      case 'highlight': return toggleHighlight();
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
    el.hlBtn.classList.toggle('active', !!markOf(a));
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
    if (gh && e.target.closest('.ren')) { renameTagAt(gh); return; }
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
    if (!li || (prefs.mode !== 'subject' && prefs.mode !== 'tag')) return;
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
    if (prefs.mode === 'tag') {
      // Dropping on a tag adds that tag (the note keeps its other tags).
      if (!n || !g.dataset.key.startsWith('tag:') || (n.userTags || []).some((t) => t.toLowerCase() === g.dataset.label.toLowerCase())) { renderList(); return; }
      await setTags(id, [...(n.userTags || []), g.dataset.label]);
      return;
    }
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
  api.onFlushRequest(() => flush());
  window.addEventListener('blur', () => { if (dirty) flush(); });

  (async () => {
    setMode(prefs.mode);
    try { await refreshList(); } catch (e) { el.listEmpty.textContent = String(e.message || e); el.listEmpty.hidden = false; }
    if (notes.length) openNote(notes[0].id); else showEmpty();
  })();
})();
