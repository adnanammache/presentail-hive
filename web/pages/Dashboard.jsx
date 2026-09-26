import { useState } from 'react';
import { ago, api, fmtDateTime, until, useApi } from '../api.js';
import { Avatar, Badge, Empty, Icon, Loading, PageHeader, agentTone, runTone, statusLabel } from '../components/ui.jsx';
import { useTaskUI } from '../components/work.jsx';
import SpendCard from '../components/Spend.jsx';
import SetupCard from '../components/SetupCard.jsx';
import BriefCard from '../components/Brief.jsx';
import { HealthBanner } from '../components/Notifications.jsx';
import { MarkdownText } from '../components/Markdown.jsx';

function Stat({ label, value, sub, tone, href }) {
  return (
    <a className={`stat ${tone ? `stat-${tone}` : ''}`} href={href}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </a>
  );
}

export default function Dashboard() {
  const { data } = useApi('/overview', ['task', 'workflow', 'agent']);
  const { data: agents } = useApi('/agents', ['agent', 'message', 'task']);
  const { data: activity } = useApi('/activity?limit=15', ['activity']);
  const { openTask } = useTaskUI();
  const setEditing = (t) => openTask(t.id);

  if (!data) return <Loading />;
  const s = data.stats;
  return (
    <>
      <PageHeader title="Mission control" subtitle={new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} />

      <HealthBanner />
      <SetupCard />

      <div className="stats">
        <Stat label="Agents" value={s.agents} sub={`${s.agents_active} active${s.agents_error ? ` · ${s.agents_error} erroring` : ''}`} tone={s.agents_error ? 'red' : null} href="#/agents" />
        <Stat label="Open tasks" value={s.tasks_open} sub={`${s.tasks_done_week} done this week`} href="#/tasks" />
        <Stat label="Needs you" value={s.tasks_review + s.tasks_blocked} sub={`${s.tasks_review} to review · ${s.tasks_blocked} blocked`} tone={s.tasks_review + s.tasks_blocked ? 'amber' : null} href="#/tasks" />
        <Stat label="Workflows" value={s.workflows_enabled} sub={s.runs_failed_week ? `${s.runs_failed_week} failed runs this week` : 'no failures this week'} tone={s.runs_failed_week ? 'red' : null} href="#/workflows" />
      </div>

      <div className="dash-grid">
        <BriefCard />
        <SpendCard />
        <section className="card">
          <header className="card-head">
            <h2>Needs your attention</h2>
            <a href="#/tasks" className="link">Board →</a>
          </header>
          {data.attention.length === 0 ? (
            <Empty title="All clear">Nothing waiting for review and nothing blocked.</Empty>
          ) : (
            <ul className="list">
              {data.attention.map((t) => (
                <li key={t.id} className="list-row clickable" onClick={() => setEditing(t)}>
                  <Avatar name={t.agent_name ?? '?'} color={t.agent_color ?? '#94a3b8'} size={28} />
                  <div className="grow">
                    <div className="row-title">{t.title}</div>
                    {t.result && <div className="row-sub clamp">{t.result}</div>}
                  </div>
                  <Badge tone={t.blocked_kind ? 'red' : 'amber'}>{t.blocked_kind ? 'Blocked' : statusLabel(t.status)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <header className="card-head">
            <h2>Coming up</h2>
            <a href="#/workflows" className="link">Recurring →</a>
          </header>
          {data.upcoming.length === 0 ? (
            <Empty title="Nothing recurring is scheduled" />
          ) : (
            <ul className="list">
              {data.upcoming.map((w) => (
                <li key={w.id} className="list-row">
                  <span className="icon-tile">
                    <Icon name="clock" />
                  </span>
                  <div className="grow">
                    <div className="row-title">{w.name}</div>
                    <div className="row-sub">
                      {w.agent_name ?? 'Unassigned'} · {fmtDateTime(w.next_run_at, w.timezone)} <span className="small">({w.timezone})</span>
                    </div>
                  </div>
                  <span className="muted small nowrap">{until(w.next_run_at)}</span>
                  <button className="icon-btn" title="Run now" onClick={() => api(`/workflows/${w.id}/run`, { method: 'POST' })}>
                    <Icon name="play" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <header className="card-head">
            <h2>Agents</h2>
            <a href="#/agents" className="link">All →</a>
          </header>
          <ul className="list">
            {agents?.map((a) => (
              <li key={a.id}>
                <a className="list-row clickable" href={`#/agents/${a.id}`}>
                  <Avatar name={a.name} color={a.color} size={32} status={a.status} />
                  <div className="grow">
                    <div className="row-title">{a.name}</div>
                    <div className="row-sub clamp">{a.last_message ? <MarkdownText text={a.last_message} /> : a.title}</div>
                  </div>
                  <div className="right">
                    <Badge tone={agentTone[a.status]}>{a.status}</Badge>
                    <span className="muted small">{a.open_tasks} open</span>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <header className="card-head">
            <h2>Recent runs & activity</h2>
          </header>
          <ul className="list compact">
            {data.runs.map((r) => (
              <li key={`r${r.id}`} className="list-row">
                <Badge tone={runTone[r.status]}>{r.status}</Badge>
                <div className="grow">
                  <div className="row-title">{r.workflow_name}</div>
                  {r.output && <div className="row-sub clamp">{r.output}</div>}
                </div>
                <span className="muted small nowrap">{ago(r.started_at)}</span>
              </li>
            ))}
            {activity?.map((e) => (
              <li key={`a${e.id}`} className="list-row">
                <span className={`activity-dot kind-${e.kind}`} />
                <div className="grow row-sub">{e.text}</div>
                <span className="muted small nowrap">{ago(e.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
