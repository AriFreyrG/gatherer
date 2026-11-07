const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ai = require('../src/main/claude');
const { profile, inferSubjects } = require('../src/main/topics');
const { localSummary } = require('../src/main/summarize');
const settings = require('../src/main/settings');
const storage = require('../src/main/storage');

// Fake Anthropic client: records requests and answers with canned JSON.
function fake(answer) {
  const calls = [];
  ai.setClientFactory((apiKey) => ({
    beta: { messages: { create: async (req) => { calls.push({ apiKey, req }); return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer(req)) }] }; } } },
    models: { retrieve: async () => ({}) },
  }));
  return calls;
}

test('summarizeNote sends the page with existing subjects and cleans the answer', async () => {
  const calls = fake(() => ({ summary: '  Sourdough needs a lively starter.\n Feed it daily. ', topics: ['Baking', 'baking', 'Bread, sourdough'] }));
  const r = await ai.summarizeNote('sk-test', { title: 'Starter', url: 'https://x', text: 'Feed your starter.', subjects: ['Baking', 'Travel'] });
  assert.strictEqual(r.summary, 'Sourdough needs a lively starter. Feed it daily.');
  assert.deepStrictEqual(r.topics, ['Baking', 'baking', 'Bread sourdough']);
  const { apiKey, req } = calls[0];
  assert.strictEqual(apiKey, 'sk-test');
  assert.strictEqual(req.model, ai.MODEL);
  assert.strictEqual(req.output_config.format.type, 'json_schema');
  assert.strictEqual(req.fallbacks, 'default');
  assert.match(req.messages[0].content, /Baking \| Travel/);
  assert.match(req.messages[0].content, /Feed your starter/);
});

test('summarizeNote surfaces refusals and empty pages as errors', async () => {
  ai.setClientFactory(() => ({ beta: { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } } }));
  await assert.rejects(ai.summarizeNote('k', { title: 't', text: 'body' }), /declined/);
  await assert.rejects(ai.summarizeNote('k', { title: 't', text: '  ' }), /no text/);
});

test('organizeNotes keeps only known ids and passes earlier labels to later chunks', async () => {
  const calls = fake((req) => {
    const ids = [...req.messages[0].content.matchAll(/^(n\d+)\t/gm)].map((m) => m[1]);
    return { assignments: [...ids.map((id) => ({ id, subject: Number(id.slice(1)) % 2 ? 'Machine learning' : 'Baking' })), { id: 'bogus', subject: 'X' }] };
  });
  const notes = Array.from({ length: 260 }, (_, i) => ({ id: 'n' + i, title: 'T' + i, summary: 'S' }));
  const r = await ai.organizeNotes('k', notes, ['Iceland travel']);
  assert.strictEqual(r.size, 260);
  assert.strictEqual(r.get('n1'), 'Machine learning');
  assert.ok(!r.has('bogus'));
  assert.strictEqual(calls.length, 2);
  assert.match(calls[0].req.messages[0].content, /Iceland travel/);
  assert.match(calls[1].req.messages[0].content, /Machine learning/);
});

test('AI subject labels group notes that share no vocabulary', () => {
  const d = (id, title, text, aiTopics) => ({ id, profile: profile({ title, text, tags: [], aiTopics }) });
  const notes = [
    d('a', 'Transformers explained', 'Attention layers map tokens to vectors.', ['Machine learning']),
    d('b', 'Gradient descent intuition', 'Walking downhill on a loss surface.', ['Machine learning']),
    d('c', 'Sourdough starter basics', 'Feed flour and water daily.', ['Baking']),
    d('e', 'Croissant lamination', 'Fold butter into the dough in layers.', ['Baking']),
    d('f', 'Hot springs near Reykjavik', 'Geothermal pools by the coast.', []),
  ];
  const r = inferSubjects(notes);
  assert.strictEqual(r.get('a'), 'Machine learning');
  assert.strictEqual(r.get('b'), 'Machine learning');
  assert.strictEqual(r.get('c'), 'Baking');
  assert.strictEqual(r.get('e'), 'Baking');
  assert.strictEqual(r.get('f'), 'Other');
});

test('localSummary picks a few representative sentences in order', () => {
  const text = 'Sourdough bread relies on a wild yeast starter that you feed with flour and water. ' +
    'Subscribe to our newsletter for more recipes every week from us. ' +
    'The weather was nice on the day I first tried to make it at home. ' +
    'A healthy sourdough starter doubles in size within a few hours of feeding. ' +
    'Long fermentation gives sourdough bread its tang and keeps the crumb open.';
  const s = localSummary({ title: 'Sourdough starter basics', text });
  assert.match(s, /^Sourdough bread relies/);
  assert.ok(!/newsletter/.test(s));
  assert.ok(s.length <= 500);
  assert.strictEqual(localSummary({ title: 'x', text: '' }), '');
});

test('settings encrypt the key and never expose it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherer-set-'));
  const file = path.join(dir, 'settings.json');
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('enc:' + s), decryptString: (b) => b.toString().slice(4) };
  settings.setup({ path: file, safeStorage });
  const env = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.strictEqual(settings.publicSettings().hasKey, false);
    const pub = settings.setApiKey(' sk-ant-secret1234 ');
    assert.deepStrictEqual(pub, { hasKey: true, keySource: 'settings', keyHint: '…1234', autoSummarize: true, provider: 'auto' });
    assert.ok(!fs.readFileSync(file, 'utf8').includes('sk-ant-secret1234'));
    assert.strictEqual(settings.apiKey(), 'sk-ant-secret1234');
    settings.setApiKey('');
    assert.strictEqual(settings.apiKey(), '');
    process.env.ANTHROPIC_API_KEY = 'sk-env-9999';
    assert.strictEqual(settings.publicSettings().keySource, 'environment');
  } finally { if (env === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = env; }
});

test('storage keeps AI summary and topics, falls back to a local summary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherer-ai-'));
  storage.setDir(dir);
  const body = '<p>Attention layers let a transformer weigh every token against every other token in the input.</p><p>That is why transformers handle long sentences better than older recurrent networks did.</p>';
  const a = storage.create({ title: 'Transformers explained', url: 'https://a', content: body });
  const b = storage.create({ title: 'Gradient descent intuition', url: 'https://b', content: '<p>Walking downhill on a loss surface, one small step at a time, until the error stops shrinking.</p>' });
  assert.strictEqual(storage.get(a.id).summarySource, 'local');
  assert.match(storage.get(a.id).summary, /Attention layers/);

  storage.setAi(a.id, { summary: 'How attention works.', by: 'apple', topics: ['Machine learning'] });
  storage.setAi(b.id, { topics: ['Machine learning'] });
  storage.save(a.id, { content: body + '<p>Edited.</p>' });
  const n = storage.get(a.id);
  assert.strictEqual(n.summary, 'How attention works.');
  assert.strictEqual(n.summarySource, 'apple');
  assert.deepStrictEqual(n.topics, ['Machine learning']);
  const l = storage.list();
  assert.strictEqual(l.find((x) => x.id === a.id).subject, 'Machine learning');
  assert.strictEqual(l.find((x) => x.id === b.id).subject, 'Machine learning');
  const briefs = storage.briefs();
  assert.strictEqual(briefs.find((x) => x.id === a.id).summary, 'How attention works.');
  assert.match(briefs.find((x) => x.id === b.id).summary, /Walking downhill/);

  storage.setAi(a.id, { summary: '' });
  assert.strictEqual(storage.get(a.id).summarySource, 'local');
});
