// How chat messages render: Markdown formatting, literal text, and what's never let through.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite;
let Markdown;
let safeUrl;
before(async () => {
  vite = await createServer({ configFile: new URL('../vite.config.js', import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, logLevel: 'silent' });
  ({ default: Markdown, safeUrl } = await vite.ssrLoadModule('/components/MarkdownRender.jsx'));
});
after(() => vite?.close());

const html = (text) => renderToStaticMarkup(createElement(Markdown, { text }));

test('bold, italic, strikethrough, headings and rules', () => {
  const out = html('**Access is working.** and *italic* and ~~gone~~\n\n## Summary\n\n---');
  assert.match(out, /<strong>Access is working\.<\/strong>/);
  assert.match(out, /<em>italic<\/em>/);
  assert.match(out, /<del>gone<\/del>/);
  assert.match(out, /<h2>Summary<\/h2>/);
  assert.match(out, /<hr\/>/);
  assert.doesNotMatch(out, /\*\*/);
});

test('nested lists, numbered lists and read-only task lists', () => {
  const out = html('1. First\n   - nested a\n   - nested b\n2. Second\n\n- [x] Filed VAT\n- [ ] Pay it');
  assert.match(out, /<ol>[\s\S]*<li>First[\s\S]*<ul>[\s\S]*nested a[\s\S]*<\/ul>[\s\S]*Second[\s\S]*<\/ol>/);
  const boxes = out.match(/<input[^>]*>/g);
  assert.equal(boxes.length, 2);
  assert.ok(boxes.every((b) => /disabled/.test(b)));
  assert.match(boxes[0], /checked/);
});

test('tables are wrapped so they scroll inside the bubble', () => {
  const out = html('| Entity | VAT |\n| --- | ---: |\n| UAE | 5% |\n| SAL | 11% |');
  assert.match(out, /<div class="md-table"><table>[\s\S]*<th>Entity<\/th>[\s\S]*<td[^>]*>11%<\/td>/);
});

test('fenced code keeps its language, gets a copy button, and is never formatted', () => {
  const out = html('```python\nprint("**not bold**")\n# not a heading\n```');
  assert.match(out, /<div class="md-code-head"><span>python<\/span><button[^>]*>Copy<\/button>/);
  assert.match(out, /<pre><code>print\(&quot;\*\*not bold\*\*&quot;\)\n# not a heading<\/code><\/pre>/);
  assert.doesNotMatch(out, /<strong>|<h1>/);
  assert.match(html('```\nplain\n```'), /<span>code<\/span>/);
});

test('literal syntax stays literal: escapes, code spans, lone asterisks', () => {
  assert.match(html('\\*\\*not bold\\*\\*'), /<p>\*\*not bold\*\*<\/p>/);
  assert.match(html('Use `**x**` here'), /<code>\*\*x\*\*<\/code>/);
  assert.match(html('5 * 3 = 15 and a*b'), /<p>5 \* 3 = 15 and a\*b<\/p>/);
});

test('plain text stays readable: single newlines are line breaks', () => {
  assert.match(html('Line one\nLine two'), /<p>Line one<br\/>\nLine two<\/p>/);
});

test('incomplete Markdown mid-stream renders without throwing', () => {
  for (const partial of ['**bold with no end', '```js\nconst a = 1', '| a | b |\n| --', '- [ ', '[link](http://exa', '> quote\n>', '~~', '#']) {
    assert.doesNotThrow(() => html(partial), partial);
  }
  assert.match(html('```js\nconst a = 1'), /<pre><code>const a = 1<\/code><\/pre>/);
});

test('raw HTML is shown as text, never rendered', () => {
  const out = html('<script>alert(1)</script> <b>hi</b> <img src=x onerror=alert(1)>');
  assert.doesNotMatch(out, /<script|<b>|<img/);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('unsafe links are dropped; external links open safely in a new tab', () => {
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:msgbox(1)', 'file:///etc/passwd', ' javascript:alert(1)']) {
    assert.equal(safeUrl(bad), '', bad);
    const out = html(`[click](${bad.trim()})`);
    assert.doesNotMatch(out, /<a /, bad);
    assert.match(out, /click/);
  }
  assert.doesNotMatch(html('<javascript:alert(1)>'), /href="javascript/i);
  const ext = html('[Wafeq](https://app.wafeq.com/x) and https://example.com/a/very/long/path');
  assert.match(ext, /<a href="https:\/\/app\.wafeq\.com\/x" target="_blank" rel="noopener noreferrer nofollow">Wafeq<\/a>/);
  assert.match(ext, /<a href="https:\/\/example\.com\/a\/very\/long\/path" target="_blank"/);
  assert.match(html('[task](#/tasks/5)'), /<a href="#\/tasks\/5">task<\/a>/);
  assert.match(html('[mail](mailto:ops@presentail.com)'), /href="mailto:ops@presentail\.com"/);
});

test('images are never loaded: shown as a link to the address', () => {
  const out = html('![receipt](https://tracker.example/pixel.png) ![x](javascript:alert(1))');
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /<a href="https:\/\/tracker\.example\/pixel\.png"[^>]*>🖼 receipt<\/a>/);
  assert.match(out, /<span>🖼 x<\/span>/);
});

test('blockquotes and inline code', () => {
  const out = html('> Due in **2 days**\n\nRun `odoo.read`');
  assert.match(out, /<blockquote>\n<p>Due in <strong>2 days<\/strong><\/p>\n<\/blockquote>/);
  assert.match(out, /<code>odoo\.read<\/code>/);
});

test('previews show the words without the Markdown marks', async () => {
  const { MarkdownText } = await vite.ssrLoadModule('/components/MarkdownRender.jsx');
  const plain = (text) => renderToStaticMarkup(createElement(MarkdownText, { text })).replace(/\s+/g, ' ').trim(); // as shown on one line
  assert.equal(plain('**Access is working.** See [Wafeq](https://wafeq.com)'), 'Access is working. See Wafeq');
  assert.equal(plain('## Summary\n\n- one\n- two'), 'Summary one two');
  assert.equal(plain('Use `a*b` and 5 * 3'), 'Use a*b and 5 * 3');
  assert.doesNotMatch(plain('<img src=x onerror=alert(1)> ![p](https://t.example/p.png)'), /<img/);
});
