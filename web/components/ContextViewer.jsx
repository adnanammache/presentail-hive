// The context area beside a conversation: the Work overview, a file, or a task, opened without
// leaving the chat. Several can be open at once as tabs; each closes on its own. On wide screens it
// sits beside the chat and can be resized (drag, or the arrow keys on the handle); on narrow screens
// the parent shows it as a drawer.
//
// Files are previewed only where the browser can show them safely (PDF, images, text, Markdown, CSV,
// JSON), from /api/files/raw which checks access and never serves HTML or script. Anything else shows
// what it is, with Download. A passage selected in a text preview, or the whole file, can be
// referred to in the next message ("Discuss"); nothing is sent until the person sends it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ago, fmtDateTime, useApi } from '../api.js';
import { Icon, statusLabel } from './ui.jsx';
import Markdown from './Markdown.jsx';
import TaskPanel from './TaskPanel.jsx';
import WorkOverview from './WorkOverview.jsx';
import { fileSize } from './Chat.jsx';
import { parseCsv } from './chatUtil.js';

export const MIN_WIDTH = 340;

const REASONS = {
  unsupported: (m) => `There's no preview for ${m.type} files here. Download it to open it in the app you use for them.`,
  too_large: () => 'This file is too large to preview here (the limit is 2 MB). Download it to read it.',
  missing: () => "The stored copy of this file is missing, so it can't be shown or downloaded.",
};

function TextPreview({ url, kind, onSelection }) {
  const [state, setState] = useState({ text: null, error: '' });
  const box = useRef(null);
  const load = useCallback(() => {
    setState({ text: null, error: '' });
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? "This file isn't available any more, or you no longer have access to it." : `Couldn't load the preview (${res.status}).`);
        return res.text();
      })
      .then((text) => setState({ text, error: '' }), (err) => setState({ text: null, error: err.message }));
  }, [url]);
  useEffect(load, [load]);

  // Selected text inside this preview (and only this preview) can be discussed.
  useEffect(() => {
    const on = () => {
      const sel = document.getSelection();
      const inside = sel && sel.rangeCount && box.current?.contains(sel.anchorNode) && box.current?.contains(sel.focusNode);
      onSelection(inside ? sel.toString().trim() : '');
    };
    document.addEventListener('selectionchange', on);
    return () => (document.removeEventListener('selectionchange', on), onSelection(''));
  }, [onSelection]);

  if (state.error)
    return (
      <div className="fv-fallback" role="alert">
        <p>{state.error}</p>
        <button type="button" className="btn btn-sm" onClick={load}>
          Try again
        </button>
      </div>
    );
  if (state.text == null) return <p className="muted small fv-loading">Loading preview…</p>;
  let content;
  if (kind === 'markdown') content = <Markdown text={state.text} className="fv-md" />;
  else if (kind === 'csv') {
    const { rows, truncated } = parseCsv(state.text);
    content = (
      <>
        <div className="fv-table-wrap">
          <table className="fv-table">
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {r.map((cell, j) => (i === 0 ? <th key={j}>{cell}</th> : <td key={j}>{cell}</td>))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {truncated && <p className="muted small">Showing the first {rows.length} rows. Download the file for the rest.</p>}
      </>
    );
  } else if (kind === 'json') {
    let pretty = state.text;
    try {
      pretty = JSON.stringify(JSON.parse(state.text), null, 2);
    } catch {
      /* show as it is */
    }
    content = <pre className="fv-pre">{pretty}</pre>;
  } else content = <pre className="fv-pre">{state.text}</pre>;
  return (
    <div className="fv-text" ref={box}>
      {content}
    </div>
  );
}

export function FileView({ fileRef, onDiscuss, onOpenTask }) {
  const { data: meta, error, reload } = useApi(`/files/meta?ref=${encodeURIComponent(fileRef)}`);
  const [selection, setSelection] = useState('');
  const onSelection = useCallback((t) => setSelection(t), []);
  if (error)
    return (
      <div className="fv-fallback" role="alert">
        <Icon name="alert" size={20} />
        <p>{/not found/i.test(error) ? "This file isn't available. It may have been removed, or you no longer have access to it." : `Couldn't load this file: ${error}`}</p>
        {!/not found/i.test(error) && (
          <button type="button" className="btn btn-sm" onClick={reload}>
            Try again
          </button>
        )}
      </div>
    );
  if (!meta) return <p className="muted small fv-loading">Loading…</p>;
  const discuss = (quote) => onDiscuss({ ref: meta.ref, filename: meta.filename, ...(quote ? { quote: quote.slice(0, 4000) } : {}) });
  return (
    <div className="fv">
      <header className="fv-head">
        <div className="grow">
          <h3 className="fv-name" title={meta.filename}>
            {meta.filename}
          </h3>
          <div className="fv-meta muted small">
            {meta.type} · {fileSize(meta.size)} · added <time title={fmtDateTime(meta.added_at)}>{ago(meta.added_at)}</time>
            {meta.source === 'output' && ' · made by the agent'}
          </div>
          {meta.task && (
            <div className="fv-task small">
              From task{' '}
              <button type="button" className="link-btn" onClick={() => onOpenTask(meta.task.id)}>
                {meta.task.title}
              </button>{' '}
              <span className={`chip-soft ${['review', 'waiting_approval'].includes(meta.task.status) ? 'amber' : ''}`}>{statusLabel(meta.task.status)}</span>
            </div>
          )}
        </div>
      </header>
      <div className="fv-actions">
        {onDiscuss && (
          <button type="button" className="btn btn-sm" onClick={() => discuss('')} title="Refer to this file in your next message">
            <Icon name="comment" size={14} /> Discuss this file
          </button>
        )}
        {meta.unavailable_reason !== 'missing' && (
          <a className="btn btn-sm" href={meta.download_url} download={meta.filename}>
            <Icon name="download" size={14} /> Download
          </a>
        )}
        {meta.raw_url && (
          <a className="btn btn-sm" href={meta.raw_url} target="_blank" rel="noopener noreferrer" title="Open the preview in a new tab">
            <Icon name="external" size={14} /> Open in new tab
          </a>
        )}
      </div>
      <div className="fv-body">
        {!meta.preview && (
          <div className="fv-fallback">
            <Icon name="file" size={22} />
            <p>{(REASONS[meta.unavailable_reason] ?? REASONS.unsupported)(meta)}</p>
          </div>
        )}
        {meta.preview === 'pdf' && <iframe className="fv-frame" src={meta.raw_url} title={`Preview of ${meta.filename}`} />}
        {meta.preview === 'image' && <img className="fv-img" src={meta.raw_url} alt={meta.filename} />}
        {['text', 'markdown', 'csv', 'json'].includes(meta.preview) && <TextPreview url={meta.raw_url} kind={meta.preview} onSelection={onSelection} />}
      </div>
      {selection && onDiscuss && (
        <div className="fv-selection" role="region" aria-label="Selected text">
          <span className="clamp-1 small">“{selection.slice(0, 120)}{selection.length > 120 ? '…' : ''}”</span>
          <button type="button" className="btn btn-sm btn-primary" onMouseDown={(e) => e.preventDefault()} onClick={() => discuss(selection)}>
            <Icon name="comment" size={14} /> Ask about selection
          </button>
        </div>
      )}
    </div>
  );
}

const TAB_ICON = { overview: 'panel', file: 'file', task: 'check' };

/**
 * items: [{ key, kind: 'overview' | 'file' | 'task', title, fileRef?, taskId? }], active: key.
 * mode: 'inline' (beside the chat, resizable) | 'drawer'.
 */
export default function ContextViewer({ items, active, onActivate, onCloseItem, onCloseAll, mode, width, maxWidth, onResize, overview, me, onOpenFile, onOpenTask, onDiscuss }) {
  const current = items.find((i) => i.key === active) ?? items[0];
  const handle = useRef(null);
  const drag = (e) => {
    if (mode !== 'inline') return;
    e.preventDefault();
    const startX = e.clientX;
    const start = width;
    const move = (ev) => onResize(Math.min(maxWidth, Math.max(MIN_WIDTH, start + (startX - ev.clientX))));
    const up = () => (window.removeEventListener('pointermove', move), window.removeEventListener('pointerup', up), document.body.classList.remove('resizing'));
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const key = (e) => {
    const step = e.shiftKey ? 80 : 24;
    const set = (w) => (e.preventDefault(), onResize(Math.min(maxWidth, Math.max(MIN_WIDTH, w))));
    if (e.key === 'ArrowLeft') set(width + step);
    else if (e.key === 'ArrowRight') set(width - step);
    else if (e.key === 'Home') set(maxWidth);
    else if (e.key === 'End') set(MIN_WIDTH);
  };
  if (!current) return null;
  return (
    <div className={`ctx ctx-${mode}`}>
      {mode === 'inline' && (
        <div
          ref={handle}
          className="ctx-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the side panel"
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={maxWidth}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={drag}
          onKeyDown={key}
        />
      )}
      <div className="ctx-tabs">
        <div className="ctx-tablist" role="tablist" aria-label="Open beside the conversation">
          {items.map((i) => (
            <div key={i.key} className={`ctx-tab ${i.key === current.key ? 'on' : ''}`}>
              <button type="button" role="tab" id={`ctx-tab-${i.key}`} aria-selected={i.key === current.key} aria-controls="ctx-panel" onClick={() => onActivate(i.key)} title={i.title}>
                <Icon name={TAB_ICON[i.kind]} size={15} />
                <span className="clamp-1">{i.title}</span>
              </button>
              {items.length > 1 && (
                <button type="button" className="icon-btn sm" aria-label={`Close ${i.title}`} onClick={() => onCloseItem(i.key)}>
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
        <button type="button" className="icon-btn" aria-label="Close the side panel" title="Close" onClick={onCloseAll}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="ctx-body" id="ctx-panel" role="tabpanel" aria-labelledby={`ctx-tab-${current.key}`}>
        {current.kind === 'overview' && overview}
        {current.kind === 'file' && <FileView key={current.fileRef} fileRef={current.fileRef} onDiscuss={onDiscuss} onOpenTask={onOpenTask} />}
        {current.kind === 'task' && <TaskPanel key={current.taskId} taskId={current.taskId} me={me} embedded onClose={() => onCloseItem(current.key)} onOpenFile={onOpenFile} />}
      </div>
    </div>
  );
}
