import { useEffect, useState } from 'react';
import { api, useApi } from '../api.js';
import { Avatar, Loading, PageHeader } from '../components/ui.jsx';
import { money } from '../components/Spend.jsx';

const STATUS = { active: 'Working', idle: 'Ready', paused: 'Not set up', error: 'Error' };

// Arranged agents first (in their saved order), the rest by name.
const byPlace = (a, b) => (a.sort_order ?? 1e9) - (b.sort_order ?? 1e9) || a.name.localeCompare(b.name);

function Node({ a, arrange }) {
  const Tag = arrange ? 'div' : 'a';
  return (
    <Tag
      className={`org-node status-${a.status} ${arrange ? 'arranging' : ''}`}
      href={arrange ? undefined : `#/agents/${a.id}`}
      style={{ '--c': a.color }}
      draggable={Boolean(arrange)}
      onDragStart={arrange ? (e) => (e.dataTransfer.setData('text/agent', String(a.id)), (e.dataTransfer.effectAllowed = 'move')) : undefined}
      onDragOver={arrange ? (e) => (e.preventDefault(), e.stopPropagation(), arrange.hover(a.id)) : undefined}
      onDrop={arrange ? (e) => (e.preventDefault(), e.stopPropagation(), arrange.drop(Number(e.dataTransfer.getData('text/agent')), a.team_id, a.id)) : undefined}
    >
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
      {arrange && (
        <span className="org-arrows">
          <button type="button" className="icon-btn sm" aria-label={`Move ${a.name} up`} disabled={arrange.first} onClick={() => arrange.step(a.id, -1)}>
            ↑
          </button>
          <button type="button" className="icon-btn sm" aria-label={`Move ${a.name} down`} disabled={arrange.last} onClick={() => arrange.step(a.id, 1)}>
            ↓
          </button>
        </span>
      )}
    </Tag>
  );
}

export default function OrgChart({ me }) {
  const { data: agents } = useApi('/agents', ['agent', 'task', 'run']);
  const { data: teams } = useApi('/teams', ['agent']);
  const [arranging, setArranging] = useState(false);
  const [layout, setLayout] = useState(null); // { [teamId]: [agentIds] } while arranging
  const [over, setOver] = useState(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (!arranging) setLayout(null);
  }, [arranging]);
  if (!agents || !teams) return <Loading />;

  const saved = Object.fromEntries(teams.map((t) => [t.id, agents.filter((a) => a.team_id === t.id).sort(byPlace).map((a) => a.id)]));
  const current = layout ?? saved;
  const byId = new Map(agents.map((a) => [a.id, a]));
  const columns = teams.map((t) => ({ team: t, members: (current[t.id] ?? []).map((id) => ({ ...byId.get(id), team_id: t.id })).filter((a) => a.id) }));

  const save = async (next) => {
    const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(saved[k]));
    setLayout(next);
    setMsg('');
    try {
      await api('/org/layout', { method: 'PUT', body: { teams: changed.map((k) => ({ team_id: Number(k), ids: next[k] })) } });
    } catch (err) {
      setMsg(err.message);
      setLayout(null);
    }
  };
  /** Put agent `id` into `teamId`, before agent `beforeId` (or at the end). */
  const place = (id, teamId, beforeId) => {
    if (!id || id === beforeId) return;
    // Dragging someone down onto a card below them puts them after it; otherwise before it.
    const old = current[teamId] ?? [];
    const after = beforeId && old.includes(id) && old.indexOf(id) < old.indexOf(beforeId);
    const next = Object.fromEntries(Object.entries(current).map(([k, ids]) => [k, ids.filter((x) => x !== id)]));
    const list = next[teamId] ?? [];
    const at = beforeId ? list.indexOf(beforeId) + (after ? 1 : 0) : -1;
    list.splice(at < 0 ? list.length : at, 0, id);
    next[teamId] = list;
    save(next);
  };
  const step = (teamId, id, dir) => {
    const list = [...current[teamId]];
    const i = list.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    save({ ...current, [teamId]: list });
  };
  const unassigned = agents.filter((a) => !a.team_id);
  const live = agents.filter((a) => a.platform === 'managed' && a.status !== 'paused').length;

  return (
    <>
      <PageHeader title="Org chart" subtitle={`${agents.length} agents · ${teams.length} teams · ${live} live`}>
        {me?.role === 'owner' && (
          <button type="button" className={`btn ${arranging ? 'btn-primary' : ''}`} onClick={() => setArranging((x) => !x)}>
            {arranging ? 'Done arranging' : 'Arrange'}
          </button>
        )}
        <a className="btn" href="#/agents">
          Manage agents & teams
        </a>
      </PageHeader>
      {arranging && (
        <p className="org-hint small">
          Drag people up or down, or into another team. On a phone, use the ↑ ↓ arrows. Changes save as you go.
          {msg && <span style={{ color: 'var(--red)' }}> {msg}</span>}
        </p>
      )}
      <div className={`org ${arranging ? 'arranging' : ''}`}>
        <div className="org-root">
          <span className="brand-mark" />
          <div>
            <strong>Presentail</strong>
            <div className="muted small">{me?.name ? `${me.name} · Founder` : 'Leadership'}</div>
          </div>
        </div>
        <div className="org-columns" style={{ '--cols': columns.length }}>
          {columns.map(({ team, members }) => (
            <section
              key={team.id}
              className={`org-col ${arranging && over === team.id ? 'drop' : ''}`}
              style={{ '--c': team.color }}
              onDragOver={arranging ? (e) => (e.preventDefault(), setOver(team.id)) : undefined}
              onDragLeave={arranging ? () => setOver(null) : undefined}
              onDrop={arranging ? (e) => (e.preventDefault(), setOver(null), place(Number(e.dataTransfer.getData('text/agent')), team.id, null)) : undefined}
            >
              <header className="org-team">
                <strong>{team.name}</strong>
                <span className="muted small">{members.length}</span>
              </header>
              <div className="org-members">
                {members.map((a, i) => (
                  <Node
                    key={a.id}
                    a={a}
                    arrange={
                      arranging && {
                        first: i === 0,
                        last: i === members.length - 1,
                        hover: () => setOver(team.id),
                        drop: (id, teamId, beforeId) => (setOver(null), place(id, teamId, beforeId)),
                        step: (id, dir) => step(team.id, id, dir),
                      }
                    }
                  />
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
