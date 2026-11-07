const test = require('node:test');
const assert = require('node:assert');
const { parseCaptureLink, linksFromArgv, captureLink, BOOKMARKLET } = require('../src/main/capture');

test('parses gatherer://add links', () => {
  assert.deepStrictEqual(
    parseCaptureLink('gatherer://add?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&title=Hello%20%20world'),
    { url: 'https://example.com/a?b=1', title: 'Hello world' });
  assert.deepStrictEqual(parseCaptureLink('gatherer:add?url=http://example.com'), { url: 'http://example.com/', title: '' });
  assert.deepStrictEqual(parseCaptureLink('GATHERER:///save?url=https://example.com/x'), { url: 'https://example.com/x', title: '' });
});

test('round-trips links built by captureLink', () => {
  const url = 'https://example.com/path?q=a b&x=1#frag';
  const parsed = parseCaptureLink(captureLink(url, 'A & B'));
  assert.strictEqual(parsed.url, new URL(url).href);
  assert.strictEqual(parsed.title, 'A & B');
});

test('rejects anything that is not an http(s) page capture', () => {
  for (const bad of [
    '', 'not a url', 'https://example.com', 'gatherer://delete?url=https://example.com',
    'gatherer://add', 'gatherer://add?url=', 'gatherer://add?url=file:///etc/passwd',
    'gatherer://add?url=javascript:alert(1)', 'gatherer://add?url=gatherer-asset://x/y',
    'gatherer://add?url=https://user:pw@example.com/',
  ]) assert.strictEqual(parseCaptureLink(bad), null, bad);
});

test('finds links in argv', () => {
  assert.deepStrictEqual(linksFromArgv(['/app/gatherer', '--flag', 'gatherer://add?url=https://a.com', 42]), ['gatherer://add?url=https://a.com']);
  assert.deepStrictEqual(linksFromArgv(undefined), []);
});

test('bookmarklet builds a link the app accepts', () => {
  assert.ok(BOOKMARKLET.startsWith('javascript:'));
  let href = '';
  const location = { href: 'https://example.com/story?id=7' };
  const document = { title: 'A story' };
  new Function('location', 'document', BOOKMARKLET.slice('javascript:'.length))(
    new Proxy(location, { set: (o, k, v) => { if (k === 'href') href = v; o[k] = v; return true; } }), document);
  assert.deepStrictEqual(parseCaptureLink(href), { url: 'https://example.com/story?id=7', title: 'A story' });
});
