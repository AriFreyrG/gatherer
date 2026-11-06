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
