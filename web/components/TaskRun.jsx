import { useEffect, useRef, useState } from 'react';
import { api, toDate, useApi } from '../api.js';
import { Badge, Icon, runTone } from './ui.jsx';

const STATUS_LABEL = {
  starting: 'Starting…',
  running: 'Working',
  needs_approval: 'Needs your approval',
  waiting: 'Waiting for you',
  failed: 'Failed',
  ended: 'Ended',
};
const ACTIVE = ['starting', 'running', 'needs_approval'];
const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const time = (s) => toDate(s)?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export async function uploadFiles(taskId, files) {
  for (const file of files) {
    const res = await fetch(`/api/tasks/${taskId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Upload failed for ${file.name}`);
  }
}

function Files({ taskId, locked }) {
  const { data: files, reload } = useApi(`/tasks/${taskId}/files`, ['task']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const input = useRef(null);
  const add = async (list) => {
    setBusy(true);
    setError(null);
    try {
      await uploadFiles(taskId, [...list]);
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div className="run-files">
      {files?.map((f) => (
        <span key={f.id} className="file-chip">
          <Icon name="paperclip" size={13} /> {f.filename} <span className="muted">{(f.size / 1024).toFixed(0)} KB</span>
          {!locked && (
            <button type="button" aria-label={`Remove ${f.filename}`} onClick={() => api(`/tasks/${taskId}/files/${f.id}`, { method: 'DELETE' }).then(reload)}>
              <Icon name="x" size={12} />
            </button>
          )}
        </span>
      ))}
      {!locked && (
        <label className="btn btn-sm">
          <Icon name="paperclip" size={14} /> {busy ? 'Uploading…' : 'Attach files'}
          <input ref={input} type="file" multiple hidden onChange={(e) => add(e.target.files)} />
        </label>
      )}
      {files?.length === 0 && locked && <span className="muted small">No files attached.</span>}
      {error && <span className="text-red small">{error}</span>}
    </div>
  );
}

function Timeline({ events, agentName }) {
  const box = useRef(null);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [events.length]);
  const shown = events.filter((e) =>
    ['agent.message', 'agent.tool_use', 'agent.mcp_tool_use', 'agent.custom_tool_use', 'agent.tool_result', 'user.custom_tool_result', 'session.error', 'user.message', 'user.tool_confirmation'].includes(e.type),
  );
  return (
    <div className="timeline" ref={box}>
      {shown.length === 0 && <div className="muted small">Waiting for {agentName} to start…</div>}
      {shown.map((e) => {
        const d = e.data;
        if (e.type === 'agent.message') return <div key={e.event_id} className="tl-msg"><strong>{agentName}</strong><div className="pre">{d.text}</div></div>;
        if (e.type === 'user.message') return <div key={e.event_id} className="tl-msg mine"><strong>You</strong><div className="pre">{d.text}</div></div>;
        if (e.type === 'agent.tool_use' || e.type === 'agent.mcp_tool_use')
          return (
            <div key={e.event_id} className="tl-tool">
              <span className="tl-time">{time(e.created_at)}</span>
              <code>{d.name}</code> <span className="tl-detail">{d.detail}</span>
            </div>
          );
        if (e.type === 'agent.custom_tool_use')
          return (
            <div key={e.event_id} className={`tl-tool ${d.kind === 'write' ? 'odoo-write' : ''}`}>
              <span className="tl-time">{time(e.created_at)}</span>
              <code>{d.name}</code> <span className="tl-detail">{d.detail}</span>
              {d.kind === 'write' && <span className="badge badge-amber">change</span>}
            </div>
          );
        if (e.type === 'user.custom_tool_result') return d.is_error ? <div key={e.event_id} className="tl-tool error">↳ {d.preview}</div> : null;
        if (e.type === 'agent.tool_result') return d.is_error ? <div key={e.event_id} className="tl-tool error">↳ {d.preview || 'Command failed'}</div> : null;
        if (e.type === 'user.tool_confirmation') return <div key={e.event_id} className={`tl-tool ${d.result === 'allow' ? 'ok' : 'error'}`}>{d.result === 'allow' ? '✓ You approved' : '✕ You rejected'}</div>;
        if (e.type === 'session.error') return <div key={e.event_id} className="tl-tool error">⚠ {d.message}</div>;
        return null;
      })}
    </div>
  );
}

/** Live view of a Claude Managed Agent working on a task: files, activity, approvals, replies, cost. */
/** A managed agent's runs on a task. `hideFiles`: the task panel shows files and the Start button itself. */
export default function TaskRun({ task, agentName, hideFiles }) {
  const { data: runs } = useApi(`/tasks/${task.id}/runs`, ['run']);
  const [reply, setReply] = useState('');
  const [error, setError] = useState(null);
  const current = runs?.[0];
  const active = current && ACTIVE.includes(current.status);

  const act = (fn) => async (...args) => {
    setError(null);
    try {
      await fn(...args);
    } catch (err) {
      setError(err.message);
    }
  };
  const start = act(() => api(`/tasks/${task.id}/runs`, { method: 'POST' }));
  const send = act(async (text) => {
    await api(`/runs/${current.id}/reply`, { method: 'POST', body: { text } });
    setReply('');
  });
  const confirm = act((eventId, allow, approveRest = false) => {
    if (approveRest && !window.confirm('Approve this and every further Odoo change the agent makes until it next stops and hands back to you?')) return;
    const deny_message = allow ? undefined : prompt('Optional: tell the agent why, or what to do instead') || undefined;
    // A reason is often a rule worth keeping ("Abu Dhabi fees go to 5104"): offer to make it a lesson.
    const remember = Boolean(deny_message) && window.confirm(`Should ${agentName} remember this for next time?\n\n"${deny_message}"`);
    return api(`/runs/${current.id}/confirm`, { method: 'POST', body: { event_id: eventId, result: allow ? 'allow' : 'deny', deny_message, approve_rest: approveRest, remember } });
  });
  const stop = act(() => api(`/runs/${current.id}/interrupt`, { method: 'POST' }));

  return (
    <section className="run-panel">
      <header className="run-head">
        <strong>Agent run</strong>
        {current && <Badge tone={runTone[current.status]}>{STATUS_LABEL[current.status] ?? current.status}</Badge>}
        {current?.cost_cents > 0 && <span className="muted small">{money(current.cost_cents)}</span>}
        <span className="spacer" />
        {active && current.status === 'running' && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={stop}>
            <Icon name="stop" size={13} /> Stop
          </button>
        )}
        {!active && !hideFiles && (
          <button type="button" className="btn btn-sm btn-primary" onClick={start}>
            <Icon name="play" size={13} /> {current ? 'Start a new run' : `Run with ${agentName}`}
          </button>
        )}
      </header>

      {!hideFiles && <Files taskId={task.id} locked={active} />}
      {hideFiles && !current && <p className="muted small">No runs yet. Start {agentName} when the task is ready.</p>}

      {current && (
        <>
          <Timeline events={current.events} agentName={agentName} />
          {current.error && <div className="form-error">{current.error}</div>}

          {current.outputs?.length > 0 && (
            <div className="run-outputs">
              <span className="small strong">Files from {agentName}</span>
              <div className="run-files">
                {current.outputs.map((o) => (
                  <a key={o.id} className="file-chip out" href={`/api/runs/${current.id}/outputs/${o.id}`} download={o.filename}>
                    ⬇ {o.filename} <span className="muted">{Math.max(1, Math.round(o.size / 1024))} KB</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          {current.pending.map((p) =>
            p.kind === 'wafeq' ? (
              <div key={p.event_id} className="approval odoo">
                <div className="small strong">{agentName} wants to post to Wafeq</div>
                <div className="odoo-call">
                  <code>{p.detail}</code>
                </div>
                <div className="small muted">Nothing has been sent yet. Approving sends every step below to Wafeq in order and stops at the first error.</div>
                {p.lines && <pre className="code approval-preview">{p.lines}</pre>}
                {p.preview && (
                  <details open={p.preview.length < 1200}>
                    <summary className="small">The exact changes (everything that will be sent)</summary>
                    <pre className="code approval-preview">{p.preview}</pre>
                  </details>
                )}
                <div className="approval-actions">
                  <button type="button" className="btn btn-sm btn-danger-ghost" onClick={() => confirm(p.event_id, false)}>
                    Reject and discard
                  </button>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => confirm(p.event_id, true)}>
                    <Icon name="check" size={13} /> Approve and post
                  </button>
                </div>
              </div>
            ) : p.kind === 'odoo' ? (
              <div key={p.event_id} className="approval odoo">
                <div className="small strong">{agentName} wants to change Odoo</div>
                <div className="odoo-call">
                  <code>{p.detail}</code>
                </div>
                {p.reason && <div className="small">{p.reason}</div>}
                {p.preview && p.preview !== '{}' && (
                  <details open={p.preview.length < 1200}>
                    <summary className="small">The exact change (everything that will be sent)</summary>
                    <pre className="code approval-preview">{p.preview}</pre>
                  </details>
                )}
                <div className="approval-actions">
                  <button type="button" className="btn btn-sm btn-danger-ghost" onClick={() => confirm(p.event_id, false)}>
                    Reject
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => confirm(p.event_id, true, true)} title="Approve this and the agent's further Odoo changes until it next stops and hands back to you">
                    Approve the rest of this turn
                  </button>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => confirm(p.event_id, true)}>
                    <Icon name="check" size={13} /> Approve
                  </button>
                </div>
              </div>
            ) : (
              <div key={p.event_id} className="approval">
                <div className="small strong">
                  {agentName} wants to run <code>{p.name}</code>
                </div>
                {p.detail && <pre className="code approval-preview">{p.detail}</pre>}
                {p.preview && (
                  <details open={p.preview.length < 1200}>
                    <summary className="small">What it will write</summary>
                    <pre className="code approval-preview">{p.preview}</pre>
                  </details>
                )}
                <div className="approval-actions">
                  <button type="button" className="btn btn-sm btn-danger-ghost" onClick={() => confirm(p.event_id, false)}>
                    Reject
                  </button>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => confirm(p.event_id, true)}>
                    <Icon name="check" size={13} /> Approve
                  </button>
                </div>
              </div>
            ),
          )}

          {['waiting', 'needs_approval', 'running'].includes(current.status) && (
            <div className="run-reply">
              {current.status === 'waiting' && (
                <div className="chips">
                  <button type="button" className="chip" onClick={() => send('Looks right. Go ahead and post.')}>Go ahead and post</button>
                  <button type="button" className="chip" onClick={() => send("Don't post anything yet. Explain the differences first.")}>Explain first</button>
                </div>
              )}
              <div className="composer compact">
                <textarea
                  rows={1}
                  value={reply}
                  placeholder={`Reply to ${agentName}…`}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && reply.trim()) {
                      e.preventDefault();
                      send(reply.trim());
                    }
                  }}
                />
                <button type="button" className="btn btn-primary" disabled={!reply.trim()} onClick={() => send(reply.trim())} aria-label="Send">
                  <Icon name="send" size={16} />
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {error && <div className="form-error">{error}</div>}
    </section>
  );
}
