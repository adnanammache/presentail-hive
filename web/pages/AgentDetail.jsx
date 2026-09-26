import { useState } from 'react';
import { ago, api, useApi } from '../api.js';
import { Avatar, Badge, Empty, Icon, Loading, PLATFORM_LABELS, agentTone } from '../components/ui.jsx';
import { AgentForm, WorkflowForm } from '../components/forms.jsx';
import { useTaskUI } from '../components/work.jsx';
import Chat from '../components/Chat.jsx';
import Capabilities from '../components/Capabilities.jsx';
import { TaskCard } from '../components/TaskViews.jsx';
import { WorkflowList } from './Workflows.jsx';
import Markdown from '../components/Markdown.jsx';

function Connect({ agent, onRotate }) {
  const [show, setShow] = useState(false);
  const base = `${location.origin}/api/agent`;
  const token = show ? agent.api_token : agent.api_token.slice(0, 8) + '•'.repeat(24);
  const auth = `-H "Authorization: Bearer ${agent.api_token}"`;
  const examples = [
    ['Fetch my open tasks', `curl ${base}/tasks ${auth}`],
    ['Report progress on a task', `curl -X PATCH ${base}/tasks/TASK_ID ${auth} \\\n  -H "Content-Type: application/json" \\\n  -d '{"status":"done","result":"Posted 6 invoices, total AED 18,420"}'`],
    ['Send a chat message', `curl -X POST ${base}/messages ${auth} \\\n  -H "Content-Type: application/json" -d '{"body":"Month-end finished ✅"}'`],
    ['Read new messages (poll)', `curl "${base}/messages?since_id=0" ${auth}`],
    ['Heartbeat / set status', `curl -X POST ${base}/heartbeat ${auth} \\\n  -H "Content-Type: application/json" -d '{"status":"active"}'`],
  ];
  return (
    <div className="connect">
      <section className="card">
        <h3>API token</h3>
        <p className="muted small">The agent uses this token to talk back to Presentail Hive. Keep it secret.</p>
        <div className="token-row">
          <code className="token">{token}</code>
          <button className="btn btn-sm" onClick={() => setShow((s) => !s)}>
            {show ? 'Hide' : 'Reveal'}
          </button>
          <button className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(agent.api_token)}>
            Copy
          </button>
          <button className="btn btn-sm btn-danger-ghost" onClick={() => confirm('Rotate the token? The old one stops working immediately.') && onRotate()}>
            Rotate
          </button>
        </div>
      </section>
      <section className="card">
        <h3>How messages reach {agent.name}</h3>
        {agent.platform === 'claude' ? (
          <p>Claude agent — every message and task is answered directly through the Anthropic API using the system prompt and model on this agent.</p>
        ) : agent.webhook_url ? (
          <>
            <p>
              Each message, task and workflow run is POSTed to <code>{agent.webhook_url}</code>. Respond with <code>{'{"reply": "…"}'}</code> to answer in the chat, or call the API below later.
            </p>
            <pre className="code">{`{
  "event": "message" | "task.assigned" | "workflow.run",
  "message": { "id": 12, "body": "…" },           // for "message"
  "task": { "id": 7, "title": "…", "description": "…" }, // for tasks & runs
  "run_id": 3,                                        // for "workflow.run"
  "agent": { "id": ${agent.id}, "name": "${agent.name}" },
  "callback": { "api": "${base}" }
}`}</pre>
          </>
        ) : (
          <p>No webhook set — {agent.name} should poll the API below for new tasks and messages. Add a webhook in Settings to push work to it instead.</p>
        )}
      </section>
      <section className="card">
        <h3>Agent API</h3>
        {examples.map(([label, cmd]) => (
          <div key={label} className="example">
            <div className="small strong">{label}</div>
            <pre className="code">{cmd}</pre>
          </div>
        ))}
      </section>
    </div>
  );
}

const SOURCE = { manual: 'Added here', rejection: 'From a rejection', slack: 'From Slack', task: 'From a task' };

/** What this agent has learned from corrections; all of it goes into its instructions. */
function Lessons({ agent }) {
  const { data, reload } = useApi(`/agents/${agent.id}/lessons`, ['lesson']);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const add = async (e) => {
    e.preventDefault();
    try {
      await api(`/agents/${agent.id}/lessons`, { method: 'POST', body: { text } });
      setText('');
      setError('');
      reload();
    } catch (err) {
      setError(err.message);
    }
  };
  const edit = async (l) => {
    const next = prompt('Edit the lesson', l.text);
    if (next != null && next.trim() && next !== l.text) await api(`/lessons/${l.id}`, { method: 'PATCH', body: { text: next } });
    reload();
  };
  if (!data) return <Loading />;
  return (
    <>
      <form className="lesson-add" onSubmit={add}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Teach ${agent.name} something, e.g. "Abu Dhabi fees always go to account 5104"`} aria-label="New lesson" />
        <button className="btn btn-primary" disabled={!text.trim()}>
          Teach
        </button>
      </form>
      {error && <div className="form-error">{error}</div>}
      <p className="muted small">
        {agent.name} follows these on every task and chat. Lessons are also saved when you reject something with a reason, or DM {agent.name} in Slack starting with “remember:”
      </p>
      {data.length === 0 ? (
        <Empty title="Nothing learned yet" />
      ) : (
        <ul className="lesson-list">
          {data.map((l) => (
            <li key={l.id} className={l.active ? '' : 'off'}>
              <div className="grow">
                <div>{l.text}</div>
                <div className="muted small">
                  {SOURCE[l.source] ?? l.source}
                  {l.created_by && ` by ${l.created_by}`}
                  {l.task_title && (
                    <>
                      {' · '}
                      <a href={`#/tasks/${l.task_id}`}>{l.task_title}</a>
                    </>
                  )}
                  {' · '}
                  {ago(l.created_at)}
                </div>
              </div>
              <button className="btn btn-sm" onClick={() => edit(l)}>
                Edit
              </button>
              <button className="btn btn-sm" onClick={() => api(`/lessons/${l.id}`, { method: 'PATCH', body: { active: !l.active } }).then(reload)}>
                {l.active ? 'Pause' : 'Use again'}
              </button>
              <button className="icon-btn" aria-label="Delete lesson" onClick={() => confirm('Delete this lesson?') && api(`/lessons/${l.id}`, { method: 'DELETE' }).then(reload)}>
                <Icon name="trash" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Messages between this agent and other agents (the message_agent tool). */
function Colleagues({ agent }) {
  const { data } = useApi(`/agents/${agent.id}/dms`, ['agent_dm']);
  if (!data) return <Loading />;
  if (!data.length)
    return (
      <Empty title="No messages with colleagues yet">
        When {agent.name} asks another agent something (or is asked), the conversation shows here and in Slack.
      </Empty>
    );
  return (
    <ul className="dm-list">
      {data.map((d) => (
        <li key={d.id} className="dm">
          <div className="dm-q">
            <b>{d.from_name}</b> → <b>{d.to_name}</b>
            <span className="muted small"> · {ago(d.created_at)}</span>
            <Markdown text={d.message} />
          </div>
          <div className={`dm-a ${d.status}`}>
            <b>{d.to_name}</b>
            {d.status === 'asked' ? <p className="muted">Thinking…</p> : <Markdown text={d.reply} className={d.status === 'failed' ? 'text-red' : ''} />}
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function AgentDetail({ id, meta }) {
  const { data: agent, setData } = useApi(`/agents/${id}`, ['agent']);
  const { data: tasks } = useApi(`/tasks?agent_id=${id}`, ['task']);
  const { data: allWorkflows } = useApi('/workflows', ['workflow']);
  const [tab, setTab] = useState('chat');
  const [modal, setModal] = useState(null);
  const { openComposer, openTask } = useTaskUI();

  if (!agent) return <Loading />;
  const workflows = allWorkflows?.filter((w) => w.agent_id === agent.id) ?? [];
  const openTasks = tasks?.filter((t) => t.status !== 'done') ?? [];
  const doneTasks = tasks?.filter((t) => t.status === 'done') ?? [];

  const remove = async () => {
    if (!confirm(`Delete ${agent.name}? Its chat history goes with it; tasks become unassigned.`)) return;
    await api(`/agents/${agent.id}`, { method: 'DELETE' });
    location.hash = '#/agents';
  };
  const togglePause = () => api(`/agents/${agent.id}`, { method: 'PATCH', body: { status: agent.status === 'paused' ? 'idle' : 'paused' } }).then(setData);

  const tabs = [
    ['chat', 'Chat'],
    ['skills', 'Skills & tools'],
    ['tasks', `Tasks (${openTasks.length})`],
    ['workflows', `Workflows (${workflows.length})`],
    ['lessons', 'Lessons'],
    ['colleagues', 'Colleagues'],
    ['connect', 'Connect'],
  ];

  return (
    <div className="agent-detail">
      <header className="agent-hero" style={{ '--c': agent.color }}>
        <a href="#/agents" className="link small">
          ← Agents
        </a>
        <div className="hero-row">
          <Avatar name={agent.name} color={agent.color} size={56} status={agent.status} />
          <div className="grow">
            <h1>{agent.name}</h1>
            <div className="hero-title">
              {agent.title}
              {agent.team_name && (
                <>
                  {' · '}
                  <a href="#/agents" className="team-chip" style={{ '--c': agent.team_color }}>
                    {agent.team_name}
                  </a>
                </>
              )}
            </div>
            <div className="hero-meta">
              <Badge tone={agentTone[agent.status]}>{agent.status}</Badge>
              <span className="pill">{PLATFORM_LABELS[agent.platform]}</span>
              {agent.platform === 'claude' && <span className="pill mono">{agent.model || 'claude-opus-5'}</span>}
              <span className="muted small">last seen {ago(agent.last_seen_at)}</span>
              {(agent.month_cents > 0 || agent.budget_cents != null) && (
                <span className={`muted small ${agent.budget_cents != null && agent.month_cents >= agent.budget_cents ? 'over-budget' : ''}`}>
                  · ${((agent.month_cents || 0) / 100).toFixed(2)}
                  {agent.budget_cents != null && ` of $${(agent.budget_cents / 100).toFixed(2)}`} this month
                </span>
              )}
            </div>
          </div>
          <div className="page-actions">
            <button className="btn" onClick={togglePause}>
              {agent.status === 'paused' ? 'Resume' : 'Pause'}
            </button>
            <button className="btn" onClick={() => setModal({ kind: 'agent' })}>
              <Icon name="edit" size={16} /> Settings
            </button>
            <button className="icon-btn" title="Delete agent" onClick={remove}>
              <Icon name="trash" />
            </button>
          </div>
        </div>
        {agent.description && <p className="hero-desc">{agent.description}</p>}
        <nav className="tabs" role="tablist">
          {tabs.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </nav>
      </header>

      {tab === 'chat' && <Chat agent={agent} claudeReady={meta?.claude} />}

      {tab === 'skills' && (
        <div className="tab-body">
          <Capabilities agent={agent} onSaved={setData} />
        </div>
      )}

      {tab === 'tasks' && (
        <div className="tab-body">
          <div className="tab-actions">
            <button className="btn btn-primary" onClick={() => openComposer({ assignee: `agent:${agent.id}` })}>
              <Icon name="plus" size={16} /> Assign task
            </button>
          </div>
          {openTasks.length === 0 && <Empty title="No open tasks" />}
          <div className="task-list">
            {openTasks.map((t) => (
              <TaskCard key={t.id} task={t} onOpen={(task) => openTask(task.id)} draggable={false} />
            ))}
          </div>
          {doneTasks.length > 0 && (
            <>
              <h3 className="section-title">Completed</h3>
              <div className="task-list faded">
                {doneTasks.slice(0, 20).map((t) => (
                  <TaskCard key={t.id} task={t} onOpen={(task) => openTask(task.id)} draggable={false} />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'workflows' && (
        <div className="tab-body">
          <div className="tab-actions">
            <button className="btn btn-primary" onClick={() => setModal({ kind: 'workflow', defaults: { agent_id: agent.id } })}>
              <Icon name="plus" size={16} /> New workflow
            </button>
          </div>
          {workflows.length === 0 ? (
            <Empty title="No recurring workflows" />
          ) : (
            <WorkflowList workflows={workflows} onEdit={(w) => setModal({ kind: 'workflow', workflow: w })} onRuns={() => (location.hash = '#/workflows')} />
          )}
        </div>
      )}

      {tab === 'lessons' && (
        <div className="tab-body">
          <Lessons agent={agent} />
        </div>
      )}

      {tab === 'colleagues' && (
        <div className="tab-body">
          <Colleagues agent={agent} />
        </div>
      )}

      {tab === 'connect' && (
        <div className="tab-body">
          <Connect agent={agent} onRotate={() => api(`/agents/${agent.id}/rotate-token`, { method: 'POST' }).then(setData)} />
        </div>
      )}

      {modal?.kind === 'agent' && <AgentForm agent={agent} onClose={() => setModal(null)} onSaved={setData} />}
      {modal?.kind === 'workflow' && <WorkflowForm workflow={modal.workflow} defaults={modal.defaults} onClose={() => setModal(null)} />}
    </div>
  );
}
