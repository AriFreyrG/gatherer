// Local, offline summary: picks the 2-3 sentences that best represent the page.
// Used when no API key is set, when the AI is unreachable, and for notes gathered before
// summaries existed. Sentences are scored by how many of the page's frequent words they hold,
// with a nudge toward the opening (where articles usually state their point).

const STOP = new Set(`a an and are as at be been but by can could did do does for from had has have he her his how i if in
into is it its just may me more most my no not of on one or our out over she so some such than that the their them then there
these they this those to too up us was we were what when where which while who why will with would you your about after also
all any because before being both each even here however many much only other own said same should since still through
under until very well`.split(/\s+/).filter(Boolean));

const MAX_SENTENCES = 80;
const TARGET_CHARS = 420;

function sentences(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  // Split after . ! ? (optionally followed by a closing quote/bracket) when the next sentence starts.
  const parts = clean.split(/(?<=[.!?][”"')\]]?)\s+(?=[\p{Lu}\p{N}“"‘'(])/u);
  return parts.map((s) => s.trim()).filter((s) => s.length >= 40 && s.length <= 400 && /\p{L}{3}/u.test(s));
}

const tokens = (s) => (s.toLowerCase().match(/\p{L}[\p{L}\p{N}'-]*/gu) || []).filter((w) => w.length > 2 && !STOP.has(w));

// Looks like page furniture rather than prose.
const JUNK = /\b(cookie|subscribe|sign up|newsletter|all rights reserved|click here|advertisement|share this)\b/i;

function localSummary({ title, text }) {
  const all = sentences(text).filter((s) => !JUNK.test(s)).slice(0, MAX_SENTENCES);
  if (!all.length) return '';
  if (all.length <= 2) return all.join(' ').slice(0, TARGET_CHARS * 1.5);

  const freq = new Map();
  for (const s of all) for (const w of new Set(tokens(s))) freq.set(w, (freq.get(w) || 0) + 1);
  for (const w of tokens(title || '')) freq.set(w, (freq.get(w) || 0) + 3);

  const scored = all.map((s, i) => {
    const ws = tokens(s);
    if (!ws.length) return { i, s, score: 0 };
    let sum = 0;
    for (const w of new Set(ws)) sum += Math.log(1 + (freq.get(w) || 0));
    const position = 1 + 0.6 / (1 + i / 3); // early sentences get up to +60%
    return { i, s, score: (sum / Math.sqrt(ws.length)) * position };
  });

  const picked = [];
  let len = 0;
  for (const c of [...scored].sort((a, b) => b.score - a.score)) {
    if (picked.length >= 3) break;
    if (picked.length && len + c.s.length > TARGET_CHARS) continue;
    picked.push(c); len += c.s.length;
  }
  return picked.sort((a, b) => a.i - b.i).map((c) => c.s).join(' ');
}

module.exports = { localSummary, sentences };
