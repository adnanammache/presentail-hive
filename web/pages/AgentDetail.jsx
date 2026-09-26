// The agent workspace: a compact header with the agent's real status, tabs (Chat, Tasks, Knowledge,
// Tools & access, Activity), and the Work overview next to the chat. Routes:
//   #/agents/:id                   chat, last conversation opened here
//   #/agents/:id/chat/:chatId      a conversation
//   #/agents/:id/:tab              tasks | knowledge | tools | activity
// Older tab names still work: skills, connect → tools; lessons → knowledge; workflows → tasks;
// colleagues → chat with About open. #/agents/:id/tasks/recurring opens the recurring tasks.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ago, api, fmtDateTime, toDate, useApi } from '../api.js';
import { Avatar, Badge, Empty, Icon, Loading, PLATFORM_LABELS, runTone } from '../components/ui.jsx';
import { AgentForm } from '../components/forms.jsx';
import { usePref, useTaskUI } from '../components/work.jsx';
import Chat from '../components/Chat.jsx';
import Capabilities from '../components/Capabilities.jsx';
import WorkOverview from '../components/WorkOverview.jsx';
import { TaskCard } from '../components/TaskViews.jsx';
import { RecurringSection } from '../components/Recurring.jsx';
import Markdown from '../components/Markdown.jsx';

const TABS = [
  ['chat', 'Chat'],
  ['tasks', 'Tasks'],
  ['knowledge', 'Knowledge'],
  ['tools', 'Tools & access'],
  ['activity', 'Activity'],
];
const ALIASES = { skills: 'tools', connect: 'tools', lessons: 'knowledge', workflows: 'tasks', colleagues: 'chat' };

/** Wide enough for chat and the Work overview side by side. */
function useWide(query = '(min-width: 1280px)') {
  const [wide, setWide] = useState(() => (typeof matchMedia === 'undefined' ? true : matchMedia(query).matches));
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return wide;
}

// ---------------------------------------------------------------- Tools & access: the Agent API

function Connect({ agent, onRotate }) {
  const [show, setShow] = useState(false);
  const base = `${location.origin}/api/agent`;
  if (!agent.api_token)
    return (
      <section className="card">
        <h3>Agent API</h3>
        <p className="muted small">Only workspace owners can see {agent.name}'s API token and connection details.</p>
      </section>
    );
  const token = show ? agent.api_token : agent.api_token.slice(0, 8) + '•'.repeat(24);
  const auth = `-H "Authorization: Bearer ${agent.api_token}"`;
  const examples = [
    ['Fetch my open tasks', `curl ${base}/tasks ${auth}`],
    ['Report progress on a task', `curl -X PATCH ${base}/tasks/TASK_ID ${auth} \\\n  -H "Content-Type: application/json" \\\n  -d '{"status":"done","result":"Posted 6 invoices, total AED 18,420"}'`],
    ['Reply in a conversation', `curl -X POST ${base}/messages ${auth} \\\n  -H "Content-Type: application/json" -d '{"chat_id":CHAT_ID,"body":"Month-end finished ✅"}'`],
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
          <p>Claude agent: every message and task is answered directly through the Anthropic API using the system prompt and model on this agent.</p>
        ) : agent.platform === 'managed' ? (
          <p>Claude Managed Agent: each conversation and task runs in its own session on Claude Managed Agents, with the skills and systems chosen above.</p>
        ) : agent.webhook_url ? (
          <>
            <p>
              Each message, task and workflow run is POSTed to <code>{agent.webhook_url}</code>. Respond with <code>{'{"reply": "…"}'}</code> to answer in the conversation, or call the API below later.
            </p>
            <pre className="code">{`{
  "event": "message" | "task.assigned" | "workflow.run",
  "message": { "id": 12, "chat_id": 3, "body": "…" },   // for "message"
  "task": { "id": 7, "title": "…", "description": "…" }, // for tasks & runs
  "run_id": 3,                                           // for "workflow.run"
  "agent": { "id": ${agent.id}, "name": "${agent.name}" },
  "callback": { "api": "${base}" }
}`}</pre>
          </>
        ) : (
          <p>No webhook set: {agent.name} should poll the API below for new tasks and messages. Add a webhook in Settings to push work to it instead.</p>
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

// ---------------------------------------------------------------- Knowledge

const SOURCE = { manual: 'Added here', rejection: 'From a rejection', slack: 'From Slack', task: 'From a task', chat: 'From a conversation', agent: 'Saved by the agent' };

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
    if (next != null && next.trim() && next !== l.text) await api(`/lessons/${l.id}`, { method: 'PATCH', body: { text: next } }).catch((err) => setError(err.message));
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
      {data.length === 0 ? (
        <Empty title="Nothing learned yet">Use “Save as lesson” on a chat message, add one here, or reject a change with a reason.</Empty>
      ) : (
        <ul className="lesson-list">
          {data.map((l) => (
            <li key={l.id} className={l.active ? '' : 'off'}>
              <div className="grow">
                {l.title && <div className="strong">{l.title}</div>}
                <div className="pre-wrap">{l.text}</div>
                <div className="muted small">
                  {!l.active && 'Switched off · '}
                  {SOURCE[l.source] ?? l.source}
                  {l.created_by && ` by ${l.created_by}`}
                  {l.chat_id && (
                    <>
                      {' · '}
                      <a href={`#/agents/${agent.id}/chat/${l.chat_id}`}>open conversation</a>
                    </>
                  )}
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
              <button className="btn btn-sm" onClick={() => api(`/lessons/${l.id}`, { method: 'PATCH', body: { active: !l.active } }).then(reload, (err) => setError(err.message))}>
                {l.active ? 'Switch off' : 'Switch on'}
              </button>
              <button className="icon-btn" aria-label="Delete lesson" onClick={() => confirm('Delete this lesson?') && api(`/lessons/${l.id}`, { method: 'DELETE' }).then(reload, (err) => setError(err.message))}>
                <Icon name="trash" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Knowledge({ agent, onSettings, onTools }) {
  const { data: caps } = useApi('/capabilities');
  let skills = [];
  try {
    skills = JSON.parse(agent.skills || '[]');
  } catch {
    skills = [];
  }
  const library = caps?.skills ?? [];
  return (
    <div className="knowledge">
      <section className="k-section">
        <div className="k-head">
          <div>
            <h3>Instructions</h3>
            <p className="muted small">How {agent.name} is told to work, in every chat and task. Only owners can change them.</p>
          </div>
          <button type="button" className="btn btn-sm" onClick={onSettings}>
            <Icon name="edit" size={14} /> Edit in Settings
          </button>
        </div>
        {agent.system_prompt?.trim() ? <pre className="k-instructions">{agent.system_prompt}</pre> : <p className="muted">No custom instructions. {agent.name} works from its role, description, skills and lessons.</p>}
      </section>
      <section className="k-section">
        <div className="k-head">
          <div>
            <h3>Reference materials</h3>
            <p className="muted small">Skills: playbooks and scripts {agent.name} reads when a task calls for them.</p>
          </div>
          <button type="button" className="btn btn-sm" onClick={onTools}>
            Manage in Tools & access
          </button>
        </div>
        {skills.length === 0 ? (
          <p className="muted">No skills attached.</p>
        ) : (
          <ul className="k-skills">
            {skills.map((k) => {
              const s = library.find((x) => x.key === k);
              return (
                <li key={k}>
                  <Icon name="book" size={15} />
                  <span>
                    <strong>{s?.name ?? k}</strong>
                    {s?.description && <span className="muted small"> · {s.description}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="k-section">
        <div className="k-head">
          <div>
            <h3>Lessons</h3>
            <p className="muted small">What {agent.name} has been taught. Active lessons are part of its instructions and override skills where they differ.</p>
          </div>
        </div>
        <Lessons agent={agent} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- Activity

const RUN_LABEL = { starting: 'Starting', running: 'Running', needs_approval: 'Needs approval', waiting: 'Finished turn', failed: 'Failed', ended: 'Ended' };
const money = (c) => `$${((c || 0) / 100).toFixed(2)}`;

function Activity({ agent }) {
  const { data, error } = useApi(`/agents/${agent.id}/history`, ['run', 'agent']);
  if (error) return <div className="form-error">{error}</div>;
  if (!data) return <Loading />;
  const budget = agent.budget_cents;
  return (
    <div className="activity-tab">
      <section className="usage-cards">
        <div className="usage-card">
          <span className="muted small">Spent this month</span>
          <strong className={budget != null && data.usage.month_cents >= budget ? 'text-red' : ''}>{money(data.usage.month_cents)}</strong>
          {budget != null && <span className="muted small">of {money(budget)} budget</span>}
        </div>
        <div className="usage-card">
          <span className="muted small">Runs this month</span>
          <strong>{data.usage.month_runs}</strong>
        </div>
        <div className="usage-card">
          <span className="muted small">Last month</span>
          <strong>{money(data.usage.last_month_cents)}</strong>
        </div>
      </section>
      <section>
        <h3 className="section-title">Runs</h3>
        {data.runs.length === 0 ? (
          <Empty title="No runs yet" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>What</th>
                  <th>Status</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{fmtDateTime(r.created_at)}</td>
                    <td>
                      {r.kind === 'task' && r.task_id ? (
                        <a href={`#/tasks/${r.task_id}`}>{r.task_title ?? `Task #${r.task_id}`}</a>
                      ) : r.kind === 'chat' && r.chat_id ? (
                        <a href={`#/agents/${agent.id}/chat/${r.chat_id}`}>Conversation: {r.chat_title || 'untitled'}</a>
                      ) : r.kind === 'consult' ? (
                        'Question from a colleague'
                      ) : (
                        r.kind
                      )}
                      {r.error && <div className="text-red small clamp-2">{r.error}</div>}
                    </td>
                    <td>
                      <Badge tone={runTone[r.status] ?? 'neutral'}>{RUN_LABEL[r.status] ?? r.status}</Badge>
                    </td>
                    <td className="num">{r.cost_cents ? money(r.cost_cents) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section>
        <h3 className="section-title">Events</h3>
        {data.log.length === 0 ? (
          <Empty title="Nothing logged yet" />
        ) : (
          <ul className="event-log">
            {data.log.map((l) => (
              <li key={l.id} className={l.kind === 'error' ? 'error' : ''}>
                <time>{ago(l.created_at)}</time>
                <span>{l.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- About

function Colleagues({ agent }) {
  const { data } = useApi(`/agents/${agent.id}/dms`, ['agent_dm']);
  if (!data) return <Loading />;
  if (!data.length) return <p className="muted small">When {agent.name} asks another agent something (or is asked), it shows here and in Slack.</p>;
  return (
    <ul className="dm-list">
      {data.slice(0, 20).map((d) => (
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

function About({ agent, status, onClose }) {
  const panel = useRef(null);
  useEffect(() => {
    panel.current?.focus();
    const esc = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  const rows = [
    ['Role', agent.title],
    ['Team', agent.team_name],
    ['Runs on', PLATFORM_LABELS[agent.platform] ?? agent.platform],
    ['Model', ['claude', 'managed'].includes(agent.platform) ? agent.model || 'Default' : null],
    ['Reviewer', agent.reviewer_name],
    ['Last activity', status?.last_activity_at ? `${ago(status.last_activity_at)} (${fmtDateTime(status.last_activity_at)})` : 'None yet'],
  ].filter(([, v]) => v);
  return (
    <aside className="task-panel about-panel" role="dialog" aria-modal="false" aria-labelledby="about-title" ref={panel} tabIndex={-1}>
      <header className="about-head">
        <h2 id="about-title">About {agent.name}</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="x" />
        </button>
      </header>
      <div className="about-body">
        <div className="about-id">
          <Avatar id={agent.id} name={agent.name} color={agent.color} size={64} />
          <div>
            <div className="strong">{agent.name}</div>
            <div className="muted">{agent.title}</div>
          </div>
        </div>
        {agent.description ? <p className="pre-wrap">{agent.description}</p> : <p className="muted">No description yet.</p>}
        <dl className="about-list">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <h3 className="section-title">Colleagues</h3>
        <Colleagues agent={agent} />
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- header menu

function MoreMenu({ agent, canManage, onPause, onDelete, onAbout }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector('[role=menuitem]')?.focus();
    const away = (e) => !box.current?.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => (document.removeEventListener('mousedown', away), document.removeEventListener('keydown', esc));
  }, [open]);
  const pick = (fn) => () => (setOpen(false), fn());
  return (
    <div className="more-menu" ref={box}>
      <button type="button" className="btn icon-only" aria-haspopup="menu" aria-expanded={open} aria-label="More actions" onClick={() => setOpen((o) => !o)}>
        <Icon name="dots" size={18} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button type="button" role="menuitem" onClick={pick(onAbout)}>
            <Icon name="info" size={15} /> About this agent
          </button>
          {canManage && (
            <>
              <button type="button" role="menuitem" onClick={pick(onPause)}>
                <Icon name={agent.status === 'paused' ? 'play' : 'pause'} size={15} /> {agent.status === 'paused' ? 'Resume agent' : 'Pause agent'}
              </button>
              <div className="menu-sep" />
              <button type="button" role="menuitem" className="danger" onClick={pick(onDelete)}>
                <Icon name="trash" size={15} /> Delete agent
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the page

export default function AgentDetail({ id, meta, tab: routeTab, param }) {
  const { data: agent, setData, error: agentError } = useApi(`/agents/${id}`, ['agent']);
  const { data: me } = useApi('/me');
  const { data: tasks } = useApi(`/tasks?agent_id=${id}`, ['task']);
  const { data: recurring } = useApi(`/workflows?agent_id=${id}`, ['workflow']);
  const [modal, setModal] = useState(null);
  const [about, setAbout] = useState(routeTab === 'colleagues');
  const [actionError, setActionError] = useState('');
  const { openComposer, openTask } = useTaskUI();
  const wide = useWide();
  const [panelPref, setPanelPref] = usePref('workPanel', 'open');
  const [drawer, setDrawer] = useState(false);

  // The old Colleagues link opens About; going to another section closes it.
  useEffect(() => setAbout(routeTab === 'colleagues'), [routeTab, param]);
  const tab = ALIASES[routeTab] ?? (TABS.some(([k]) => k === routeTab) ? routeTab : 'chat');
  const chatParam = tab === 'chat' && routeTab === 'chat' ? param : undefined;
  const selectedChat = chatParam === 'new' ? 'new' : chatParam ? Number(chatParam) : undefined;

  // The conversation the chat is showing (it tells us), for the Work overview.
  const [shownChat, setShownChat] = useState(null);

  const { data: ws, error: wsError, reload: reloadWs } = useApi(`/agents/${id}/workspace${shownChat ? `?chat_id=${shownChat}` : ''}`, ['run', 'task', 'agent', 'workflow', 'chat']);

  const go = useCallback((t, extra) => {
    location.hash = `#/agents/${id}${t === 'chat' && !extra ? '' : `/${t}`}${extra ? `/${extra}` : ''}`;
  }, [id]);
  const selectChat = useCallback((chatId) => (location.hash = `#/agents/${id}/chat/${chatId ?? 'new'}`), [id]);

  if (agentError) return <Empty title="Agent not found">It may have been deleted. <a href="#/agents">Back to Team & agents</a></Empty>;
  if (!agent) return <Loading />;
  const activeRecurring = recurring?.filter((w) => w.status !== 'ended').length ?? 0;
  const taskView = tab === 'tasks' && (param === 'recurring' || routeTab === 'workflows') ? 'recurring' : 'tasks';
  const openTasks = tasks?.filter((t) => t.status !== 'done') ?? [];
  const doneTasks = tasks?.filter((t) => t.status === 'done') ?? [];
  const isOwner = me?.role === 'owner';

  const remove = async () => {
    if (!confirm(`Delete ${agent.name}? Its conversations go with it; tasks become unassigned.`)) return;
    try {
      await api(`/agents/${agent.id}`, { method: 'DELETE' });
      location.hash = '#/agents';
    } catch (err) {
      setActionError(err.message);
    }
  };
  const togglePause = () =>
    api(`/agents/${agent.id}`, { method: 'PATCH', body: { status: agent.status === 'paused' ? 'idle' : 'paused' } }).then(setData, (err) => setActionError(err.message));
  const viewRecurring = () => {
    setDrawer(false);
    go('tasks', 'recurring');
  };

  const status = ws?.status;
  const paused = agent.status === 'paused';
  const isHuman = agent.platform === 'human';
  const panelOpen = tab === 'chat' && wide && panelPref === 'open';
  const overview = (
    <WorkOverview
      agent={agent}
      data={ws}
      error={wsError}
      chatId={shownChat}
      onRetry={reloadWs}
      onViewRecurring={viewRecurring}
      onClose={wide ? () => setPanelPref('closed') : () => setDrawer(false)}
    />
  );

  return (
    <div className={`agent-ws ${panelOpen ? 'with-panel' : ''}`}>
      <div className="agent-main">
        <header className="agent-head">
          <nav className="agent-crumbs" aria-label="Breadcrumb">
            <a href="#/agents">Team & agents</a>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{agent.name}</span>
          </nav>
          <div className="agent-id-row">
            <Avatar id={agent.id} name={agent.name} color={agent.color} size={52} />
            <div className="grow agent-id">
              <div className="agent-name-row">
                <h1>{agent.name}</h1>
                {!isHuman && (
                  <span className="ai-badge">
                    <Icon name="sparkles" size={13} /> AI agent
                  </span>
                )}
                {paused && <Badge tone="amber">Paused</Badge>}
                {status && (
                  <span className={`status-pill tone-${paused ? 'neutral' : status.tone}`} title={status.last_activity_at ? `Last activity ${ago(status.last_activity_at)}` : 'No activity yet'}>
                    <span className="status-dot" aria-hidden="true" />
                    {status.label}
                  </span>
                )}
              </div>
              <div className="agent-role">
                {agent.title}
                {agent.team_name && <> · {agent.team_name}</>}
              </div>
            </div>
            <div className="agent-actions">
              {agent.slack_url && (
                <a className="btn" href={agent.slack_url} target="_blank" rel="noreferrer" title={`Open your DM with ${agent.name} in Slack`}>
                  <Icon name="chat" size={16} /> <span className="hide-sm">Message in Slack</span>
                </a>
              )}
              {isOwner && (
                <button className="btn" onClick={() => setModal({ kind: 'agent' })}>
                  <Icon name="gear" size={16} /> <span className="hide-sm">Settings</span>
                </button>
              )}
              <MoreMenu agent={agent} canManage={isOwner} onPause={togglePause} onDelete={remove} onAbout={() => setAbout(true)} />
            </div>
          </div>
          <div className="agent-desc-row">
            {agent.description && <p className="agent-desc clamp-1">{agent.description}</p>}
            <button type="button" className="link-btn" onClick={() => setAbout(true)}>
              About this agent
            </button>
          </div>
          {actionError && <div className="form-error">{actionError}</div>}
          <div className="tabs-row">
            <nav className="tabs" role="tablist" aria-label={`${agent.name} sections`}>
              {TABS.map(([k, l]) => (
                <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => go(k)}>
                  {l}
                  {k === 'tasks' && openTasks.length > 0 && <span className="tab-count">{openTasks.length}</span>}
                </button>
              ))}
            </nav>
          </div>
        </header>

        {tab === 'chat' && (
          <Chat
            agent={agent}
            claudeReady={meta?.claude}
            chatId={selectedChat}
            onSelectChat={selectChat}
            onShownChat={setShownChat}
            toolbar={
              !panelOpen && (
                <button type="button" className="btn" onClick={() => (wide ? setPanelPref('open') : setDrawer(true))} aria-label="Show work overview">
                  <Icon name="panel" size={16} /> <span className="hide-sm">Work overview</span>
                </button>
              )
            }
          />
        )}

        {tab === 'tasks' && (
          <div className="tab-body">
            <div className="segmented" role="tablist" aria-label="Tasks or recurring tasks">
              <button type="button" role="tab" aria-selected={taskView === 'tasks'} className={taskView === 'tasks' ? 'on' : ''} onClick={() => go('tasks')}>
                Tasks ({openTasks.length})
              </button>
              <button type="button" role="tab" aria-selected={taskView === 'recurring'} className={taskView === 'recurring' ? 'on' : ''} onClick={() => go('tasks', 'recurring')}>
                <Icon name="repeat" size={14} /> Recurring ({activeRecurring})
              </button>
            </div>
            {taskView === 'recurring' ? (
              <RecurringSection
                query={`agent_id=${agent.id}`}
                defaults={{ assignee: `agent:${agent.id}` }}
                emptyText={`Nothing recurring for ${agent.name} yet. Create one here, or ask ${agent.name} in chat, e.g. “Every Monday at 9 AM, check outstanding supplier invoices.”`}
              />
            ) : (
              <>
                <div className="tab-actions">
                  <button className="btn btn-primary" onClick={() => openComposer({ assignee: `agent:${agent.id}` })}>
                    <Icon name="plus" size={16} /> Assign task
                  </button>
                </div>
                {tasks && openTasks.length === 0 && <Empty title="No open tasks" />}
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
              </>
            )}
          </div>
        )}

        {tab === 'knowledge' && (
          <div className="tab-body">
            <Knowledge agent={agent} onSettings={() => (isOwner ? setModal({ kind: 'agent' }) : setActionError('Only workspace owners can change instructions.'))} onTools={() => go('tools')} />
          </div>
        )}

        {tab === 'tools' && (
          <div className="tab-body">
            <Capabilities agent={agent} onSaved={setData} />
            <h3 className="section-title">Connection & API</h3>
            <Connect agent={agent} onRotate={() => api(`/agents/${agent.id}/rotate-token`, { method: 'POST' }).then(setData, (err) => setActionError(err.message))} />
          </div>
        )}

        {tab === 'activity' && (
          <div className="tab-body">
            <Activity agent={agent} />
          </div>
        )}
      </div>

      {panelOpen && (
        <aside className="work-panel" aria-labelledby="wo-title">
          {overview}
        </aside>
      )}
      {!wide && drawer && tab === 'chat' && (
        <>
          <div className="drawer-backdrop" onClick={() => setDrawer(false)} />
          <aside className="task-panel work-drawer" role="dialog" aria-modal="true" aria-labelledby="wo-title">
            {overview}
          </aside>
        </>
      )}

      {about && <About agent={agent} status={status} onClose={() => setAbout(false)} />}
      {modal?.kind === 'agent' && <AgentForm agent={agent} onClose={() => setModal(null)} onSaved={setData} />}
    </div>
  );
}
