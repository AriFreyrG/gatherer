// Builds a full offline snapshot of a gathered page: one self-contained HTML file with every
// stylesheet, image and font inlined as data: URIs and every script removed, so the page can be
// read exactly as it looked with no network. No Electron deps.
const { JSDOM, VirtualConsole } = require('jsdom');

const FILE = 'page.html'; // stored as <notes>/assets/<id>/page.html
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// Applied twice: as a <meta> in the file (for opening it in any browser) and as a response header
// when the app shows it. Nothing in a snapshot can run code or reach the network.
const CSP = "default-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";

const DEFAULTS = {
  maxResources: 400,
  maxResourceBytes: 10 * 1024 * 1024,
  maxTotalBytes: 60 * 1024 * 1024,
  timeoutMs: 15000,
  deadlineMs: 60000,
  concurrency: 6,
};
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  otf: 'font/otf', eot: 'application/vnd.ms-fontobject', css: 'text/css',
};
const REMOVE = 'script,iframe,frame,frameset,object,embed,applet,base,portal,video,audio,track,meta[http-equiv],link[rel~="preload"],link[rel~="prefetch"],link[rel~="preconnect"],link[rel~="dns-prefetch"],link[rel~="modulepreload"],link[rel~="manifest"]';
const LAZY = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-url'];

const abs = (v, base) => { try { return new URL(String(v).trim(), base).href; } catch { return null; } };
const isHttp = (u) => /^https?:/i.test(u || '');

// Fetches subresources with a shared byte budget and an overall deadline; each URL is fetched once.
function makeFetcher(referer, opts) {
  const o = { ...DEFAULTS, ...opts };
  const doFetch = o.fetch || fetch;
  const started = Date.now();
  const cache = new Map();
  let total = 0, count = 0, active = 0;
  const waiting = [];
  const slot = () => (active < o.concurrency ? (active++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
  const release = () => { const next = waiting.shift(); if (next) next(); else active--; };

  async function load(url) {
    if (count++ >= o.maxResources || Date.now() - started > o.deadlineMs || total >= o.maxTotalBytes) return null;
    await slot();
    try {
      const res = await doFetch(url, {
        redirect: 'follow', signal: AbortSignal.timeout(o.timeoutMs),
        headers: { 'User-Agent': UA, Accept: '*/*', ...(referer ? { Referer: referer } : {}) },
      });
      if (!res.ok) return null;
      if (Number(res.headers.get('content-length')) > o.maxResourceBytes) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > o.maxResourceBytes || total + buf.length > o.maxTotalBytes) return null;
      total += buf.length;
      let type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!type || type === 'application/octet-stream' || type === 'binary/octet-stream') {
        const ext = (new URL(res.url || url).pathname.match(/\.([a-z0-9]+)$/i) || [])[1];
        type = MIME_BY_EXT[(ext || '').toLowerCase()] || type || 'application/octet-stream';
      }
      return { buf, type, url: res.url || url };
    } catch { return null; } finally { release(); }
  }
  const get = (url) => { if (!cache.has(url)) cache.set(url, load(url)); return cache.get(url); };
  const stats = () => ({ resources: count, bytes: total });
  return { get, stats };
}

const dataUri = ({ buf, type }) => `data:${type};base64,${buf.toString('base64')}`;

async function inlineUrl(url, base, fetcher, accept) {
  const u = abs(url, base);
  if (!u || !isHttp(u)) return null;
  const r = await fetcher.get(u);
  if (!r || (accept && !accept.test(r.type))) return null;
  return dataUri(r);
}

const URL_RE = /url\(\s*(['"]?)([^'")]*?)\1\s*\)/gi;
const IMPORT_RE = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?\s*([^;]*);/gi;

async function replaceAsync(str, re, fn) {
  const jobs = [];
  str.replace(re, (...m) => { jobs.push(fn(...m)); return m[0]; });
  const out = await Promise.all(jobs);
  let i = 0;
  return str.replace(re, () => out[i++]);
}

// Inlines @import rules (a few levels deep) and every url() in a stylesheet.
async function inlineCss(css, base, fetcher, depth = 0) {
  css = await replaceAsync(css, IMPORT_RE, async (whole, _q, href, media) => {
    const u = abs(href, base);
    if (depth > 3 || !u || !isHttp(u)) return '';
    const r = await fetcher.get(u);
    if (!r) return '';
    const inner = await inlineCss(r.buf.toString('utf8'), r.url, fetcher, depth + 1);
    return media.trim() ? `@media ${media.trim()} {\n${inner}\n}` : inner;
  });
  return replaceAsync(css, URL_RE, async (whole, _q, ref) => {
    if (!ref || /^(data:|#)/i.test(ref)) return whole;
    const d = await inlineUrl(ref, base, fetcher);
    return d ? `url("${d}")` : 'url("")';
  });
}
// Stops a fetched stylesheet from closing its <style> element early.
const safeStyle = (css) => css.replace(/<\/(style)/gi, '<\\/$1');

function parseSrcset(s) {
  return String(s || '').split(/,\s+(?=\S)/).map((part) => {
    const [url, d] = part.trim().split(/\s+/);
    const m = (d || '').match(/^([\d.]+)([wx])$/);
    return { url, w: m && m[2] === 'w' ? +m[1] : 0, x: m && m[2] === 'x' ? +m[1] : (m ? 0 : 1) };
  }).filter((c) => c.url);
}
// A sharp but not huge candidate: the widest up to 1600px, or the densest up to 2x.
function bestFromSrcset(s) {
  const c = parseSrcset(s);
  if (!c.length) return null;
  const byW = c.filter((x) => x.w).sort((a, b) => a.w - b.w);
  if (byW.length) return (byW.filter((x) => x.w <= 1600).pop() || byW[0]).url;
  const byX = c.sort((a, b) => a.x - b.x);
  return (byX.filter((x) => x.x <= 2).pop() || byX[0]).url;
}

function imageSource(img) {
  const cur = img.getAttribute('src') || '';
  const lazy = LAZY.map((a) => img.getAttribute(a)).find(Boolean);
  const set = img.getAttribute('srcset') || img.getAttribute('data-srcset');
  if (set) { const b = bestFromSrcset(set); if (b) return b; }
  if (lazy && (!cur || cur.startsWith('data:'))) return lazy;
  return cur || lazy || null;
}

// Strips everything that could run code, phone home or navigate the app.
function neutralize(doc, base) {
  // Without scripts, <noscript> holds what the reader should see.
  for (const ns of doc.querySelectorAll('noscript')) {
    const frag = JSDOM.fragment(ns.textContent && !ns.children.length ? ns.textContent : ns.innerHTML);
    ns.replaceWith(frag);
  }
  doc.querySelectorAll(REMOVE).forEach((n) => n.remove());
  for (const el of doc.querySelectorAll('*')) {
    for (const { name, value } of [...el.attributes]) {
      const n = name.toLowerCase();
      if (n.startsWith('on') || n === 'srcdoc' || n === 'ping' || n === 'integrity' || n === 'nonce' ||
          (/^(href|src|action|formaction|xlink:href|data)$/.test(n) && /^\s*(javascript|vbscript):/i.test(value))) {
        el.removeAttribute(name);
      }
    }
  }
  for (const a of doc.querySelectorAll('a[href], area[href]')) {
    const href = a.getAttribute('href');
    if (href.startsWith('#')) continue;
    const u = abs(href, base);
    if (u) { a.setAttribute('href', u); a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer'); }
    else a.removeAttribute('href');
  }
  doc.querySelectorAll('form').forEach((f) => f.removeAttribute('action'));
}

async function inlineResources(doc, base, fetcher) {
  const jobs = [];
  // Stylesheets become <style> blocks, keeping their media queries.
  for (const link of doc.querySelectorAll('link[href]')) {
    const rel = (link.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    if (rel.includes('stylesheet') && !rel.includes('alternate')) {
      jobs.push((async () => {
        const u = abs(link.getAttribute('href'), base);
        const r = u && isHttp(u) ? await fetcher.get(u) : null;
        if (!r) { link.remove(); return; }
        const style = doc.createElement('style');
        const media = link.getAttribute('media');
        if (media && media !== 'all') style.setAttribute('media', media);
        style.textContent = safeStyle(await inlineCss(r.buf.toString('utf8'), r.url, fetcher));
        link.replaceWith(style);
      })());
    } else if (rel.includes('icon')) {
      jobs.push((async () => {
        const d = await inlineUrl(link.getAttribute('href'), base, fetcher, /^image\//);
        if (d) link.setAttribute('href', d); else link.remove();
      })());
    } else if (!rel.includes('canonical')) link.remove();
  }
  for (const style of doc.querySelectorAll('style')) {
    jobs.push((async () => { style.textContent = safeStyle(await inlineCss(style.textContent, base, fetcher)); })());
  }
  for (const el of doc.querySelectorAll('[style]')) {
    if (!/url\(/i.test(el.getAttribute('style'))) continue;
    jobs.push((async () => { el.setAttribute('style', await inlineCss(el.getAttribute('style'), base, fetcher)); })());
  }
  // <picture> sources would win over the inlined <img>, so fold them into it.
  for (const pic of doc.querySelectorAll('picture')) {
    const img = pic.querySelector('img');
    const src = pic.querySelector('source[srcset],source[data-srcset]');
    if (img && src && !img.getAttribute('srcset')) img.setAttribute('srcset', src.getAttribute('srcset') || src.getAttribute('data-srcset'));
    pic.querySelectorAll('source').forEach((s) => s.remove());
  }
  for (const img of doc.querySelectorAll('img')) {
    jobs.push((async () => {
      const src = imageSource(img);
      const d = src && !src.startsWith('data:') ? await inlineUrl(src, base, fetcher, /^image\//) : null;
      for (const a of ['srcset', 'data-srcset', 'sizes', 'loading', 'decoding', 'crossorigin', ...LAZY]) img.removeAttribute(a);
      if (d) img.setAttribute('src', d);
      else if (src && src.startsWith('data:')) img.setAttribute('src', src);
      else img.removeAttribute('src');
    })());
  }
  for (const el of doc.querySelectorAll('image[href], image[xlink\\:href], input[type="image"][src]')) {
    const attr = el.hasAttribute('src') ? 'src' : el.hasAttribute('href') ? 'href' : 'xlink:href';
    jobs.push((async () => {
      const d = await inlineUrl(el.getAttribute(attr), base, fetcher, /^image\//);
      if (d) el.setAttribute(attr, d); else el.removeAttribute(attr);
    })());
  }
  await Promise.all(jobs);
}

// html: the page's raw HTML; url: its final URL. Returns the snapshot HTML and what it contains.
async function snapshot(html, url, opts = {}) {
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() }); // scripts are never executed; CSS parse noise is dropped
  const doc = dom.window.document;
  const fetcher = makeFetcher(url, opts);
  neutralize(doc, url);
  await inlineResources(doc, url, fetcher);

  const head = doc.head || doc.documentElement.insertBefore(doc.createElement('head'), doc.body);
  head.querySelectorAll('meta[charset]').forEach((m) => m.remove());
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', CSP);
  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  const from = doc.createElement('meta');
  from.setAttribute('name', 'gatherer:archived-from');
  from.setAttribute('content', url);
  const at = doc.createElement('meta');
  at.setAttribute('name', 'gatherer:archived-at');
  at.setAttribute('content', opts.date || new Date().toISOString());
  head.prepend(charset, csp, from, at);

  const out = `<!doctype html>\n<!-- Offline copy saved by Gatherer from ${url.replace(/--/g, '%2D%2D')} -->\n` + doc.documentElement.outerHTML + '\n';
  return { html: out, ...fetcher.stats() };
}

module.exports = { FILE, CSP, snapshot, inlineCss, bestFromSrcset };
