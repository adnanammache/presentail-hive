import { useState } from 'react';
import { ago, useApi } from '../api.js';
import { Avatar, Badge, Empty, Icon, Loading, PLATFORM_LABELS, PageHeader, agentTone } from '../components/ui.jsx';
import { AgentForm } from '../components/forms.jsx';

export default function Agents() {
  const { data: agents } = useApi('/agents', ['agent', 'task', 'workflow']);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHeader title="Agents" subtitle="Everything that works for you — Claude agents, Make scenarios, Replit apps, or your own scripts.">
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} /> Add agent
        </button>
      </PageHeader>
      {!agents ? (
        <Loading />
      ) : agents.length === 0 ? (
        <Empty title="No agents yet">Add your first agent to start assigning work.</Empty>
      ) : (
        <div className="agent-grid">
          {agents.map((a) => (
            <a key={a.id} className="agent-card" href={`#/agents/${a.id}`} style={{ '--c': a.color }}>
              <header>
                <Avatar name={a.name} color={a.color} size={44} status={a.status} />
                <div className="grow">
                  <h3>{a.name}</h3>
                  <div className="muted small">{a.role}</div>
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
                <span className="muted small">seen {ago(a.last_seen_at)}</span>
              </footer>
            </a>
          ))}
        </div>
      )}
      {adding && <AgentForm onClose={() => setAdding(false)} onSaved={(a) => (location.hash = `#/agents/${a.id}`)} />}
    </>
  );
}
