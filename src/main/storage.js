// One standalone HTML file per note. Dir is injectable for tests; defaults to userData/notes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sanitize } = require('./scraper');
const topics = require('./topics');

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
// user to override automatic organisation (empty = automatic).
function render({ title, url, dateGathered, content, siteName, tags, subject }) {
  const opt = (name, v) => (v ? `<meta name="gatherer:${name}" content="${esc(v)}">\n` : '');
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${esc(title)}</title>\n` +
    `<meta name="gatherer:url" content="${esc(url)}">\n<meta name="gatherer:date-gathered" content="${esc(dateGathered)}">\n` +
    opt('site-name', siteName) + opt('tags', (tags || []).join(', ')) + opt('subject', subject) +
    `</head><body>${content}</body></html>\n`;
}

function parse(id, html) {
  const metaVal = (name) => {
    const m = html.match(new RegExp(`<meta\\s+name="gatherer:${name}"\\s+content="([^"]*)"`, 'i'));
    return m ? unesc(m[1]) : '';
  };
  const t = html.match(/<title>([\s\S]*?)<\/title>/i);
  const b = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const tags = metaVal('tags').split(',').map((x) => x.trim()).filter(Boolean);
  return {
    id, title: t ? unesc(t[1]) : 'Untitled', url: metaVal('url'), dateGathered: metaVal('date-gathered'),
    siteName: metaVal('site-name'), tags, subject: metaVal('subject'), content: b ? b[1] : '',
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
  const entry = { key, sum: summary(note), profile: topics.profile({ title: note.title, tags: note.tags, text: topics.htmlToText(note.content) }) };
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

function get(id) {
  try { return parse(id, fs.readFileSync(fileFor(id), 'utf8')); }
  catch (e) { throw e.code === 'ENOENT' ? new Error('Note not found') : e; }
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
  const cur = get(id);
  const next = { ...cur, title: String(title ?? cur.title).trim() || 'Untitled', content: sanitize(content ?? cur.content) };
  writeAtomic(fileFor(id), render(next));
  return summary(next);
}

// Pin a note to a subject by hand; an empty subject returns it to automatic organisation.
function setSubject(id, subject) {
  const cur = get(id);
  const next = { ...cur, subject: String(subject || '').trim().replace(/\s+/g, ' ').slice(0, 60) };
  writeAtomic(fileFor(id), render(next));
  return summary(next);
}

function remove(id) {
  try { fs.unlinkSync(fileFor(id)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.rmSync(assetDir(id), { recursive: true, force: true });
  return true;
}

// Copies one note file from another Gatherer notes folder (srcDir) into this library, with its
// images. Keeps the note's id when it is free; a different note under the same id gets a new id.
// Returns the id it was saved under, or null when the same note is already here.
function importNote(srcDir, file) {
  const oldId = file.slice(0, -5);
  fileFor(oldId);
  const html = fs.readFileSync(path.join(srcDir, file), 'utf8');
  if (!/<meta\s+name="gatherer:url"/i.test(html)) throw new Error('Not a Gatherer note');
  const note = parse(oldId, html);
  let id = oldId;
  if (fs.existsSync(fileFor(id))) {
    if (get(id).content === sanitize(note.content)) return null;
    id = newId();
  }
  const srcAssets = path.join(srcDir, 'assets', oldId);
  if (fs.existsSync(srcAssets)) {
    const dest = assetDir(id);
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(srcAssets)) {
      const from = path.join(srcAssets, f);
      if (/^[\w-]+\.[a-z]+$/i.test(f) && fs.lstatSync(from).isFile()) fs.copyFileSync(from, path.join(dest, f));
    }
  }
  const content = id === oldId ? note.content : note.content.split(`gatherer-asset://${oldId}/`).join(`gatherer-asset://${id}/`);
  writeAtomic(fileFor(id), render({ ...note, tags: cleanTags(note.tags), content: sanitize(content) }));
  return id;
}

module.exports = { setDir, getDir, list, get, create, save, setSubject, remove, importNote, assetsRoot, assetDir };
