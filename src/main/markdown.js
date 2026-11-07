// Converts a note's sanitized HTML body to CommonMark/GFM Markdown. No Electron deps.
//
//   toMarkdown(html, { image }) -> string
//     image(src) may return a replacement src (e.g. a relative path to an exported copy).
//   frontMatter({ title, url, dateGathered, siteName, subject, tags }) -> YAML block
const { JSDOM } = require('jsdom');

const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DETAILS', 'DIV', 'DL', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
  'SUMMARY', 'TABLE', 'UL', 'DD', 'DT']);

// Escape characters that would otherwise turn plain text into Markdown syntax.
function escapeText(s) {
  return s.replace(/([\\`*_[\]<>|])/g, '\\$1');
}
// Characters that only matter at the start of a line.
function escapeLineStarts(s) {
  return s.replace(/^(\s*)([#+-]|\d+[.)])(?=\s|$)/gm, (m, sp, mark) => sp + mark.replace(/([#+\-.)])/, '\\$1'))
    .replace(/^(\s*)(=+|~~~|```)/gm, '$1\\$2');
}

const codeFence = (text) => {
  const longest = Math.max(2, ...(text.match(/`+/g) || []).map((r) => r.length));
  return '`'.repeat(longest + 1);
};
const inlineCode = (text) => {
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map((r) => r.length));
  const tick = '`'.repeat(longest + 1);
  const pad = /^`|`$/.test(text) || /^ .* $/.test(text) ? ' ' : '';
  return tick + pad + text + pad + tick;
};
const linkDest = (u) => (/[\s()<>]/.test(u) ? `<${u.replace(/[<>]/g, encodeURIComponent)}>` : u);
const linkTitle = (t) => (t ? ` "${t.replace(/"/g, '\\"')}"` : '');

function toMarkdown(html, { image } = {}) {
  const doc = new JSDOM(`<body>${html || ''}</body>`).window.document;
  const mapImg = (src) => (image ? image(src) || src : src);

  // Inline content -> single string (may contain "\n" from <br>, as hard breaks).
  function inline(node, ctx = {}) {
    let out = '';
    for (const n of node.childNodes) out += inlineNode(n, ctx);
    return out;
  }
  function wrap(mark, s) {
    const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : s;
  }
  function inlineNode(n, ctx) {
    if (n.nodeType === 3) {
      const t = ctx.pre ? n.data : n.data.replace(/\s+/g, ' ');
      return ctx.pre ? t : escapeText(t);
    }
    if (n.nodeType !== 1) return '';
    const tag = n.tagName;
    switch (tag) {
      case 'BR': return '\\\n';
      case 'STRONG': case 'B': return wrap('**', inline(n, ctx));
      case 'EM': case 'I': case 'CITE': case 'DFN': return wrap('_', inline(n, ctx));
      case 'S': case 'DEL': case 'STRIKE': return wrap('~~', inline(n, ctx));
      case 'CODE': case 'KBD': case 'SAMP': case 'TT': return inlineCode(n.textContent);
      case 'SUP': return `<sup>${escapeText(n.textContent)}</sup>`;
      case 'SUB': return `<sub>${escapeText(n.textContent)}</sub>`;
      case 'MARK': return wrap('==', inline(n, ctx));
      case 'A': {
        const href = n.getAttribute('href') || '';
        const text = inline(n, ctx).trim();
        if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return text;
        if (!text) return '';
        if (text === escapeText(href) && /^https?:\/\/\S+$/.test(href)) return `<${href}>`;
        return `[${text}](${linkDest(href)}${linkTitle(n.getAttribute('title'))})`;
      }
      case 'IMG': {
        const src = n.getAttribute('src');
        if (!src) return '';
        const alt = (n.getAttribute('alt') || '').replace(/\s+/g, ' ').replace(/([\\[\]])/g, '\\$1');
        return `![${alt}](${linkDest(mapImg(src))}${linkTitle(n.getAttribute('title'))})`;
      }
      case 'SCRIPT': case 'STYLE': case 'TEMPLATE': return '';
      default:
        // A block element inside inline context (e.g. <div> in <li>): keep it on its own line.
        if (BLOCK.has(tag)) return '\n' + blocks(n).trim() + '\n';
        return inline(n, ctx);
    }
  }

  const cleanInline = (s) => escapeLineStarts(s.replace(/[ \t]+/g, ' ').replace(/ ?\\\n ?/g, '\\\n').trim()).replace(/\\$/, '');

  // Block content -> array of Markdown blocks (joined with blank lines).
  function blocks(node) {
    const out = [];
    let run = []; // pending inline nodes between block elements
    const flushRun = () => {
      if (!run.length) return;
      const fake = doc.createElement('span');
      for (const n of run) fake.appendChild(n.cloneNode(true));
      const t = cleanInline(inline(fake));
      if (t) out.push(t);
      run = [];
    };
    for (const n of [...node.childNodes]) {
      if (n.nodeType === 1 && BLOCK.has(n.tagName)) { flushRun(); const b = block(n); if (b) out.push(b); }
      else if (n.nodeType === 1 || n.nodeType === 3) run.push(n);
    }
    flushRun();
    return out.join('\n\n');
  }

  const indent = (s, pad) => s.split('\n').map((l, i) => (i === 0 || !l ? l : pad + l)).join('\n');

  function list(n, ordered) {
    let i = Number(n.getAttribute('start')) || 1;
    const items = [];
    let loose = false;
    for (const li of n.children) {
      if (li.tagName !== 'LI') continue;
      const marker = ordered ? `${i++}.` : '-';
      let body = blocks(li) || '';
      // A paragraph-style item makes the whole list loose; otherwise keep nested lists tight.
      if ([...li.children].some((c) => /^(P|BLOCKQUOTE|PRE|TABLE|H[1-6])$/.test(c.tagName))) loose = true;
      else body = body.replace(/\n\n/g, '\n');
      items.push(marker + ' ' + indent(body, ' '.repeat(marker.length + 1)));
    }
    return items.join(loose ? '\n\n' : '\n');
  }

  function table(n) {
    const rows = [...n.querySelectorAll('tr')].filter((tr) => tr.closest('table') === n);
    if (!rows.length) return '';
    const cell = (c) => cleanInline(inline(c)).replace(/\\\n/g, ' ').replace(/\n+/g, ' ') || ' ';
    const grid = rows.map((tr) => [...tr.children].filter((c) => /^T[HD]$/.test(c.tagName)).map(cell));
    const width = Math.max(...grid.map((r) => r.length));
    if (!width) return '';
    const pad = (r) => [...r, ...Array(width - r.length).fill(' ')];
    const line = (r) => `| ${pad(r).join(' | ')} |`;
    return [line(grid[0]), line(Array(width).fill('---')), ...grid.slice(1).map(line)].join('\n');
  }

  function block(n) {
    const tag = n.tagName;
    switch (tag) {
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
        const t = cleanInline(inline(n)).replace(/\\\n/g, ' ').replace(/^\\(?=[#+\-]|\d)/, '');
        return t ? `${'#'.repeat(Number(tag[1]))} ${t}` : '';
      }
      case 'P': return cleanInline(inline(n));
      case 'HR': return '---';
      case 'BLOCKQUOTE': {
        const b = blocks(n);
        return b ? b.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n') : '';
      }
      case 'PRE': {
        const code = n.querySelector('code');
        const text = (code || n).textContent.replace(/\n$/, '');
        const lang = ((code && code.className) || '').match(/(?:lang(?:uage)?-)(\w[\w+#-]*)/);
        const fence = codeFence(text);
        return `${fence}${lang ? lang[1] : ''}\n${text}\n${fence}`;
      }
      case 'UL': return list(n, false);
      case 'OL': return list(n, true);
      case 'TABLE': return table(n);
      case 'FIGCAPTION': { const t = cleanInline(inline(n)); return t ? `_${t}_` : ''; }
      case 'DT': { const t = cleanInline(inline(n)); return t ? `**${t}**` : ''; }
      case 'DD': return blocks(n).split('\n').map((l) => (l ? `: ${l}` : l)).join('\n');
      default: return blocks(n);
    }
  }

  return blocks(doc.body).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

const yamlStr = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;

function frontMatter({ title, url, dateGathered, siteName, subject, tags }) {
  const lines = ['---', `title: ${yamlStr(title || 'Untitled')}`];
  if (url) lines.push(`source: ${yamlStr(url)}`);
  if (siteName) lines.push(`site: ${yamlStr(siteName)}`);
  if (dateGathered) lines.push(`gathered: ${yamlStr(dateGathered)}`);
  if (subject) lines.push(`subject: ${yamlStr(subject)}`);
  if (tags && tags.length) lines.push(`tags: [${tags.map(yamlStr).join(', ')}]`);
  lines.push('---', '');
  return lines.join('\n');
}

module.exports = { toMarkdown, frontMatter };
