// Brings notes over from another Gatherer notes folder, such as the one an earlier,
// unsandboxed build kept in ~/Library/Application Support/Gatherer. The Mac App Store build
// runs in a sandbox with its own container, so it can only read that folder after the user
// picks it in an Open dialog. No Electron deps.
const fs = require('fs');
const os = require('os');
const path = require('path');
const storage = require('./storage');

// Where builds outside the sandbox keep their notes. os.userInfo() reads the real home folder,
// which stays correct inside the sandbox, where HOME points into the container.
function legacyNotesDir(appName = 'Gatherer') {
  const home = os.userInfo().homedir;
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', appName, 'notes');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), appName, 'notes');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), appName, 'notes');
}

const isNoteFile = (f) => /^[\w-]+\.html$/.test(f);

// The user may pick the notes folder itself or the Gatherer folder that contains it.
function resolveNotesDir(picked) {
  const inner = path.join(picked, 'notes');
  try { if (fs.statSync(inner).isDirectory() && fs.readdirSync(inner).some(isNoteFile)) return inner; } catch { /* use picked */ }
  return picked;
}

// Imports every note in dir. Returns { imported: [ids], skipped, failed }.
function importFolder(picked) {
  const dir = resolveNotesDir(picked);
  if (path.resolve(dir) === path.resolve(storage.getDir())) return { imported: [], skipped: 0, failed: 0 };
  const result = { imported: [], skipped: 0, failed: 0 };
  for (const f of fs.readdirSync(dir).filter(isNoteFile)) {
    try {
      const id = storage.importNote(dir, f);
      if (id) result.imported.push(id); else result.skipped++;
    } catch (e) {
      console.warn(`[migrate] skipped ${f}: ${e.message}`);
      result.failed++;
    }
  }
  return result;
}

module.exports = { legacyNotesDir, resolveNotesDir, importFolder };
