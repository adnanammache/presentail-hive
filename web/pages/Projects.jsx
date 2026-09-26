import { useEffect, useState } from 'react';
import { api, fmtDay, useApi } from '../api.js';
import { DateInput, Empty, Icon, Loading, Modal } from '../components/ui.jsx';
import BotAvatar from '../components/BotAvatar.jsx';
import { AssigneePicker, PersonAvatar, useAssignees } from '../components/work.jsx';

const HEALTH = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track' };
export const healthLabel = (h) => HEALTH[h];

export function Star({ project }) {
  const toggle = (e) => {
    e.preventDefault();
    e.stopPropagation();
    api(`/projects/${project.id}/favorite`, { method: project.favorite ? 'DELETE' : 'PUT' });
  };
  return (
    <button type="button" className={`star ${project.favorite ? 'on' : ''}`} aria-pressed={project.favorite} aria-label={project.favorite ? `Remove ${project.name} from favorites` : `Add ${project.name} to favorites`} onClick={toggle}>
      <Icon name="star" size={17} />
    </button>
  );
}

export function MemberStack({ members, max = 4 }) {
  const shown = members.slice(0, max);
  return (
    <span className="member-stack" aria-label={members.map((m) => `${m.name} (${m.type === 'agent' ? 'AI agent' : 'person'})`).join(', ')}>
      {shown.map((m) => (
        <span key={`${m.type}:${m.ref}`} className="member" title={`${m.name}${m.type === 'agent' ? ' · AI agent' : ''}`}>
          {m.type === 'agent' ? <BotAvatar id={m.agent_id} name={m.name} color={m.color} size={26} /> : <PersonAvatar name={m.name} size={26} photo={m.avatar_url} />}
        </span>
      ))}
      {members.length > max && <span className="member more">+{members.length - max}</span>}
    </span>
  );
}

/** Create or edit a project: name, brief, owner, optional due date, and members (people and agents). */
export function ProjectForm({ project, onClose, onSaved }) {
  const { people, agents } = useAssignees();
  const { data: me } = useApi('/me');
  const [v, setV] = useState({
    name: project?.name ?? '',
    description: project?.description ?? '',
    owner: project?.owner_email ? `user:${project.owner_email}` : null,
    due_date: project?.due_date ?? '',
    health: project?.health ?? '',
    members: new Set((project?.members ?? []).map((m) => `${m.type}:${m.ref}`)),
  });
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!project && me?.email && !v.owner) setV((x) => ({ ...x, owner: `user:${me.email}` }));
  }, [me?.email]);
  const toggle = (ref) => setV((x) => {
    const m = new Set(x.members);
    m.has(ref) ? m.delete(ref) : m.add(ref);
    return { ...x, members: m };
  });
  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = {
        name: v.name,
        description: v.description,
        owner_email: v.owner ? v.owner.slice(5) : undefined,
        due_date: v.due_date || null,
        members: [...v.members].map((r) => ({ type: r.startsWith('agent:') ? 'agent' : 'user', ref: r.replace(/^(agent|user):/, '') })),
        ...(project ? { health: v.health || null } : {}),
      };
      const saved = await api(project ? `/projects/${project.id}` : '/projects', { method: project ? 'PATCH' : 'POST', body });
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };
  const match = (x) => !q || x.name.toLowerCase().includes(q.toLowerCase());
  const row = (x) => (
    <label key={x.ref} className="member-row">
      <input type="checkbox" checked={v.members.has(x.ref)} onChange={() => toggle(x.ref)} />
      {x.type === 'agent' ? <BotAvatar id={x.id} name={x.name} color={x.color} size={24} /> : <PersonAvatar name={x.name} size={24} photo={x.avatar_url} />}
      <span className="grow">
        {x.name}
        <span className="muted small"> · {x.detail}</span>
      </span>
      {x.type === 'agent' && <span className="type-tag agent"><Icon name="bot" size={11} />AI agent</span>}
    </label>
  );
  return (
    <Modal title={project ? 'Edit project' : 'New project'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Name</span>
          <input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required autoFocus maxLength={120} />
        </label>
        <label className="field">
          <span className="field-label">Description or brief</span>
          <textarea rows={3} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} placeholder="What is this project for?" />
        </label>
        <div className="grid-2">
          <div className="field">
            <span className="field-label">Owner</span>
            <AssigneePicker label="Owner" value={v.owner} onChange={(ref) => ref && setV({ ...v, owner: ref })} allowNone={false} onlyPeople />
          </div>
          <div className="field">
            <span className="field-label">Due date (optional)</span>
            <DateInput value={v.due_date} onChange={(d) => setV({ ...v, due_date: d ?? '' })} label="Due date" placeholder="No due date" clearable />
          </div>
        </div>
        {project && (
          <label className="field">
            <span className="field-label">Health</span>
            <select value={v.health} onChange={(e) => setV({ ...v, health: e.target.value })}>
              <option value="">Not set</option>
              {Object.entries(HEALTH).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <span className="field-hint">Set by you. Hive never guesses it.</span>
          </label>
        )}
        <fieldset className="form-section">
          <legend>Members</legend>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people and agents" aria-label="Search members" />
          <div className="member-list">
            <div className="picker-group">People</div>
            {people.filter(match).map(row)}
            <div className="picker-group">AI agents</div>
            {agents.filter(match).map(row)}
          </div>
          <span className="field-hint">Adding an agent doesn't give it access to new systems or start it.</span>
        </fieldset>
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : project ? 'Save' : 'Create project'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function Projects() {
  const [status, setStatus] = useState('active');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const { data: projects } = useApi(`/projects?status=${status}${q ? `&q=${encodeURIComponent(q)}` : ''}`, ['project', 'task']);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="page-sub">Group related work. Tasks don't need a project.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={16} /> New project
        </button>
      </div>
      <div className="filters">
        <label className="search-box">
          <Icon name="search" size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects…" aria-label="Search projects" />
        </label>
        <div className="segmented" role="radiogroup" aria-label="Show">
          {[
            ['active', 'Active'],
            ['archived', 'Archived'],
          ].map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={status === k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {!projects ? (
        <Loading />
      ) : projects.length === 0 ? (
        <Empty title={q ? 'No projects match' : status === 'archived' ? 'No archived projects' : 'No projects yet'}>
          {status === 'active' && !q && (
            <>
              A project gathers tasks, people, agents and reference files around one goal, like a month-end close.{' '}
              <button type="button" className="link-btn" onClick={() => setCreating(true)}>
                Create the first one
              </button>
            </>
          )}
        </Empty>
      ) : (
        <div className="project-grid">
          {projects.map((p) => (
            <a key={p.id} className="project-card" href={`#/projects/${p.id}`}>
              <header>
                <span className="project-icon" style={{ '--c': p.color }} aria-hidden="true">
                  <Icon name="folder" size={18} />
                </span>
                <h3 className="grow clamp-1">{p.name}</h3>
                <Star project={p} />
              </header>
              {p.description && <p className="project-desc clamp-2">{p.description}</p>}
              <div className="project-meta small">
                <span>
                  <Icon name="user" size={13} /> {p.owner_name ?? 'No owner'}
                </span>
                {p.due_date && (
                  <span>
                    <Icon name="calendar" size={13} /> Due {fmtDay(p.due_date)}
                  </span>
                )}
                {p.health && <span className={`health health-${p.health}`}>{healthLabel(p.health)}</span>}
              </div>
              <div className="project-progress">
                {p.counts.total > 0 ? (
                  <>
                    <div className="progress-bar" role="img" aria-label={`${p.counts.done} of ${p.counts.total} tasks done`}>
                      <span style={{ width: `${(100 * p.counts.done) / p.counts.total}%` }} />
                    </div>
                    <span className="small muted">
                      {p.counts.done} of {p.counts.total} tasks done
                      {p.counts.blocked > 0 ? ` · ${p.counts.blocked} blocked` : ''}
                      {p.counts.overdue > 0 ? ` · ${p.counts.overdue} overdue` : ''}
                    </span>
                  </>
                ) : (
                  <span className="small muted">No tasks yet</span>
                )}
              </div>
              <footer>
                <MemberStack members={p.members} />
                <span className="small muted">
                  {p.people_count} {p.people_count === 1 ? 'person' : 'people'} · {p.agent_count} AI agent{p.agent_count === 1 ? '' : 's'}
                </span>
              </footer>
            </a>
          ))}
        </div>
      )}
      {creating && <ProjectForm onClose={() => setCreating(false)} onSaved={(p) => (location.hash = `#/projects/${p.id}`)} />}
    </>
  );
}
