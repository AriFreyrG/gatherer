// Chooses which engine writes summaries and subjects, and hides the difference from callers.
//
//   'apple'  Apple Intelligence on this Mac (the default when available; free, private, offline)
//   'claude' Claude through the user's own Anthropic API key (optional; any OS, bigger model)
//   none     local extractive summary + keyword subjects (always works)
//
// The user's setting is 'auto' (Apple if available, else Claude if a key is saved), 'apple',
// 'claude' or 'off'.
const apple = require('./apple');
const claude = require('./claude');
const settings = require('./settings');

const LABELS = { apple: 'Apple Intelligence', claude: 'Claude' };

// -> { engine: 'apple'|'claude'|null, apple: {available, reason}, reason }
async function current() {
  const pref = settings.publicSettings().provider;
  const a = await apple.status();
  const key = settings.apiKey();
  let engine = null, reason = '';
  if (pref === 'off') reason = 'AI summaries are turned off in Settings.';
  else if (pref === 'apple') { if (a.available) engine = 'apple'; else reason = a.reason; }
  else if (pref === 'claude') { if (key) engine = 'claude'; else reason = 'Add an Anthropic API key in Settings to use Claude.'; }
  else if (a.available) engine = 'apple';
  else if (key) engine = 'claude';
  else reason = a.reason || 'Apple Intelligence is not available.';
  return { engine, apple: a, reason };
}

// -> { summary, topics, by }
async function summarize(input) {
  const { engine, reason } = await current();
  if (engine === 'apple') return { ...(await apple.summarizeNote(input)), by: 'apple' };
  if (engine === 'claude') return { ...(await claude.summarizeNote(settings.apiKey(), input)), by: 'claude' };
  throw new Error(reason);
}

// -> Map(id -> subject)
async function organize(notes, pinned) {
  const { engine, reason } = await current();
  if (engine === 'apple') return apple.organizeNotes(notes, pinned);
  if (engine === 'claude') return claude.organizeNotes(settings.apiKey(), notes, pinned);
  throw new Error(reason);
}

function describeError(e) {
  if (e instanceof apple.AppleAIError) return e.message;
  return claude.describeError(e);
}

module.exports = { current, summarize, organize, describeError, LABELS };
