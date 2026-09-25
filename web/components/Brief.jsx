import { useState } from 'react';
import { ago, api, fmtDateTime, useApi } from '../api.js';
import { money } from './Spend.jsx';

const TaskLink = ({ id, children }) => (id ? <a href={`#/tasks/${id}`}>{children}</a> : <>{children}</>);

/** The latest daily brief from the Chief of Staff, on the dashboard. */
export default function BriefCard() {
  const { data, reload } = useApi('/brief', ['brief']);
  const [sending, setSending] = useState(false);
  if (!data) return null;
  const b = data.brief;
  const send = async () => {
    setSending(true);
    try {
      await api('/brief', { method: 'POST' });
      await reload();
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="card brief-card">
      <header className="card-head">
        <h2>☀️ Daily brief</h2>
        <span className="muted small">
          {b ? `${ago(b.created_at)}` : 'No brief yet'}
          {data.next_at && ` · next ${fmtDateTime(data.next_at, data.config.timezone)}`}
        </span>
        <button className="btn btn-sm" onClick={send} disabled={sending}>
          {sending ? 'Writing…' : 'Brief me now'}
        </button>
      </header>
      {!b ? (
        <p className="muted">Your Chief of Staff sends a brief every morning: what each department did, what's waiting on you, what failed and what's scheduled today. Tap "Brief me now" for one right away.</p>
      ) : (
        <div className="brief">
          <p className="brief-headline">{b.headline}</p>
          {(b.approvals.length > 0 || b.review.length > 0) && (
            <div className="brief-sec">
              <h3>Waiting on you</h3>
              <ul>
                {b.approvals.map((a) => (
                  <li key={`a${a.run_id}`}>
                    🟡 <b>{a.agent}</b> needs approval{a.count > 1 ? ` (${a.count})` : ''} on <TaskLink id={a.task_id}>{a.title}</TaskLink>
                  </li>
                ))}
                {b.review.map((t) => (
                  <li key={`t${t.task_id}`}>
                    {t.status === 'blocked' ? '🔴' : '👀'} <TaskLink id={t.task_id}>{t.title}</TaskLink>
                    {t.agent && <span className="muted"> · {t.agent}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {b.teams.length > 0 && (
            <div className="brief-sec">
              <h3>Done</h3>
              {b.teams.map((g) => (
                <div key={g.team} className="brief-team">
                  <span className="team-chip" style={{ '--c': g.color }}>
                    {g.team}
                  </span>
                  <ul>
                    {g.items.map((i) => (
                      <li key={i.task_id}>
                        <TaskLink id={i.task_id}>{i.title}</TaskLink>
                        {i.agent && <span className="muted"> · {i.agent}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          {b.failed.length > 0 && (
            <div className="brief-sec">
              <h3>Failed</h3>
              <ul>
                {b.failed.map((f, i) => (
                  <li key={i}>
                    🔴 <TaskLink id={f.task_id}>{f.title ?? 'a run'}</TaskLink> <span className="muted">· {f.agent ?? 'Unassigned'}: {f.error}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {b.today.length > 0 && (
            <div className="brief-sec">
              <h3>Scheduled today</h3>
              <ul>
                {b.today.map((w) => (
                  <li key={w.id}>
                    {fmtDateTime(w.at, w.timezone)} · {w.name}
                    {w.agent && <span className="muted"> · {w.agent}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {b.close && b.close.done < b.close.total && (
            <div className="brief-sec">
              <h3>
                <a href="#/close">
                  {b.close.label} close: {b.close.done} of {b.close.total} done
                </a>
              </h3>
              <ul>
                {b.close.overdue.length > 0 && <li>🔴 Overdue: {b.close.overdue.join(', ')}</li>}
                {b.close.not_started.length > 0 && <li>Not started: {b.close.not_started.join(', ')}</li>}
              </ul>
            </div>
          )}
          <p className="muted small">
            AI spend: {money(b.spend.since_cents)} since the last brief · {money(b.spend.month_cents)} this month
          </p>
        </div>
      )}
    </section>
  );
}
