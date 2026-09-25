import { useState } from 'react';
import { ago, api, toDate, useApi } from '../api.js';
import { Avatar, Badge, Icon, Loading, PageHeader, TASK_COLUMNS, priorityTone } from '../components/ui.jsx';
import { TaskForm } from '../components/forms.jsx';

export function TaskCard({ task, onOpen, draggable }) {
  const overdue = task.due_date && task.status !== 'done' && toDate(task.due_date + ' 23:59:59') < new Date();
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
        {task.workflow_name && (
          <span className="muted small" title={`From workflow ${task.workflow_name}`}>
            <Icon name="repeat" size={13} />
          </span>
        )}
        <span className="spacer" />
        {task.due_date ? <span className={`small ${overdue ? 'text-red' : 'muted'}`}>due {task.due_date.slice(5)}</span> : <span className="muted small">{ago(task.updated_at)}</span>}
      </footer>
    </article>
  );
}

export default function Tasks() {
  const [agentFilter, setAgentFilter] = useState('');
  const { data: tasks, setData } = useApi(`/tasks${agentFilter ? `?agent_id=${agentFilter}` : ''}`, ['task']);
  const { data: agents } = useApi('/agents', ['agent']);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(null);
  const [over, setOver] = useState(null);

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
        <button className="btn btn-primary" onClick={() => setCreating({ agent_id: agentFilter })}>
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
      {editing && <TaskForm task={editing} onClose={() => setEditing(null)} />}
      {creating && <TaskForm defaults={creating} onClose={() => setCreating(null)} />}
    </>
  );
}
