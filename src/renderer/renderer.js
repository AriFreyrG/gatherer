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
    summary: $('summary'), sumText: $('summary-text'), sumBadge: $('summary-badge'),
    sumBtn: $('summary-btn'), sumStatus: $('summary-status'),
    regroup: $('regroup-btn'), regroupStatus: $('regroup-status'),
    settings: $('settings'), setForm: $('settings-form'), keyInput: $('key-input'),
    keyCurrent: $('key-current'), keyRemove: $('key-remove'), autoSum: $('auto-summarize'), setMsg: $('settings-msg'),
    searchCount: $('search-count'), scroller: $('scroller'),
  };

  let notes = [];
  let current = null; // { id, ... }
  let dirty = false;
  let timer = null;
  let saving = Promise.resolve();
  let savedRange = null;
  let settings = { hasKey: false, keySource: '', keyHint: '', autoSummarize: true, provider: 'auto', engine: '', engineReason: '', appleAvailable: false, appleReason: '' };
  const ENGINE = { apple: 'Apple Intelligence', claude: 'Claude' };
  const aiBusy = new Set(); // note ids whose AI summary is being written
  const aiErrors = new Map(); // id -> last error message
  const cleanErr = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');

  /* ---------- search ---------- */
  // Typing in the sidebar box searches the full text of every note (in the main process).
  // Matches in the open note are painted with the CSS Custom Highlight API, which never
  // touches the editor's DOM, so highlights can't leak into saved notes.
  const S = window.GathererSearch;
  const canHighlight = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function';
  let results = null; // SearchResult[] for `resultsFor`, or null when not searching
  let resultsFor = '';
  let searchSeq = 0;
  let searchTimer = null;
  let matchRanges = []; // Range[] of matches in the open note's title and body
  let matchIdx = -1;
  const query = () => el.filter.value.trim();

  function scheduleSearch(delay = 120) { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, delay); }
  async function runSearch() {
    clearTimeout(searchTimer);
    const q = query();
    const seq = ++searchSeq;
    const changed = q !== resultsFor;
    let r = null;
    if (q) { try { r = await api.notes.search(q); } catch { r = []; } }
    if (seq !== searchSeq) return; // a newer search is on its way
    results = r; resultsFor = q;
    renderList();
    if (changed) { el.list.scrollTop = 0; highlightNote(); }
  }

  // Title and snippet text with <mark>s around the given [start, end] ranges.
  function marked(text, ranges) {
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const [a, b] of ranges || []) {
      if (a < pos || b > text.length) continue;
      if (a > pos) frag.append(text.slice(pos, a));
      const m = document.createElement('mark'); m.textContent = text.slice(a, b); frag.append(m);
      pos = b;
    }
    frag.append(text.slice(pos));
    return frag;
  }

  function renderResults() {
    el.list.textContent = '';
    if (results.length) {
      const head = document.createElement('li');
      head.className = 'result-head';
      head.textContent = results.length === 1 ? '1 note' : `${results.length} notes`;
      el.list.appendChild(head);
    }
    for (const r of results) {
      const li = document.createElement('li');
      li.className = 'note result'; li.dataset.id = r.id;
      if (current && current.id === r.id) li.classList.add('selected');
      const t = document.createElement('div'); t.className = 't'; t.append(marked(r.title || 'Untitled', r.title ? r.titleRanges : []));
      const s = document.createElement('div'); s.className = 's';
      const a = document.createElement('span'); a.textContent = r.siteName || host(r.url);
      const b = document.createElement('span');
      b.textContent = r.hits > 1 ? `${r.hits >= 50 ? '50+' : r.hits} matches` : fmtDate(r.dateGathered, { dateStyle: 'short' });
      s.append(a, b);
      li.append(t, s);
      if (r.snippet) { const p = document.createElement('div'); p.className = 'snip'; p.append(marked(r.snippet, r.snippetRanges)); li.appendChild(p); }
      el.list.appendChild(li);
    }
    el.listEmpty.hidden = results.length > 0;
    el.listEmpty.textContent = notes.length ? `No notes contain “${resultsFor}”.` : 'No notes yet.';
    renderSubjectChip();
  }

  function textNodes(root) {
    const out = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n);
    return out;
  }

  // Find every match in the open note. `jump` scrolls to the first one.
  function highlightNote({ jump = false } = {}) {
    matchRanges = []; matchIdx = -1;
    const terms = current && !el.view.hidden ? S.parseQuery(query()) : [];
    for (const root of terms.length ? [el.title, el.editor] : []) {
      // Join the text nodes so a match can span formatting, e.g. "gather <b>pages</b>".
      const nodes = textNodes(root);
      const starts = [];
      let text = '';
      for (const n of nodes) { starts.push(text.length); text += n.data; }
      let i = 0;
      for (const [a, b] of S.findRanges(S.fold(text), terms, 2000)) {
        while (i + 1 < nodes.length && starts[i + 1] <= a) i++;
        let j = i;
        while (j + 1 < nodes.length && starts[j + 1] < b) j++;
        const r = document.createRange();
        r.setStart(nodes[i], a - starts[i]); r.setEnd(nodes[j], b - starts[j]);
        matchRanges.push(r);
      }
    }
    if (canHighlight) {
      CSS.highlights.delete('gatherer-current');
      if (matchRanges.length) CSS.highlights.set('gatherer-search', new Highlight(...matchRanges));
      else CSS.highlights.delete('gatherer-search');
    }
    if (jump && matchRanges.length) gotoMatch(0); else updateCount();
  }

  function gotoMatch(i) {
    const n = matchRanges.length;
    if (!n) return;
    matchIdx = ((i % n) + n) % n;
    const r = matchRanges[matchIdx];
    if (canHighlight) CSS.highlights.set('gatherer-current', new Highlight(r));
    const box = r.getBoundingClientRect();
    const view = el.scroller.getBoundingClientRect();
    if (box.top < view.top + 40 || box.bottom > view.bottom - 40) el.scroller.scrollTop += box.top - view.top - view.height / 3;
    updateCount();
  }

  function updateCount() {
    const n = matchRanges.length;
    el.searchCount.hidden = !query() || !current || el.view.hidden;
    el.searchCount.textContent = !n ? '0' : matchIdx >= 0 ? `${matchIdx + 1}/${n}` : String(n);
    el.searchCount.title = n ? `${n} match${n === 1 ? '' : 'es'} in this note. Enter or Cmd/Ctrl+G for the next, Shift for the previous.` : 'No matches in this note';
  }

  let rehighlightTimer = null;
  const rehighlightSoon = () => {
    if (!query()) return;
    clearTimeout(rehighlightTimer);
    rehighlightTimer = setTimeout(() => { const keep = matchIdx; highlightNote(); if (keep >= 0 && matchRanges.length) { matchIdx = Math.min(keep, matchRanges.length - 1); if (canHighlight) CSS.highlights.set('gatherer-current', new Highlight(matchRanges[matchIdx])); updateCount(); } }, 400);
  };

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
    renderRegroup();
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
    if (query() && results) return renderResults();
    // While the first full-text results are on their way, filter by title and source.
    const q = query().toLowerCase();
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
      if (query()) scheduleSearch(300); // the saved text may match differently now
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
    renderSummary();
    revealCurrent();
    el.scroller.scrollTop = 0;
    renderList();
    highlightNote({ jump: true });
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

  /* ---------- summary ---------- */
  function renderSummary() {
    if (!current) return;
    const id = current.id;
    const text = current.summary || '';
    const by = current.summarySource;
    const isAi = by === 'apple' || by === 'claude';
    const busy = aiBusy.has(id);
    const engine = ENGINE[settings.engine];
    el.summary.hidden = !text && !engine;
    el.sumText.textContent = text || (busy ? 'Writing a summary…' : 'No summary yet.');
    el.sumText.classList.toggle('empty', !text);
    el.sumBadge.textContent = isAi ? ENGINE[by] : 'Local';
    el.sumBadge.classList.toggle('ai', isAi);
    el.sumBadge.hidden = !text;
    el.sumBadge.title = by === 'apple' ? 'Written on this Mac by Apple Intelligence' : by === 'claude' ? 'Written by Claude from the page text'
      : 'Picked from the page on this device, without AI';
    const err = aiErrors.get(id);
    el.sumStatus.textContent = busy ? 'Summarizing…' : err || '';
    el.sumStatus.classList.toggle('error', !busy && !!err);
    if (engine) {
      el.sumBtn.textContent = isAi ? 'Regenerate' : '\u2726 Summarize';
      el.sumBtn.title = `${isAi ? 'Write a fresh summary' : 'Summarize this page'} with ${engine}`;
    } else {
      el.sumBtn.textContent = 'Set up AI';
      el.sumBtn.title = settings.engineReason || 'Turn on AI summaries in Settings';
    }
    el.sumBtn.disabled = busy;
  }
  el.sumBtn.addEventListener('click', async () => {
    if (!current) return;
    if (!settings.engine) { openSettings(); return; }
    const id = current.id;
    aiErrors.delete(id); aiBusy.add(id); renderSummary();
    try { await flush(); await api.ai.summarize(id); }
    catch (e) { aiErrors.set(id, cleanErr(e)); }
    finally { aiBusy.delete(id); renderSummary(); }
  });
  api.onAiStatus(({ id, busy, error }) => {
    if (busy) { aiBusy.add(id); aiErrors.delete(id); } else aiBusy.delete(id);
    if (error) aiErrors.set(id, error);
    if (current && current.id === id) renderSummary();
  });
  // A background summary landed: refresh the list (subjects may move) and the open summary.
  api.onNoteChanged(async ({ id }) => {
    try { await refreshList(); } catch {}
    if (!current || current.id !== id) return;
    try {
      const n = await api.notes.get(id);
      if (current && current.id === id) { current.summary = n.summary; current.summarySource = n.summarySource; current.topics = n.topics; renderSummary(); }
    } catch {}
  });

  /* ---------- regroup by meaning ---------- */
  let regrouping = false;
  function renderRegroup() {
    el.regroup.hidden = !settings.engine || prefs.mode !== 'subject';
    el.regroup.title = `Ask ${ENGINE[settings.engine] || 'the AI'} to group your notes by what they mean, not by shared words`;
    el.regroup.disabled = regrouping;
    if (el.regroup.hidden && !regrouping) el.regroupStatus.textContent = '';
  }
  el.regroup.addEventListener('click', async () => {
    if (regrouping) return;
    regrouping = true; renderRegroup();
    el.regroupStatus.textContent = 'Grouping…'; el.regroupStatus.title = '';
    try {
      await flush();
      notes = await api.ai.organize();
      revealCurrent(); renderList();
      el.regroupStatus.textContent = '';
    } catch (e) {
      el.regroupStatus.textContent = 'Failed'; el.regroupStatus.title = cleanErr(e);
    } finally { regrouping = false; renderRegroup(); }
  });

  /* ---------- settings ---------- */
  function applySettings(s) {
    settings = s || settings;
    renderRegroup();
    if (current) renderSummary();
    el.keyCurrent.textContent = settings.hasKey
      ? (settings.keySource === 'environment' ? `Using the key from ANTHROPIC_API_KEY (${settings.keyHint}).` : `A key is saved (${settings.keyHint}).`)
      : 'No key saved.';
    el.keyRemove.hidden = settings.keySource !== 'settings';
    for (const r of document.querySelectorAll('input[name=provider]')) r.checked = r.value === settings.provider;
    const st = $('engine-status');
    st.classList.toggle('on', !!settings.engine);
    st.innerHTML = '<span class="dot"></span>';
    st.append(settings.engine
      ? `Using ${ENGINE[settings.engine]}${settings.engine === 'apple' ? ', on this Mac. Nothing leaves your computer.' : '.'}`
      : (settings.engineReason || 'AI is off.') + ' Using local summaries.');
    if (settings.engine !== 'apple' && settings.provider !== 'off' && settings.appleReason && !st.textContent.includes(settings.appleReason)) {
      st.append(` (Apple Intelligence: ${settings.appleReason})`);
    }
    el.autoSum.checked = settings.autoSummarize !== false;
    el.autoSum.disabled = !settings.engine;
  }
  function setMsg(text, isErr) { el.setMsg.textContent = text; el.setMsg.hidden = !text; el.setMsg.classList.toggle('error', !!isErr); }
  async function openSettings() {
    setMsg(''); el.keyInput.value = ''; applySettings(); el.settings.hidden = false;
    try { applySettings(await api.settings.get()); } catch {} // re-checks Apple Intelligence
  }
  $('provider').addEventListener('change', async (e) => {
    if (e.target.name !== 'provider') return;
    try { applySettings(await api.settings.setProvider(e.target.value)); setMsg(''); } catch (err) { setMsg(cleanErr(err), true); }
  });
  function closeSettings() { el.settings.hidden = true; }
  $('settings-btn').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('console-link').addEventListener('click', (e) => { e.preventDefault(); api.openExternal(e.currentTarget.href); });
  el.settings.addEventListener('mousedown', (e) => { if (e.target === el.settings) closeSettings(); });
  el.settings.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSettings(); } });
  el.setForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = el.keyInput.value.trim();
    if (!key) { setMsg('Paste a key first.', true); return; }
    setMsg('Checking the key…');
    try { applySettings(await api.settings.setKey(key)); el.keyInput.value = ''; setMsg(settings.engine === 'claude' ? 'Saved. New pages will get summaries from Claude.' : 'Saved. Choose Claude above to use it.'); }
    catch (err) { setMsg(cleanErr(err), true); }
  });
  el.keyRemove.addEventListener('click', async () => {
    try { applySettings(await api.settings.setKey('')); setMsg('Key removed.'); }
    catch (err) { setMsg(cleanErr(err), true); }
  });
  el.autoSum.addEventListener('change', async () => {
    try { applySettings(await api.settings.setAutoSummarize(el.autoSum.checked)); } catch (err) { setMsg(cleanErr(err), true); }
  });

  function showEmpty() {
    current = null; el.view.hidden = true; el.empty.hidden = false; renderList(); highlightNote();
  }

  /* ---------- editor / toolbar ---------- */
  el.title.addEventListener('input', markDirty);
  el.title.addEventListener('input', rehighlightSoon);
  el.editor.addEventListener('input', rehighlightSoon);
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
    else if (li && query()) gotoMatch(matchIdx + 1);
  });

  // Up/Down moves between visible notes, wherever focus is in the sidebar (except the filter box).
  document.getElementById('sidebar').addEventListener('keydown', (e) => {
    if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || (e.target === el.filter && !results)) return;
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
  el.filter.addEventListener('input', () => { if (!query()) runSearch(); else { if (!results) renderList(); scheduleSearch(); } });
  el.filter.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      if (!el.filter.value) return el.filter.blur();
      e.preventDefault(); el.filter.value = ''; runSearch(); return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (query() !== resultsFor) await runSearch();
    if (matchRanges.length) gotoMatch(matchIdx + (e.shiftKey ? -1 : 1));
    else if (results && results.length) openNote(results[0].id);
  });
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || !el.modal.hidden) return;
    const k = e.key.toLowerCase();
    if (k === 'f' && !e.shiftKey) { e.preventDefault(); el.filter.focus(); el.filter.select(); }
    else if (k === 'g' && matchRanges.length) { e.preventDefault(); gotoMatch(matchIdx + (e.shiftKey ? -1 : 1)); }
  });

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
    try { applySettings(await api.settings.get()); } catch {}
    try { for (const id of await api.notes.aiBusy()) aiBusy.add(id); } catch {}
    setMode(prefs.mode);
    try { await refreshList(); } catch (e) { el.listEmpty.textContent = String(e.message || e); el.listEmpty.hidden = false; }
    if (notes.length) openNote(notes[0].id); else showEmpty();
  })();
})();
