// Renders message text (agents' and people's) as GitHub-flavoured Markdown, at display time.
// The stored text is never changed. Safe by construction: raw HTML is shown as text, links only
// go to http(s)/mailto/tel or Hive's own pages, images are never loaded (shown as links), and
// code blocks are only ever displayed.
import { memo, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

/** Only links a person can safely follow: web, email, phone and relative (Hive) links. */
export function safeUrl(url) {
  const u = defaultUrlTransform(String(url ?? '').trim()); // '' for javascript:, data:, vbscript: …
  if (!u) return '';
  if (/^[a-z][a-z\d+.-]*:/i.test(u) && !/^(https?|mailto|tel):/i.test(u)) return '';
  return u;
}

const external = (href) => /^(https?:)?\/\//i.test(href);

function Link({ href, children }) {
  if (!href) return <span className="md-dead-link">{children}</span>;
  return external(href) ? (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ) : (
    <a href={href}>{children}</a>
  );
}

// Images in messages are never fetched (they could track readers or be anything): a link instead.
function Image({ src, alt }) {
  const label = `🖼 ${alt || 'image'}`;
  return src ? <Link href={src}>{label}</Link> : <span>{label}</span>;
}

const textOf = (node) => (node?.type === 'text' ? node.value : (node?.children ?? []).map(textOf).join(''));

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button type="button" className="md-copy" onClick={copy} aria-label="Copy code">
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** A fenced code block: its language, a copy button, and the code as plain text. */
function CodeBlock({ node }) {
  const code = node?.children?.find((c) => c.tagName === 'code');
  const lang = (code?.properties?.className ?? []).find((c) => String(c).startsWith('language-'))?.slice(9);
  const text = textOf(code ?? node).replace(/\n$/, '');
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{lang || 'code'}</span>
        <CopyButton text={text} />
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

const Table = ({ node, ...props }) => (
  <div className="md-table">
    <table {...props} />
  </div>
);

const COMPONENTS = { a: Link, img: Image, pre: CodeBlock, table: Table };

// Raw HTML (e.g. "<b>", "<script>") is shown as the literal text the sender typed.
const htmlAsText = () => (tree) => {
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.type === 'html') Object.assign(child, { type: 'text' });
      else walk(child);
    }
  };
  walk(tree);
};
// remark-breaks: a single newline is a line break, as people expect in chat.
const PLUGINS = [remarkGfm, remarkBreaks, htmlAsText];

function Markdown({ text, className = '' }) {
  return (
    <div className={className ? `md ${className}` : 'md'}>
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS} urlTransform={safeUrl}>
        {String(text ?? '')}
      </ReactMarkdown>
    </div>
  );
}

// Re-renders only when its own text changes, so a new message doesn't re-parse the whole thread.
export default memo(Markdown);

/**
 * A message as plain text, for one-line previews (inbox, dashboard): the words without the
 * Markdown marks, parsed the same way (so `a*b` and code keep their asterisks).
 */
export const MarkdownText = memo(function MarkdownText({ text }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, htmlAsText]} allowedElements={[]} unwrapDisallowed>
      {String(text ?? '')}
    </ReactMarkdown>
  );
});
