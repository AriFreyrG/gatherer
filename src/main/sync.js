// Two-way folder sync between the local notes folder and a folder in iCloud Drive (or any
// synced folder). The local folder stays the source the app reads, so every note is always
// on this Mac and works offline; iCloud Drive carries the copy to other Macs. No Electron deps.
//
// It is a three-way merge: `state.files` remembers each file as it was after the last sync
// (its hash, and its size and mtime on each side). A file that changed on one side only is
// copied to the other. A file that changed on both is a conflict: the newer copy wins, and for
// a note the older one is kept as a separate "conflicted copy" note so no edit is lost.
// A file is deleted on one side only when it was synced before and then removed on the other.
//
// Synced: top-level <id>.html notes, and files one folder deep under <folder>/<id>/
// (assets/<id>/img-001.png and the like). Dotfiles, temp files and iCloud placeholders are not.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MARKER = '.gatherer-sync';
const NOTE_RE = /^[\w-]+\.html$/;
const ID_RE = /^[\w-]+$/;
const FILE_RE = /^[\w.-]+$/;

const isSyncable = (rel) => {
  const parts = rel.split('/');
  if (parts.some((p) => p.startsWith('.') || p.endsWith('.tmp'))) return false;
  if (parts.length === 1) return NOTE_RE.test(parts[0]);
  return parts.length === 3 && ID_RE.test(parts[0]) && ID_RE.test(parts[1]) && FILE_RE.test(parts[2]);
};

// Walk a sync root. Returns { files: Map<rel, {size, mtimeMs}>, pending: Set<rel> }.
// `pending` holds files iCloud has not downloaded yet (".name.icloud" placeholders).
function scan(root) {
  const files = new Map();
  const pending = new Set();
  const walk = (dir, rel, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const ent of entries) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      const stub = ent.name.match(/^\.(.+)\.icloud$/);
      if (stub) { const real = rel ? `${rel}/${stub[1]}` : stub[1]; if (isSyncable(real)) pending.add(real); continue; }
      if (ent.isDirectory()) { if (depth < 2 && !ent.name.startsWith('.')) walk(path.join(dir, ent.name), r, depth + 1); continue; }
      if (!ent.isFile() || !isSyncable(r)) continue;
      try { const st = fs.statSync(path.join(dir, ent.name)); files.set(r, { size: st.size, mtimeMs: Math.round(st.mtimeMs) }); }
      catch { /* vanished mid-scan */ }
    }
  };
  walk(root, '', 0);
  return { files, pending };
}

const hashFile = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
const sameStat = (a, b) => !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs;

function copyAtomic(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.copyFileSync(src, tmp);
  const st = fs.statSync(src);
  fs.utimesSync(tmp, st.atime, st.mtime);
  fs.renameSync(tmp, dest);
}

function removeFile(root, rel) {
  try { fs.unlinkSync(path.join(root, rel)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // Tidy up an asset folder once its last file is gone.
  const dir = path.dirname(rel);
  if (dir !== '.') { try { fs.rmdirSync(path.join(root, dir)); } catch { /* not empty */ } }
}

const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');

// Keep the losing side of a note conflict as its own note, titled so it's easy to spot.
function writeConflictCopy(srcFile, rel, mtimeMs, roots) {
  const id = rel.slice(0, -5);
  const copyRel = `${id}-conflict-${stamp(mtimeMs)}.html`;
  const html = fs.readFileSync(srcFile, 'utf8').replace(/<title>([\s\S]*?)<\/title>/i, (_, t) => `<title>${t} (conflicted copy)</title>`);
  for (const root of roots) {
    const dest = path.join(root, copyRel);
    if (!fs.existsSync(dest)) { fs.writeFileSync(dest, html, 'utf8'); fs.utimesSync(dest, new Date(), new Date(mtimeMs)); }
  }
  return copyRel;
}

// Ensure `chosen` is usable as a sync root and return the folder to sync with. A folder that
// is empty or already holds Gatherer notes is used as is; any other folder (such as the top of
// iCloud Drive) gets a "Gatherer" folder inside it.
function prepareRoot(chosen) {
  const isRoot = (d) => fs.existsSync(path.join(d, MARKER));
  let root = chosen;
  if (!isRoot(chosen)) {
    const visible = fs.readdirSync(chosen).filter((f) => !f.startsWith('.'));
    if (visible.length) root = path.join(chosen, 'Gatherer');
  }
  fs.mkdirSync(root, { recursive: true });
  if (!isRoot(root)) fs.writeFileSync(path.join(root, MARKER), 'This folder is synced by Gatherer. Its notes are plain HTML files.\n');
  return root;
}

// One sync pass. Mutates and returns `state` ({ remote, files }). Returns a report:
// { state, changedLocal: rel[], uploaded, downloaded, deleted, conflicts: rel[], pending }.
function syncOnce({ local, remote, state }) {
  if (!fs.existsSync(path.join(remote, MARKER))) {
    throw new Error('The sync folder is missing. If iCloud Drive is still setting up, try again in a moment; otherwise choose the folder again.');
  }
  if (!state || state.remote !== remote) state = { remote, files: {} };
  const base = state.files;
  const L = scan(local);
  const R = scan(remote);
  const report = { changedLocal: [], uploaded: 0, downloaded: 0, deleted: 0, conflicts: [], pending: R.pending.size };
  const all = new Set([...L.files.keys(), ...R.files.keys(), ...Object.keys(base)]);

  // Hash a side's file only when its size or mtime moved since the last sync.
  const hashOf = (root, rel, st, rec) => (rec && sameStat(st, rec) ? state.files[rel].hash : hashFile(path.join(root, rel)));
  const record = (rel, hash) => {
    const l = fs.statSync(path.join(local, rel));
    const r = fs.statSync(path.join(remote, rel));
    base[rel] = { hash, l: { size: l.size, mtimeMs: Math.round(l.mtimeMs) }, r: { size: r.size, mtimeMs: Math.round(r.mtimeMs) } };
  };
  const pull = (rel, hash) => { copyAtomic(path.join(remote, rel), path.join(local, rel)); record(rel, hash); report.downloaded++; report.changedLocal.push(rel); };
  const push = (rel, hash) => { copyAtomic(path.join(local, rel), path.join(remote, rel)); record(rel, hash); report.uploaded++; };

  // Notes first, so an asset's fate can follow its note's (a restored note gets its images back).
  const noteOf = (rel) => (rel.includes('/') ? `${rel.split('/')[1]}.html` : null);
  const order = [...all].sort((a, b) => (a.includes('/') - b.includes('/')) || a.localeCompare(b));
  const exists = (root, rel) => fs.existsSync(path.join(root, rel));

  for (const rel of order) {
    if (R.pending.has(rel)) continue; // wait until iCloud has downloaded it
    const ls = L.files.get(rel);
    const rs = R.files.get(rel);
    const b = base[rel];
    try {
      if (ls && rs) {
        const lh = hashOf(local, rel, ls, b && b.l);
        const rh = hashOf(remote, rel, rs, b && b.r);
        if (lh === rh) { record(rel, lh); continue; }
        const lChanged = !b || lh !== b.hash;
        const rChanged = !b || rh !== b.hash;
        if (lChanged && !rChanged) push(rel, lh);
        else if (rChanged && !lChanged) pull(rel, rh);
        else {
          // Both sides changed: newer wins; keep the other note as a conflicted copy.
          const localWins = ls.mtimeMs >= rs.mtimeMs;
          if (NOTE_RE.test(rel)) {
            const loser = localWins ? path.join(remote, rel) : path.join(local, rel);
            const copy = writeConflictCopy(loser, rel, localWins ? rs.mtimeMs : ls.mtimeMs, [local, remote]);
            record(copy, hashFile(path.join(local, copy)));
            report.conflicts.push(rel); report.changedLocal.push(copy);
          }
          if (localWins) push(rel, lh); else pull(rel, rh);
        }
      } else if (ls) {
        const lh = hashOf(local, rel, ls, b && b.l);
        const keep = noteOf(rel) && exists(local, noteOf(rel)) && exists(remote, noteOf(rel));
        if (b && lh === b.hash && !keep) { removeFile(local, rel); delete base[rel]; report.deleted++; report.changedLocal.push(rel); }
        else push(rel, lh); // new here, or edited here after being deleted elsewhere
      } else if (rs) {
        const rh = hashOf(remote, rel, rs, b && b.r);
        const keep = noteOf(rel) && exists(local, noteOf(rel)) && exists(remote, noteOf(rel));
        if (b && rh === b.hash && !keep) { removeFile(remote, rel); delete base[rel]; report.deleted++; }
        else pull(rel, rh);
      } else {
        delete base[rel]; // gone on both sides
      }
    } catch (e) {
      if (e.code === 'ENOENT') continue; // changed while we looked; next pass picks it up
      throw e;
    }
  }
  return { state, ...report };
}

// Turns changed file paths into the note ids they belong to.
const idsOf = (rels) => [...new Set(rels.map((r) => (r.includes('/') ? r.split('/')[1] : r.slice(0, -5))))];

module.exports = { MARKER, isSyncable, scan, prepareRoot, syncOnce, idsOf };
