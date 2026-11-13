// App settings in <userData>/settings.json. The Anthropic API key is encrypted with Electron's
// safeStorage (the macOS Keychain, DPAPI on Windows, libsecret on Linux) and never sent to the
// renderer. The Reddit app secret is kept the same way. ANTHROPIC_API_KEY in the environment is honoured as a fallback for development.
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

function decrypt(enc, plain) {
  if (enc) {
    try { return getCrypto().decryptString(Buffer.from(enc, 'base64')); } catch { return ''; }
  }
  return plain || '';
}
function encryptInto(s, field, value) {
  delete s[field + 'Enc']; delete s[field + 'Plain'];
  if (!value) return;
  const c = getCrypto();
  if (c && c.isEncryptionAvailable()) s[field + 'Enc'] = c.encryptString(value).toString('base64');
  else s[field + 'Plain'] = value; // no OS keychain available (rare on Linux); file stays in userData
}

function storedKey() { const s = read(); return decrypt(s.apiKeyEnc, s.apiKeyPlain); }

// The Reddit app key for reading posts through Reddit's API, or null. The secret is empty for
// an "installed app" key. REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET are a development fallback.
function storedReddit() {
  const s = read();
  if (!s.redditClientId) return null;
  return { clientId: s.redditClientId, secret: decrypt(s.redditSecretEnc, s.redditSecretPlain) };
}
function redditCreds() {
  const own = storedReddit();
  if (own) return own;
  const id = String(process.env.REDDIT_CLIENT_ID || '').trim();
  return id ? { clientId: id, secret: String(process.env.REDDIT_CLIENT_SECRET || '').trim() } : null;
}

function setReddit({ clientId, secret } = {}) {
  const id = String(clientId || '').trim();
  const s = read();
  delete s.redditClientId;
  encryptInto(s, 'redditSecret', '');
  if (id) { s.redditClientId = id; encryptInto(s, 'redditSecret', String(secret || '').trim()); }
  write(s);
  return publicSettings();
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
    reddit: (() => {
      const own = storedReddit();
      const r = own || redditCreds();
      return { hasKey: !!r, source: own ? 'settings' : r ? 'environment' : '', hint: r ? `…${r.clientId.slice(-4)}` : '' };
    })(),
  };
}

function setApiKey(key) {
  const k = String(key || '').trim();
  const s = read();
  encryptInto(s, 'apiKey', k);
  write(s);
  return publicSettings();
}

function setAutoSummarize(on) { const s = read(); s.autoSummarize = !!on; write(s); return publicSettings(); }

module.exports = { setup, apiKey, publicSettings, setApiKey, setAutoSummarize, redditCreds, setReddit };
