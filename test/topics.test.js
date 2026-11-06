const test = require('node:test');
const assert = require('node:assert');
const { profile, inferSubjects, OTHER } = require('../src/main/topics');

const doc = (id, title, text, tags = [], pinned) => ({ id, profile: profile({ title, text, tags }), pinned });

const corpus = () => [
  doc('a', 'Sourdough starter basics', 'Feed your sourdough starter flour and water daily. A healthy starter doubles. Bread baking with sourdough needs patience.'),
  doc('b', 'Baking a crusty sourdough loaf', 'Shape the dough, proof overnight, bake the sourdough bread in a dutch oven for a crisp crust.'),
  doc('c', 'Why sourdough bread is tangy', 'Lactic acid bacteria in the sourdough starter give bread its tang. Longer fermentation means more sour.'),
  doc('d', 'Transformers explained', 'Neural networks with attention. Machine learning models such as transformers learn from tokens.', ['Machine Learning']),
  doc('e', 'Training a small language model', 'Machine learning practitioners train neural networks on GPUs. The model learns weights by gradient descent.', ['AI', 'Machine Learning']),
  doc('f', 'Gradient descent intuition', 'Gradient descent is how neural networks and other machine learning models are optimised.'),
  doc('g', 'Visiting Reykjavik in winter', 'Northern lights, geothermal pools and the Icelandic coast.'),
];

test('groups related notes and leaves unrelated ones in Other', () => {
  const r = inferSubjects(corpus());
  console.log(Object.fromEntries(r));
  assert.strictEqual(r.get('a'), r.get('b'));
  assert.strictEqual(r.get('b'), r.get('c'));
  assert.strictEqual(r.get('d'), r.get('e'));
  assert.strictEqual(r.get('e'), r.get('f'));
  assert.notStrictEqual(r.get('a'), r.get('d'));
  assert.strictEqual(r.get('g'), OTHER);
  assert.match(r.get('a'), /sourdough|bread/i);
  assert.match(r.get('d'), /machine learning|neural/i);
});

test('pinned subjects are kept and attract similar notes', () => {
  const c = corpus();
  c[6] = doc('g', 'Visiting Reykjavik in winter', 'Northern lights and Iceland travel.', [], 'Iceland travel');
  c.push(doc('h', 'Best hot springs in Iceland', 'Iceland has many hot springs; plan your Iceland travel around them.'));
  const r = inferSubjects(c);
  console.log(Object.fromEntries(r));
  assert.strictEqual(r.get('g'), 'Iceland travel');
  assert.strictEqual(r.get('h'), 'Iceland travel');
});

test('handles empty and single collections', () => {
  assert.strictEqual(inferSubjects([]).size, 0);
  assert.strictEqual(inferSubjects([doc('x', 'Hello', 'world')]).get('x'), OTHER);
});
