// A compact strip above the conversation when there is real work to see or act on: a run working
// (its current step, reported progress, Stop for that run), a run waiting for approval of specific
// actions, a linked task waiting for input or for this person's review, or something that failed.
// Everything comes from /chats/:id/work (runs and tasks, never message wording); each action names
// its run, task or version, so nothing else is stopped or approved. Nothing shows when idle.
import { useContext, useEffect, useRef, useState } from 'react';
import { LiveContext, api, useApi } from '../api.js';
import { Icon } from './ui.jsx';

const TONE = { approval: 'amber', input: 'amber', review: 'amber', failed: 'red', working: 'blue' };
const ICON = { approval: 'clock', input: 'comment', review: 'check', failed: 'alert', working: null };

function Item({ item, agent, onOpenTask, onReply, onDone, compact }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState(null); // null: closed; string: writing feedback / a reply
  const act = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      setNote(null);
      onDone();
    } catch (err) {
      setError(err.status === 409 ? `${err.message}` : err.message);
      if (err.status === 409) onDone();
    } finally {
      setBusy(false);
    }
  };
  const stop = () => act(() => api(`/runs/${item.run_id}/interrupt`, { method: 'POST' }));
  const confirm = (p, allow) => act(() => api(`/runs/${item.run_id}/confirm`, { method: 'POST', body: { event_id: p.event_id, result: allow ? 'allow' : 'deny' } }));
  const review = (decision) =>
    act(() =>
      item.review.mode === 'review'
        ? api(`/tasks/${item.task_id}/review`, { method: 'POST', body: { decision, note: note ?? '', version: item.review.version } })
        : api(`/tasks/${item.task_id}/${decision === 'approve' ? 'approve' : 'send-back'}`, { method: 'POST', body: { note: note ?? '', version: item.review.version } }),
    );
  const reply = () => act(() => api(`/tasks/${item.task_id}/reply`, { method: 'POST', body: { text: note } }));

  const open = item.task_id && (
    <button type="button" className="btn btn-sm" onClick={() => onOpenTask(item.task_id)}>
      Open task
    </button>
  );
  let body = null;
  let actions = null;
  if (item.kind === 'working') {
    body = (
      <>
        {item.step && <span className="clamp-1">{item.step}</span>}
        {item.progress && (
          <span className="ss-progress">
            <span className="ss-bar" aria-hidden="true">
              <span style={{ width: `${Math.min(100, Math.round((item.progress.done / item.progress.total) * 100))}%` }} />
            </span>
            {item.progress.done} of {item.progress.total} {item.progress.label}
          </span>
        )}
      </>
    );
    actions = (
      <>
        {open}
        {item.run_id && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={stop} title={item.source === 'task' ? `Stop the run on “${item.task_title}” only` : 'Stop this run only (the agent stays on)'}>
            <Icon name="stop" size={13} /> Stop
          </button>
        )}
      </>
    );
  } else if (item.kind === 'approval') {
    const p = item.pending[0];
    body = (
      <>
        {item.pending.length > 1 && <span>{item.pending.length} actions waiting. First: </span>}
        {p && <span className="clamp-2">{p.label}</span>}
        {item.mine && p && <span className="ss-consequence">Approving runs exactly this action, nothing else.</span>}
      </>
    );
    actions = item.mine && p ? (
      <>
        {open}
        <button type="button" className="btn btn-sm btn-danger-ghost" disabled={busy} onClick={() => confirm(p, false)}>
          Reject
        </button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => confirm(p, true)}>
          Approve
        </button>
      </>
    ) : (
      <>
        <span className="muted small">An approver needs to decide.</span>
        {open}
      </>
    );
  } else if (item.kind === 'input') {
    body = item.detail && <span className="clamp-2">{item.detail}</span>;
    actions = (
      <>
        {open}
        {note === null && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setNote('')}>
            Reply
          </button>
        )}
      </>
    );
  } else if (item.kind === 'review') {
    const submit = item.review.mode === 'submit';
    body = (
      <span className="ss-consequence">
        {submit
          ? `Approving lets ${agent.name} submit, file or pay exactly what it prepared for “${item.task_title}”.`
          : `Approving marks “${item.task_title}” done. It doesn't file, post or publish anything.`}
      </span>
    );
    actions = (
      <>
        {open}
        {note === null && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setNote('')}>
            {submit ? 'Send back' : 'Request changes'}
          </button>
        )}
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => review('approve')}>
          <Icon name="check" size={13} /> {submit ? 'Approve to submit' : 'Approve'}
        </button>
      </>
    );
  } else if (item.kind === 'failed') {
    body = item.detail && <span className="clamp-2">{item.detail}</span>;
    actions = item.source === 'task' ? (
      open && (
        <button type="button" className="btn btn-sm" onClick={() => onOpenTask(item.task_id)}>
          Open task to retry
        </button>
      )
    ) : (
      <button type="button" className="btn btn-sm" onClick={onReply}>
        Reply to try again
      </button>
    );
  }

  return (
    <div className={`ss-item tone-${TONE[item.kind]} ${compact ? 'compact' : ''}`}>
      <span className="ss-icon" aria-hidden="true">
        {ICON[item.kind] ? <Icon name={ICON[item.kind]} size={16} /> : <span className="spinner" />}
      </span>
      <div className="grow ss-text">
        <div className="ss-title">
          <strong>{item.label}</strong>
          {item.source === 'task' ? <span className="clamp-1"> · {item.task_title}</span> : item.kind !== 'working' && item.title ? <span className="clamp-1"> · {item.title}</span> : null}
        </div>
        {body && <div className="ss-sub">{body}</div>}
        {note !== null && (
          <form
            className="ss-note"
            onSubmit={(e) => {
              e.preventDefault();
              if (item.kind === 'input') reply();
              else review('changes');
            }}
          >
            <textarea
              autoFocus
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              aria-label={item.kind === 'input' ? 'Your reply' : 'What needs changing'}
              placeholder={item.kind === 'input' ? `Reply to ${agent.name} on this task` : 'What needs changing? The agent gets this on the task.'}
              onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setNote(null))}
            />
            <div className="ss-note-actions">
              <button type="button" className="btn btn-sm" onClick={() => setNote(null)}>
                Cancel
              </button>
              <button className="btn btn-sm btn-primary" disabled={!note.trim() || busy}>
                {item.kind === 'input' ? 'Send reply' : item.review?.mode === 'submit' ? 'Send back' : 'Request changes'}
              </button>
            </div>
          </form>
        )}
        {error && (
          <div className="ss-error small" role="alert">
            {error}
          </div>
        )}
      </div>
      {note === null && <div className="ss-actions">{actions}</div>}
    </div>
  );
}

export default function StatusStrip({ chatId, agent, onOpenTask, onReply }) {
  const live = useContext(LiveContext);
  const { data, reload } = useApi(chatId ? `/chats/${chatId}/work` : null);
  const [all, setAll] = useState(false);
  const [announce, setAnnounce] = useState('');
  const lastKey = useRef(null);

  useEffect(() => setAll(false), [chatId]);
  useEffect(() => {
    if (!live || !chatId) return;
    let timer;
    return live.on((e) => {
      if (!['*', 'run', 'task', 'message', 'chat'].includes(e.type)) return;
      if (e.agent_id != null && e.agent_id !== agent.id && e.type !== 'task') return;
      clearTimeout(timer);
      timer = setTimeout(reload, 250);
    });
  }, [live, chatId, agent.id, reload]);

  const items = data?.items ?? [];
  const lead = items.find((i) => i.key === data?.primary) ?? items[0];
  // Tell screen readers when the lead status changes, not on every step.
  useEffect(() => {
    const key = lead ? `${lead.key}` : null;
    if (key === lastKey.current) return;
    lastKey.current = key;
    setAnnounce(lead ? `${lead.label}${lead.task_title ? `: ${lead.task_title}` : ''}` : '');
  }, [lead]);

  const live$ = (
    <div className="sr-only" role="status" aria-live="polite">
      {announce}
    </div>
  );
  if (!chatId || !lead) return live$;
  const others = items.filter((i) => i !== lead);
  return (
    <section className="status-strip" aria-label="Work in this conversation">
      {live$}
      <Item item={lead} agent={agent} onOpenTask={onOpenTask} onReply={onReply} onDone={reload} />
      {others.length > 0 && (
        <>
          <button type="button" className="link-btn ss-more" aria-expanded={all} onClick={() => setAll((a) => !a)}>
            {all ? 'Hide the others' : `${others.length} more in this conversation`}
          </button>
          {all && (
            <div className="ss-others">
              {others.map((i) => (
                <Item key={i.key} item={i} agent={agent} onOpenTask={onOpenTask} onReply={onReply} onDone={reload} compact />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
