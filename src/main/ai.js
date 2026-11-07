// Optional AI layer: per-note summaries and grouping by meaning, through the Claude API.
//
// Everything here is an enhancement. With no API key (or no network) callers fall back to the
// local summary in summarize.js and the keyword topics in topics.js, so the app keeps working
// offline. The key is the user's own Anthropic API key, entered in Settings (see settings.js).
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5-5';
const MAX_ARTICLE_CHARS = 60000; // a long article is ~15k tokens; plenty for a summary
const ORGANIZE_CHUNK = 250; // notes per regroup request

let clientFactory = (apiKey) => new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 });
// Tests swap in a fake client.
function setClientFactory(f) { clientFactory = f; }

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '2-3 plain sentences, under 70 words' },
    topics: { type: 'array', items: { type: 'string' }, description: '1-3 short subject labels, most fitting first' },
  },
  required: ['summary', 'topics'],
  additionalProperties: false,
};

const ORGANIZE_SCHEMA = {
  type: 'object',
  properties: {
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, subject: { type: 'string' } },
        required: ['id', 'subject'],
        additionalProperties: false,
      },
    },
  },
  required: ['assignments'],
  additionalProperties: false,
};

// One structured-output request. Opts into server-side fallbacks so a classifier decline on the
// primary model is retried on Anthropic's recommended fallback instead of failing outright.
async function ask(apiKey, { system, user, schema, maxTokens }) {
  const client = clientFactory(apiKey);
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (res.stop_reason === 'refusal') throw new Error('The AI declined to process this page');
  if (res.stop_reason === 'max_tokens') throw new Error('The AI response was cut off');
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return JSON.parse(text); } catch { throw new Error('The AI returned an unreadable answer'); }
}

const cleanLabel = (s) => String(s || '').replace(/[\r\n,]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

// -> { summary, topics: string[] }
async function summarizeNote(apiKey, { title, url, text, subjects = [] }) {
  const body = String(text || '').trim();
  if (!body) throw new Error('This note has no text to summarize');
  const known = [...new Set(subjects.map(cleanLabel).filter(Boolean))].slice(0, 60);
  const out = await ask(apiKey, {
    maxTokens: 2000,
    system:
      'You summarize saved web pages for a personal reading notebook. Write the summary in the ' +
      "page's own language, as plain sentences with no preamble, no markdown and no \"This article\" opener. " +
      'Then name the subject the page belongs under: broad enough that related pages would share it ' +
      '(e.g. "Machine learning", "Baking", "Iceland travel"), 1-4 words, sentence case. ' +
      'If one of the existing subjects fits, use it exactly as written.',
    user:
      `Existing subjects: ${known.length ? known.join(' | ') : '(none yet)'}\n\n` +
      `<page>\nTitle: ${title || 'Untitled'}\nURL: ${url || ''}\n\n${body.slice(0, MAX_ARTICLE_CHARS)}\n</page>`,
    schema: SUMMARY_SCHEMA,
  });
  const summary = String(out.summary || '').replace(/\s+/g, ' ').trim();
  const topics = [...new Set((Array.isArray(out.topics) ? out.topics : []).map(cleanLabel).filter(Boolean))].slice(0, 3);
  if (!summary) throw new Error('The AI returned an empty summary');
  return { summary, topics };
}

// Group a whole collection by meaning in one pass, so labels are consistent across notes.
//   notes: [{ id, title, summary }]   pinned: subjects the user chose by hand
// -> Map(id -> subject)
async function organizeNotes(apiKey, notes, pinned = []) {
  const result = new Map();
  let labels = [...new Set(pinned.map(cleanLabel).filter(Boolean))];
  for (let i = 0; i < notes.length; i += ORGANIZE_CHUNK) {
    const chunk = notes.slice(i, i + ORGANIZE_CHUNK);
    const lines = chunk.map((n) => `${n.id}\t${cleanLabel(n.title) || 'Untitled'}\t${String(n.summary || '').replace(/\s+/g, ' ').slice(0, 300)}`);
    const out = await ask(apiKey, {
      maxTokens: 16000,
      system:
        'You organize a personal notebook of saved web pages into subjects by what each page is about, ' +
        'not by shared words. Pick a small set of subjects that a person would recognise as folders: ' +
        'roughly one subject per 3-8 notes, each 1-4 words in sentence case. Pages about the same field ' +
        'belong together even when they use different vocabulary. Reuse the given subjects exactly when they fit. ' +
        'A page that fits nothing else goes under "Other". Return one assignment for every id.',
      user:
        `Subjects already in use: ${labels.length ? labels.join(' | ') : '(none)'}\n\n` +
        `Notes (id, title, summary), one per line:\n${lines.join('\n')}`,
      schema: ORGANIZE_SCHEMA,
    });
    const ids = new Set(chunk.map((n) => n.id));
    for (const a of Array.isArray(out.assignments) ? out.assignments : []) {
      const s = cleanLabel(a.subject);
      if (ids.has(a.id) && s) result.set(a.id, s);
    }
    labels = [...new Set([...labels, ...result.values()])].filter((l) => l.toLowerCase() !== 'other');
  }
  return result;
}

// Cheap request that proves a key works, used when the user saves one.
async function checkKey(apiKey) {
  const client = clientFactory(apiKey);
  await client.models.retrieve(MODEL);
  return true;
}

// Map SDK errors to something worth showing a person.
function describeError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'The API key was rejected. Check it in Settings.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use the model.';
  if (e instanceof Anthropic.RateLimitError) return 'The AI is rate limited right now. Try again in a minute.';
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach the AI service. Are you offline?';
  if (e instanceof Anthropic.APIError) return `AI request failed (${e.status || 'error'}).`;
  return (e && e.message) || 'AI request failed';
}

module.exports = { summarizeNote, organizeNotes, checkKey, describeError, setClientFactory, MODEL };
