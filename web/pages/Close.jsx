import { useState } from 'react';
import { api, useApi } from '../api.js';
import { Avatar, Badge, Empty, Field, Icon, Loading, Modal, PageHeader, statusLabel } from '../components/ui.jsx';
import { useTaskUI } from '../components/work.jsx';

const TONE = { before: 'neutral', not_started: 'neutral', backlog: 'neutral', ready: 'neutral', scheduled: 'neutral', in_progress: 'blue', review: 'amber', waiting_approval: 'amber', blocked: 'red', done: 'green' };
const label = (s) => (s === 'not_started' ? 'Not started' : s === 'before' ? 'Before Hive' : s === 'blocked' ? 'Blocked' : statusLabel(s));
const shortMonth = (p) => new Date(`${p}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
const fmtDue = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function ItemForm({ item, agents, onClose }) {
  const [v, setV] = useState({ entity: '', name: '', agent_id: '', instructions: 'Do the … for {month}. Stop at the dry run and show me the totals before posting anything.', files_hint: '', due_day: 10, ...item });
  const [error, setError] = useState('');
  const set = (k) => (e) => setV((x) => ({ ...x, [k]: e.target.value }));
  const save = async (e) => {
    e.preventDefault();
    const body = { entity: v.entity, name: v.name, agent_id: v.agent_id ? Number(v.agent_id) : null, instructions: v.instructions, files_hint: v.files_hint, due_day: Number(v.due_day) };
    try {
      await api(item ? `/close/items/${item.id}` : '/close/items', { method: item ? 'PATCH' : 'POST', body });
      onClose();
    } catch (err) {
      setError(err.message);
    }
  };
  const remove = async () => {
    if (!confirm(`Remove "${item.name}" from the close? Past tasks stay.`)) return;
    await api(`/close/items/${item.id}`, { method: 'DELETE' });
    onClose();
  };
  return (
    <Modal title={item ? `Edit ${item.name}` : 'Add a month-end job'} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <div className="grid-2">
          <Field label="Company">
            <input value={v.entity} onChange={set('entity')} required placeholder="UAE, Lebanon, Cyprus…" list="close-entities" />
          </Field>
          <Field label="Job">
            <input value={v.name} onChange={set('name')} required placeholder="e.g. Deliveroo" />
          </Field>
          <Field label="Agent">
            <select value={v.agent_id ?? ''} onChange={set('agent_id')}>
              <option value="">Unassigned</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Due" hint="Day of the following month.">
            <input type="number" min="1" max="31" value={v.due_day} onChange={set('due_day')} />
          </Field>
        </div>
        <Field label="Instructions" hint="{month} becomes the month, e.g. August 2026.">
          <textarea rows={3} value={v.instructions} onChange={set('instructions')} />
        </Field>
        <Field label="Files to attach" hint="Shown when you start the job, so you know what to upload.">
          <input value={v.files_hint} onChange={set('files_hint')} />
        </Field>
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          {item && (
            <button type="button" className="btn btn-danger-ghost" onClick={remove}>
              Remove
            </button>
          )}
          <span className="spacer" />
          <button className="btn btn-primary">{item ? 'Save' : 'Add job'}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function Close() {
  const { data } = useApi('/close?months=6', ['task', 'agent']);
  const { data: agents } = useApi('/agents', ['agent']);
  const { data: tasks } = useApi('/tasks', ['task']);
  const [period, setPeriod] = useState(null);
  const { openComposer, openTask } = useTaskUI();
  const [editing, setEditing] = useState(null); // item, or {} for new
  const [editMode, setEditMode] = useState(false);

  if (!data || !agents) return <Loading />;
  const p = period ?? data.closing;
  const prog = data.progress[p];
  const pct = prog.total ? Math.round((prog.done / prog.total) * 100) : 0;
  const entities = [...new Set(data.items.map((i) => i.entity))];

  const start = async (item) => {
    const d = await api(`/close/items/${item.id}/draft/${p}`);
    openComposer({ ...d, assignee: d.agent_id ? `agent:${d.agent_id}` : null });
  };
  const open = (taskId) => openTask(taskId);

  return (
    <>
      <PageHeader title="Month-end close" subtitle="Every company's recurring month-end jobs, and where each month stands.">
        <button className={`btn ${editMode ? 'btn-primary' : ''}`} onClick={() => setEditMode((x) => !x)}>
          <Icon name="edit" size={16} /> {editMode ? 'Done editing' : 'Edit jobs'}
        </button>
      </PageHeader>

      <div className="chips close-months" role="tablist" aria-label="Month">
        {data.periods.map((x) => (
          <button key={x} role="tab" aria-selected={x === p} className={`chip ${x === p ? 'on' : ''}`} onClick={() => setPeriod(x)}>
            {data.labels[x]}
            {x === data.closing && ' · closing'}
            <span className="close-chip-count">
              {data.progress[x].done}/{data.progress[x].total}
            </span>
          </button>
        ))}
      </div>

      <section className="card close-summary">
        <div className="close-summary-top">
          <h2>{data.labels[p]}</h2>
          <span className="muted">
            {prog.done} of {prog.total} done
          </span>
        </div>
        <div className="setup-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${pct}%`, background: pct === 100 ? 'var(--green)' : undefined }} />
        </div>
      </section>

      {data.items.length === 0 ? (
        <Empty title="No month-end jobs yet">
          <button className="btn btn-primary" onClick={() => setEditing({})}>
            Add the first job
          </button>
        </Empty>
      ) : (
        entities.map((entity) => (
          <section key={entity} className="card close-group">
            <header className="card-head">
              <h2>{entity}</h2>
              <span className="muted small">
                {data.items.filter((i) => i.entity === entity && data.cells[i.id][p].status === 'done').length} of {data.items.filter((i) => i.entity === entity).length} done
              </span>
            </header>
            <ul className="list">
              {data.items
                .filter((i) => i.entity === entity)
                .map((item) => {
                  const cell = data.cells[item.id][p];
                  return (
                    <li key={item.id} className="close-row">
                      {item.agent_name ? <Avatar name={item.agent_name} color={item.agent_color} size={30} /> : <span className="close-noagent" />}
                      <div className="grow">
                        <div className="row-title">{item.name}</div>
                        <div className="row-sub">
                          {item.agent_name ?? 'No agent'} · due {fmtDue(cell.due)}
                        </div>
                      </div>
                      <div className="close-history" aria-label="Last months">
                        {data.periods.map((x) => {
                          const c = data.cells[item.id][x];
                          return (
                            <button
                              key={x}
                              className={`close-dot s-${c.status} ${c.overdue ? 'overdue' : ''} ${x === p ? 'current' : ''}`}
                              title={`${data.labels[x]}: ${label(c.status)}${c.overdue ? ' (overdue)' : ''}`}
                              onClick={() => setPeriod(x)}
                            >
                              {shortMonth(x)[0]}
                            </button>
                          );
                        })}
                      </div>
                      <Badge tone={cell.overdue && cell.status === 'not_started' ? 'red' : TONE[cell.status]}>
                        {cell.overdue && cell.status === 'not_started' ? 'Overdue' : label(cell.status)}
                      </Badge>
                      {editMode ? (
                        <button className="btn btn-sm" onClick={() => setEditing(item)}>
                          Edit
                        </button>
                      ) : cell.task_id ? (
                        <button className="btn btn-sm" onClick={() => open(cell.task_id)}>
                          Open
                        </button>
                      ) : (
                        <button className="btn btn-sm btn-primary" onClick={() => start(item)} disabled={!item.agent_id}>
                          <Icon name="play" size={13} /> Start
                        </button>
                      )}
                    </li>
                  );
                })}
            </ul>
          </section>
        ))
      )}
      {editMode && (
        <button className="btn" onClick={() => setEditing({})}>
          <Icon name="plus" size={16} /> Add a job
        </button>
      )}

      <datalist id="close-entities">
        {entities.map((e) => (
          <option key={e} value={e} />
        ))}
      </datalist>
      {editing && <ItemForm item={editing.id ? editing : null} agents={agents} onClose={() => setEditing(null)} />}
    </>
  );
}
