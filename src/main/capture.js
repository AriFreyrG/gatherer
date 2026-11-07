// One-click capture: pages arrive as gatherer:// links from the browser extension,
// the bookmarklet or any other app. No Electron deps, so it can be unit tested.
//
//   gatherer://add?url=<http(s) URL>[&title=<page title>]
//
// Any web page can open a gatherer:// link, so only http(s) page URLs are accepted
// and nothing else in the link is acted on.

const SCHEME = 'gatherer';
const ACTIONS = new Set(['add', 'capture', 'save']);

// Parse a gatherer:// link. Returns { url, title } or null if it is not a capture link.
function parseCaptureLink(raw) {
  let link;
  try { link = new URL(String(raw || '').trim()); } catch { return null; }
  if (link.protocol !== SCHEME + ':') return null;
  // gatherer://add?… has host "add"; gatherer:add?… and gatherer:///add?… put it in the path.
  const action = (link.hostname || link.pathname.replace(/^\/+/, '').split('/')[0] || '').toLowerCase();
  if (!ACTIONS.has(action)) return null;
  const target = link.searchParams.get('url');
  if (!target) return null;
  let page;
  try { page = new URL(target); } catch { return null; }
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return null;
  if (page.username || page.password) return null;
  const title = (link.searchParams.get('title') || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return { url: page.href, title };
}

// Find capture links among command-line arguments (Windows and Linux pass the link in argv).
function linksFromArgv(argv) {
  return (argv || []).filter((a) => typeof a === 'string' && a.toLowerCase().startsWith(SCHEME + ':'));
}

// Build a capture link, e.g. for the bookmarklet or tests.
function captureLink(url, title) {
  const q = new URLSearchParams({ url });
  if (title) q.set('title', title);
  return `${SCHEME}://add?${q}`;
}

// Bookmarklet that sends the current page to Gatherer. Works in Safari, Chrome, Firefox, Edge and Arc.
const BOOKMARKLET = "javascript:(()=>{location.href='gatherer://add?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)})()";

module.exports = { SCHEME, parseCaptureLink, linksFromArgv, captureLink, BOOKMARKLET };
