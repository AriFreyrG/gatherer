// Reddit posts, read from the page as a browser shows it. Reddit serves post pages as a script
// shell and walls off its .json and old.reddit pages for apps, and its API now needs Reddit's
// approval, so Gatherer reads the page your browser already rendered (sent by the extension)
// or one rendered in Gatherer's hidden window. Handles the current site (<shreddit-post>,
// <shreddit-comment>) and old.reddit.com. No Electron deps.
const { JSDOM, VirtualConsole } = require('jsdom');
const { sanitize } = require('./scraper');

const BASE = 'https://www.reddit.com';
const MAX_TOTAL = 300; // comments kept in all
const HOSTS = /^(?:www\.|old\.|new\.|np\.|m\.|sh\.)?reddit\.com$/i;

// { id } for a Reddit post link, { share } for a /r/<sub>/s/<code> share link, or null.
function parsePostUrl(input) {
  let u;
  try { u = new URL(input); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (host === 'redd.it') {
    const m = u.pathname.match(/^\/([a-z0-9]{4,10})\/?$/i);
    return m ? { id: m[1].toLowerCase() } : null;
  }
  if (!HOSTS.test(host)) return null;
  let m = u.pathname.match(/^\/(?:r|u|user)\/[^/]+\/comments\/([a-z0-9]{4,10})(?:\/|$)/i)
    || u.pathname.match(/^\/comments\/([a-z0-9]{4,10})(?:\/|$)/i);
  if (m) return { id: m[1].toLowerCase() };
  m = u.pathname.match(/^\/r\/[^/]+\/s\/([a-z0-9]+)\/?$/i);
  if (m) return { share: u.href };
  return null;
}

const isRedditUrl = (url) => { try { const h = new URL(url).hostname; return HOSTS.test(h) || h === 'redd.it'; } catch { return false; } };

/* ---------- reading the page ---------- */

const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const num = (v) => { const n = parseInt(String(v || '').replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : null; };
const iso = (v) => { if (!v) return ''; const d = new Date(/^\d+(\.\d+)?$/.test(v) ? Number(v) * (Number(v) < 1e12 ? 1000 : 1) : v); return isNaN(d) ? '' : d.toISOString(); };
// The element's own descendants matching sel, not those inside a nested comment.
const own = (el, sel, scope) => [...el.querySelectorAll(sel)].filter((x) => x.closest(scope) === el);

function images(root, base) {
  const out = [];
  for (const img of root.querySelectorAll('img')) {
    const raw = img.getAttribute('src') || (img.getAttribute('srcset') || '').split(',').pop().trim().split(/\s+/)[0];
    let src;
    try { src = new URL(raw, base).href; } catch { continue; }
    if (!/^https?:/.test(src) || /\/(?:avatars?|emoji|communityIcon|snoovatar)|styles\.redditmedia|static\/|award/i.test(src)) continue;
    const w = num(img.getAttribute('width'));
    if (w !== null && w < 80) continue;
    if (!out.includes(src)) out.push(src);
  }
  return out;
}

// The current site: <shreddit-post> and nested <shreddit-comment> elements.
function readNew(doc, base) {
  const post = doc.querySelector('shreddit-post');
  if (!post) return null;
  const a = (n) => post.getAttribute(n) || '';
  const body = post.querySelector('[slot="text-body"]');
  const mediaBox = post.querySelector('[slot="post-media-container"], gallery-carousel, shreddit-aspect-ratio');
  const type = a('post-type');
  const href = a('content-href');
  const p = {
    title: a('post-title') || text(post.querySelector('[slot="title"]')) || text(doc.querySelector('h1')),
    sub: a('subreddit-prefixed-name').replace(/^r\//, '') || a('subreddit-name'),
    author: a('author'),
    created: iso(a('created-timestamp')),
    score: num(a('score')),
    comments: num(a('comment-count')),
    flair: text(post.querySelector('shreddit-post-flair, flair-tag, [slot="post-flair"]')),
    bodyHtml: body ? body.innerHTML : '',
    images: mediaBox ? images(mediaBox, base) : [],
    video: type === 'video' || !!post.querySelector('shreddit-player, shreddit-player-2'),
    link: type === 'link' && href && !isRedditUrl(href) ? href : '',
    permalink: a('permalink'),
  };
  const comment = (el) => {
    const t = own(el, 'faceplate-timeago[ts], time[datetime]', 'shreddit-comment')[0];
    return {
      author: el.getAttribute('author') || '',
      score: num(el.getAttribute('score')),
      created: iso(el.getAttribute('created') || (t && (t.getAttribute('ts') || t.getAttribute('datetime')))),
      deleted: el.hasAttribute('is-comment-deleted') || el.getAttribute('author') === '[deleted]',
      bodyHtml: (own(el, '[slot="comment"]', 'shreddit-comment')[0] || {}).innerHTML || '',
      replies: [],
    };
  };
  // Build the tree from each comment's nearest comment ancestor.
  const all = [...doc.querySelectorAll('shreddit-comment')];
  const nodes = new Map(all.map((el) => [el, comment(el)]));
  const top = [];
  for (const el of all) {
    const parent = el.parentElement && el.parentElement.closest('shreddit-comment');
    (parent && nodes.has(parent) ? nodes.get(parent).replies : top).push(nodes.get(el));
  }
  p.tree = top;
  return p;
}

// old.reddit.com: .thing.link and nested .thing.comment.
function readOld(doc, base) {
  const post = doc.querySelector('#siteTable .thing.link, .thing.link');
  if (!post) return null;
  const a = (n) => post.getAttribute(n) || '';
  const url = a('data-url');
  const p = {
    title: text(post.querySelector('a.title')),
    sub: a('data-subreddit'),
    author: a('data-author'),
    created: iso(a('data-timestamp')),
    score: num(a('data-score')),
    comments: num(a('data-comments-count')),
    flair: text(post.querySelector('.linkflairlabel')),
    bodyHtml: (post.querySelector('.usertext-body .md') || {}).innerHTML || '',
    images: [],
    video: false,
    link: url && !isRedditUrl(new URL(url, base).href) ? new URL(url, base).href : '',
    permalink: a('data-permalink'),
  };
  if (p.link && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(p.link)) { p.images = [p.link]; p.link = ''; }
  const read = (table) => [...(table ? table.children : [])].filter((el) => el.matches('.thing.comment')).map((el) => ({
    author: el.getAttribute('data-author') || '',
    score: num(text(el.querySelector(':scope > .entry .score.unvoted')) || el.getAttribute('data-score')),
    created: iso((el.querySelector(':scope > .entry time') || { getAttribute: () => '' }).getAttribute('datetime')),
    deleted: el.classList.contains('deleted'),
    bodyHtml: (el.querySelector(':scope > .entry .usertext-body .md') || {}).innerHTML || '',
    replies: read(el.querySelector(':scope > .child > .sitetable')),
  }));
  p.tree = read(doc.querySelector('.commentarea > .sitetable'));
  return p;
}

/* ---------- writing the note ---------- */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const day = (s) => (s ? s.slice(0, 10) : '');
const count = (n, one, many) => (n === null ? '' : `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`);
const userLink = (name) => (!name || name === '[deleted]') ? '<em>[deleted]</em>' : `<a href="${BASE}/user/${encodeURIComponent(name)}">u/${esc(name)}</a>`;
const when = (s) => (s ? `<time datetime="${esc(s)}">${day(s)}</time>` : '');

function comments(list, budget) {
  const out = [];
  for (const c of list) {
    if (budget.left <= 0) break;
    if (c.deleted && !c.replies.length) continue;
    budget.left -= 1;
    const meta = [count(c.score, 'point', 'points'), when(c.created)].filter(Boolean).join(' · ');
    out.push(`<blockquote><p><strong>${userLink(c.author)}</strong>${meta ? ' · ' + meta : ''}</p>`
      + `${c.deleted ? '<p><em>[deleted]</em></p>' : c.bodyHtml}${comments(c.replies, budget)}</blockquote>`);
  }
  return out.join('');
}

// Makes Reddit's own HTML safe and self-contained: absolute links, sanitized.
function finish(html, base) {
  const body = new JSDOM(`<body>${html}</body>`).window.document.body;
  for (const a of body.querySelectorAll('a[href]')) {
    try { a.setAttribute('href', new URL(a.getAttribute('href'), base).href); } catch { a.removeAttribute('href'); }
  }
  return sanitize(body.innerHTML);
}

function toNote(p, pageUrl) {
  const url = p.permalink ? new URL(p.permalink, BASE).href : pageUrl;
  const sub = p.sub || '';
  const by = [
    sub && `<a href="${BASE}/r/${encodeURIComponent(sub)}">r/${esc(sub)}</a>`,
    `Posted by ${userLink(p.author)}${p.created ? ' on ' + when(p.created) : ''}`,
    count(p.score, 'point', 'points'), count(p.comments, 'comment', 'comments'), p.flair && esc(p.flair),
  ].filter(Boolean).join(' · ');
  const media = p.images.map((src) => `<p><img src="${esc(src)}" alt=""></p>`).join('')
    + (p.video ? `<p><a href="${esc(url)}">Watch the video on Reddit</a></p>` : '')
    + (p.link ? `<p>Link: <a href="${esc(p.link)}">${esc(p.link)}</a></p>` : '');
  const thread = comments(p.tree, { left: MAX_TOTAL });
  const html = `<p>${by}</p>${media}${p.bodyHtml}${thread ? `<hr><h2>Comments</h2>${thread}` : ''}`;
  const content = finish(html, BASE);
  return {
    title: p.title || (sub ? `r/${sub}` : 'Reddit post'),
    content,
    url,
    siteName: 'Reddit',
    tags: sub ? [sub] : [],
    // A clean standalone page for the offline copy: Reddit's own page needs its scripts to show anything.
    html: `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.title)}</title>
<style>h1{font-size:1.6rem;line-height:1.25}body{font:16px/1.55 -apple-system,system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1c1c1c}
blockquote{margin:.6rem 0 .6rem .4rem;padding-left:.9rem;border-left:2px solid #d0d3d6}img{max-width:100%;height:auto}
a{color:#0b57d0}time{color:#666}</style></head><body><article><h1>${esc(p.title)}</h1>${content}</article></body></html>`,
    finalUrl: url,
  };
}

// The note for a rendered Reddit post page, or null when the page holds no post (a sign-in
// wall, a listing, an error page).
function fromPage(html, pageUrl) {
  if (!/<shreddit-post\b|class="[^"]*\bthing\b[^"]*\blink\b/i.test(html)) return null;
  const doc = new JSDOM(html, { url: pageUrl, virtualConsole: new VirtualConsole() }).window.document;
  const p = readNew(doc, pageUrl) || readOld(doc, pageUrl);
  if (!p || !p.title) return null;
  return toNote(p, pageUrl);
}

module.exports = { parsePostUrl, isRedditUrl, fromPage };
