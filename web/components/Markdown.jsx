// Message text as Markdown. The renderer (and its parser libraries) is a separate download so it
// doesn't hold up the first paint; it starts loading in the background as soon as the app does,
// and until it's there a message shows as plain text.
import { Suspense, lazy, memo } from 'react';

const load = () => import('./MarkdownRender.jsx');
const Render = lazy(load);
const RenderText = lazy(() => load().then((m) => ({ default: m.MarkdownText })));
if (typeof window !== 'undefined') (window.requestIdleCallback ?? setTimeout)(() => load().catch(() => {}));

function Markdown({ text, className = '' }) {
  const plain = (
    <div className={className ? `md ${className}` : 'md'}>
      <p className="pre">{text}</p>
    </div>
  );
  return (
    <Suspense fallback={plain}>
      <Render text={text} className={className} />
    </Suspense>
  );
}
export default memo(Markdown);

/** A message as plain text for one-line previews (inbox, dashboard). */
export const MarkdownText = memo(function MarkdownText({ text }) {
  return (
    <Suspense fallback={text}>
      <RenderText text={text} />
    </Suspense>
  );
});
