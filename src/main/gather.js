// Turns a link, or a page a browser already rendered, into a note: picks how to read it, then
// hands back the note's parts and the HTML its offline copy is made from. No Electron deps; the
// hidden-window renderer is injected.
const { scrape, extract, normalizeUrl } = require('./scraper');
const reddit = require('./reddit');

const REDDIT_BLOCKED = 'Reddit doesn’t let apps load its posts. Open the post in your browser and click the Send to Gatherer button in the extension instead.';

// Errors a real browser window can get past: pages built by scripts, and sites that turn away
// anything that is not a browser.
const worthRendering = (e) => /^Could not find any readable content|responded with HTTP 403\b/.test(e && e.message || '');

// A page's HTML as a browser rendered it (from the extension or the hidden window).
function fromHtml(html, finalUrl) {
  if (reddit.isRedditUrl(finalUrl)) {
    const note = reddit.fromPage(html, finalUrl);
    if (note) return note;
    if (reddit.parsePostUrl(finalUrl)) throw new Error(REDDIT_BLOCKED);
  }
  return { ...extract(html, finalUrl), html, finalUrl };
}

// opts.render(url): { html, finalUrl } from a hidden browser window (optional).
async function gather(input, { render = null } = {}) {
  const url = normalizeUrl(input);
  if (reddit.parsePostUrl(url)) {
    if (!render) throw new Error(REDDIT_BLOCKED);
    let page;
    try { page = await render(url); } catch { throw new Error(REDDIT_BLOCKED); }
    return fromHtml(page.html, page.finalUrl);
  }
  try { return await scrape(url); }
  catch (e) {
    if (!render || !worthRendering(e)) throw e;
    let page;
    try { page = await render(url); } catch { throw e; }
    try { return fromHtml(page.html, page.finalUrl); } catch { throw e; }
  }
}

module.exports = { gather, fromHtml, REDDIT_BLOCKED };
