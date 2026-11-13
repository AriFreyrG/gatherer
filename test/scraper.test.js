const test = require('node:test');
const assert = require('node:assert');
const { extract } = require('../src/main/scraper');

const para = (s) => `<p>${s} ${'This sentence pads the paragraph so it reads like real article prose. '.repeat(2)}</p>`;
const page = (body) => `<!doctype html><html><head><title>Test page</title></head><body>${body}</body></html>`;

test('keeps article content whose wrappers carry clutter-like class names', () => {
  const html = page(`
    <article class="post has-comments social-share-enabled ad-free">
      <h1>Real headline</h1>
      <div class="entry-content shared-layout">${para('First real paragraph.')}${para('Second real paragraph.')}</div>
      <div class="leaderboard-note">${para('Leader paragraph that must stay.')}</div>
      <aside class="callout">${para('A callout inside the article with real prose.')}</aside>
      ${para('Closing paragraph of the story.')}
    </article>`);
  const { content } = extract(html, 'https://example.com/a');
  for (const s of ['First real paragraph', 'Second real paragraph', 'Leader paragraph', 'callout inside the article', 'Closing paragraph']) {
    assert.ok(content.includes(s), `lost: ${s}`);
  }
});

test('still removes share bars, ads, related links and comment threads', () => {
  const html = page(`
    <main>
      <h1>Headline</h1>
      ${para('Body one.')}${para('Body two.')}${para('Body three.')}${para('Body four.')}
      <div class="share-bar"><a href="https://x.com/s">Share on X</a> <a href="https://fb.com/s">Facebook</a></div>
      <div id="adSlot">Advertisement BUY NOW</div>
      <div class="related-posts"><ul><li><a href="/1">Other story one</a></li><li><a href="/2">Other story two</a></li></ul></div>
      <section class="comments">${para('Commenter one says something long.')}${para('Commenter two replies at length.')}</section>
      <aside><a href="/x">Popular</a> <a href="/y">Trending</a></aside>
    </main>`);
  const { content } = extract(html, 'https://example.com/b');
  assert.ok(content.includes('Body four'));
  for (const s of ['Share on X', 'Advertisement', 'Other story one', 'Commenter one', 'Trending']) {
    assert.ok(!content.includes(s), `kept clutter: ${s}`);
  }
});

test('script-built pages fall back to the hidden browser window', async () => {
  const { gather } = require('../src/main/gather');
  const http = require('node:http');
  const shell = '<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script>render()</script></body></html>';
  const server = http.createServer((_q, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(shell); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/story`;
  try {
    await assert.rejects(gather(url, {}), /Could not find any readable content/);
    let rendered = null;
    const render = async (u) => { rendered = u; return { html: page(`<article><h1>Built by script</h1>${para('Rendered paragraph one.')}${para('Rendered paragraph two.')}</article>`), finalUrl: u }; };
    const note = await gather(url, { render });
    assert.strictEqual(rendered, url);
    assert.ok(note.content.includes('Rendered paragraph two'));
    assert.ok(note.html.includes('Built by script'), 'offline copy comes from the rendered page');
  } finally { server.close(); }
});
