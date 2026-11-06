// Downloads a note's remote images into its own asset folder so notes keep working offline
// and opening a note doesn't contact the original site. No Electron deps.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SCHEME = 'gatherer-asset';
const MAX_IMAGES = 60;
const MAX_BYTES = 15 * 1024 * 1024;
const CONCURRENCY = 4;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/x-icon': 'ico' };
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const assetUrl = (id, file) => `${SCHEME}://${id}/${file}`;

async function download(url, referer) {
  const res = await fetch(url, {
    redirect: 'follow', signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.5', ...(referer ? { Referer: referer } : {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = EXT[type];
  if (!ext) throw new Error(`not an image (${type || 'unknown type'})`);
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('too large');
  return { buf, ext };
}

// Rewrites every http(s) <img src> in html to a local asset URL, saving files under dir.
// Images that fail to download keep their remote src. Returns the new html.
async function localize(html, { id, dir, referer }) {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const imgs = [...doc.querySelectorAll('img[src]')].filter((i) => /^https?:/i.test(i.getAttribute('src'))).slice(0, MAX_IMAGES);
  if (!imgs.length) return html;
  fs.mkdirSync(dir, { recursive: true });
  const bySrc = new Map(); // same image used twice -> one file
  let n = 0;
  const queue = [...new Set(imgs.map((i) => i.getAttribute('src')))];
  const worker = async () => {
    while (queue.length) {
      const src = queue.shift();
      const idx = ++n;
      try {
        const { buf, ext } = await download(src, referer);
        const file = `img-${String(idx).padStart(3, '0')}.${ext}`;
        fs.writeFileSync(path.join(dir, file), buf);
        bySrc.set(src, assetUrl(id, file));
      } catch (e) { console.warn(`[images] kept remote ${src}: ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  for (const img of imgs) {
    const local = bySrc.get(img.getAttribute('src'));
    if (local) { img.setAttribute('src', local); img.removeAttribute('srcset'); }
  }
  return doc.body.innerHTML;
}

// Maps a gatherer-asset:// URL to a file path inside root, or null if it isn't a valid asset URL.
function resolveAsset(url, root) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== `${SCHEME}:`) return null;
  const id = u.hostname;
  const file = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!/^[\w-]+$/.test(id) || !/^[\w-]+\.[a-z]+$/i.test(file)) return null;
  return path.join(root, id, file);
}

module.exports = { SCHEME, localize, resolveAsset };
