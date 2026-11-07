// One standalone HTML file per note. Dir is injectable for tests; defaults to userData/notes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sanitize } = require('./scraper');
const topics = require('./topics');
const { localSummary } = require('./summarize');

let dir = null;
function setDir(d) { dir = d; }
function getDir() {
  if (!dir) dir = path.join(require('electron').app.getPath('userData'), 'notes');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const unesc = (s) => s.replace(/&(#39|quot|lt|gt|amp);/g, (_, e) => ({ '#39': "'", quot: '"', lt: '<', gt: '>', amp: '&' }[e]));

// Downloaded images for a note live in <notes>/assets/<id>/.
const assetsRoot = () => path.join(getDir(), 'assets');
function assetDir(id) { fileFor(id); return path.join(assetsRoot(), id); }

function fileFor(id) {
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) throw new Error('Invalid note id');
  return path.join(getDir(), id + '.html');
}

function newId() {
  const d = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');
  return `${d}-${crypto.randomBytes(2).toString('hex')}`;
}

// Optional metadata: siteName and tags come from the page when gathered; subject is set by the
// user to override automatic organisation (empty = automatic). summary and topics are written by
// the optional AI layer: a short summary, and subject labels chosen by meaning.
function render({ title, url, dateGathered, content, siteName, tags, subject, summary, topics: aiTopics }) {
  const opt = (name, v) => (v ? `<meta name="gatherer:${name}" content="${esc(v)}">\n` : '');
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${esc(title)}</title>\n` +
    `<meta name="gatherer:url" content="${esc(url)}">\n<meta name="gatherer:date-gathered" content="${esc(dateGathered)}">\n` +
    opt('site-name', siteName) + opt('tags', (tags || []).join(', ')) + opt('subject', subject) +
    opt('summary', summary) + opt('topics', (aiTopics || []).join(', ')) +
    `</head><body>${content}</body></html>\n`;
}

function parse(id, html) {
  const metaVal = (name) => {
    const m = html.match(new RegExp(`<meta\\s+name="gatherer:${name}"\\s+content="([^"]*)"`, 'i'));
    return m ? unesc(m[1]) : '';
  };
  const t = html.match(/<title>([\s\S]*?)<\/title>/i);
  const b = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const csv = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
  return {
    id, title: t ? unesc(t[1]) : 'Untitled', url: metaVal('url'), dateGathered: metaVal('date-gathered'),
    siteName: metaVal('site-name'), tags: csv(metaVal('tags')), subject: metaVal('subject'),
    summary: metaVal('summary'), topics: csv(metaVal('topics')), content: b ? b[1] : '',
  };
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

const summary = ({ id, title, url, dateGathered, siteName, subject }) =>
  ({ id, title, url, dateGathered, siteName: siteName || '', pinnedSubject: subject || '' });

// Parsed summary + topic profile per file, reused while the file is unchanged.
const cache = new Map(); // file name -> { key, sum, profile }

function readEntry(f) {
  const file = path.join(getDir(), f);
  const st = fs.statSync(file);
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(f);
  if (hit && hit.key === key) return hit;
  const note = parse(f.slice(0, -5), fs.readFileSync(file, 'utf8'));
  const text = topics.htmlToText(note.content);
  const entry = {
    key, sum: summary(note),
    brief: note.summary || localSummary({ title: note.title, text }),
    profile: topics.profile({ title: note.title, tags: note.tags, text: (note.summary ? note.summary + ' ' : '') + text, aiTopics: note.topics }),
  };
  cache.set(f, entry);
  return entry;
}

// NoteSummary[] newest first. Each carries `subject`: the pinned subject, or an inferred one.
function list() {
  const entries = [];
  const seen = new Set();
  for (const f of fs.readdirSync(getDir())) {
    if (!/^[\w-]+\.html$/.test(f)) continue;
    seen.add(f);
    try { entries.push(readEntry(f)); } catch { /* skip unreadable */ }
  }
  for (const f of cache.keys()) if (!seen.has(f)) cache.delete(f);
  const subjects = topics.inferSubjects(entries.map((e) => ({ id: e.sum.id, profile: e.profile, pinned: e.sum.pinnedSubject })));
  return entries.map((e) => ({ ...e.sum, subject: subjects.get(e.sum.id) || topics.OTHER }))
    .sort((a, b) => (b.dateGathered || '').localeCompare(a.dateGathered || ''));
}

function read(id) {
  try { return parse(id, fs.readFileSync(fileFor(id), 'utf8')); }
  catch (e) { throw e.code === 'ENOENT' ? new Error('Note not found') : e; }
}

// Note for the renderer. A note with no AI summary gets a local one, computed on the fly and not
// saved, so editing the note keeps it current.
function get(id) {
  const note = read(id);
  if (note.summary) return { ...note, summarySource: 'ai' };
  const local = localSummary({ title: note.title, text: topics.htmlToText(note.content) });
  return { ...note, summary: local, summarySource: local ? 'local' : '' };
}

// Plain text of a note, for the AI.
function textOf(id) { const n = read(id); return { title: n.title, url: n.url, text: topics.htmlToText(n.content).trim() }; }

// Every note's id, title, pinned subject and best available summary, for regrouping.
function briefs() {
  list();
  return [...cache.values()].map((e) => ({ id: e.sum.id, title: e.sum.title, summary: e.brief, pinned: e.sum.pinnedSubject }));
}

const cleanTags = (tags) => [...new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).replace(/[,\s]+/g, ' ').trim()).filter((t) => t && t.length <= 40))].slice(0, 12);

function create({ title, url, dateGathered, content, siteName, tags }) {
  const id = newId();
  const note = {
    title: String(title || 'Untitled'), url: url || '', dateGathered: dateGathered || new Date().toISOString(),
    siteName: String(siteName || '').trim().slice(0, 80), tags: cleanTags(tags), subject: '', content: sanitize(content),
  };
  writeAtomic(fileFor(id), render(note));
  return { id, ...note };
}

function save(id, { title, content } = {}) {
  const cur = read(id);
  const next = { ...cur, title: String(title ?? cur.title).trim() || 'Untitled', content: sanitize(content ?? cur.content) };
  writeAtomic(fileFor(id), render(next));
  return summary(next);
}

// Pin a note to a subject by hand; an empty subject returns it to automatic organisation.
function setSubject(id, subject) {
  const cur = read(id);
  const next = { ...cur, subject: String(subject || '').trim().replace(/\s+/g, ' ').slice(0, 60) };
  writeAtomic(fileFor(id), render(next));
  return summary(next);
}

// Store what the AI produced. Either field may be omitted to leave it as it is; an empty summary
// clears it (the note falls back to the local summary).
function setAi(id, { summary: text, topics: labels } = {}) {
  const cur = read(id);
  const next = { ...cur };
  if (text !== undefined) next.summary = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  if (labels !== undefined) next.topics = cleanTags(labels).slice(0, 3);
  writeAtomic(fileFor(id), render(next));
  return summary(next);
}

function remove(id) {
  try { fs.unlinkSync(fileFor(id)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.rmSync(assetDir(id), { recursive: true, force: true });
  return true;
}

module.exports = { setDir, list, get, textOf, briefs, create, save, setSubject, setAi, remove, assetsRoot, assetDir };
