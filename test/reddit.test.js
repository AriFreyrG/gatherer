const test = require('node:test');
const assert = require('node:assert');
const reddit = require('../src/main/reddit');
const { gather, NEEDS_REDDIT_KEY } = require('../src/main/gather');

const POST_URL = 'https://www.reddit.com/r/wallstreetbets/comments/1xuvp44/im_a_piece_of_sh_jensen_huangs_last_hours_as/';

const comment = (id, author, body, score, replies = []) => ({
  kind: 't1',
  data: { id, author, score, created_utc: 1762992000, body_html: `<div class="md"><p>${body}</p></div>`,
    replies: replies.length ? { kind: 'Listing', data: { children: replies } } : '' },
});
const listing = () => ([
  { kind: 'Listing', data: { children: [{ kind: 't3', data: {
    id: '1xuvp44', title: 'I\'m a piece of sh*t: Jensen <Huang>\'s last hours', subreddit: 'wallstreetbets', author: 'trader1',
    created_utc: 1762992000, score: 4321, num_comments: 3, permalink: '/r/wallstreetbets/comments/1xuvp44/im_a_piece/',
    is_self: true, link_flair_text: 'Meme',
    selftext_html: '<div class="md"><p>Body of the post with a <a href="/r/stocks">link</a>.</p><script>alert(1)</script></div>',
  } }] } },
  { kind: 'Listing', data: { children: [
    { kind: 't1', data: { author: 'AutoModerator', stickied: true, body_html: '<p>Bot rules</p>', created_utc: 1, score: 1 } },
    comment('c1', 'alice', 'Top comment text', 900, [comment('c2', 'bob', 'A reply to alice', 50)]),
    comment('c3', '[deleted]', 'Second comment', 10),
    { kind: 'more', data: { count: 12, children: [] } },
  ] } },
]);

test('recognises Reddit post links and nothing else', () => {
  assert.deepStrictEqual(reddit.parsePostUrl(POST_URL), { id: '1xuvp44' });
  assert.deepStrictEqual(reddit.parsePostUrl('https://old.reddit.com/r/x/comments/AbC123/t/def456/'), { id: 'abc123' });
  assert.deepStrictEqual(reddit.parsePostUrl('https://redd.it/1xuvp44'), { id: '1xuvp44' });
  assert.deepStrictEqual(reddit.parsePostUrl('https://www.reddit.com/r/x/s/Zq9Kx2'), { share: 'https://www.reddit.com/r/x/s/Zq9Kx2' });
  assert.strictEqual(reddit.parsePostUrl('https://www.reddit.com/r/wallstreetbets/'), null);
  assert.strictEqual(reddit.parsePostUrl('https://notreddit.com/r/x/comments/abc123/'), null);
});

test('renders the post, its media, and top comments as safe HTML', () => {
  const r = reddit.render(listing());
  assert.strictEqual(r.title, 'I\'m a piece of sh*t: Jensen <Huang>\'s last hours');
  assert.strictEqual(r.siteName, 'Reddit');
  assert.deepStrictEqual(r.tags, ['wallstreetbets']);
  assert.strictEqual(r.url, 'https://www.reddit.com/r/wallstreetbets/comments/1xuvp44/im_a_piece/');
  assert.ok(r.content.includes('&lt;Huang&gt;'), 'title is escaped');
  assert.ok(r.content.includes('Body of the post'));
  assert.ok(r.content.includes('href="https://www.reddit.com/r/stocks"'), 'relative links made absolute');
  assert.ok(!/<script|alert/.test(r.content), 'scripts removed');
  assert.ok(r.content.includes('Top comment text') && r.content.includes('A reply to alice'));
  assert.ok(r.content.indexOf('A reply to alice') > r.content.indexOf('Top comment text'));
  assert.ok(!r.content.includes('Bot rules'), 'sticky AutoModerator comment skipped');
  assert.ok(r.content.includes('12 more comments on Reddit'));
  assert.ok(r.content.includes('4,321 points') && r.content.includes('Meme'));
  assert.ok(/^<!doctype html>/.test(r.html) && r.html.includes('Top comment text'), 'offline copy page');
});

test('reads a post through the API with an app key', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.endsWith('/api/v1/access_token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify(listing()), { status: 200 });
  };
  const note = await gather(POST_URL, { redditCreds: () => ({ clientId: 'cid-a', secret: 'sec' }), fetchImpl });
  assert.ok(note.content.includes('Top comment text'));
  assert.strictEqual(calls[0].opts.headers.Authorization, 'Basic ' + Buffer.from('cid-a:sec').toString('base64'));
  assert.ok(calls[1].url.startsWith('https://oauth.reddit.com/comments/1xuvp44?'));
  assert.strictEqual(calls[1].opts.headers.Authorization, 'bearer tok');
  assert.match(calls[1].opts.headers['User-Agent'], /^desktop:/);
});

test('a rejected key gives a clear message', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 });
  await assert.rejects(reddit.checkKey({ clientId: 'bad', secret: 'x' }, fetchImpl), reddit.RedditAuthError);
});

test('without a key, Reddit posts ask for one unless the hidden window got the post', async () => {
  const wall = async () => ({ html: '<html><body><p>Log in to continue</p></body></html>', finalUrl: POST_URL });
  await assert.rejects(gather(POST_URL, { render: wall }), { message: NEEDS_REDDIT_KEY });
  await assert.rejects(gather(POST_URL, {}), { message: NEEDS_REDDIT_KEY });
  const para = 'This is the body of the post, long enough to read like real prose for the extractor. '.repeat(3);
  const ok = async () => ({ html: `<html><head><title>T</title></head><body><shreddit-post><h1>Post title</h1><p>${para}</p><p>${para}</p></shreddit-post></body></html>`, finalUrl: POST_URL });
  const note = await gather(POST_URL, { render: ok });
  assert.ok(note.content.includes('body of the post'));
});
