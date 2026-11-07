// Apple Intelligence (on-device Foundation Models) through the small Swift helper in
// native/apple-ai. Nothing leaves the Mac. On other platforms, Intel Macs, older macOS or with
// Apple Intelligence turned off, status() reports why and callers use the local fallback.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NAME = 'gatherer-ai';

let helperOverride = null;
// Tests point this at a fake helper.
function setHelperPath(p) { helperOverride = p; statusCache = null; }

function helperPath() {
  if (helperOverride) return helperOverride;
  if (process.platform !== 'darwin') return null;
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, NAME)); // packaged app
  candidates.push(path.join(__dirname, '..', '..', 'native', 'apple-ai', 'bin', NAME)); // npm run build:apple-ai
  return candidates.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}

class AppleAIError extends Error {
  constructor(message, code) { super(message); this.code = code || 'error'; }
}

// The on-device model works on one request at a time, so generation requests queue up.
let queue = Promise.resolve();
function run(request, timeoutMs) {
  if (request.cmd === 'status') return spawnHelper(request, timeoutMs);
  const p = queue.then(() => spawnHelper(request, timeoutMs));
  queue = p.catch(() => {});
  return p;
}

function spawnHelper(request, timeoutMs = 120000) {
  const exe = helperPath();
  if (!exe) return Promise.reject(new AppleAIError('Apple Intelligence is only available in the Mac app.', 'missing'));
  return new Promise((resolve, reject) => {
    let out = '', err = '', done = false;
    const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { if (!done) { done = true; child.kill(); reject(new AppleAIError('Apple Intelligence took too long.', 'timeout')); } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); reject(new AppleAIError(`Could not start Apple Intelligence helper: ${e.message}`, 'spawn')); });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      let res = null;
      try { res = JSON.parse(out.trim().split('\n').pop() || 'null'); } catch {}
      if (res && res.ok) return resolve(res);
      if (res && res.error) return reject(new AppleAIError(res.error, res.code));
      // A dyld failure here usually means macOS is older than 26.
      reject(new AppleAIError(code === 0 ? 'Apple Intelligence gave no answer.' : 'Apple Intelligence needs macOS 26 or later.', 'crash'));
      if (err) console.warn('[apple-ai]', err.trim().slice(0, 500));
    });
    child.stdin.end(JSON.stringify(request));
  });
}

// { available, reason } — cached; the state rarely changes while the app runs, and refresh() re-checks.
let statusCache = null;
async function status({ refresh } = {}) {
  if (statusCache && !refresh) return statusCache;
  try {
    const r = await run({ cmd: 'status' }, 15000);
    statusCache = { available: !!r.available, reason: r.reason || '' };
  } catch (e) {
    statusCache = { available: false, reason: e.code === 'missing' ? 'Apple Intelligence needs the Mac app on macOS 26 or later.' : e.message };
  }
  return statusCache;
}

const cleanLabel = (s) => String(s || '').replace(/[\r\n,]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

// -> { summary, topics }
async function summarizeNote({ title, url, text, subjects = [] }) {
  if (!String(text || '').trim()) throw new AppleAIError('This note has no text to summarize', 'empty');
  const r = await run({ cmd: 'summarize', title, url, text: String(text).slice(0, 20000), subjects });
  const summary = String(r.summary || '').replace(/\s+/g, ' ').trim();
  if (!summary) throw new AppleAIError('Apple Intelligence returned an empty summary', 'empty');
  const topics = [...new Set((r.topics || []).map(cleanLabel).filter(Boolean))].slice(0, 3);
  return { summary, topics };
}

// notes: [{ id, title, summary }] -> Map(id -> subject)
async function organizeNotes(notes, pinned = []) {
  const r = await run({ cmd: 'organize', notes: notes.map(({ id, title, summary }) => ({ id, title, summary })), subjects: pinned }, 10 * 60000);
  const ids = new Set(notes.map((n) => n.id));
  const map = new Map();
  for (const a of r.assignments || []) { const s = cleanLabel(a.subject); if (ids.has(a.id) && s) map.set(a.id, s); }
  return map;
}

module.exports = { status, summarizeNote, organizeNotes, setHelperPath, helperPath, AppleAIError };
