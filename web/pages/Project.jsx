import { useEffect, useRef, useState } from 'react';
import { ago, api, fmtDay, useApi } from '../api.js';
import { Icon, Loading } from '../components/ui.jsx';
import WorkView from '../components/TaskViews.jsx';
import { STAGES, useTaskUI } from '../components/work.jsx';
import { MemberStack, ProjectForm, Star, healthLabel } from './Projects.jsx';

const TABS = [
  ['overview', 'Overview'],
  ['board', 'Board'],
  ['list', 'List'],
  ['files', 'Files'],
];

function ActionsMenu({ project, onEdit }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return;
    const away = (e) => !box.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', away);
    box.current?.querySelector('[role=menuitem]')?.focus();
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  if (!project.can_manage) return null;
  const archive = () => api(`/projects/${project.id}`, { method: 'PATCH', body: { status: project.status === 'archived' ? 'active' : 'archived' } });
  const remove = async () => {
    if (!confirm(`Delete “${project.name}”? Its tasks are kept (without a project), with their history. Reference files are deleted.`)) return;
    await api(`/projects/${project.id}`, { method: 'DELETE' });
    location.hash = '#/projects';
  };
  return (
    <div className="card-menu" ref={box} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button type="button" className="btn icon-only" aria-haspopup="menu" aria-expanded={open} aria-label="Project actions" onClick={() => setOpen((o) => !o)}>
        <Icon name="dots" size={18} />
      </button>
      {open && (
        <div className="menu right" role="menu">
          <button type="button" role="menuitem" onClick={() => (setOpen(false), onEdit())}>
            Edit project
          </button>
          <button type="button" role="menuitem" onClick={() => (setOpen(false), archive())}>
            {project.status === 'archived' ? 'Restore from archive' : 'Archive project'}
          </button>
          <button type="button" role="menuitem" className="danger" onClick={() => (setOpen(false), remove())}>
            Delete project
          </button>
        </div>
      )}
    </div>
  );
}

/** Reference files and links, as a full tab or as the compact strip under the board. */
function Resources({ project, compact, onAll }) {
  const { data: items, reload } = useApi(`/projects/${project.id}/resources`, ['project']);
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const upload = async (files) => {
    setBusy(true);
    setError('');
    try {
      for (const f of files) {
        const res = await fetch(`/api/projects/${project.id}/resources`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name) }, body: f });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Couldn't upload ${f.name}`);
      }
      reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const addLink = async () => {
    setError('');
    try {
      await api(`/projects/${project.id}/resources`, { method: 'POST', body: { url, label } });
      setUrl('');
      setLabel('');
      reload();
    } catch (err) {
      setError(err.message);
    }
  };
  const chip = (r) =>
    r.kind === 'file' ? (
      <a key={r.id} className="resource" href={`/api/projects/${project.id}/resources/${r.id}/file`}>
        <Icon name="file" size={16} /> <span className="clamp-1">{r.label}</span>
      </a>
    ) : (
      <a key={r.id} className="resource" href={r.url} target="_blank" rel="noreferrer">
        <Icon name="link" size={16} /> <span className="clamp-1">{r.label}</span>
      </a>
    );
  if (compact)
    return (
      <section className="resources-strip" aria-label="Project resources">
        <strong>
          <Icon name="folder" size={16} /> Project resources
        </strong>
        {items?.slice(0, 3).map(chip)}
        {items?.length === 0 && <span className="muted small">No reference files or links yet.</span>}
        <button type="button" className="resource more" onClick={onAll}>
          {items?.length > 3 ? `View all ${items.length}` : 'Manage files'} <Icon name="chevron" size={14} />
        </button>
      </section>
    );
  return (
    <div className="resources-tab">
      {items?.length === 0 && <p className="muted">No reference files or links yet. Add the checklists, guidelines and templates people and agents should work from.</p>}
      <ul className="resource-list">
        {items?.map((r) => (
          <li key={r.id}>
            {chip(r)}
            <span className="muted small">
              {r.kind === 'file' ? `${Math.max(1, Math.round((r.size ?? 0) / 1024))} KB · ` : ''}added by {r.created_by ?? 'someone'} {ago(r.created_at)}
            </span>
            {project.can_contribute && (
              <button type="button" className="icon-btn sm" aria-label={`Remove ${r.label}`} onClick={() => api(`/projects/${project.id}/resources/${r.id}`, { method: 'DELETE' }).then(reload, (e) => setError(e.message))}>
                <Icon name="trash" size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {project.can_contribute ? (
        <div className="resource-add">
          <label className="btn">
            <Icon name="paperclip" size={15} /> {busy ? 'Uploading…' : 'Upload files'}
            <input type="file" multiple hidden onChange={(e) => (upload([...e.target.files]), (e.target.value = ''))} />
          </label>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" aria-label="Link" />
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" aria-label="Link label" />
          <button type="button" className="btn" disabled={!url.trim()} onClick={addLink}>
            Add link
          </button>
        </div>
      ) : (
        <p className="muted small">Only this project's members can add files and links.</p>
      )}
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}

function Overview({ project }) {
  const { data: activity } = useApi(`/projects/${project.id}/activity`, ['task', 'project']);
  const { data: boardData } = useApi(`/board?project_id=${project.id}&done_limit=0`, ['task']);
  const counts = boardData?.counts;
  return (
    <div className="overview-grid">
      <section className="card">
        <h2>Brief</h2>
        <p className="brief-text">{project.description || <span className="muted">No brief yet.</span>}</p>
        <dl className="kv">
          <dt>Owner</dt>
          <dd>{project.owner_name ?? '—'}</dd>
          <dt>Due</dt>
          <dd>{project.due_date ? fmtDay(project.due_date) : 'No due date'}</dd>
          <dt>Created</dt>
          <dd>{fmtDay(project.created_at?.slice(0, 10))}</dd>
          {project.health && (
            <>
              <dt>Health</dt>
              <dd>
                <span className={`health health-${project.health}`}>{healthLabel(project.health)}</span> <span className="muted small">(set by the owner)</span>
              </dd>
            </>
          )}
        </dl>
      </section>
      <section className="card">
        <h2>Tasks</h2>
        {counts ? (
          <ul className="stage-summary">
            {STAGES.map((s) => (
              <li key={s.id}>
                <span className={`stage-pill stage-${s.id}`}>{s.label}</span>
                <strong>{counts[s.id] ?? 0}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <Loading />
        )}
        {(project.counts.blocked > 0 || project.counts.overdue > 0) && (
          <p className="small">
            {project.counts.blocked > 0 && <span className="text-red">{project.counts.blocked} blocked. </span>}
            {project.counts.overdue > 0 && <span className="text-red">{project.counts.overdue} overdue.</span>}
          </p>
        )}
      </section>
      <section className="card">
        <h2>Members</h2>
        <ul className="member-lines">
          {project.members.map((m) => (
            <li key={`${m.type}:${m.ref}`}>
              <MemberStack members={[m]} />
              <span className="grow">{m.name}</span>
              <span className={`type-tag ${m.type === 'agent' ? 'agent' : 'person'}`}>{m.type === 'agent' ? 'AI agent' : 'Person'}</span>
            </li>
          ))}
          {project.members.length === 0 && <li className="muted small">No members yet.</li>}
        </ul>
      </section>
      <section className="card">
        <h2>Recent activity</h2>
        <ol className="activity-list">
          {activity?.map((e) => (
            <li key={e.id}>
              <span className="activity-text">
                <strong>{e.actor}</strong> · {e.text} · <em>{e.title}</em>
              </span>
              <time className="muted small">{ago(e.created_at)}</time>
            </li>
          ))}
          {activity?.length === 0 && <li className="muted small">Nothing yet.</li>}
        </ol>
      </section>
    </div>
  );
}

export default function Project({ id, tab = 'board' }) {
  const { data: project, error } = useApi(`/projects/${id}`, ['project', 'task']);
  const { openComposer } = useTaskUI();
  const [editing, setEditing] = useState(false);
  if (error) return <div className="form-error">{error}</div>;
  if (!project) return <Loading />;
  const go = (t) => (location.hash = `#/projects/${id}/${t}`);
  const archived = project.status === 'archived';
  return (
    <div className="project-page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <a href="#/projects">Projects</a>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{project.name}</span>
      </nav>
      <header className="project-head">
        <div className="project-title">
          <span className="project-icon lg" style={{ '--c': project.color }} aria-hidden="true">
            <Icon name="folder" size={24} />
          </span>
          <h1>{project.name}</h1>
          <Star project={project} />
          {archived && <span className="chip-soft">Archived</span>}
        </div>
        <div className="project-head-actions">
          <MemberStack members={project.members} />
          {project.can_manage && (
            <button type="button" className="btn" onClick={() => setEditing(true)}>
              <Icon name="users" size={16} /> Members
            </button>
          )}
          {!archived && (
            <button type="button" className="btn btn-primary" onClick={() => openComposer({ project_id: Number(id) })} disabled={!project.can_contribute} title={project.can_contribute ? undefined : "Only this project's members can add tasks"}>
              <Icon name="plus" size={16} /> New task
            </button>
          )}
          <ActionsMenu project={project} onEdit={() => setEditing(true)} />
        </div>
      </header>
      {project.description && <p className="project-brief">{project.description}</p>}
      <div className="project-facts">
        <span>
          <Icon name="user" size={15} /> Owner: {project.owner_name ?? '—'}
        </span>
        {project.due_date && (
          <span>
            <Icon name="calendar" size={15} /> Due {fmtDay(project.due_date)}
          </span>
        )}
        {project.health && <span className={`health health-${project.health}`}>{healthLabel(project.health)}</span>}
        <span>
          <Icon name="users" size={15} /> {project.people_count} {project.people_count === 1 ? 'person' : 'people'} · {project.agent_count} AI agent{project.agent_count === 1 ? '' : 's'}
        </span>
      </div>
      <div className="tabs" role="tablist" aria-label="Project views">
        {TABS.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => go(k)}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'overview' && <Overview project={project} />}
      {(tab === 'board' || tab === 'list') && (
        <>
          <WorkView
            key={`${id}-${tab}`}
            scope={{ projectId: Number(id) }}
            prefKey={`project-${id}`}
            forceView={tab}
          />
          <Resources project={project} compact onAll={() => go('files')} />
        </>
      )}
      {tab === 'files' && <Resources project={project} />}
      {editing && <ProjectForm project={project} onClose={() => setEditing(false)} />}
    </div>
  );
}
