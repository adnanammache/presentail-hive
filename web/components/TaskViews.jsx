// The shared task views: filters, attention strip, Board and List. Used by All tasks, My tasks and
// each project. Moving a card only changes its stage: it never starts, stops or runs anything.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtDay, useApi } from '../api.js';
import { Icon, Loading } from './ui.jsx';
import { AssigneeChip, BLOCKERS, DueLabel, PRIORITY_LABELS, STAGES, stageLabel, usePref, useTaskUI } from './work.jsx';

const EMPTY_FILTERS = { q: '', project_id: '', assignee: '', type: '', priority: '', due: '', attention: '' };

// ---------------------------------------------------------------- data

function useBoard(scope, filters, doneLimit) {
  const qs = new URLSearchParams(
    Object.entries({ ...filters, ...(scope.mine ? { mine: '1' } : {}), ...(scope.projectId ? { project_id: scope.projectId } : {}), done_limit: doneLimit }).filter(([, v]) => v !== '' && v != null),
  ).toString();
  return useApi(`/board?${qs}`, ['task', 'run', 'project']);
}

// ---------------------------------------------------------------- filters

function Filters({ filters, set, scope, projects, assignees }) {
  const [q, setQ] = useState(filters.q);
  useEffect(() => setQ(filters.q), [filters.q]);
  useEffect(() => {
    const t = setTimeout(() => q !== filters.q && set({ q }), 250);
    return () => clearTimeout(t);
  }, [q]);
  const active = Object.entries(filters).some(([k, v]) => v && k !== 'attention');
  return (
    <div className="filters" role="search">
      <label className="search-box">
        <Icon name="search" size={16} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={scope.projectId ? 'Search this project…' : 'Search tasks…'} aria-label="Search tasks" />
      </label>
      {!scope.projectId && (
        <select value={filters.project_id} onChange={(e) => set({ project_id: e.target.value })} aria-label="Project">
          <option value="">All projects</option>
          <option value="none">No project</option>
          {projects?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      {!scope.mine && (
        <>
          <select value={filters.assignee} onChange={(e) => set({ assignee: e.target.value })} aria-label="Assignee">
            <option value="">All assignees</option>
            <option value="none">Unassigned</option>
            <optgroup label="People">
              {assignees.people.map((p) => (
                <option key={p.ref} value={p.ref}>
                  {p.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="AI agents">
              {assignees.agents.map((a) => (
                <option key={a.ref} value={a.ref}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          </select>
          <div className="segmented" role="radiogroup" aria-label="Assignee type">
            {[
              ['', 'Everyone'],
              ['people', 'People'],
              ['agents', 'AI agents'],
            ].map(([v, l]) => (
              <button key={v} type="button" role="radio" aria-checked={filters.type === v} className={filters.type === v ? 'on' : ''} onClick={() => set({ type: v })}>
                {l}
              </button>
            ))}
          </div>
        </>
      )}
      <select value={filters.priority} onChange={(e) => set({ priority: e.target.value })} aria-label="Priority">
        <option value="">Any priority</option>
        {Object.entries(PRIORITY_LABELS).map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
      <select value={filters.due} onChange={(e) => set({ due: e.target.value })} aria-label="Due date">
        <option value="">Any due date</option>
        <option value="overdue">Overdue</option>
        <option value="today">Due today</option>
        <option value="week">Due in the next 7 days</option>
        <option value="none">No due date</option>
      </select>
      {active && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => set({ ...EMPTY_FILTERS })}>
          <Icon name="x" size={14} /> Clear filters
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- attention strip

export function AttentionStrip({ projectId, value, onPick }) {
  const { data } = useApi(`/attention${projectId ? `?project_id=${projectId}` : ''}`, ['task', 'run']);
  if (!data) return null;
  const items = [
    ['review_mine', data.review_mine, data.review_mine === 1 ? 'awaiting your review' : 'awaiting your review or approval', 'clock', 'amber'],
    ['blocked', data.blocked, 'blocked', 'alert', 'red'],
    ['overdue', data.overdue, 'overdue', 'calendar', 'red'],
  ].filter(([, n]) => n > 0);
  if (!items.length) return value ? null : <p className="attention-clear muted small">Nothing needs your attention right now.</p>;
  return (
    <div className="attention" role="group" aria-label="Needs attention">
      {items.map(([k, n, label, icon, tone]) => (
        <button key={k} type="button" className={`attention-chip tone-${tone} ${value === k ? 'on' : ''}`} aria-pressed={value === k} onClick={() => onPick(value === k ? '' : k)}>
          <Icon name={icon} size={15} />
          <strong>{n}</strong> {label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- card

function CardMenu({ task, onMove, onOpen }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return;
    const away = (e) => !box.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', away);
    box.current?.querySelector('[role=menuitem]')?.focus();
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const key = (e) => {
    const items = [...box.current.querySelectorAll('[role=menuitem]')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') (e.preventDefault(), items[(i + 1) % items.length]?.focus());
    if (e.key === 'ArrowUp') (e.preventDefault(), items[(i - 1 + items.length) % items.length]?.focus());
    if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), setOpen(false), box.current.querySelector('button')?.focus());
  };
  return (
    <div className="card-menu" ref={box} onClick={(e) => e.stopPropagation()} onKeyDown={key}>
      <button type="button" className="icon-btn sm" aria-haspopup="menu" aria-expanded={open} aria-label={`Actions for ${task.title}`} onClick={() => setOpen((o) => !o)}>
        <Icon name="dots" size={16} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button type="button" role="menuitem" onClick={() => (setOpen(false), onOpen(task))}>
            Open details
          </button>
          <div className="menu-label">Move to</div>
          {STAGES.filter((s) => s.id !== task.stage).map((s) => (
            <button key={s.id} type="button" role="menuitem" onClick={() => (setOpen(false), onMove(task, s.id))}>
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function latestUpdate(t) {
  if (t.progress) return null;
  const same = (text) => t.blocker?.reason && text.trim() === t.blocker.reason.trim();
  if (['starting', 'running'].includes(t.run_status)) return `${t.assignee?.name ?? 'The agent'} is working…`;
  if (t.status === 'scheduled' && t.start_on) return `Starts ${fmtDay(t.start_on)}`;
  const line = t.result?.split('\n').find((l) => l.trim());
  if (line && !same(line) && !same(t.result)) return line;
  return null;
}

export function TaskCard({ task: t, showProject, onOpen, onMove, draggable = true }) {
  const update = latestUpdate(t);
  const blocker = t.blocker && BLOCKERS[t.blocker.kind];
  return (
    <article
      className={`work-card ${t.blocker ? `blocked-${t.blocker.kind}` : ''}`}
      draggable={draggable}
      onDragStart={(e) => (e.dataTransfer.setData('text/task', String(t.id)), (e.dataTransfer.effectAllowed = 'move'))}
      onClick={() => onOpen(t)}
      onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && onOpen(t)}
      tabIndex={0}
      aria-label={`${t.title}. ${stageLabel(t.stage)}${blocker ? `, ${blocker.label}` : ''}`}
    >
      <header className="work-card-head">
        <h3 className="work-card-title">{t.title}</h3>
        {onMove && <CardMenu task={t} onMove={onMove} onOpen={onOpen} />}
      </header>
      {showProject && t.project_name && (
        <div className="project-label">
          <span className="project-dot" style={{ background: t.project_color }} aria-hidden="true" />
          {t.project_name}
        </div>
      )}
      <AssigneeChip assignee={t.assignee} />
      {blocker && (
        <div className={`blocker-line kind-${t.blocker.kind}`}>
          <span className="blocker-badge">
            <Icon name={blocker.icon} size={13} /> {blocker.short}
          </span>
          {t.blocker.reason && <span className="blocker-reason clamp-1">{t.blocker.reason}</span>}
        </div>
      )}
      {t.status === 'waiting_approval' && !blocker && (
        <div className="blocker-line kind-approval">
          <span className="blocker-badge">
            <Icon name="clock" size={13} /> Waiting for approval
          </span>
        </div>
      )}
      {t.progress && (
        <div className="progress" title={`${t.progress.done} of ${t.progress.total} ${t.progress.label}`}>
          <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={t.progress.total} aria-valuenow={t.progress.done}>
            <span style={{ width: `${(100 * t.progress.done) / t.progress.total}%` }} />
          </div>
          <span className="small muted">
            {t.progress.done} of {t.progress.total} {t.progress.label}
          </span>
        </div>
      )}
      {update && <p className="work-card-update clamp-2">{update}</p>}
      <footer className="work-card-meta">
        {['high', 'urgent'].includes(t.priority) && (
          <span className={`prio prio-${t.priority}`}>
            <Icon name="flag" size={13} /> {PRIORITY_LABELS[t.priority]}
          </span>
        )}
        <DueLabel date={t.due_date} done={t.status === 'done'} />
        {t.series_id && (
          <span className="meta-icon" title="Repeats">
            <Icon name="repeat" size={13} />
          </span>
        )}
        <span className="spacer" />
        {t.file_count > 0 && (
          <span className="meta-icon" title={`${t.file_count} attachment${t.file_count === 1 ? '' : 's'}`}>
            <Icon name="paperclip" size={13} /> {t.file_count}
          </span>
        )}
        {t.deliverable_count > 0 && (
          <span className="meta-icon" title={`${t.deliverable_count} deliverable${t.deliverable_count === 1 ? '' : 's'}`}>
            <Icon name="file" size={13} /> {t.deliverable_count}
          </span>
        )}
        {t.comment_count > 0 && (
          <span className="meta-icon" title={`${t.comment_count} comment${t.comment_count === 1 ? '' : 's'}`}>
            <Icon name="comment" size={13} /> {t.comment_count}
          </span>
        )}
        {t.status === 'done' && (
          <span className="done-mark" title="Done">
            <Icon name="check" size={13} /> Done
          </span>
        )}
      </footer>
      {t.needs_me && (
        <button type="button" className="btn btn-sm review-btn" onClick={(e) => (e.stopPropagation(), onOpen(t))}>
          {t.blocked_kind === 'approval' || t.status === 'waiting_approval' ? 'Review & approve' : 'Review'}
        </button>
      )}
    </article>
  );
}

// ---------------------------------------------------------------- board and list

function Board({ data, showProject, onOpen, onMove, onAdd, onMore }) {
  const [over, setOver] = useState(null);
  return (
    <div className="work-board">
      {STAGES.map((col) => {
        const items = data.tasks.filter((t) => t.stage === col.id);
        const count = data.counts[col.id] ?? items.length;
        return (
          <section
            key={col.id}
            className={`work-col col-${col.id} ${over === col.id ? 'drop' : ''}`}
            aria-label={`${col.label}, ${count} task${count === 1 ? '' : 's'}`}
            onDragOver={(e) => (e.preventDefault(), setOver(col.id))}
            onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget) && setOver(null)}
            onDrop={(e) => {
              setOver(null);
              const t = data.tasks.find((x) => x.id === Number(e.dataTransfer.getData('text/task')));
              if (t && t.stage !== col.id) onMove(t, col.id);
            }}
          >
            <header className="work-col-head">
              <h2>{col.label}</h2>
              <span className="count">{count}</span>
              <span className="spacer" />
              {col.id !== 'done' && (
                <button type="button" className="icon-btn sm" aria-label={`New task in ${col.label}`} title={`New task in ${col.label}`} onClick={() => onAdd(col.id)}>
                  <Icon name="plus" size={15} />
                </button>
              )}
            </header>
            <div className="work-col-body">
              {items.map((t) => (
                <TaskCard key={t.id} task={t} showProject={showProject} onOpen={onOpen} onMove={onMove} />
              ))}
              {items.length === 0 && <p className="col-empty">No tasks</p>}
              {col.id === 'done' && data.done_total > data.done_loaded && (
                <button type="button" className="btn btn-sm btn-ghost more-done" onClick={onMore}>
                  Showing the latest {data.done_loaded} of {data.done_total}. Show older
                </button>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function List({ data, showProject, onOpen, onMore }) {
  const order = Object.fromEntries(STAGES.map((s, i) => [s.id, i]));
  const rows = [...data.tasks].sort((a, b) => order[a.stage] - order[b.stage]);
  return (
    <div className="work-list-wrap">
      <table className="work-list">
        <thead>
          <tr>
            <th scope="col">Title</th>
            {showProject && <th scope="col">Project</th>}
            <th scope="col">Assignee</th>
            <th scope="col">Status</th>
            <th scope="col">Priority</th>
            <th scope="col">Due</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} onClick={() => onOpen(t)}>
              <td>
                <button type="button" className="link-btn" onClick={(e) => (e.stopPropagation(), onOpen(t))}>
                  {t.title}
                </button>
              </td>
              {showProject && (
                <td>
                  {t.project_name ? (
                    <span className="project-label">
                      <span className="project-dot" style={{ background: t.project_color }} aria-hidden="true" />
                      {t.project_name}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              )}
              <td>
                <AssigneeChip assignee={t.assignee} size={20} />
              </td>
              <td>
                <span className={`stage-pill stage-${t.stage}`}>{stageLabel(t.stage)}</span>
                {t.blocker && <span className={`blocker-badge kind-${t.blocker.kind}`}>{BLOCKERS[t.blocker.kind].short}</span>}
              </td>
              <td>{PRIORITY_LABELS[t.priority]}</td>
              <td>{t.due_date ? <DueLabel date={t.due_date} done={t.status === 'done'} /> : <span className="muted">—</span>}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={showProject ? 6 : 5} className="muted empty-row">
                No tasks match.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {data.done_total > data.done_loaded && (
        <button type="button" className="btn btn-sm btn-ghost more-done" onClick={onMore}>
          Showing the latest {data.done_loaded} of {data.done_total} done tasks. Show older
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the whole view

/**
 * Filters + attention + Board/List for a scope: { mine } (My tasks), { projectId }, or {} (All tasks).
 * `prefKey` keeps the view mode and filters per page in this browser.
 */
export default function WorkView({ scope, prefKey, header, showAttention = true, forceView }) {
  const { openComposer, openTask } = useTaskUI();
  const [viewPref, setView] = usePref(`${prefKey}:view`, 'board');
  const view = forceView ?? viewPref;
  const [filters, setFiltersRaw] = usePref(`${prefKey}:filters`, EMPTY_FILTERS);
  const [doneLimit, setDoneLimit] = useState(20);
  const [error, setError] = useState('');
  const { data, setData, reload } = useBoard(scope, filters, doneLimit);
  const { data: projects } = useApi(scope.projectId ? null : '/projects', ['project']);
  const assigneesPeople = useApi('/people', ['user']).data;
  const assigneesAgents = useApi('/agents', ['agent']).data;
  const assignees = useMemo(
    () => ({
      people: (assigneesPeople ?? []).map((p) => ({ ref: `user:${p.email}`, name: p.name || p.email })),
      agents: (assigneesAgents ?? []).map((a) => ({ ref: `agent:${a.id}`, name: a.name })),
    }),
    [assigneesPeople, assigneesAgents],
  );
  const set = (patch) => setFiltersRaw((f) => ({ ...EMPTY_FILTERS, ...f, ...patch }));
  const f = { ...EMPTY_FILTERS, ...filters };

  /** Change a card's stage: optimistic, rolled back with a message if it fails. Starts nothing. */
  const move = async (task, stage) => {
    setError('');
    const before = data;
    setData((d) => d && { ...d, tasks: d.tasks.map((x) => (x.id === task.id ? { ...x, stage, status: stage } : x)) });
    try {
      await api(`/tasks/${task.id}`, { method: 'PATCH', body: { status: stage } });
      reload();
    } catch (err) {
      setData(before);
      setError(`Couldn't move “${task.title}”: ${err.message}`);
    }
  };

  return (
    <div className="work-view">
      {header?.({ view, setView })}
      {showAttention && <AttentionStrip projectId={scope.projectId} value={f.attention} onPick={(v) => set({ attention: v })} />}
      <div className="work-toolbar">
        <Filters filters={f} set={set} scope={scope} projects={projects} assignees={assignees} />
        {!forceView && (
        <div className="segmented view-toggle" role="radiogroup" aria-label="View">
          <button type="button" role="radio" aria-checked={view === 'board'} className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>
            <Icon name="board" size={15} /> Board
          </button>
          <button type="button" role="radio" aria-checked={view === 'list'} className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>
            <Icon name="list" size={15} /> List
          </button>
        </div>
        )}
      </div>
      {f.attention && (
        <div className="filter-note">
          Showing: <strong>{{ review_mine: 'awaiting your review', blocked: 'blocked', overdue: 'overdue' }[f.attention]}</strong>
          <button type="button" className="link-btn" onClick={() => set({ attention: '' })}>
            Show all
          </button>
        </div>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {!data ? (
        <Loading />
      ) : view === 'list' ? (
        <List data={data} showProject={!scope.projectId} onOpen={openTask} onMore={() => setDoneLimit((n) => n + 50)} />
      ) : (
        <Board
          data={data}
          showProject={!scope.projectId}
          onOpen={openTask}
          onMove={move}
          onAdd={(stage) => openComposer({ status: stage, ...(scope.projectId ? { project_id: scope.projectId } : {}) })}
          onMore={() => setDoneLimit((n) => n + 50)}
        />
      )}
    </div>
  );
}
