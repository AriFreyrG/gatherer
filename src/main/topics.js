// Local, dependency-free subject inference. No network, no model download.
//
// Each note becomes a bag of weighted terms (title, page tags and body; unigrams and bigrams).
// Terms are scored per note with TF-IDF, and a note's top terms are its keywords. A subject is
// a keyword shared by at least two notes; subjects are picked greedily by how much of the
// collection they explain, then every note is assigned to the best subject among its keywords.
// Notes that share nothing with any other note go to "Other". Subjects the user pinned by hand
// act as seeds, so similar notes gather around them automatically.
//
// When the optional AI layer (ai.js) has labelled a note by meaning, those labels ride along as
// very strong candidate terms, so notes the AI put together end up together even when they share
// no vocabulary. Without them this is the same keyword inference as before.

const OTHER = 'Other';

const STOP = new Set(`a about above after again against all almost also although always am among an and another any anyone
anything are aren around as at away back be became because become becomes been before being below between both but by
came can cannot could couldn did didn do does doesn doing don done down during each either else enough even ever every
everything few first for from further get gets getting give given go goes going gone got had hadn has hasn have haven
having he her here hers herself him himself his how however i if in into is isn it its itself just keep know known last
least less let like likely made make makes making many may maybe me might mine more most mostly much must my myself near
need needs never new next no nor not now of off often on once one only onto or other others our ours ourselves out over
own per perhaps put quite rather really right said same say says see seem seems several shall she should shouldn show
since so some something still such take than that the their theirs them themselves then there these they thing things
think this those though through thus to together too took toward towards two under until up upon us use used uses using
very via want wants was wasn way ways we well went were weren what whatever when where whether which while who whom whose
why will with within without won would wouldn yes yet you your yours yourself yourselves
also already actually across ago anyway become came come comes could day days does early end far find found good great
help here high however inc including info into large later lot lots long look looking low main mr mrs ms new news often
old part people place point read really recent recently says set small sure tell three time times today top true try
week weeks year years full via less better best way part using based within around today yesterday month months
click subscribe newsletter cookie cookies privacy policy terms share email follow sign login log copyright reserved rights
advertisement sponsored related comments comment reply read more image images photo photos video getty caption credit
www http https com org net html amp nbsp
og og: ll ve re don isn didn doesn wasn aren`.split(/\s+/).filter(Boolean));

const MAX_BODY_WORDS = 4000;
const KEYWORDS_PER_NOTE = 10;

// Light normalisation so "models"/"model" and "libraries"/"library" meet. Deliberately conservative.
function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is|ous)$/.test(w)) return w.slice(0, -1);
  return w;
}

function words(text) {
  return (String(text || '').toLowerCase().match(/[\p{L}][\p{L}\p{N}'’-]*[\p{L}\p{N}]|[\p{L}]{2,}/gu) || [])
    .map((w) => w.replace(/['’]s$/, '').replace(/['’]/g, ''));
}

const okWord = (w) => w.length >= 3 && !STOP.has(w) && !/^\d/.test(w) && w.length <= 30;

// Returns Map(term -> count). Bigrams only from adjacent non-stop words.
function terms(text, limit) {
  const out = new Map();
  const ws = words(text);
  const n = limit ? Math.min(ws.length, limit) : ws.length;
  let prev = null;
  for (let i = 0; i < n; i++) {
    const raw = ws[i];
    if (!okWord(raw)) { prev = null; continue; }
    const s = stem(raw);
    out.set(s, (out.get(s) || 0) + 1);
    if (prev) { const bg = prev + ' ' + s; out.set(bg, (out.get(bg) || 0) + 1); }
    prev = s;
  }
  return out;
}

// Remember the surface form people actually wrote, for labels.
function surfaceForms(text, forms) {
  const ws = words(text);
  let prev = null, prevRaw = null;
  for (const raw of ws.slice(0, MAX_BODY_WORDS)) {
    if (!okWord(raw)) { prev = null; continue; }
    const s = stem(raw);
    bump(forms, s, raw);
    if (prev) bump(forms, prev + ' ' + s, prevRaw + ' ' + raw);
    prev = s; prevRaw = raw;
  }
}
function bump(forms, key, raw) {
  let m = forms.get(key); if (!m) forms.set(key, (m = new Map()));
  m.set(raw, (m.get(raw) || 0) + 1);
}

const normLabel = (s) => String(s || '').trim().replace(/\s+/g, ' ');
const labelKey = (s) => normLabel(s).toLowerCase();

function titleCase(s) {
  return s.split(' ').map((w) => (w.length <= 3 && /^[a-z]+$/.test(w) && w !== s ? w : w[0].toUpperCase() + w.slice(1))).join(' ')
    .replace(/^./, (c) => c.toUpperCase());
}

// Build a per-note term profile. Kept separate so callers can cache it per file.
//   note = { title, text, tags: string[], aiTopics?: string[] }
const AI_WEIGHT = 12;
const wholeKey = (label) => [...terms(label).keys()].filter((k) => !k.includes(' ')).join(' ');

function profile({ title, text, tags, aiTopics }) {
  const tf = new Map();
  const add = (m, w) => { for (const [t, c] of m) tf.set(t, (tf.get(t) || 0) + c * w); };
  add(terms(title), 3);
  for (const tag of tags || []) {
    const tt = terms(tag);
    add(tt, 2);
    // A whole tag phrase (e.g. "Machine Learning") is a strong subject candidate on its own.
    const whole = [...tt.keys()].filter((k) => !k.includes(' ')).join(' ');
    if (whole && whole.split(' ').length <= 3) tf.set('#' + whole, (tf.get('#' + whole) || 0) + 4);
  }
  add(terms(text, MAX_BODY_WORDS), 1);
  const forms = new Map();
  surfaceForms(title + ' ' + (tags || []).join(' . ') + ' ' + text, forms);
  for (const tag of tags || []) {
    const tt = [...terms(tag).keys()].filter((k) => !k.includes(' ')).join(' ');
    if (tt) bump(forms, '#' + tt, normLabel(tag));
  }
  // AI subject labels: the first one is the AI's best fit, so it weighs most.
  const ai = new Set();
  (aiTopics || []).forEach((label, i) => {
    const k = wholeKey(label);
    if (!k || k === 'other' || ai.has(k)) return;
    ai.add(k);
    tf.set('#' + k, (tf.get('#' + k) || 0) + AI_WEIGHT / (i + 1));
    for (let j = 0; j < 50; j++) bump(forms, '#' + k, normLabel(label));
  });
  // Dampen raw counts so one long article does not dominate.
  const w = new Map();
  for (const [t, c] of tf) w.set(t, 1 + Math.log(c));
  return { w, forms, ai };
}

// notes: [{ id, profile, pinned? }] -> Map(id -> subject label)
function inferSubjects(notes) {
  const result = new Map();
  const N = notes.length;
  if (!N) return result;

  const df = new Map();
  for (const n of notes) for (const t of n.profile.w.keys()) df.set(t, (df.get(t) || 0) + 1);

  // Labels pinned by the user act as seed subjects.
  const pinnedLabels = new Map(); // key -> label
  for (const n of notes) if (n.pinned) pinnedLabels.set(labelKey(n.pinned), normLabel(n.pinned));
  const seedTerm = new Map(); // term -> pinned label key
  for (const [key] of pinnedLabels) {
    const t = [...terms(key).keys()].filter((k) => !k.includes(' ')).join(' ');
    if (t) seedTerm.set(t, key);
  }

  const maxDf = N >= 6 ? Math.ceil(N * 0.7) : N;
  const keywords = new Map(); // id -> [{t, s}]
  for (const n of notes) {
    // "#machine learning" (a page tag) and "machine learning" (body text) are the same candidate.
    const acc = new Map();
    const ai = n.profile.ai || new Set();
    for (const [t, w] of n.profile.w) {
      const d = df.get(t);
      const k = t.startsWith('#') ? t.slice(1) : t;
      const isAi = t.startsWith('#') && ai.has(k);
      // A meaning-based label stays a candidate even when most notes share it.
      if (d > maxDf && !isAi && !seedTerm.has(k)) continue;
      const idf = Math.log(1 + N / d);
      const boost = isAi ? 3 : t.startsWith('#') ? 1.6 : t.includes(' ') ? 1.35 : 1;
      acc.set(k, (acc.get(k) || 0) + w * idf * boost);
    }
    const scored = [...acc].map(([t, s]) => ({ t, s }));
    scored.sort((a, b) => b.s - a.s);
    keywords.set(n.id, scored.slice(0, KEYWORDS_PER_NOTE));
  }

  const auto = notes.filter((n) => !n.pinned);
  for (const n of notes) if (n.pinned) result.set(n.id, pinnedLabels.get(labelKey(n.pinned)));

  // Greedy cover: repeatedly pick the term that best explains the still-unassigned notes.
  const chosen = new Set();
  const unassigned = new Set(auto.map((n) => n.id));
  for (const t of seedTerm.keys()) chosen.add(t);
  for (let guard = 0; guard < 200 && unassigned.size > 1; guard++) {
    const score = new Map(), count = new Map();
    for (const id of unassigned) {
      for (const { t, s } of keywords.get(id)) {
        if (chosen.has(t)) continue;
        score.set(t, (score.get(t) || 0) + s);
        count.set(t, (count.get(t) || 0) + 1);
      }
    }
    let best = null, bestScore = 0;
    for (const [t, s] of score) if (count.get(t) >= 2 && s > bestScore) { best = t; bestScore = s; }
    if (!best) break;
    chosen.add(best);
    for (const id of [...unassigned]) if (keywords.get(id).some((k) => k.t === best)) unassigned.delete(id);
  }

  // Assign each note to its strongest chosen term; drop subjects that end up with one note.
  const assign = () => {
    const a = new Map();
    for (const n of auto) {
      const k = keywords.get(n.id).find((k) => chosen.has(k.t));
      a.set(n.id, k ? k.t : null);
    }
    return a;
  };
  let a = assign();
  for (let pass = 0; pass < 5; pass++) {
    const sizes = new Map();
    for (const t of a.values()) if (t) sizes.set(t, (sizes.get(t) || 0) + 1);
    const lonely = [...chosen].filter((t) => !seedTerm.has(t) && (sizes.get(t) || 0) < 2);
    if (!lonely.length) break;
    lonely.forEach((t) => chosen.delete(t));
    a = assign();
  }

  // Merge the "#tag" and plain-word versions of the same term into one subject.
  const canon = (t) => (t.startsWith('#') ? t.slice(1) : t);
  const formsFor = (t) => {
    const tally = new Map();
    for (const n of notes) {
      for (const key of [t, '#' + canon(t), canon(t)]) {
        const m = n.profile.forms.get(key); if (!m) continue;
        for (const [raw, c] of m) tally.set(raw, (tally.get(raw) || 0) + c * (key.startsWith('#') ? 3 : 1));
      }
    }
    let best = canon(t), bc = 0;
    for (const [raw, c] of tally) if (c > bc) { best = raw; bc = c; }
    return best;
  };
  const labelCache = new Map();
  const labelOf = (t) => {
    if (seedTerm.has(t)) return pinnedLabels.get(seedTerm.get(t));
    const k = canon(t);
    if (!labelCache.has(k)) {
      const f = formsFor(t);
      labelCache.set(k, /[A-Z]/.test(f) ? f : titleCase(f));
    }
    return labelCache.get(k);
  };
  // Auto labels that collide with a pinned label (case-insensitively) join it.
  for (const n of auto) {
    const t = a.get(n.id);
    let label = t ? labelOf(t) : OTHER;
    if (pinnedLabels.has(labelKey(label))) label = pinnedLabels.get(labelKey(label));
    result.set(n.id, label);
  }
  return result;
}

// Strip HTML to plain text for profiling.
function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ');
}

module.exports = { profile, inferSubjects, htmlToText, OTHER };
