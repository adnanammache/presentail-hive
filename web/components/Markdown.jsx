// Markdown for agent messages. Safe by construction: raw HTML is dropped (never rendered), and link
// and image URLs go through react-markdown's default filter, which blocks javascript:, data: and other
// unsafe protocols. Images show as links (no third-party requests from a message). Incomplete
// Markdown while a message is still arriving just renders as text until it's complete.
import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Icon } from './ui.jsx';

function CodeBlock({ children, className }) {
  const [copied, setCopied] = useState(false);
  const text = String(children ?? '').replace(/\n$/, '');
  const lang = /language-([\w+-]+)/.exec(className ?? '')?.[1];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: nothing to do */
    }
  };
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span>{lang ?? 'code'}</span>
        <button type="button" className="md-copy" onClick={copy} aria-label="Copy code">
          <Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

const components = {
  // Chat-sized headings.
  h1: ({ children }) => <h3 className="md-h md-h1">{children}</h3>,
  h2: ({ children }) => <h4 className="md-h md-h2">{children}</h4>,
  h3: ({ children }) => <h5 className="md-h md-h3">{children}</h5>,
  h4: ({ children }) => <h6 className="md-h md-h4">{children}</h6>,
  h5: ({ children }) => <h6 className="md-h md-h4">{children}</h6>,
  h6: ({ children }) => <h6 className="md-h md-h4">{children}</h6>,
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
  img: ({ src, alt }) =>
    src ? (
      <a href={src} target="_blank" rel="noopener noreferrer nofollow">
        {alt || 'image'}
      </a>
    ) : null,
  // Wide tables and code scroll inside the message, never the page.
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
  pre: ({ children }) => {
    const code = children?.props;
    return <CodeBlock className={code?.className}>{code?.children}</CodeBlock>;
  },
  code: ({ children, className }) => <code className={className ? `${className} md-inline` : 'md-inline'}>{children}</code>,
  input: ({ checked, type }) => (type === 'checkbox' ? <input type="checkbox" checked={Boolean(checked)} readOnly disabled /> : null),
};

/** Render a message's Markdown. The stored text is never changed. */
export default memo(function Markdown({ text }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {String(text ?? '')}
      </ReactMarkdown>
    </div>
  );
});
