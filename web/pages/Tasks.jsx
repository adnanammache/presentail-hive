import { useEffect, useState } from 'react';
import { ago, api, dubaiToday, fmtDay, useApi } from '../api.js';
import { Avatar, Badge, Icon, Loading, PageHeader, TASK_COLUMNS, priorityTone } from '../components/ui.jsx';
import { TaskForm } from '../components/forms.jsx';

/** "Presentail SAL (Lebanon)" → "Lebanon", "… – Dubai" → "Dubai": short enough for a card. */
const entityShort = (name) => (/Dubai \+ Abu Dhabi/.test(name) ? 'UAE' : /\(([^)]+)\)\s*$/.exec(name)?.[1] ?? name.split(/\s[–-]\s/).pop());

export function TaskCard({ task, onOpen, draggable }) {
  const overdue = task.due_date && task.status !== 'done' && task.due_date < dubaiToday();
  return (
    <article
      className="task-card"
      draggable={draggable}
      onDragStart={(e) => e.dataTransfer.setData('text/task', String(task.id))}
      onClick={() => onOpen(task)}
    >
      <div className="task-title">{task.title}</div>
      {task.result && <div className="task-result clamp">{task.result}</div>}
      <footer className="task-meta">
        {task.agent_name ? <Avatar name={task.agent_name} color={task.agent_color} size={20} /> : <span className="muted small">Unassigned</span>}
        <Badge tone={priorityTone[task.priority]}>{task.priority}</Badge>
        {task.series_id && (
          <span className="muted small" title="Repeats">
            <Icon name="repeat" size={13} />
          </span>
        )}
        {task.entity_name && (
          <span className="entity-tag" title={task.entity_name}>
            {entityShort(task.entity_name)}
          </span>
        )}
        {task.workflow_name && (
          <span className="muted small" title={`From workflow ${task.workflow_name}`}>
            <Icon name="repeat" size={13} />
          </span>
        )}
        <span className="spacer" />
        {task.status === 'scheduled' && task.start_on ? (
          <span className="muted small">starts {fmtDay(task.start_on)}</span>
        ) : task.due_date ? (
          <span className={`small ${overdue ? 'text-red' : 'muted'}`}>due {fmtDay(task.due_date)}</span>
        ) : (
          <span className="muted small">{ago(task.updated_at)}</span>
        )}
      </footer>
    </article>
  );
}

export default function Tasks({ openId }) {
  const [agentFilter, setAgentFilter] = useState('');
  const [entityFilter, setEntityFilter] = useState('');
  const query = new URLSearchParams({ ...(agentFilter ? { agent_id: agentFilter } : {}), ...(entityFilter ? { entity_id: entityFilter } : {}) }).toString();
  const { data: tasks, setData } = useApi(`/tasks${query ? `?${query}` : ''}`, ['task']);
  const { data: agents } = useApi('/agents', ['agent']);
  const { data: entities } = useApi('/entities', ['entity']);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(null);
  const [over, setOver] = useState(null);

  // Deep links (#/tasks/42), e.g. from a Slack alert, open that task.
  useEffect(() => {
    if (!openId || !tasks) return;
    const t = tasks.find((x) => x.id === Number(openId));
    if (t) setEditing(t);
  }, [openId, tasks === null]);
  const closeTask = () => {
    setEditing(null);
    if (openId) history.replaceState(null, '', '#/tasks');
  };

  const move = async (id, status) => {
    setData((ts) => ts.map((t) => (t.id === id ? { ...t, status } : t)));
    await api(`/tasks/${id}`, { method: 'PATCH', body: { status } });
  };

  return (
    <>
      <PageHeader title="Tasks" subtitle="Drag cards between columns. Agents move their own cards through the Agent API.">
        <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} aria-label="Filter by agent">
          <option value="">All agents</option>
          {agents?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)} aria-label="Filter by entity">
          <option value="">All entities</option>
          {entities?.map((en) => (
            <option key={en.id} value={en.id}>
              {en.name}
            </option>
          ))}
          <option value="none">Not entity-specific</option>
        </select>
        <button className="btn btn-primary" onClick={() => setCreating({ agent_id: agentFilter, ...(entityFilter && entityFilter !== 'none' ? { entity_id: entityFilter } : {}) })}>
          <Icon name="plus" size={16} /> New task
        </button>
      </PageHeader>
      {!tasks ? (
        <Loading />
      ) : (
        <div className="board">
          {TASK_COLUMNS.map((col) => {
            const items = tasks.filter((t) => t.status === col.id);
            return (
              <section
                key={col.id}
                className={`column col-${col.id} ${over === col.id ? 'drop' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOver(col.id);
                }}
                onDragLeave={() => setOver(null)}
                onDrop={(e) => {
                  setOver(null);
                  const id = Number(e.dataTransfer.getData('text/task'));
                  if (id) move(id, col.id);
                }}
              >
                <header className="column-head">
                  <span>{col.label}</span>
                  <span className="count">{items.length}</span>
                  <button className="icon-btn sm" title={`Add to ${col.label}`} onClick={() => setCreating({ status: col.id, agent_id: agentFilter })}>
                    <Icon name="plus" size={14} />
                  </button>
                </header>
                <div className="column-body">
                  {items.map((t) => (
                    <TaskCard key={t.id} task={t} onOpen={setEditing} draggable />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
      {editing && <TaskForm task={editing} onClose={closeTask} />}
      {creating && <TaskForm defaults={creating} onClose={() => setCreating(null)} />}
    </>
  );
}
