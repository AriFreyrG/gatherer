const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const storage = require('../src/main/storage');
const migrate = require('../src/main/migrate');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gatherer-'));

test('imports notes and their images from an old notes folder, once', () => {
  const oldRoot = tmp();
  const oldNotes = path.join(oldRoot, 'notes');
  storage.setDir(oldNotes);
  const a = storage.create({ title: 'Old one', url: 'https://example.com/a', content: '<p>First</p>', tags: ['Baking'], siteName: 'Ex' });
  const b = storage.create({ title: 'Old two', url: 'https://example.com/b', content: '<p>Pic</p>' });
  storage.save(b.id, { content: `<p>Pic</p><p><img src="gatherer-asset://${b.id}/img-001.png"></p>` });
  fs.mkdirSync(storage.assetDir(b.id), { recursive: true });
  fs.writeFileSync(path.join(storage.assetDir(b.id), 'img-001.png'), 'png-bytes');
  fs.writeFileSync(path.join(oldNotes, 'not-a-note.html'), '<html><body>hi</body></html>');

  const newNotes = path.join(tmp(), 'notes');
  storage.setDir(newNotes);
  // Picking the parent folder works as well as the notes folder.
  let r = migrate.importFolder(oldRoot);
  assert.deepStrictEqual(r.imported.sort(), [a.id, b.id].sort());
  assert.strictEqual(r.failed, 1);
  assert.strictEqual(storage.get(a.id).title, 'Old one');
  assert.deepStrictEqual(storage.get(a.id).tags, ['Baking']);
  assert.strictEqual(storage.get(a.id).siteName, 'Ex');
  assert.strictEqual(fs.readFileSync(path.join(storage.assetDir(b.id), 'img-001.png'), 'utf8'), 'png-bytes');

  // Running it again changes nothing.
  r = migrate.importFolder(oldNotes);
  assert.deepStrictEqual(r.imported, []);
  assert.strictEqual(r.skipped, 2);
  assert.strictEqual(storage.list().length, 2);
});

test('a different note with a clashing id is imported under a new id with its images', () => {
  const oldNotes = path.join(tmp(), 'notes');
  storage.setDir(oldNotes);
  const old = storage.create({ title: 'Old', url: 'https://example.com/o', content: '<p>Old</p>' });
  storage.save(old.id, { content: `<p>Old</p><p><img src="gatherer-asset://${old.id}/img-001.png"></p>` });
  fs.mkdirSync(storage.assetDir(old.id), { recursive: true });
  fs.writeFileSync(path.join(storage.assetDir(old.id), 'img-001.png'), 'old-img');

  const newNotes = path.join(tmp(), 'notes');
  fs.mkdirSync(newNotes, { recursive: true });
  fs.copyFileSync(path.join(oldNotes, old.id + '.html'), path.join(newNotes, old.id + '.html'));
  storage.setDir(newNotes);
  storage.save(old.id, { content: '<p>Edited here</p>' });

  const r = migrate.importFolder(oldNotes);
  assert.strictEqual(r.imported.length, 1);
  const id = r.imported[0];
  assert.notStrictEqual(id, old.id);
  assert.ok(storage.get(id).content.includes(`gatherer-asset://${id}/img-001.png`));
  assert.strictEqual(fs.readFileSync(path.join(storage.assetDir(id), 'img-001.png'), 'utf8'), 'old-img');
  assert.strictEqual(storage.get(old.id).content, '<p>Edited here</p>');
});
