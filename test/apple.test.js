const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const apple = require('../src/main/apple');
const intelligence = require('../src/main/intelligence');
const settings = require('../src/main/settings');

// A stand-in for the Swift helper: same stdin/stdout JSON protocol, behaviour picked by env.
function fakeHelper(dir, script) {
  const p = path.join(dir, 'gatherer-ai');
  fs.writeFileSync(p, `#!${process.execPath}\nlet s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const req=JSON.parse(s);${script}});\n`, { mode: 0o755 });
  return p;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gatherer-apple-'));

test('talks to the helper over JSON and cleans its answers', async () => {
  apple.setHelperPath(fakeHelper(tmp(), `
    const out = req.cmd === 'status' ? { ok: true, available: true }
      : req.cmd === 'summarize' ? { ok: true, summary: '  About ' + req.title + '. ', topics: ['Baking', 'Baking', 'Bread, sourdough'] }
      : { ok: true, assignments: req.notes.map(n => ({ id: n.id, subject: 'Topic ' + n.id })).concat([{ id: 'nope', subject: 'X' }]) };
    console.log(JSON.stringify(out));`));
  assert.deepStrictEqual(await apple.status(), { available: true, reason: '' });
  const r = await apple.summarizeNote({ title: 'Starter', text: 'Feed it.', subjects: [] });
  assert.deepStrictEqual(r, { summary: 'About Starter.', topics: ['Baking', 'Bread sourdough'] });
  const m = await apple.organizeNotes([{ id: 'a', title: 'A', summary: 'x' }], []);
  assert.deepStrictEqual([...m], [['a', 'Topic a']]);
});

test('reports helper errors and unavailability', async () => {
  apple.setHelperPath(fakeHelper(tmp(), `
    if (req.cmd === 'status') console.log(JSON.stringify({ ok: true, available: false, reason: 'Apple Intelligence is turned off in System Settings.' }));
    else { console.log(JSON.stringify({ ok: false, code: 'guardrail', error: 'Apple Intelligence declined to process this page.' })); process.exit(1); }`));
  assert.deepStrictEqual(await apple.status(), { available: false, reason: 'Apple Intelligence is turned off in System Settings.' });
  await assert.rejects(apple.summarizeNote({ title: 't', text: 'x' }), (e) => e.code === 'guardrail' && /declined/.test(e.message));
  apple.setHelperPath(path.join(tmp(), 'missing'));
  const s = await apple.status();
  assert.strictEqual(s.available, false);
});

test('engine choice: Apple first, Claude only with a key, off means local', async () => {
  const dir = tmp();
  settings.setup({ path: path.join(dir, 'settings.json'), safeStorage: { isEncryptionAvailable: () => false } });
  const env = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  try {
    apple.setHelperPath(fakeHelper(dir, `console.log(JSON.stringify({ ok: true, available: true }))`));
    assert.strictEqual((await intelligence.current()).engine, 'apple');
    settings.setProvider('claude');
    assert.strictEqual((await intelligence.current()).engine, null);
    settings.setApiKey('sk-test');
    assert.strictEqual((await intelligence.current()).engine, 'claude');
    settings.setProvider('off');
    assert.strictEqual((await intelligence.current()).engine, null);
    settings.setProvider('auto');
    assert.strictEqual((await intelligence.current()).engine, 'apple');
    apple.setHelperPath(fakeHelper(tmp(), `console.log(JSON.stringify({ ok: true, available: false, reason: 'no' }))`));
    assert.strictEqual((await intelligence.current()).engine, 'claude'); // auto falls back to Claude with a key
    settings.setApiKey('');
    const c = await intelligence.current();
    assert.strictEqual(c.engine, null);
    assert.strictEqual(c.reason, 'no');
  } finally { if (env !== undefined) process.env.ANTHROPIC_API_KEY = env; }
});
