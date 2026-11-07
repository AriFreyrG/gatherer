const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const storage = require('../src/main/storage');

test('list infers subjects, keeps metadata through saves, and honours pinned subjects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherer-'));
  storage.setDir(dir);
  const mk = (title, body, tags = [], siteName = '') => storage.create({ title, url: 'https://example.com/' + title.length, content: `<p>${body}</p>`, tags, siteName });
  const a = mk('Sourdough starter', 'Feed the sourdough starter flour and water.', ['Baking'], 'Bread Mag');
  const b = mk('Sourdough loaf', 'Bake sourdough bread in a dutch oven.');
  const c = mk('Kayaking in fjords', 'Paddle the calm fjords by kayak.');
  let l = storage.list();
  const by = (id) => l.find((n) => n.id === id);
  assert.strictEqual(by(a.id).subject, by(b.id).subject);
  assert.strictEqual(by(c.id).subject, 'Other');
  assert.strictEqual(by(a.id).siteName, 'Bread Mag');
  assert.strictEqual(by(a.id).pinnedSubject, '');

  storage.save(a.id, { title: 'Sourdough starter!', content: '<p>Edited sourdough text</p>' });
  assert.deepStrictEqual(storage.get(a.id).tags, ['Baking']);
  assert.strictEqual(storage.get(a.id).siteName, 'Bread Mag');

  storage.setSubject(c.id, 'Outdoors');
  l = storage.list();
  assert.strictEqual(by(c.id).subject, 'Outdoors');
  assert.strictEqual(by(c.id).pinnedSubject, 'Outdoors');
  storage.save(c.id, { content: '<p>More paddling</p>' });
  assert.strictEqual(storage.get(c.id).subject, 'Outdoors');
  storage.setSubject(c.id, '');
  l = storage.list();
  assert.strictEqual(by(c.id).subject, 'Other');
  storage.remove(b.id);
  assert.strictEqual(storage.list().length, 2);
});

test('user tags are kept apart from page tags, survive saves, and can be renamed or merged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherer-'));
  storage.setDir(dir);
  const a = storage.create({ title: 'A', url: 'https://a.example/', content: '<p>Alpha</p>', tags: ['page tag'] });
  const b = storage.create({ title: 'B', url: 'https://b.example/', content: '<p>Beta</p>' });
  assert.deepStrictEqual(storage.get(a.id).userTags, []);
  const sum = storage.setTags(a.id, ['#Reading', 'reading', 'To Try', '  ', 'a,b']);
  assert.deepStrictEqual(sum.userTags, ['Reading', 'To Try', 'a b']);
  assert.deepStrictEqual(storage.get(a.id).tags, ['page tag']);
  storage.save(a.id, { content: '<p>Alpha edited</p>' });
  storage.setSubject(a.id, 'Letters');
  assert.deepStrictEqual(storage.get(a.id).userTags, ['Reading', 'To Try', 'a b']);
  storage.setTags(b.id, ['later']);
  assert.strictEqual(storage.renameTag('reading', 'Later'), 1);
  assert.deepStrictEqual(storage.get(a.id).userTags, ['Later', 'To Try', 'a b']);
  storage.renameTag('later', 'later');
  assert.deepStrictEqual(storage.get(a.id).userTags, ['later', 'To Try', 'a b']);
  storage.renameTag('to try', '');
  assert.deepStrictEqual(storage.get(a.id).userTags, ['later', 'a b']);
  const l = storage.list();
  assert.deepStrictEqual(l.find((n) => n.id === b.id).userTags, ['later']);
});

test('highlights are <mark> elements that survive sanitizing and show in the summary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherer-'));
  storage.setDir(dir);
  const a = storage.create({ title: 'H', url: 'https://h.example/', content: '<p>One <mark>key idea</mark> here.</p>' });
  const sum = storage.save(a.id, { content: '<p>One <mark class="flash">key <b>idea</b></mark> and <mark>another</mark>.</p><p><mark> </mark></p>' });
  assert.deepStrictEqual(sum.highlights, ['key idea', 'another']);
  assert.match(storage.get(a.id).content, /<mark>key <b>idea<\/b><\/mark>/);
  assert.deepStrictEqual(storage.list()[0].highlights, ['key idea', 'another']);
});
