const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const archive = require('../src/main/archive');
const storage = require('../src/main/storage');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const site = {
  'https://ex.com/style.css': ['text/css', '@import "more.css" screen; body { background: url(bg.png) } </style><script>alert(1)</script>'],
  'https://ex.com/more.css': ['text/css', '@font-face { font-family: X; src: url("/f.woff2") }'],
  'https://ex.com/bg.png': ['image/png', PNG],
  'https://ex.com/f.woff2': ['application/octet-stream', Buffer.from('wOF2')],
  'https://ex.com/a.png': ['image/png', PNG],
  'https://ex.com/big.png': ['image/png', PNG],
  'https://ex.com/lazy.png': ['image/png', PNG],
};
const calls = [];
const fakeFetch = async (url) => {
  calls.push(url);
  const hit = site[url];
  if (!hit) return new Response('nope', { status: 404 });
  return new Response(hit[1], { headers: { 'content-type': hit[0] } });
};

const PAGE = `<!doctype html><html><head><meta charset="windows-1252"><title>T</title>
<link rel="stylesheet" href="/style.css"><link rel="preload" href="/x.js"><base href="https://evil.example/">
<meta http-equiv="refresh" content="0;url=https://evil.example"><script>steal()</script></head>
<body onload="steal()"><h1>Hello</h1><p style="background:url('/bg.png')">Text <a href="/next" onclick="x()">next</a>
<a href="javascript:alert(1)">bad</a></p>
<img src="/a.png"><img src="/small.png" srcset="/a.png 400w, /big.png 1200w, /huge.png 3000w">
<img src="data:image/gif;base64,R0lGOD" data-src="/lazy.png"><img src="/missing.png">
<noscript><p>No JS fallback</p></noscript><iframe src="https://ads.example"></iframe><form action="https://ex.com/post"><button>Go</button></form>
</body></html>`;

test('snapshot inlines styles, images and fonts and strips everything that could run or phone home', async () => {
  calls.length = 0;
  const { html, resources } = await archive.snapshot(PAGE, 'https://ex.com/post/1', { fetch: fakeFetch, date: '2026-11-07T00:00:00.000Z' });
  assert.ok(resources >= 6);
  const doc = new (require('jsdom').JSDOM)(html).window.document;
  assert.strictEqual(doc.querySelectorAll('script').length, 0, 'no scripts, even from css trying to close <style>');
  assert.ok(!/onload|onclick|javascript:|<iframe|<base|http-equiv="refresh"|rel="preload"/i.test(html));
  assert.ok(!/action="https/.test(html));
  assert.ok(html.includes(`content="${archive.CSP}"`), 'carries its own CSP');
  assert.ok(html.includes('<meta charset="utf-8">') && !/windows-1252/.test(html));
  assert.ok(html.includes('name="gatherer:archived-from" content="https://ex.com/post/1"'));
  // CSS: import inlined under its media query, url()s become data URIs (font type guessed from extension).
  assert.ok(html.includes('@media screen'));
  assert.ok(html.includes('url("data:font/woff2;base64,'));
  assert.ok(html.includes('url("data:image/png;base64,'));
  assert.ok(!/<link[^>]+stylesheet/.test(html));
  // Images: inlined; srcset picks the widest candidate up to 1600w; lazy src wins over placeholder.
  const imgs = [...doc.querySelectorAll('img')];
  assert.strictEqual(imgs.length, 4);
  assert.ok(imgs.slice(0, 3).every((i) => i.getAttribute('src').startsWith('data:image/png;base64,')));
  assert.ok(imgs.every((i) => !i.hasAttribute('srcset') && !i.hasAttribute('data-src')));
  assert.ok(!imgs[3].hasAttribute('src'), 'failed image does not point back at the site');
  assert.ok(calls.includes('https://ex.com/big.png') && !calls.includes('https://ex.com/huge.png') && !calls.includes('https://ex.com/small.png'));
  assert.strictEqual(calls.filter((c) => c === 'https://ex.com/bg.png').length, 1, 'each resource fetched once');
  // Links are absolute and open outside the snapshot.
  const a = doc.querySelector('a[href]');
  assert.strictEqual(a.getAttribute('href'), 'https://ex.com/next');
  assert.strictEqual(a.getAttribute('target'), '_blank');
  assert.ok(doc.body.textContent.includes('No JS fallback'));
});

test('snapshot respects its byte budget', async () => {
  const { html } = await archive.snapshot('<img src="https://ex.com/a.png"><img src="https://ex.com/big.png">', 'https://ex.com/', { fetch: fakeFetch, maxTotalBytes: PNG.length });
  assert.strictEqual((html.match(/data:image\/png/g) || []).length, 1);
});

test('bestFromSrcset', () => {
  assert.strictEqual(archive.bestFromSrcset('a.jpg 1x, b.jpg 2x, c.jpg 3x'), 'b.jpg');
  assert.strictEqual(archive.bestFromSrcset('a.jpg 2000w, b.jpg 3000w'), 'a.jpg');
  assert.strictEqual(archive.bestFromSrcset('a.jpg'), 'a.jpg');
});

test('notes report their offline copy, and deleting a note removes it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherer-'));
  storage.setDir(dir);
  const n = storage.create({ title: 'T', url: 'https://ex.com/', content: '<p>Hi</p>' });
  assert.strictEqual(storage.get(n.id).archive, null);
  storage.saveArchive(n.id, '<!doctype html><p>copy</p>');
  const info = storage.get(n.id).archive;
  assert.ok(info && info.bytes > 0 && info.savedAt);
  storage.save(n.id, { content: '<p>Edited</p>' });
  assert.ok(storage.get(n.id).archive, 'editing the note keeps the copy');
  assert.ok(fs.existsSync(path.join(dir, 'assets', n.id, archive.FILE)));
  storage.remove(n.id);
  assert.ok(!fs.existsSync(path.join(dir, 'assets', n.id)));
});
