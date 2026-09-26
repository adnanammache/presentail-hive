// Task details, in a side panel. Every field edits in place; actions appear only when they apply
// and you're allowed to take them. Starting an agent is always its own explicit button.
import { useEffect, useRef, useState } from 'react';
import { ago, api, fmtDateTime, fmtDay, useApi } from '../api.js';
import { DateInput, Icon } from './ui.jsx';
import TaskRun, { uploadFiles } from './TaskRun.jsx';
import { HandoffBar, TeachBar } from './forms.jsx';
import { AssigneeChip, AssigneePicker, BLOCKERS, DueLabel, PRIORITY_LABELS, STAGES, stageLabel } from './work.jsx';
import { ScheduleFields, SeriesBar, formFromTask, scheduleBody } from './schedule.jsx';

const ACTIVE_RUN = ['starting', 'running', 'needs_approval'];

function Section({ title, children, right }) {
  return (
    <section className="panel-section">
      <header>
        <h3>{title}</h3>
        {right}
      </header>
      {children}
    </section>
  );
}

/** A text field that saves when you leave it. */
function InlineText({ value, onSave, multiline, placeholder, label, className }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  const commit = () => v !== (value ?? '') && onSave(v);
  const Tag = multiline ? 'textarea' : 'input';
  return (
    <Tag
      className={className}
      value={v}
      aria-label={label}
      placeholder={placeholder}
      rows={multiline ? 4 : undefined}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => !multiline && e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
}

function Files({ task }) {
  const { data: files, reload } = useApi(`/tasks/${task.id}/files`, ['task']);
  const { data: links, reload: reloadLinks } = useApi(`/tasks/${task.id}/links`, ['task']);
  const { data: runs } = useApi(task.agent_id ? `/tasks/${task.id}/runs` : null, ['run']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [url, setUrl] = useState('');
  const outputs = (runs ?? []).flatMap((r) => (r.outputs ?? []).map((o) => ({ ...o, run_id: r.id })));
  const add = async (list) => {
    setBusy(true);
    setErr('');
    try {
      await uploadFiles(task.id, [...list]);
      reload();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const addLink = async (kind) => {
    setErr('');
    try {
      await api(`/tasks/${task.id}/links`, { method: 'POST', body: { url, kind } });
      setUrl('');
      reloadLinks();
    } catch (e) {
      setErr(e.message);
    }
  };
  const refs = (links ?? []).filter((l) => l.kind === 'reference');
  const delivered = (links ?? []).filter((l) => l.kind === 'deliverable');
  return (
    <>
      {(outputs.length > 0 || delivered.length > 0) && (
        <div className="deliverables">
          <div className="small strong">Deliverables</div>
          <div className="run-files">
            {outputs.map((o) => (
              <a key={`${o.run_id}-${o.id}`} className="file-chip out" href={`/api/runs/${o.run_id}/outputs/${o.id}`} download={o.filename}>
                <Icon name="file" size={13} /> {o.filename}
              </a>
            ))}
            {delivered.map((l) => (
              <a key={l.id} className="file-chip out" href={l.url} target="_blank" rel="noreferrer">
                <Icon name="link" size={13} /> {l.label || l.url.replace(/^https?:\/\//, '')}
              </a>
            ))}
          </div>
        </div>
      )}
      <div className="run-files">
        {files?.map((f) => (
          <span key={f.id} className="file-chip">
            <Icon name="paperclip" size={13} /> {f.filename} <span className="muted">{Math.max(1, Math.round(f.size / 1024))} KB</span>
            <button type="button" aria-label={`Remove ${f.filename}`} onClick={() => api(`/tasks/${task.id}/files/${f.id}`, { method: 'DELETE' }).then(reload, (e) => setErr(e.message))}>
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        {refs.map((l) => (
          <span key={l.id} className="file-chip">
            <Icon name="link" size={13} />
            <a href={l.url} target="_blank" rel="noreferrer" className="clamp-1">
              {l.label || l.url.replace(/^https?:\/\//, '')}
            </a>
            <button type="button" aria-label={`Remove link ${l.url}`} onClick={() => api(`/tasks/${task.id}/links/${l.id}`, { method: 'DELETE' }).then(reloadLinks)}>
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        <label className="btn btn-sm">
          <Icon name="paperclip" size={14} /> {busy ? 'Uploading…' : 'Attach files'}
          <input type="file" multiple hidden onChange={(e) => (add(e.target.files), (e.target.value = ''))} />
        </label>
      </div>
      <div className="field-pair link-row">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… (a reference or a deliverable)" aria-label="Link" />
        <button type="button" className="btn btn-sm" disabled={!url.trim()} onClick={() => addLink('reference')}>
          Add link
        </button>
        <button type="button" className="btn btn-sm" disabled={!url.trim()} onClick={() => addLink('deliverable')}>
          Add as deliverable
        </button>
      </div>
      {err && <div className="text-red small">{err}</div>}
    </>
  );
}

function Comments({ task }) {
  const { data: comments, reload } = useApi(`/tasks/${task.id}/comments`, ['task']);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const send = async () => {
    setErr('');
    try {
      await api(`/tasks/${task.id}/comments`, { method: 'POST', body: { body: text } });
      setText('');
      reload();
    } catch (e) {
      setErr(e.message);
    }
  };
  return (
    <>
      <ul className="comments">
        {comments?.map((c) => (
          <li key={c.id}>
            <div className="comment-head">
              <strong>{c.author_name}</strong>
              <span className="muted small">{ago(c.created_at)}</span>
            </div>
            <div className="comment-body">{c.body}</div>
          </li>
        ))}
        {comments?.length === 0 && <li className="muted small">No comments yet.</li>}
      </ul>
      <div className="comment-new">
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a comment" aria-label="Write a comment" />
        <button type="button" className="btn btn-sm" disabled={!text.trim()} onClick={send}>
          Comment
        </button>
      </div>
      {err && <div className="text-red small">{err}</div>}
    </>
  );
}

function Activity({ task }) {
  const { data: events } = useApi(`/tasks/${task.id}/events`, ['task', 'run']);
  if (!events?.length) return <p className="muted small">No activity yet.</p>;
  return (
    <ol className="activity-list">
      {events.map((e) => (
        <li key={e.id}>
          <span className="activity-text">
            <strong>{e.actor}</strong> · {e.text}
          </span>
          <time className="muted small" dateTime={e.created_at} title={fmtDateTime(e.created_at, 'Asia/Dubai')}>
            {ago(e.created_at)}
          </time>
        </li>
      ))}
    </ol>
  );
}

/** Mark blocked (why, and who needs to act) or clear it. */
function BlockerEditor({ task, save }) {
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState('info');
  const [reason, setReason] = useState('');
  const [owner, setOwner] = useState('');
  if (task.blocker)
    return (
      <div className={`blocker-box kind-${task.blocker.kind}`} role="status">
        <div className="blocker-title">
          <Icon name={BLOCKERS[task.blocker.kind].icon} size={15} /> {BLOCKERS[task.blocker.kind].label}
        </div>
        {task.blocker.reason && <div className="small">{task.blocker.reason}</div>}
        <div className="small muted">
          {[task.blocker.owner && `Needs: ${task.blocker.owner}`, task.blocker.at && `since ${ago(task.blocker.at)}`].filter(Boolean).join(' · ')}
        </div>
        {task.blocker.kind !== 'approval' && (
          <button type="button" className="btn btn-sm" onClick={() => save({ blocked: null })}>
            Clear blocker
          </button>
        )}
      </div>
    );
  if (!editing)
    return (
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(true)}>
        <Icon name="alert" size={14} /> Mark as blocked
      </button>
    );
  return (
    <div className="blocker-form">
      <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Blocked because">
        <option value="info">Waiting for information</option>
        <option value="approval">Waiting for approval</option>
        <option value="failed">Execution failed</option>
      </select>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What's missing?" aria-label="Reason" />
      <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Who needs to act? (optional)" aria-label="Who needs to resolve it" />
      <div className="field-pair">
        <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>
          Cancel
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => (save({ blocked: { kind, reason, owner } }), setEditing(false))}>
          Mark blocked
        </button>
      </div>
    </div>
  );
}

export default function TaskPanel({ taskId, onClose, me }) {
  const { data: task, reload, error: loadError } = useApi(taskId ? `/tasks/${taskId}` : null, ['task', 'run']);
  const { data: agents } = useApi('/agents', ['agent']);
  const { data: projects } = useApi('/projects', ['project']);
  const { data: entities } = useApi('/entities', ['entity']);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [sched, setSched] = useState(null);
  const [busy, setBusy] = useState(false);
  const panel = useRef(null);
  useEffect(() => {
    setError('');
    setNote('');
    setSched(null);
    panel.current?.focus();
  }, [taskId]);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.task-composer:focus-within') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!taskId) return null;
  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      const r = await fn();
      reload();
      return r;
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const save = (patch, scope) => run(() => api(`/tasks/${taskId}`, { method: 'PATCH', body: { ...patch, ...(scope ? { scope } : {}) } }));

  if (!task)
    return (
      <aside className="task-panel" aria-label="Task details" ref={panel} tabIndex={-1}>
        <header className="panel-head">
          <span className="spacer" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <div className="panel-body">{loadError ? <div className="form-error">{loadError}</div> : <p className="muted">Loading…</p>}</div>
      </aside>
    );

  const agent = agents?.find((a) => a.id === task.agent_id);
  const managed = agent?.platform === 'managed';
  const activeRun = ACTIVE_RUN.includes(task.run_status);
  const done = task.status === 'done';
  const failed = task.blocker?.kind === 'failed';
  const startKey = `start-${task.id}-${task.start_key ?? 'none'}-${task.blocked_at ?? ''}`;
  const start = () => run(() => api(`/tasks/${task.id}/start`, { method: 'POST', body: { key: startKey } }).then((r) => !r.start.ok && Promise.reject(new Error(r.start.error))));
  const project = projects?.find((p) => p.id === task.project_id);
  const reviewerRef = task.reviewer_email ? `user:${task.reviewer_email}` : task.handoff_agent_id ? `agent:${task.handoff_agent_id}` : null;
  const schedValues = sched ?? { ...formFromTask(task), needs_approval: Boolean(task.needs_approval) };

  return (
    <aside className="task-panel" aria-labelledby="panel-title" ref={panel} tabIndex={-1}>
      <header className="panel-head">
        <nav className="crumbs small" aria-label="Breadcrumb">
          {task.project_id ? <a href={`#/projects/${task.project_id}`}>{task.project_name}</a> : <span>No project</span>}
          <span aria-hidden="true">/</span>
          <span>#{task.id}</span>
        </nav>
        <span className="spacer" />
        <button type="button" className="icon-btn" aria-label="Close task details" onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      <div className="panel-body">
        <InlineText className="panel-title" label="Title" value={task.title} onSave={(title) => save({ title })} />
        <div id="panel-title" className="sr-only">
          {task.title}
        </div>
        <div className="panel-status">
          <span className={`stage-pill stage-${task.stage}`}>{stageLabel(task.stage)}</span>
          {task.status === 'scheduled' && <span className="chip-soft">Starts {fmtDay(task.start_on)}</span>}
          {task.status === 'waiting_approval' && <span className="chip-soft amber">Waiting for approval to submit</span>}
          {activeRun && <span className="chip-soft blue">Agent {task.run_status === 'needs_approval' ? 'needs approval' : 'working'}</span>}
          <DueLabel date={task.due_date} done={done} />
        </div>

        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        {task.can_edit === false && <p className="view-only small">You can view this task. Only members of “{task.project_name}” and the people on it can change it.</p>}

        {/* The outcome of finished work, first. */}
        {done && (task.result || task.deliverable_count > 0) && (
          <div className="outcome">
            <div className="small strong">
              <Icon name="check" size={14} /> Outcome
            </div>
            {task.result && <p className="outcome-text">{task.result}</p>}
          </div>
        )}

        {/* What you can do now. */}
        <fieldset className="panel-edit" disabled={task.can_edit === false}>
        <div className="panel-actions">
          {task.agent_id && !done && !activeRun && (
            <button type="button" className="btn btn-primary" disabled={busy || agent?.status === 'paused'} onClick={start} title={agent?.status === 'paused' ? `${agent.name} is paused` : undefined}>
              <Icon name="play" size={14} /> {failed ? `Retry ${task.agent_name}` : task.run_id || task.start_key ? `Start ${task.agent_name} again` : `Start ${task.agent_name}`}
            </button>
          )}
          {task.assignee?.type === 'user' && ['ready', 'in_progress', 'backlog'].includes(task.stage) && (
            <button type="button" className="btn" disabled={busy} onClick={() => save({ status: 'review' })}>
              Submit for review
            </button>
          )}
          {!done && (
            <button type="button" className="btn" disabled={busy} onClick={() => save({ status: 'done' })}>
              <Icon name="check" size={14} /> Mark complete
            </button>
          )}
        </div>

        {task.needs_me && task.status === 'review' && (
          <div className="approval">
            <div className="small strong">This is waiting for your review.</div>
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What needs changing? (needed to request changes)" aria-label="Review note" />
            <div className="approval-actions">
              <button type="button" className="btn btn-sm btn-danger-ghost" disabled={!note.trim() || busy} onClick={() => run(() => api(`/tasks/${task.id}/review`, { method: 'POST', body: { decision: 'changes', note } })).then(() => setNote(''))}>
                Request changes
              </button>
              <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api(`/tasks/${task.id}/review`, { method: 'POST', body: { decision: 'approve', note } }))}>
                <Icon name="check" size={13} /> Approve
              </button>
            </div>
          </div>
        )}
        {task.status === 'waiting_approval' && (
          <div className="approval">
            <div className="small strong">{task.agent_name ?? 'The agent'} prepared this and is waiting for approval before submitting or paying anything.</div>
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the agent (needed to send back)" aria-label="Approval note" />
            <div className="approval-actions">
              <button type="button" className="btn btn-sm btn-danger-ghost" disabled={!note.trim() || busy} onClick={() => run(() => api(`/tasks/${task.id}/send-back`, { method: 'POST', body: { note } })).then(() => setNote(''))}>
                Send back
              </button>
              <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api(`/tasks/${task.id}/approve`, { method: 'POST', body: { note } }))}>
                <Icon name="check" size={13} /> Approve
              </button>
            </div>
          </div>
        )}
        {task.approved_at && <p className="muted small">✓ Approved by {task.approved_by} on {fmtDateTime(task.approved_at, 'Asia/Dubai')}.</p>}

        <Section title="Blocker">
          <BlockerEditor task={task} save={save} />
          {task.blocker?.kind === 'info' && (
            <div className="reply-box">
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={`Provide the information${task.agent_id ? ` for ${task.agent_name}` : ''}`} aria-label="Provide information" />
              <button type="button" className="btn btn-sm btn-primary" disabled={!note.trim() || busy} onClick={() => run(() => api(`/tasks/${task.id}/reply`, { method: 'POST', body: { text: note } })).then(() => setNote(''))}>
                Send
              </button>
            </div>
          )}
        </Section>

        <dl className="panel-fields">
          <dt>Assignee</dt>
          <dd>
            <AssigneePicker
              value={task.assignee?.ref ?? null}
              onChange={(ref) => save({ assignee: ref })}
              disabledReason={activeRun ? `${task.agent_name} is working on this. Stop the run first, then reassign.` : undefined}
            />
          </dd>
          <dt>Status</dt>
          <dd>
            <select value={task.stage} onChange={(e) => save({ status: e.target.value })} aria-label="Status">
              {STAGES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </dd>
          <dt>Project</dt>
          <dd>
            <select value={task.project_id ?? ''} onChange={(e) => save({ project_id: e.target.value ? Number(e.target.value) : null })} aria-label="Project">
              <option value="">No project</option>
              {projects
                ?.filter((p) => p.can_contribute || p.id === task.project_id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              {task.project_id && !project && <option value={task.project_id}>{task.project_name} (archived)</option>}
            </select>
          </dd>
          <dt>Priority</dt>
          <dd>
            <select value={task.priority} onChange={(e) => save({ priority: e.target.value })} aria-label="Priority">
              {Object.entries(PRIORITY_LABELS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </dd>
          <dt>Due date</dt>
          <dd>
            <DateInput value={task.due_date} onChange={(d) => save({ due_date: d })} label="Due date" placeholder="No due date" clearable />
          </dd>
          <dt>Reviewer</dt>
          <dd>
            <AssigneePicker label="Reviewer" value={reviewerRef} onChange={(ref) => save(ref?.startsWith('agent:') ? { handoff_agent_id: Number(ref.slice(6)), reviewer_email: null } : { reviewer_email: ref ? ref.slice(5) : null, handoff_agent_id: null })} />
          </dd>
          <dt>Entity</dt>
          <dd>
            <select value={task.entity_id ?? ''} onChange={(e) => save({ entity_id: e.target.value ? Number(e.target.value) : null })} aria-label="Entity">
              <option value="">All / not entity-specific</option>
              {entities?.map((en) => (
                <option key={en.id} value={en.id}>
                  {en.name}
                </option>
              ))}
            </select>
          </dd>
        </dl>

        <Section title="Description">
          <InlineText multiline label="Description" value={task.description} onSave={(description) => save({ description })} placeholder="Add details, context or steps…" />
        </Section>
        <Section title="Expected result">
          <InlineText label="Expected result" value={task.done_definition} onSave={(done_definition) => save({ done_definition })} placeholder="e.g. Return drafted in Wafeq, summary sent to me." />
        </Section>
        {task.progress && (
          <p className="small">
            Progress: <strong>{task.progress.done}</strong> of {task.progress.total} {task.progress.label}
          </p>
        )}
        {task.result && !done && (
          <Section title="Latest update">
            <p className="update-text">{task.result}</p>
          </Section>
        )}

        <Section title="Attachments and deliverables">
          <Files task={task} />
        </Section>

        {task.agent_id && managed && (
          <Section title="Execution">
            <TaskRun task={task} agentName={task.agent_name} hideFiles />
          </Section>
        )}
        {task.agent_id && !managed && task.run_status == null && task.start_key && <p className="small muted">Sent to {task.agent_name}. It reports back through the Agent API.</p>}

        <details className="panel-section" open={Boolean(sched) || task.status === 'scheduled' || Boolean(task.series_id)}>
          <summary>
            <h3>Schedule, repeat and approval</h3>
          </summary>
          {task.series_id && <SeriesBar task={task} />}
          <ScheduleFields values={schedValues} put={(p) => setSched((v) => ({ ...(v ?? schedValues), ...(typeof p === 'function' ? p(v ?? schedValues) : p) }))} canStart={Boolean(task.agent_id)} locked={activeRun} />
          {sched && (
            <div className="field-pair">
              <button type="button" className="btn btn-sm" onClick={() => setSched(null)}>
                Cancel
              </button>
              {task.series_id && task.repeat && (
                <button type="button" className="btn btn-sm" onClick={() => save({ ...scheduleBody(sched), needs_approval: sched.needs_approval }, 'this').then(() => setSched(null))}>
                  Save for this one
                </button>
              )}
              <button type="button" className="btn btn-sm btn-primary" onClick={() => save({ ...scheduleBody(sched), needs_approval: sched.needs_approval }, task.series_id ? 'future' : undefined).then(() => setSched(null))}>
                {task.series_id && task.repeat ? 'Save for this and future ones' : 'Save'}
              </button>
            </div>
          )}
        </details>

        {task.agent_id && <HandoffBar taskId={task.id} />}
        {agent && <TeachBar agent={agent} taskId={task.id} />}

        </fieldset>

        <Section title="Comments">
          <Comments task={task} />
        </Section>
        <Section title="Activity">
          <Activity task={task} />
        </Section>

        <footer className="panel-foot small muted">
          Created {fmtDateTime(task.created_at, 'Asia/Dubai')}
          {task.workflow_name ? ` by workflow “${task.workflow_name}”` : ''}
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm btn-danger-ghost"
            onClick={async () => {
              if (!confirm(`Delete “${task.title}”? This can't be undone.`)) return;
              const stop = task.series_id && task.repeat && confirm('This task repeats. Stop the repeats too?\n\nOK: no more new ones.\nCancel: delete only this one.');
              await run(() => api(`/tasks/${task.id}${stop ? '?stop_series=1' : ''}`, { method: 'DELETE' }));
              onClose();
            }}
          >
            Delete task
          </button>
        </footer>
      </div>
    </aside>
  );
}
