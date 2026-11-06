// One standalone HTML file per note. Dir is injectable for tests; defaults to userData/notes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sanitize } = require('./scraper');

let dir = null;
function setDir(d) { dir = d; }
function getDir() {
  if (!dir) dir = path.join(require('electron').app.getPath('userData'), 'notes');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const unesc = (s) => s.replace(/&(#39|quot|lt|gt|amp);/g, (_, e) => ({ '#39': "'", quot: '"', lt: '<', gt: '>', amp: '&' }[e]));

function fileFor(id) {
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) throw new Error('Invalid note id');
  return path.join(getDir(), id + '.html');
}

function newId() {
  const d = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');
  return `${d}-${crypto.randomBytes(2).toString('hex')}`;
}

function render({ title, url, dateGathered, content }) {
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${esc(title)}</title>\n` +
    `<meta name="gatherer:url" content="${esc(url)}">\n<meta name="gatherer:date-gathered" content="${esc(dateGathered)}">\n` +
    `</head><body>${content}</body></html>\n`;
}

function parse(id, html) {
  const metaVal = (name) => {
    const m = html.match(new RegExp(`<meta\\s+name="gatherer:${name}"\\s+content="([^"]*)"`, 'i'));
    return m ? unesc(m[1]) : '';
  };
  const t = html.match(/<title>([\s\S]*?)<\/title>/i);
  const b = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return { id, title: t ? unesc(t[1]) : 'Untitled', url: metaVal('url'), dateGathered: metaVal('date-gathered'), content: b ? b[1] : '' };
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

const summary = ({ id, title, url, dateGathered }) => ({ id, title, url, dateGathered });

function list() {
  const out = [];
  for (const f of fs.readdirSync(getDir())) {
    if (!/^[\w-]+\.html$/.test(f)) continue;
    try { out.push(summary(parse(f.slice(0, -5), fs.readFileSync(path.join(getDir(), f), 'utf8')))); } catch { /* skip unreadable */ }
  }
  return out.sort((a, b) => (b.dateGathered || '').localeCompare(a.dateGathered || ''));
}

function get(id) {
  try { return parse(id, fs.readFileSync(fileFor(id), 'utf8')); }
  catch (e) { throw e.code === 'ENOENT' ? new Error('Note not found') : e; }
}

function create({ title, url, dateGathered, content }) {
  const id = newId();
  const note = { title: String(title || 'Untitled'), url: url || '', dateGathered: dateGathered || new Date().toISOString(), content: sanitize(content) };
  writeAtomic(fileFor(id), render(note));
  return { id, ...note };
}

function save(id, { title, content } = {}) {
  const cur = get(id);
  const next = { ...cur, title: String(title ?? cur.title).trim() || 'Untitled', content: sanitize(content ?? cur.content) };
  writeAtomic(fileFor(id), render(next));
  return summary(next);
}

function remove(id) {
  try { fs.unlinkSync(fileFor(id)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return true;
}

module.exports = { setDir, list, get, create, save, remove };
