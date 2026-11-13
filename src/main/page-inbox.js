// Receives pages from the Send to Gatherer browser extension: the page exactly as the browser
// rendered it, so sites that only work in a browser (Reddit, script-built apps, pages behind
// your own sign-in) can still be gathered. No Electron deps.
//
//   POST http://127.0.0.1:47615/pages   { url, title, html }   (JSON)
//
// It listens on the loopback interface only. Web pages can't use it: a request must carry an
// extension Origin (which a page can't forge), a JSON body and an X-Gatherer header (both of
// which make a browser ask permission first, and that permission is never given), and a Host
// of 127.0.0.1 or localhost (so a rebound DNS name can't reach it).
const http = require('http');

const PORT = 47615;
const MAX_BYTES = 40 * 1024 * 1024;
const EXTENSION_ORIGIN = /^(?:chrome-extension|moz-extension|safari-web-extension):\/\/[\w.-]+$/i;

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function allowed(req, port) {
  const host = String(req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  return EXTENSION_ORIGIN.test(String(req.headers.origin || '')) && req.headers['x-gatherer'] === '1';
}

// onPage({ url, title, html }) is called for each page. Resolves to the listening server.
function start({ port = PORT, host = '127.0.0.1', onPage }) {
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (req.method === 'OPTIONS') { res.writeHead(403); res.end(); return; } // never grant a web page access
    if (!allowed(req, port)) return reply(res, 403, { error: 'forbidden' });
    if (req.method === 'GET' && path === '/ping') return reply(res, 200, { app: 'gatherer' });
    if (req.method !== 'POST' || path !== '/pages') return reply(res, 404, { error: 'not found' });
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return reply(res, 415, { error: 'expected JSON' });
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) { reply(res, 413, { error: 'page too large' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let page;
      try { page = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(res, 400, { error: 'bad JSON' }); }
      let url;
      try { url = new URL(page && page.url); } catch { return reply(res, 400, { error: 'bad url' }); }
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return reply(res, 400, { error: 'bad url' });
      if (typeof page.html !== 'string' || !page.html) return reply(res, 400, { error: 'no html' });
      const title = String(page.title || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      try { onPage({ url: url.href, title, html: page.html }); } catch (e) { return reply(res, 500, { error: e.message }); }
      reply(res, 202, { ok: true });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server); });
  });
}

module.exports = { PORT, start };
