// Text matching shared by the main process (searching every note) and the renderer
// (highlighting matches in the open note). Loaded with require() in main and as a
// plain <script> in the renderer, where it defines window.GathererSearch.
//
// Matching ignores case and accents ("cafe" finds "Café"). A query is split into
// words; "quoted phrases" stay together. A note matches when every word appears.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GathererSearch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MARKS = /\p{M}/gu;
  const memo = new Map();

  // Fold one UTF-16 code unit to exactly one code unit, so folded and original
  // strings share indexes. A lone combining mark becomes NUL, which never matches.
  function foldChar(c) {
    let f = memo.get(c);
    if (f !== undefined) return f;
    const d = c.normalize('NFD').replace(MARKS, '').toLowerCase();
    if (d.length === 1) f = d;
    else if (d.length === 0) f = '\u0000';
    else { const l = c.toLowerCase(); f = l.length === 1 ? l : c; }
    if (memo.size < 5000) memo.set(c, f);
    return f;
  }

  // Same length as the input, so an index in the result is an index in `s`.
  function fold(s) {
    s = String(s ?? '');
    // eslint-disable-next-line no-control-regex
    if (/^[\x00-\x7f]*$/.test(s)) return s.toLowerCase();
    let out = '';
    for (let i = 0; i < s.length; i++) out += foldChar(s[i]);
    return out;
  }

  // -> folded terms, longest first, without duplicates or terms contained in another.
  function parseQuery(q) {
    const terms = [];
    const re = /"([^"]*)"?|(\S+)/g;
    let m;
    const src = String(q ?? '').slice(0, 200);
    while ((m = re.exec(src)) && terms.length < 12) {
      const t = fold((m[1] ?? m[2] ?? '').replace(/\s+/g, ' ').trim());
      if (t) terms.push(t);
    }
    const uniq = [...new Set(terms)].sort((a, b) => b.length - a.length);
    return uniq.filter((t, i) => !uniq.slice(0, i).some((u) => u.includes(t)));
  }

  // Every occurrence of any term in already-folded text -> [[start, end], ...] sorted and merged.
  function findRanges(folded, terms, limit = 5000) {
    const out = [];
    for (const t of terms) {
      let i = folded.indexOf(t);
      while (i !== -1 && out.length < limit) { out.push([i, i + t.length]); i = folded.indexOf(t, i + t.length); }
    }
    out.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [];
    for (const r of out) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    return merged;
  }

  function count(folded, term, cap = 50) {
    let n = 0;
    for (let i = folded.indexOf(term); i !== -1 && n < cap; i = folded.indexOf(term, i + term.length)) n++;
    return n;
  }

  // A short excerpt of `text` around the first match -> { text, ranges } (ranges relative to the excerpt).
  function snippet(text, folded, terms, { before = 60, length = 200 } = {}) {
    let first = -1;
    for (const t of terms) { const i = folded.indexOf(t); if (i !== -1 && (first === -1 || i < first)) first = i; }
    if (first === -1) {
      const s = text.slice(0, length).trim();
      return { text: s + (text.length > length ? '…' : ''), ranges: [] };
    }
    let start = Math.max(0, first - before);
    if (start > 0) { const sp = text.indexOf(' ', start); if (sp !== -1 && sp < first) start = sp + 1; } // start on a word
    let end = Math.min(text.length, start + length);
    if (end < text.length) { const sp = text.lastIndexOf(' ', end); if (sp > first) end = sp; }
    const pre = start > 0 ? '…' : '';
    const ranges = findRanges(folded.slice(start, end), terms, 50).map(([a, b]) => [a + pre.length, b + pre.length]);
    return { text: pre + text.slice(start, end) + (end < text.length ? '…' : ''), ranges };
  }

  return { fold, parseQuery, findRanges, count, snippet };
});
