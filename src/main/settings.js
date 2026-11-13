// App settings in <userData>/settings.json. The Anthropic API key is encrypted with Electron's
// safeStorage (the macOS Keychain, DPAPI on Windows, libsecret on Linux) and never sent to the
// renderer. ANTHROPIC_API_KEY in the environment is honoured as a fallback for development.
const fs = require('fs');
const path = require('path');

let file = null;
let crypto = null; // { isEncryptionAvailable, encryptString, decryptString }
// Tests inject a path and a fake safeStorage.
function setup({ path: p, safeStorage } = {}) { file = p || null; crypto = safeStorage || null; }

function getFile() {
  if (!file) file = path.join(require('electron').app.getPath('userData'), 'settings.json');
  return file;
}
function getCrypto() {
  if (!crypto) { try { crypto = require('electron').safeStorage; } catch { crypto = null; } }
  return crypto;
}

function read() {
  try { return JSON.parse(fs.readFileSync(getFile(), 'utf8')) || {}; } catch { return {}; }
}
function write(data) {
  fs.mkdirSync(path.dirname(getFile()), { recursive: true });
  const tmp = getFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, getFile());
}

function storedKey() {
  const s = read();
  if (s.apiKeyEnc) {
    try { return getCrypto().decryptString(Buffer.from(s.apiKeyEnc, 'base64')); } catch { return ''; }
  }
  return s.apiKeyPlain || '';
}

// The key to use, or '' when AI features are off.
function apiKey() { return storedKey() || String(process.env.ANTHROPIC_API_KEY || '').trim(); }

// What the renderer may know: whether a key is set and where it came from, never the key itself.
function publicSettings() {
  const own = storedKey();
  const env = String(process.env.ANTHROPIC_API_KEY || '').trim();
  const shown = own || env;
  return {
    hasKey: !!shown,
    keySource: own ? 'settings' : env ? 'environment' : '',
    keyHint: shown ? `…${shown.slice(-4)}` : '',
    autoSummarize: read().autoSummarize !== false,
  };
}

function setApiKey(key) {
  const k = String(key || '').trim();
  const s = read();
  delete s.apiKeyEnc; delete s.apiKeyPlain;
  if (k) {
    const c = getCrypto();
    if (c && c.isEncryptionAvailable()) s.apiKeyEnc = c.encryptString(k).toString('base64');
    else s.apiKeyPlain = k; // no OS keychain available (rare on Linux); file stays in userData
  }
  write(s);
  return publicSettings();
}

function setAutoSummarize(on) { const s = read(); s.autoSummarize = !!on; write(s); return publicSettings(); }

module.exports = { setup, apiKey, publicSettings, setApiKey, setAutoSummarize };
