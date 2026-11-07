// Exports notes to Markdown (with their images copied alongside) and to PDF.
// Markdown export is plain Node and testable; PDF export renders in a hidden Electron window.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { toMarkdown, frontMatter } = require('./markdown');
const { resolveAsset, SCHEME } = require('./images');

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon' };

// A title made safe to use as a file name on macOS, Windows and Linux.
function fileName(title) {
  const base = String(title || '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80).trim();
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base) || !base ? 'Untitled' : base;
}

// First name of the form "base", "base 2", "base 3"… for which none of the given suffixes exist in dir.
function uniqueName(dir, base, suffixes, taken = new Set()) {
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base} ${i}`;
    if (taken.has(name.toLowerCase())) continue;
    if (suffixes.every((s) => !fs.existsSync(path.join(dir, name + s)))) { taken.add(name.toLowerCase()); return name; }
  }
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

// Writes <dir>/<Title>.md and, if the note has saved images, <dir>/<Title> files/.
// Returns the path of the .md file.
function writeMarkdown(note, dir, { assetsRoot, taken } = {}) {
  const name = uniqueName(dir, fileName(note.title), ['.md', ' files'], taken);
  const filesDir = `${name} files`;
  const copied = new Map();
  const image = (src) => {
    if (!assetsRoot || !src.startsWith(`${SCHEME}:`)) return null;
    if (copied.has(src)) return copied.get(src);
    const file = resolveAsset(src, assetsRoot);
    if (!file || !fs.existsSync(file)) return null;
    fs.mkdirSync(path.join(dir, filesDir), { recursive: true });
    fs.copyFileSync(file, path.join(dir, filesDir, path.basename(file)));
    const rel = encodePath(`${filesDir}/${path.basename(file)}`);
    copied.set(src, rel);
    return rel;
  };
  const md = frontMatter(note) + `\n# ${note.title || 'Untitled'}\n\n` + toMarkdown(note.content, { image });
  const out = path.join(dir, `${name}.md`);
  fs.writeFileSync(out, md, 'utf8');
  return out;
}

// Exports every note into dir. getNote(id) loads a full note. Returns the number written.
function writeAllMarkdown(summaries, getNote, dir, opts = {}) {
  const taken = new Set();
  let n = 0;
  for (const s of summaries) {
    try { writeMarkdown(getNote(s.id), dir, { ...opts, taken }); n++; }
    catch (e) { console.warn(`[export] skipped ${s.id}: ${e.message}`); }
  }
  return n;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A standalone, print-styled HTML page for a note, with saved images inlined as data: URLs
// so the page needs nothing from the app to render.
function printableHtml(note, { assetsRoot } = {}) {
  const content = String(note.content || '').replace(new RegExp(`${SCHEME}://[\\w-]+/[\\w.-]+`, 'g'), (src) => {
    const file = assetsRoot && resolveAsset(src, assetsRoot);
    const mime = file && MIME[path.extname(file).slice(1).toLowerCase()];
    if (!mime || !fs.existsSync(file)) return src;
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  });
  const date = note.dateGathered ? new Date(note.dateGathered) : null;
  const meta = [
    date && !isNaN(date) ? `Gathered ${esc(date.toLocaleDateString(undefined, { dateStyle: 'long' }))}` : '',
    note.url ? `<a href="${esc(note.url)}">${esc(note.url)}</a>` : '',
  ].filter(Boolean).join(' · ');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'">
<title>${esc(note.title)}</title><style>
  @page { margin: 18mm 16mm; }
  body { font: 11.5pt/1.6 Georgia, "Iowan Old Style", "Times New Roman", serif; color: #111; margin: 0; overflow-wrap: anywhere; }
  h1.title { font: 700 22pt/1.2 -apple-system, "Helvetica Neue", Arial, sans-serif; margin: 0 0 6pt; }
  .meta { font: 9pt/1.4 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #666; padding-bottom: 10pt; margin-bottom: 16pt; border-bottom: 1px solid #ccc; }
  .meta a { color: #666; }
  h1, h2, h3, h4 { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; line-height: 1.25; margin: 1.4em 0 .4em; break-after: avoid; }
  p { margin: 0 0 .9em; orphans: 3; widows: 3; }
  a { color: #2a4bc4; }
  img, video { max-width: 100%; height: auto; break-inside: avoid; }
  figure { margin: 1.2em 0; break-inside: avoid; } figcaption { font-size: .85em; color: #666; text-align: center; }
  blockquote { margin: 1em 0; padding: .1em 1em; border-left: 3px solid #ccc; color: #444; }
  pre { background: #f4f4f6; padding: 10px 12px; border-radius: 6px; white-space: pre-wrap; font: 9pt/1.5 ui-monospace, Menlo, monospace; break-inside: avoid; }
  code { background: #f4f4f6; padding: .1em .3em; border-radius: 3px; font: .88em ui-monospace, Menlo, monospace; } pre code { background: none; padding: 0; }
  table { border-collapse: collapse; margin: 1em 0; } th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; }
  hr { border: 0; border-top: 1px solid #ccc; margin: 1.6em 0; }
</style></head><body>
<h1 class="title">${esc(note.title || 'Untitled')}</h1>
${meta ? `<div class="meta">${meta}</div>` : ''}
${content}
</body></html>`;
}

// Renders a note to a PDF Buffer in a hidden, script-free window.
async function renderPdf(note, { assetsRoot } = {}) {
  const { BrowserWindow, app } = require('electron');
  const tmp = fs.mkdtempSync(path.join(app ? app.getPath('temp') : os.tmpdir(), 'gatherer-pdf-'));
  const file = path.join(tmp, 'note.html');
  fs.writeFileSync(file, printableHtml(note, { assetsRoot }), 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, contextIsolation: true } });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await win.loadFile(file);
    const letter = ['US', 'CA', 'MX', 'PH', 'CL', 'CO'].includes(app.getLocaleCountryCode());
    return await win.webContents.printToPDF({ printBackground: true, pageSize: letter ? 'Letter' : 'A4', generateDocumentOutline: true });
  } finally {
    win.destroy();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { fileName, uniqueName, writeMarkdown, writeAllMarkdown, printableHtml, renderPdf };
