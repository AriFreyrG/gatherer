// Fetches a URL and turns it into clean, sanitized article HTML. No Electron deps.
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const createDOMPurify = require('dompurify');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const TAGS = ['h1','h2','h3','h4','h5','h6','p','br','hr','ul','ol','li','dl','dt','dd','blockquote','pre','code','kbd','samp',
  'figure','figcaption','img','table','thead','tbody','tfoot','tr','th','td','caption','a','strong','b','em','i','u','s','del','ins',
  'mark','sub','sup','small','abbr','cite','q','time','span','div','section','article'];
const ATTRS = ['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'target', 'rel'];
const REMOVE = 'script,style,noscript,iframe,form,input,button,select,textarea,nav,svg,canvas,video,audio,object,embed,link,meta';

// Clutter detection works on whole class/id words, split on '-' and '_' and camelCase, so
// "post-share" and "shareBar" match "share" but "shared-content" and "leader" don't.
const CLUTTER = new Set(['ad', 'ads', 'advert', 'adverts', 'advertisement', 'advertising', 'sponsor', 'sponsors', 'sponsored',
  'promo', 'promos', 'promoted', 'newsletter', 'newsletters', 'subscribe', 'share', 'shares', 'sharing', 'sharebar', 'social',
  'related', 'recommended', 'comment', 'comments', 'disqus', 'outbrain', 'taboola']);
// Words that turn a clutter word into a state flag about the page ("has-comments", "ad-free").
const BEFORE_OK = new Set(['has', 'no', 'with', 'without', 'is', 'allow', 'allows', 'enable', 'enabled', 'show']);
const AFTER_OK = new Set(['free', 'enabled', 'disabled', 'allowed', 'open', 'closed', 'count']);

const purifyWindow = new JSDOM('').window;
const DOMPurify = createDOMPurify(purifyWindow);
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  } else if (node.tagName === 'A') {
    node.removeAttribute('target'); node.removeAttribute('rel');
  }
});

function sanitize(html) {
  return DOMPurify.sanitize(String(html || ''), {
    ALLOWED_TAGS: TAGS,
    ALLOWED_ATTR: ATTRS, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|gatherer-asset:)/i,
  }).trim();
}

function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Please enter a URL');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/]*:\d+(\/|$)/.test(s)) throw new Error('Only http and https URLs are supported');
    s = 'https://' + s;
  }
  let u;
  try { u = new URL(s); } catch { throw new Error(`"${input}" is not a valid URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https URLs are supported');
  return u.href;
}

async function fetchHtml(url) {
  const host = new URL(url).hostname;
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'en-US,en;q=0.9' },
    });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new Error(`Could not reach ${host} (${timeout ? 'timeout' : (e.cause && e.cause.code) || e.message})`);
  }
  if (!res.ok) throw new Error(`${host} responded with HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`);
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (type && !/(text\/html|application\/xhtml)/.test(type)) {
    throw new Error(`This link is not a web page (${type.split(';')[0]}), so it can't be gathered`);
  }
  let buf;
  try { buf = Buffer.from(await res.arrayBuffer()); }
  catch (e) { throw new Error(`Could not read ${host} (${e.name === 'TimeoutError' ? 'timeout' : e.message})`); }
  // Decode using header charset, else sniff <meta charset>, else utf-8.
  let charset = (type.match(/charset=([\w-]+)/) || [])[1];
  if (!charset) charset = (buf.subarray(0, 4096).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  let html;
  try { html = new TextDecoder(charset || 'utf-8').decode(buf); } catch { html = buf.toString('utf8'); }
  return { html, finalUrl: res.url || url };
}

const abs = (v, base) => { try { return new URL(v, base).href; } catch { return null; } };

function firstSrcset(srcset) {
  const first = String(srcset || '').split(',')[0].trim().split(/\s+/)[0];
  return first || null;
}

// Resolve lazy-loaded images, <picture>, absolute URLs; drop unusable images.
function fixImages(root, base) {
  for (const pic of root.querySelectorAll('picture')) {
    const img = pic.querySelector('img');
    if (img) {
      if (!img.getAttribute('src') && !img.getAttribute('data-src')) {
        const s = pic.querySelector('source[srcset],source[data-srcset]');
        if (s) img.setAttribute('srcset', s.getAttribute('srcset') || s.getAttribute('data-srcset'));
      }
      pic.replaceWith(img);
    }
  }
  for (const img of root.querySelectorAll('img')) {
    const cur = img.getAttribute('src') || '';
    let src = null;
    const lazy = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-url'].map((a) => img.getAttribute(a)).find(Boolean);
    if (lazy && (!cur || cur.startsWith('data:'))) src = lazy;
    else if (cur && !cur.startsWith('data:')) src = cur;
    if (!src) src = firstSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset'));
    src = src && abs(src.trim(), base);
    const w = parseInt(img.getAttribute('width'), 10), h = parseInt(img.getAttribute('height'), 10);
    if (!src || !/^https?:/.test(src) || w <= 2 || h <= 2) { img.remove(); continue; }
    img.setAttribute('src', src);
  }
}

// The clutter word an element's class or id names, or null.
function clutterWord(el) {
  for (const name of [el.getAttribute('class') || '', el.getAttribute('id') || '']) {
    for (const part of name.split(/\s+/)) {
      const words = part.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase().split(/[-_]+/).filter(Boolean);
      for (let i = 0; i < words.length; i++) {
        if (CLUTTER.has(words[i]) && !BEFORE_OK.has(words[i - 1]) && !AFTER_OK.has(words[i + 1])) return words[i];
      }
    }
  }
  return null;
}

const textLen = (el) => el.textContent.replace(/\s+/g, ' ').trim().length;
function linkDensity(el) {
  const total = textLen(el);
  if (!total) return 0;
  let links = 0;
  for (const a of el.querySelectorAll('a')) links += textLen(a);
  return links / total;
}
const longParagraphs = (el) => [...el.querySelectorAll('p')].filter((p) => textLen(p) >= 80).length;

// True when el holds enough of the article that removing it would lose real content.
function substantial(el, rootLen, { paragraphs = 3 } = {}) {
  if (el.querySelector('h1,h2')) return true;
  const len = textLen(el);
  if (rootLen >= 600 && len >= rootLen * 0.3) return true;
  return linkDensity(el) < 0.35 && longParagraphs(el) >= paragraphs;
}

// Removes share bars, ads, related links and similar widgets named by their class or id,
// unless they hold a real share of the text.
function removeClutter(root) {
  const rootLen = textLen(root);
  for (const el of [...root.querySelectorAll('[class],[id]')]) {
    if (!el.isConnected || el === root) continue;
    const word = clutterWord(el);
    if (!word) continue;
    // Comment threads are prose too, so only their size can protect them.
    if (!substantial(el, rootLen, { paragraphs: /^comments?$|^disqus$/.test(word) ? Infinity : 3 })) el.remove();
  }
}

function clean(root, base) {
  root.querySelectorAll(REMOVE).forEach((n) => n.remove());
  const rootLen = textLen(root);
  // Asides and footers are often callouts or notes inside the article: keep those that read like prose.
  for (const el of [...root.querySelectorAll('aside,footer')]) {
    if (el.isConnected && !substantial(el, rootLen, { paragraphs: el.tagName === 'ASIDE' ? 1 : 2 })) el.remove();
  }
  removeClutter(root);
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (href.startsWith('#') || /^javascript:/i.test(href)) { a.replaceWith(...a.childNodes); continue; }
    const u = abs(href, base);
    if (u) a.setAttribute('href', u);
  }
  fixImages(root, base);
  // Unwrap empty links/paragraphs left behind.
  for (const p of root.querySelectorAll('p,div,span,a')) {
    if (!p.textContent.trim() && !p.querySelector('img,table,pre,hr')) p.remove();
  }
}

const meta = (doc, sel) => (doc.querySelector(sel)?.getAttribute('content') || '').trim();

// Topic hints the page declares about itself: section, tags, keywords (meta and JSON-LD).
function pageTags(doc) {
  const out = [];
  const push = (v) => { for (const t of String(v || '').split(/[,;|]/)) { const s = t.trim(); if (s && s.length <= 40) out.push(s); } };
  doc.querySelectorAll('meta[property="article:section"],meta[property="article:tag"],meta[name="news_keywords"],meta[name="keywords"],meta[name="parsely-section"]')
    .forEach((m) => push(m.getAttribute('content')));
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) return o.forEach(walk);
        for (const k of ['articleSection', 'keywords', 'genre']) {
          const v = o[k];
          if (Array.isArray(v)) v.forEach(push); else if (typeof v === 'string') push(v);
        }
        if (o['@graph']) walk(o['@graph']);
      };
      walk(JSON.parse(s.textContent));
    } catch { /* ignore malformed JSON-LD */ }
  }
  const seen = new Set();
  return out.filter((t) => { const k = t.toLowerCase(); if (seen.has(k) || /^(news|home|article|index|blog|post)$/i.test(t)) return false; seen.add(k); return true; }).slice(0, 12);
}

function extract(html, finalUrl) {
  const dom = new JSDOM(html, { url: finalUrl }); // scripts not executed by default
  const doc = dom.window.document;
  const host = new URL(finalUrl).hostname;
  const ogTitle = meta(doc, 'meta[property="og:title"]');
  const ogImage = abs(meta(doc, 'meta[property="og:image"]') || meta(doc, 'meta[name="twitter:image"]'), finalUrl);
  const docTitle = (doc.title || '').trim();
  fixImages(doc.body || doc, finalUrl); // before Readability strips lazy attrs
  // Readability drops class and id names, so clutter is removed by name before it runs.
  if (doc.body) removeClutter(doc.body);
  // Readability deletes every <aside>; keep callouts written inside the article as plain blocks.
  for (const el of [...doc.querySelectorAll('article aside,main aside')]) {
    if (!substantial(el, Infinity, { paragraphs: 1 })) continue;
    const div = doc.createElement('div');
    div.append(...el.childNodes);
    el.replaceWith(div);
  }

  let article = null;
  try { article = new Readability(doc.cloneNode(true)).parse(); } catch { /* fall back below */ }

  // Readability sometimes keeps only one section of a long page. When the page's own <article>
  // or <main> holds much more text than Readability kept, use that element instead.
  const semantic = [...doc.querySelectorAll('article,main,[role="main"]')]
    .reduce((best, el) => (!best || textLen(el) > textLen(best) ? el : best), null);
  const readLen = article && article.content ? article.textContent.replace(/\s+/g, ' ').trim().length : 0;
  const useReadability = readLen > 140 && !(semantic && readLen < textLen(semantic) * 0.5);

  let container;
  if (useReadability) {
    container = new JSDOM(`<body>${article.content}</body>`, { url: finalUrl }).window.document.body;
  } else {
    const src = semantic || doc.body;
    container = new JSDOM(`<body>${src ? src.innerHTML : ''}</body>`, { url: finalUrl }).window.document.body;
  }
  clean(container, finalUrl);
  let content = sanitize(container.innerHTML);
  if (!content || !/<(p|li|pre|table|h\d|blockquote)\b/i.test(content) && content.replace(/<[^>]+>/g, '').trim().length < 20) {
    throw new Error(`Could not find any readable content on ${host}`);
  }
  if (ogImage && !/<img\b/i.test(content) && /^https?:/.test(ogImage)) {
    content = sanitize(`<p><img src="${ogImage.replace(/"/g, '&quot;')}" alt=""></p>`) + content;
  }
  const title = (article && article.title || '').trim() || ogTitle || docTitle || host;
  const siteName = (article && article.siteName || '').trim() || meta(doc, 'meta[property="og:site_name"]') || meta(doc, 'meta[name="application-name"]');
  return { title, content, url: finalUrl, siteName, tags: pageTags(doc) };
}

async function scrape(input) {
  const url = normalizeUrl(input);
  const { html, finalUrl } = await fetchHtml(url);
  // The raw page comes back too, so the offline copy is made from the same fetch as the note.
  try { return { ...extract(html, finalUrl), html, finalUrl }; }
  catch (e) {
    if (e.message.startsWith('Could not find')) throw e;
    throw new Error(`Could not process the page at ${new URL(finalUrl).hostname} (${e.message})`);
  }
}

module.exports = { scrape, sanitize, normalizeUrl, fetchHtml, extract, UA };
