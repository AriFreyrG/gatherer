const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sync = require('../src/main/sync');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gatherer-sync-'));
const write = (root, rel, text, mtime) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
  if (mtime) fs.utimesSync(path.join(root, rel), mtime / 1000, mtime / 1000);
};
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const has = (root, rel) => fs.existsSync(path.join(root, rel));
const note = (title, body = '') => `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title>\n</head><body>${body}</body></html>\n`;

// Two Macs sharing one iCloud folder.
function setup() {
  const cloud = sync.prepareRoot(tmp());
  const macs = [tmp(), tmp()].map((local) => ({ local, state: null }));
  const run = (m) => { const r = sync.syncOnce({ local: m.local, remote: cloud, state: m.state }); m.state = r.state; return r; };
  return { cloud, a: macs[0], b: macs[1], run };
}

test('prepareRoot uses an empty folder, and makes a Gatherer folder inside a busy one', () => {
  const empty = tmp();
  assert.strictEqual(sync.prepareRoot(empty), empty);
  assert.ok(has(empty, sync.MARKER));
  assert.strictEqual(sync.prepareRoot(empty), empty, 'reuses an existing sync folder');
  const busy = tmp();
  write(busy, 'Taxes.pdf', 'x');
  const root = sync.prepareRoot(busy);
  assert.strictEqual(root, path.join(busy, 'Gatherer'));
  assert.strictEqual(sync.prepareRoot(busy), root, 'finds the same Gatherer folder again');
});

test('only note files and per-note asset folders are synced', () => {
  for (const ok of ['20261107-101500-ab12.html', 'assets/20261107-101500-ab12/img-001.png', 'archive/x-1/page.html']) assert.ok(sync.isSyncable(ok), ok);
  for (const no of ['.DS_Store', 'notes.txt', 'a.html.123.ab.tmp', 'assets/x/.hidden', 'a/b/c/d.png', 'assets/img.png', 'sync-state.json']) assert.ok(!sync.isSyncable(no), no);
});

test('new notes and images travel both ways, edits follow, deletes propagate', () => {
  const { cloud, a, b, run } = setup();
  write(a.local, 'n1.html', note('One'));
  write(a.local, 'assets/n1/img-001.png', 'PNG');
  write(b.local, 'n2.html', note('Two'));
  assert.strictEqual(run(a).uploaded, 2);
  const rb = run(b);
  assert.deepStrictEqual(sync.idsOf(rb.changedLocal).sort(), ['n1']);
  assert.strictEqual(read(b.local, 'assets/n1/img-001.png'), 'PNG');
  run(a);
  assert.ok(has(a.local, 'n2.html'));

  // Edit on A reaches B.
  write(a.local, 'n1.html', note('One, edited'), Date.now() + 5000);
  run(a); run(b);
  assert.match(read(b.local, 'n1.html'), /One, edited/);
  assert.strictEqual(run(b).uploaded + run(a).downloaded, 0, 'steady state does nothing');

  // Delete on B (note and its images) removes it everywhere.
  fs.rmSync(path.join(b.local, 'n1.html'));
  fs.rmSync(path.join(b.local, 'assets/n1'), { recursive: true });
  run(b);
  assert.ok(!has(cloud, 'n1.html') && !has(cloud, 'assets/n1'));
  const ra = run(a);
  assert.ok(!has(a.local, 'n1.html') && !has(a.local, 'assets/n1/img-001.png'));
  assert.ok(ra.changedLocal.includes('n1.html'));
});

test('first sync merges and never deletes', () => {
  const { cloud, a, run } = setup();
  write(cloud, 'old.html', note('From the other Mac'));
  write(a.local, 'mine.html', note('Mine'));
  run(a);
  assert.ok(has(a.local, 'old.html') && has(cloud, 'mine.html'));
});

test('editing on both Macs keeps the newer copy and saves the other as a conflicted copy', () => {
  const { cloud, a, b, run } = setup();
  write(a.local, 'n.html', note('Plan'));
  run(a); run(b);
  const t = Date.now();
  write(a.local, 'n.html', note('Plan', 'from A'), t + 10000);
  write(b.local, 'n.html', note('Plan', 'from B'), t + 20000);
  run(a);
  const r = run(b);
  assert.deepStrictEqual(r.conflicts, ['n.html']);
  assert.match(read(cloud, 'n.html'), /from B/);
  const copy = fs.readdirSync(cloud).find((f) => f.startsWith('n-conflict-'));
  assert.ok(copy, 'conflicted copy exists');
  assert.match(read(cloud, copy), /<title>Plan \(conflicted copy\)<\/title>.*from A/s);
  run(a);
  assert.match(read(a.local, 'n.html'), /from B/);
  assert.ok(has(a.local, copy));
});

test('a note edited here after being deleted elsewhere comes back, with its images', () => {
  const { cloud, a, b, run } = setup();
  write(a.local, 'n.html', note('Keep me'));
  write(a.local, 'assets/n/img-001.png', 'PNG');
  run(a); run(b);
  fs.rmSync(path.join(a.local, 'n.html')); fs.rmSync(path.join(a.local, 'assets'), { recursive: true });
  write(b.local, 'n.html', note('Keep me', 'edited on B'), Date.now() + 5000);
  run(a); // A's delete goes up first
  run(b); // B's edit restores it
  run(a);
  assert.match(read(a.local, 'n.html'), /edited on B/);
  assert.strictEqual(read(a.local, 'assets/n/img-001.png'), 'PNG');
  assert.ok(has(cloud, 'assets/n/img-001.png'));
});

test('files iCloud has not downloaded yet are left alone', () => {
  const { cloud, a, run } = setup();
  write(a.local, 'n.html', note('Here'));
  run(a);
  // iCloud evicted the file and left a placeholder.
  fs.rmSync(path.join(cloud, 'n.html'));
  write(cloud, '.n.html.icloud', 'stub');
  const r = run(a);
  assert.strictEqual(r.pending, 1);
  assert.ok(has(a.local, 'n.html'), 'not treated as a delete');
  assert.ok(!has(cloud, 'n.html'), 'not re-uploaded over the placeholder');
});

test('a missing sync folder is an error, not a mass delete', () => {
  const { cloud, a, run } = setup();
  write(a.local, 'n.html', note('Here'));
  run(a);
  fs.rmSync(cloud, { recursive: true });
  assert.throws(() => run(a), /sync folder is missing/);
  assert.ok(has(a.local, 'n.html'));
});
