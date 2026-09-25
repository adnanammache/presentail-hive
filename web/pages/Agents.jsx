import { useState } from 'react';
import { ago, useApi } from '../api.js';
import { Avatar, Badge, Empty, Icon, Loading, PLATFORM_LABELS, PageHeader, agentTone } from '../components/ui.jsx';
import { AgentForm, TeamForm } from '../components/forms.jsx';
import { money } from '../components/Spend.jsx';

function AgentCard({ a }) {
  return (
    <a className="agent-card" href={`#/agents/${a.id}`} style={{ '--c': a.color }}>
      <header>
        <Avatar name={a.name} color={a.color} size={44} status={a.status} />
        <div className="grow">
          <h3>{a.name}</h3>
          <div className="agent-title">{a.title || 'No title'}</div>
        </div>
        <Badge tone={agentTone[a.status]}>{a.status}</Badge>
      </header>
      <p className="agent-desc clamp">{a.description || 'No description.'}</p>
      <footer>
        <span className="pill">{PLATFORM_LABELS[a.platform]}</span>
        <span>
          <strong>{a.open_tasks}</strong> open tasks
        </span>
        <span>
          <strong>{a.workflows}</strong> workflows
        </span>
        <span className="spacer" />
        {a.month_cents > 0 ? <span className="muted small" title="AI spend this month">{money(a.month_cents)} this month</span> : <span className="muted small">seen {ago(a.last_seen_at)}</span>}
      </footer>
    </a>
  );
}

export default function Agents() {
  const { data: agents } = useApi('/agents', ['agent', 'task', 'workflow']);
  const { data: teams } = useApi('/teams', ['agent']);
  const [modal, setModal] = useState(null);

  if (!agents || !teams) return <Loading />;

  const groups = teams.map((t) => ({ team: t, members: agents.filter((a) => a.team_id === t.id) }));
  const noTeam = agents.filter((a) => !a.team_id);

  return (
    <>
      <PageHeader title="Agents & teams" subtitle={`${agents.length} agents across ${teams.length} teams`}>
        <button className="btn" onClick={() => setModal({ kind: 'team' })}>
          <Icon name="plus" size={16} /> New team
        </button>
        <button className="btn btn-primary" onClick={() => setModal({ kind: 'agent' })}>
          <Icon name="plus" size={16} /> New agent
        </button>
      </PageHeader>

      {agents.length === 0 && teams.length === 0 && (
        <Empty title="Build your first team">Create a team (e.g. Finance), then add agents to it with a name and title.</Empty>
      )}

      {groups.map(({ team, members }) => (
        <section key={team.id} className="team-section" style={{ '--c': team.color }}>
          <header className="team-head">
            <span className="team-dot" />
            <div className="grow">
              <h2>{team.name}</h2>
              {team.description && <p className="muted small">{team.description}</p>}
            </div>
            <span className="muted small nowrap">
              {members.length} {members.length === 1 ? 'agent' : 'agents'}
              {members.some((m) => m.month_cents) && ` · ${money(members.reduce((t, m) => t + m.month_cents, 0))} this month`}
            </span>
            <button className="btn btn-sm btn-ghost" onClick={() => setModal({ kind: 'team', team })}>
              <Icon name="edit" size={14} /> Edit
            </button>
            <button className="btn btn-sm" onClick={() => setModal({ kind: 'agent', defaults: { team_id: team.id, color: team.color } })}>
              <Icon name="plus" size={14} /> Add agent
            </button>
          </header>
          {members.length === 0 ? (
            <div className="team-empty">No agents in {team.name} yet.</div>
          ) : (
            <div className="agent-grid">
              {members.map((a) => (
                <AgentCard key={a.id} a={a} />
              ))}
            </div>
          )}
        </section>
      ))}

      {noTeam.length > 0 && (
        <section className="team-section" style={{ '--c': '#94a3b8' }}>
          <header className="team-head">
            <span className="team-dot" />
            <div className="grow">
              <h2>No team</h2>
              <p className="muted small">Open an agent and choose a team in Settings.</p>
            </div>
          </header>
          <div className="agent-grid">
            {noTeam.map((a) => (
              <AgentCard key={a.id} a={a} />
            ))}
          </div>
        </section>
      )}

      {modal?.kind === 'team' && <TeamForm team={modal.team} onClose={() => setModal(null)} />}
      {modal?.kind === 'agent' && (
        <AgentForm defaults={modal.defaults} onClose={() => setModal(null)} onSaved={(a) => (location.hash = `#/agents/${a.id}`)} />
      )}
    </>
  );
}
