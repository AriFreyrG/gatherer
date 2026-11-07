const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { toMarkdown, frontMatter } = require('../src/main/markdown');
const exporter = require('../src/main/export');

test('converts common note HTML to Markdown', () => {
  const md = toMarkdown(`<h2>Intro</h2><p>Some <strong>bold</strong>, <em>italic</em> and <a href="https://example.com">a link</a>.<br>Next line</p>
    <ul><li>One</li><li>Two<ul><li>Nested</li></ul></li></ul><ol start="3"><li>Three</li></ol>
    <blockquote><p>Quoted</p></blockquote><pre><code class="language-js">let a = \`x\`;</code></pre>
    <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><p>1. not a list *really*</p>`);
  assert.strictEqual(md, [
    '## Intro', '', 'Some **bold**, _italic_ and [a link](https://example.com).\\', 'Next line', '',
    '- One', '- Two', '  - Nested', '', '3. Three', '', '> Quoted', '', '```js', 'let a = `x`;', '```', '',
    '| A | B |', '| --- | --- |', '| 1 | 2 |', '', '1\\. not a list \\*really\\*', '',
  ].join('\n'));
});

test('front matter quotes values safely', () => {
  const fm = frontMatter({ title: 'He said "hi"', url: 'https://x.com', dateGathered: '2026-11-07T10:00:00Z', tags: ['a', 'b'] });
  assert.match(fm, /^---\ntitle: "He said \\"hi\\""\nsource: "https:\/\/x.com"\ngathered: "2026-11-07T10:00:00Z"\ntags: \["a", "b"\]\n---\n/);
});

test('file names are safe and unique', () => {
  assert.strictEqual(exporter.fileName('a/b: c?'), 'a b c');
  assert.strictEqual(exporter.fileName('...'), 'Untitled');
  assert.strictEqual(exporter.fileName('CON'), 'Untitled');
});

test('Markdown export copies saved images next to the note', () => {
  const assets = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherer-assets-'));
  fs.mkdirSync(path.join(assets, 'n1'));
  fs.writeFileSync(path.join(assets, 'n1', 'img-001.png'), 'PNG');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherer-out-'));
  const note = { id: 'n1', title: 'My: Note', url: 'https://example.com', dateGathered: '2026-11-07T10:00:00Z', tags: [], content: '<p><img src="gatherer-asset://n1/img-001.png" alt="pic"></p>' };
  const file = exporter.writeMarkdown(note, out, { assetsRoot: assets });
  assert.strictEqual(path.basename(file), 'My Note.md');
  assert.match(fs.readFileSync(file, 'utf8'), /!\[pic\]\(My%20Note%20files\/img-001\.png\)/);
  assert.strictEqual(fs.readFileSync(path.join(out, 'My Note files', 'img-001.png'), 'utf8'), 'PNG');
  // Same title again gets its own name.
  assert.strictEqual(path.basename(exporter.writeMarkdown(note, out, { assetsRoot: assets })), 'My Note 2.md');
  // Printable HTML inlines the image.
  assert.match(exporter.printableHtml(note, { assetsRoot: assets }), /src="data:image\/png;base64,UE5H"/);
});
