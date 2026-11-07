const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../src/renderer/search-core');
const storage = require('../src/main/storage');

test('fold ignores case and accents and keeps string length', () => {
  for (const s of ['Café Crème', 'Ångström', 'İstanbul', 'naïve 日本語 😀', 'é']) assert.strictEqual(S.fold(s).length, s.length);
  assert.strictEqual(S.fold('Café CRÈME'), 'cafe creme');
});

test('parseQuery keeps quoted phrases and drops redundant terms', () => {
  assert.deepStrictEqual(S.parseQuery('  Sour "dutch  oven" sourdough '), ['dutch oven', 'sourdough']);
  assert.deepStrictEqual(S.parseQuery('   '), []);
});

test('findRanges merges overlaps and snippet centres on the first match', () => {
  assert.deepStrictEqual(S.findRanges('abcabc', ['abc', 'bca']), [[0, 6]]);
  const text = 'word '.repeat(40) + 'Fjord kayaking is calm. ' + 'more '.repeat(60);
  const sn = S.snippet(text, S.fold(text), ['kayaking']);
  assert.ok(sn.text.startsWith('…') && sn.text.endsWith('…'));
  const [[a, b]] = sn.ranges;
  assert.strictEqual(sn.text.slice(a, b), 'kayaking');
});

test('storage.search matches body, title, tags and ranks title hits first', () => {
  storage.setDir(fs.mkdtempSync(path.join(os.tmpdir(), 'gatherer-search-')));
  const mk = (title, body, tags = []) => storage.create({ title, url: 'https://example.com/x', content: `<p>${body}</p>`, tags });
  const a = mk('Bread notes', 'Use a dutch oven for the café loaf.');
  const b = mk('Dutch oven guide', 'Cast iron care.');
  const c = mk('Fjords', 'Paddle <b>calm</b> water.', ['Kayak']);

  const r = storage.search('dutch oven');
  assert.deepStrictEqual(r.map((x) => x.id), [b.id, a.id]);
  assert.deepStrictEqual(r[0].titleRanges.map((x) => r[0].title.slice(...x)), ['Dutch', 'oven']);
  const ra = r[1];
  assert.deepStrictEqual(ra.snippetRanges.map((x) => ra.snippet.slice(...x)), ['dutch', 'oven']);
  assert.strictEqual(storage.search('"dutch oven" guide')[0].id, b.id);
  assert.deepStrictEqual(storage.search('"oven dutch"'), []);

  assert.deepStrictEqual(storage.search('CAFE').map((x) => x.id), [a.id]);
  assert.deepStrictEqual(storage.search('kayak calm').map((x) => x.id), [c.id]);
  assert.deepStrictEqual(storage.search('kayak bread'), []);
  assert.deepStrictEqual(storage.search(''), []);

  storage.save(c.id, { content: '<p>Now about sourdough</p>' });
  assert.deepStrictEqual(storage.search('sourdough').map((x) => x.id), [c.id]);
});
