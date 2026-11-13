// Reddit posts through Reddit's official API. Reddit serves its web pages as a script shell
// and walls off its .json and old.reddit pages for unknown clients, so a post is read with an
// app key the user registers at reddit.com/prefs/apps. Application-only OAuth: nothing is
// posted and no Reddit account is signed in. No Electron deps.
const { JSDOM } = require('jsdom');
const crypto = require('crypto');
const { sanitize } = require('./scraper');

const UA = 'desktop:com.gatherer.app:v0.1 (Gatherer web notebook)';
const BASE = 'https://www.reddit.com';
const API = 'https://oauth.reddit.com';
const MAX_TOP = 40;     // top-level comments kept
const MAX_DEPTH = 4;    // reply levels kept under each one
const MAX_TOTAL = 200;  // comments kept in all

const HOSTS = /^(?:www\.|old\.|new\.|np\.|m\.|i\.|sh\.)?reddit\.com$/i;

// { id, share } for a Reddit post link, or null. share is set for /r/<sub>/s/<code> links,
// which only redirect to the real post.
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

const isRedditHost = (url) => { try { const h = new URL(url).hostname; return HOSTS.test(h) || h === 'redd.it'; } catch { return false; } };

class RedditAuthError extends Error {}

const tokens = new Map(); // clientId -> { token, expires }

async function getToken({ clientId, secret }, fetchImpl = fetch) {
  const cached = tokens.get(clientId);
  if (cached && cached.expires > Date.now() + 60000) return cached.token;
  // A "script" or "web app" key has a secret; an "installed app" key has none and names a device.
  const body = secret
    ? new URLSearchParams({ grant_type: 'client_credentials' })
    : new URLSearchParams({ grant_type: 'https://oauth.reddit.com/grants/installed_client', device_id: deviceId(clientId) });
  let res;
  try {
    res = await fetchImpl(`${BASE}/api/v1/access_token`, {
      method: 'POST', body, signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${secret || ''}`).toString('base64'),
        'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
  } catch (e) { throw new Error(`Could not reach Reddit (${e.name === 'TimeoutError' ? 'timeout' : (e.cause && e.cause.code) || e.message})`); }
  let data = {};
  try { data = await res.json(); } catch { /* handled below */ }
  if (res.status === 401 || res.status === 403 || data.error === 'invalid_client' || data.error === 'unauthorized_client' || data.error === 'unsupported_grant_type') {
    throw new RedditAuthError('Reddit rejected the app key in Settings. Check the client ID and secret.');
  }
  if (!res.ok || !data.access_token) throw new Error(`Reddit sign-in failed (HTTP ${res.status}${data.error ? ', ' + data.error : ''})`);
  tokens.set(clientId, { token: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
  return data.access_token;
}

// Stable per key, so Reddit sees one device rather than a new one every launch.
function deviceId(clientId) { return crypto.createHash('sha256').update('gatherer:' + clientId).digest('hex').slice(0, 30); }

// Share links (/r/<sub>/s/<code>) redirect to the post; follow just that one hop.
async function resolveShare(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA } });
    const loc = res.headers.get('location');
    const p = loc && parsePostUrl(new URL(loc, url).href);
    if (p && p.id) return p.id;
  } catch { /* fall through */ }
  throw new Error('Could not open this Reddit share link. Open it in your browser and paste the full post link instead.');
}

async function api(path, creds, fetchImpl) {
  const token = await getToken(creds, fetchImpl);
  let res;
  try {
    res = await fetchImpl(API + path, { signal: AbortSignal.timeout(20000), headers: { Authorization: `bearer ${token}`, 'User-Agent': UA } });
  } catch (e) { throw new Error(`Could not reach Reddit (${e.name === 'TimeoutError' ? 'timeout' : (e.cause && e.cause.code) || e.message})`); }
  if (res.status === 401) { tokens.delete(creds.clientId); throw new RedditAuthError('Reddit rejected the app key in Settings. Check the client ID and secret.'); }
  if (res.status === 403) throw new Error('Reddit says this post is private or quarantined, so it can\'t be gathered.');
  if (res.status === 404) throw new Error('Reddit could not find this post. It may have been removed.');
  if (!res.ok) throw new Error(`Reddit responded with HTTP ${res.status}`);
  return res.json();
}

/* ---------- rendering ---------- */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const decode = (s) => String(s || '').replace(/&amp;/g, '&'); // preview URLs arrive entity-escaped without raw_json
const date = (utc) => { try { return new Date(utc * 1000).toISOString().slice(0, 10); } catch { return ''; } };
const plural = (n, w) => `${Number(n || 0).toLocaleString('en-US')} ${w}${Number(n) === 1 ? '' : 's'}`;
const userLink = (name) => (!name || name === '[deleted]') ? '<em>[deleted]</em>' : `<a href="${BASE}/user/${encodeURIComponent(name)}">u/${esc(name)}</a>`;
const img = (src, alt = '') => (src && /^https?:/.test(src) ? `<p><img src="${esc(decode(src))}" alt="${esc(alt)}"></p>` : '');

function media(post) {
  const parts = [];
  if (post.is_gallery && post.gallery_data && post.media_metadata) {
    for (const item of post.gallery_data.items || []) {
      const m = post.media_metadata[item.media_id];
      const src = m && m.s && (m.s.u || m.s.gif);
      if (src) parts.push(img(src, item.caption || ''), item.caption ? `<p><em>${esc(item.caption)}</em></p>` : '');
    }
    return parts.join('');
  }
  const preview = post.preview && post.preview.images && post.preview.images[0] && post.preview.images[0].source;
  const video = post.media && post.media.reddit_video;
  if (post.post_hint === 'image' || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(post.url || '')) {
    parts.push(img(post.url_overridden_by_dest || post.url));
  } else if (video) {
    parts.push(img(preview && preview.url));
    parts.push(`<p><a href="${esc(video.fallback_url)}">Watch the video</a> (${Math.round(video.duration || 0)} s)</p>`);
  } else if (!post.is_self && post.url) {
    parts.push(img(preview && preview.url));
    const link = abs(post.url_overridden_by_dest || post.url);
    if (link) parts.push(`<p>Link: <a href="${esc(link)}">${esc(link)}</a></p>`);
  }
  return parts.join('');
}

const abs = (v) => { try { return new URL(decode(v), BASE).href; } catch { return null; } };

function renderComments(children, depth, budget) {
  const out = [];
  let more = 0;
  for (const c of children || []) {
    if (c.kind === 'more') { more += (c.data && c.data.count) || 0; continue; }
    if (c.kind !== 't1' || !c.data) continue;
    const d = c.data;
    if (d.stickied && d.author === 'AutoModerator') continue;
    if (budget.left <= 0 || (depth === 0 && out.length >= MAX_TOP)) { more += 1; continue; }
    budget.left -= 1;
    const head = `<p><strong>${userLink(d.author)}</strong> · ${plural(d.score, 'point')} · <time datetime="${new Date(d.created_utc * 1000).toISOString()}">${date(d.created_utc)}</time>${d.edited ? ' · edited' : ''}</p>`;
    const body = d.body_html || (d.body ? `<p>${esc(d.body)}</p>` : '');
    let replies = '';
    const kids = d.replies && d.replies.data && d.replies.data.children;
    if (kids && kids.length) {
      if (depth + 1 < MAX_DEPTH) replies = renderComments(kids, depth + 1, budget);
      else replies = `<p><small>${kids.length === 1 ? '1 more reply' : `${kids.length} more replies`} on Reddit</small></p>`;
    }
    out.push(`<blockquote>${head}${body}${replies}</blockquote>`);
  }
  if (more) out.push(`<p><small>${plural(more, 'more comment')} on Reddit</small></p>`);
  return out.join('');
}

// Makes Reddit's own HTML safe and self-contained: absolute links, sanitized.
function finish(html) {
  const body = new JSDOM(`<body>${html}</body>`).window.document.body;
  for (const a of body.querySelectorAll('a[href]')) { const u = abs(a.getAttribute('href')); if (u) a.setAttribute('href', u); else a.removeAttribute('href'); }
  return sanitize(body.innerHTML);
}

// listing: the [post, comments] pair /comments/<id> returns.
function render(listing) {
  const post = listing && listing[0] && listing[0].data && listing[0].data.children && listing[0].data.children[0] && listing[0].data.children[0].data;
  if (!post) throw new Error('Reddit returned no post for this link');
  const src = (post.crosspost_parent_list && post.crosspost_parent_list[0]) || post;
  const url = BASE + post.permalink;
  const sub = post.subreddit || '';
  const flags = [post.link_flair_text, post.over_18 && 'NSFW', post.spoiler && 'Spoiler'].filter(Boolean).map(esc).join(' · ');
  const byline = `<p><a href="${BASE}/r/${encodeURIComponent(sub)}">r/${esc(sub)}</a> · Posted by ${userLink(post.author)} on `
    + `<time datetime="${new Date(post.created_utc * 1000).toISOString()}">${date(post.created_utc)}</time> · ${plural(post.score, 'point')} · ${plural(post.num_comments, 'comment')}`
    + `${flags ? ' · ' + flags : ''}</p>`;
  const cross = src !== post ? `<p><em>Crossposted from <a href="${BASE}${esc(src.permalink)}">r/${esc(src.subreddit)}</a></em></p>` : '';
  const text = src.selftext_html || (src.selftext ? `<p>${esc(src.selftext)}</p>` : '');
  const comments = renderComments(listing[1] && listing[1].data && listing[1].data.children, 0, { left: MAX_TOTAL });
  const html = `<h1>${esc(post.title)}</h1>${byline}${cross}${media(src)}${text}`
    + (comments ? `<hr><h2>Top comments</h2>${comments}` : '');
  const content = finish(html);
  return {
    title: String(post.title || '').trim() || `r/${sub}`,
    content,
    url,
    siteName: 'Reddit',
    tags: sub ? [sub] : [],
    // A standalone page for the offline copy, so it is made from the same data as the note.
    html: `<!doctype html><html><head><meta charset="utf-8"><title>${esc(post.title)}</title>
<style>body{font:16px/1.55 -apple-system,system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1c1c1c}
blockquote{margin:.6rem 0 .6rem .4rem;padding-left:.9rem;border-left:2px solid #d0d3d6}img{max-width:100%;height:auto}
a{color:#0b57d0}small,time{color:#666}</style></head><body><article>${content}</article></body></html>`,
    finalUrl: url,
  };
}

// The note for a Reddit post link. creds: { clientId, secret }.
async function gather(input, creds, fetchImpl = fetch) {
  const p = parsePostUrl(input);
  if (!p) throw new Error('This Reddit link is not a post');
  const id = p.id || await resolveShare(p.share, fetchImpl);
  const listing = await api(`/comments/${id}?raw_json=1&sort=top&limit=${MAX_TOTAL}&depth=${MAX_DEPTH + 1}`, creds, fetchImpl);
  return render(listing);
}

// Throws RedditAuthError when Reddit definitely rejects the key.
async function checkKey(creds, fetchImpl = fetch) { tokens.delete(creds.clientId); await getToken(creds, fetchImpl); }

module.exports = { parsePostUrl, isRedditHost, gather, render, checkKey, RedditAuthError, UA };
