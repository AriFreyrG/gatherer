// Turns a link into a note: picks how to read the page, then hands back the note's parts and the
// HTML its offline copy is made from. No Electron deps; the hidden-window renderer is injected.
const { scrape, extract, normalizeUrl } = require('./scraper');
const reddit = require('./reddit');

const NEEDS_REDDIT_KEY = 'Reddit blocks apps from reading its pages directly. To save Reddit posts, add a free Reddit app key in Settings.';

// Errors a real browser window can get past: pages built by scripts, and sites that turn away
// anything that is not a browser.
const worthRendering = (e) => /^Could not find any readable content|responded with HTTP 403\b/.test(e && e.message || '');

function fromHtml({ html, finalUrl }) { return { ...extract(html, finalUrl), html, finalUrl }; }

// opts.redditCreds(): { clientId, secret } or null. opts.render(url): { html, finalUrl } (optional).
async function gather(input, { redditCreds = () => null, render = null, fetchImpl } = {}) {
  const url = normalizeUrl(input);
  if (reddit.parsePostUrl(url)) {
    const creds = redditCreds();
    if (creds) return reddit.gather(url, creds, fetchImpl);
    // Without a key, a real browser window sometimes gets the post; a sign-in wall has no post in it.
    if (render) {
      try {
        const page = await render(url);
        if (/<shreddit-post\b/i.test(page.html)) return fromHtml(page);
      } catch { /* fall through to the key message */ }
    }
    throw new Error(NEEDS_REDDIT_KEY);
  }
  try { return await scrape(url); }
  catch (e) {
    if (!render || !worthRendering(e)) throw e;
    let page;
    try { page = await render(url); } catch { throw e; }
    try { return fromHtml(page); } catch { throw e; }
  }
}

module.exports = { gather, NEEDS_REDDIT_KEY };
