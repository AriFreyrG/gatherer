const test = require('node:test');
const assert = require('node:assert');
const reddit = require('../src/main/reddit');
const { gather, fromHtml, REDDIT_BLOCKED } = require('../src/main/gather');
const inbox = require('../src/main/page-inbox');

const POST_URL = 'https://www.reddit.com/r/wallstreetbets/comments/1xuvp44/im_a_piece_of_sh_jensen_huangs_last_hours_as/';

// Roughly what www.reddit.com's rendered DOM looks like (light DOM of its web components).
const newReddit = `<!doctype html><html><head><title>Reddit - The heart of the internet</title></head><body>
<shreddit-app><main>
<shreddit-post id="t3_1xuvp44" permalink="/r/wallstreetbets/comments/1xuvp44/im_a_piece/" post-title="I'm a piece of sh*t: Jensen <Huang>'s last hours"
  author="trader1" score="4321" comment-count="3" created-timestamp="2026-11-12T10:00:00.000+0000" post-type="text"
  subreddit-prefixed-name="r/wallstreetbets">
  <a slot="credit-bar"><img src="https://styles.redditmedia.com/t5_2th52/communityIcon_x.png" width="32"></a>
  <h1 slot="title">I'm a piece of sh*t: Jensen &lt;Huang&gt;'s last hours</h1>
  <shreddit-post-flair><span>Meme</span></shreddit-post-flair>
  <div slot="text-body"><div class="md"><p>Body of the post with a <a href="/r/stocks">link</a>.</p><script>alert(1)</script></div></div>
</shreddit-post>
<shreddit-comment-tree>
  <shreddit-comment author="alice" score="900" depth="0" created="2026-11-12T11:00:00Z">
    <div slot="comment"><div class="md"><p>Top comment text</p></div></div>
    <div slot="children">
      <shreddit-comment author="bob" score="50" depth="1"><faceplate-timeago ts="2026-11-12T12:00:00Z"></faceplate-timeago>
        <div slot="comment"><p>A reply to alice</p></div></shreddit-comment>
    </div>
  </shreddit-comment>
  <shreddit-comment author="[deleted]" is-comment-deleted depth="0"><div slot="comment"><p>gone</p></div></shreddit-comment>
  <shreddit-comment author="carol" score="10" depth="0"><div slot="comment"><p>Second comment</p></div></shreddit-comment>
</shreddit-comment-tree>
</main></shreddit-app></body></html>`;

const oldReddit = `<!doctype html><html><head><title>x</title></head><body>
<div id="siteTable"><div class="thing link self" data-subreddit="stocks" data-author="dave" data-score="77" data-comments-count="2"
  data-timestamp="1762992000000" data-permalink="/r/stocks/comments/abc123/title/" data-url="/r/stocks/comments/abc123/title/">
  <a class="title" href="/r/stocks/comments/abc123/title/">Old style title</a>
  <div class="usertext-body"><div class="md"><p>Old body text</p></div></div></div></div>
<div class="commentarea"><div class="sitetable">
  <div class="thing comment" data-author="erin"><div class="entry"><span class="score unvoted">12 points</span>
    <div class="usertext-body"><div class="md"><p>Old top comment</p></div></div></div>
    <div class="child"><div class="sitetable"><div class="thing comment" data-author="frank"><div class="entry">
      <div class="usertext-body"><div class="md"><p>Old nested reply</p></div></div></div></div></div></div>
  </div></div></div></body></html>`;

test('recognises Reddit post links and nothing else', () => {
  assert.deepStrictEqual(reddit.parsePostUrl(POST_URL), { id: '1xuvp44' });
  assert.deepStrictEqual(reddit.parsePostUrl('https://old.reddit.com/r/x/comments/AbC123/t/def456/'), { id: 'abc123' });
  assert.deepStrictEqual(reddit.parsePostUrl('https://redd.it/1xuvp44'), { id: '1xuvp44' });
  assert.ok(reddit.parsePostUrl('https://www.reddit.com/r/x/s/Zq9Kx2').share);
  assert.strictEqual(reddit.parsePostUrl('https://www.reddit.com/r/wallstreetbets/'), null);
  assert.strictEqual(reddit.parsePostUrl('https://notreddit.com/r/x/comments/abc123/'), null);
});

test('reads a post and its comment tree from the page the browser rendered', () => {
  const r = fromHtml(newReddit, POST_URL);
  assert.strictEqual(r.title, 'I\'m a piece of sh*t: Jensen <Huang>\'s last hours');
  assert.strictEqual(r.siteName, 'Reddit');
  assert.deepStrictEqual(r.tags, ['wallstreetbets']);
  assert.strictEqual(r.url, 'https://www.reddit.com/r/wallstreetbets/comments/1xuvp44/im_a_piece/');
  assert.ok(r.html.includes('&lt;Huang&gt;'), 'title is escaped'); assert.ok(!r.content.includes('<h1'), 'title shown by the note, not repeated');
  assert.ok(r.content.includes('Body of the post'));
  assert.ok(r.content.includes('href="https://www.reddit.com/r/stocks"'), 'relative links made absolute');
  assert.ok(!/<script|alert/.test(r.content), 'scripts removed');
  assert.ok(!r.content.includes('communityIcon'), 'subreddit icon skipped');
  assert.ok(r.content.includes('4,321 points') && r.content.includes('Meme') && r.content.includes('2026-11-12'));
  // bob's reply is nested inside alice's comment, and the deleted comment is dropped.
  const alice = r.content.indexOf('Top comment text'), bob = r.content.indexOf('A reply to alice'), carol = r.content.indexOf('Second comment');
  assert.ok(alice > 0 && bob > alice && carol > bob);
  assert.ok(/A reply to alice[\s\S]*<\/blockquote><\/blockquote><blockquote>[\s\S]*carol/.test(r.content), 'reply nested under its parent');
  assert.ok(!r.content.includes('gone'));
  assert.ok(/^<!doctype html>/.test(r.html) && r.html.includes('Top comment text') && !r.html.includes('shreddit'), 'clean offline copy');
});

test('reads old.reddit.com pages too', () => {
  const r = fromHtml(oldReddit, 'https://old.reddit.com/r/stocks/comments/abc123/title/');
  assert.strictEqual(r.title, 'Old style title');
  assert.deepStrictEqual(r.tags, ['stocks']);
  assert.ok(r.content.includes('Old body text') && r.content.includes('12 points'));
  assert.ok(r.content.indexOf('Old nested reply') > r.content.indexOf('Old top comment'));
});

test('a sign-in wall or a pasted Reddit link points to the extension', async () => {
  const wall = '<html><body><p>Log in to continue reading this post on Reddit, it is really quite good.</p></body></html>';
  assert.throws(() => fromHtml(wall, POST_URL), { message: REDDIT_BLOCKED });
  await assert.rejects(gather(POST_URL, {}), { message: REDDIT_BLOCKED });
  await assert.rejects(gather(POST_URL, { render: async () => ({ html: wall, finalUrl: POST_URL }) }), { message: REDDIT_BLOCKED });
  const note = await gather(POST_URL, { render: async () => ({ html: newReddit, finalUrl: POST_URL }) });
  assert.ok(note.content.includes('Top comment text'));
});

test('the page inbox accepts pages from the extension only', async () => {
  const got = [];
  const server = await inbox.start({ port: 0, onPage: (p) => got.push(p) });
  const port = server.address().port;
  // port 0 picks a free port; the Host check needs the real one.
  server.close();
  const s2 = await inbox.start({ port, onPage: (p) => got.push(p) });
  const send = (headers, body = JSON.stringify({ url: POST_URL, title: ' T ', html: '<p>x</p>' }), path = '/pages') =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  try {
    const ext = { Origin: 'chrome-extension://abcdefghijklmnop', 'X-Gatherer': '1' };
    assert.strictEqual((await send(ext)).status, 202);
    assert.deepStrictEqual(got, [{ url: POST_URL, title: 'T', html: '<p>x</p>' }]);
    assert.strictEqual((await send({ ...ext, Origin: 'https://evil.example' })).status, 403, 'web page origin');
    assert.strictEqual((await send({ Origin: ext.Origin })).status, 403, 'missing X-Gatherer');
    assert.strictEqual((await send(ext, JSON.stringify({ url: 'file:///etc/passwd', html: 'x' }))).status, 400);
    assert.strictEqual((await send(ext, JSON.stringify({ url: POST_URL }))).status, 400);
    const pre = await fetch(`http://127.0.0.1:${port}/pages`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(pre.status, 403);
    assert.strictEqual(pre.headers.get('access-control-allow-origin'), null);
    assert.strictEqual(got.length, 1);
  } finally { s2.close(); }
});
