import { useApi } from '../api.js';
import { Avatar, Loading, PageHeader } from '../components/ui.jsx';
import { money } from '../components/Spend.jsx';

const STATUS = { active: 'Working', idle: 'Ready', paused: 'Not set up', error: 'Error' };

function Node({ a }) {
  return (
    <a className={`org-node status-${a.status}`} href={`#/agents/${a.id}`} style={{ '--c': a.color }}>
      <Avatar name={a.name} color={a.color} size={34} status={a.status} />
      <div className="grow">
        <div className="org-name">
          <span className="clamp-1">{a.name}</span>
          {a.month_cents > 0 && <span className="org-spend" title="AI spend this month">{money(a.month_cents)}</span>}
        </div>
        <div className="org-title clamp-1">{a.title}</div>
        <div className="org-meta">
          <span>{STATUS[a.status] ?? a.status}</span>
          {a.open_tasks > 0 && <span>{a.open_tasks} open</span>}
        </div>
      </div>
    </a>
  );
}

export default function OrgChart({ me }) {
  const { data: agents } = useApi('/agents', ['agent', 'task', 'run']);
  const { data: teams } = useApi('/teams', ['agent']);
  if (!agents || !teams) return <Loading />;

  const columns = teams.map((t) => ({ team: t, members: agents.filter((a) => a.team_id === t.id) }));
  const unassigned = agents.filter((a) => !a.team_id);
  const live = agents.filter((a) => a.platform === 'managed' && a.status !== 'paused').length;

  return (
    <>
      <PageHeader title="Org chart" subtitle={`${agents.length} agents · ${teams.length} teams · ${live} live`}>
        <a className="btn" href="#/agents">
          Manage agents & teams
        </a>
      </PageHeader>
      <div className="org">
        <div className="org-root">
          <span className="brand-mark" />
          <div>
            <strong>Presentail</strong>
            <div className="muted small">{me?.name ? `${me.name} · Founder` : 'Leadership'}</div>
          </div>
        </div>
        <div className="org-columns" style={{ '--cols': columns.length }}>
          {columns.map(({ team, members }) => (
            <section key={team.id} className="org-col" style={{ '--c': team.color }}>
              <header className="org-team">
                <strong>{team.name}</strong>
                <span className="muted small">{members.length}</span>
              </header>
              <div className="org-members">
                {members.map((a) => (
                  <Node key={a.id} a={a} />
                ))}
                {members.length === 0 && <div className="muted small org-empty">No agents yet</div>}
              </div>
            </section>
          ))}
        </div>
        {unassigned.length > 0 && (
          <p className="muted small org-unassigned">
            Not on a team: {unassigned.map((a) => a.name).join(', ')}
          </p>
        )}
      </div>
    </>
  );
}
