// The agent workspace: a compact header with the agent's real status, tabs (Chat, Tasks, Knowledge,
// Tools & access, Activity). Chat is three panes: this person's conversation history (Active /
// Archived, searchable), the conversation, and an optional side panel for the Work overview, files
// and tasks, opened without leaving the chat. Routes:
//   #/agents/:id                   chat, last conversation opened here
//   #/agents/:id/chat/:chatId      a conversation (archived ones open too; links never break)
//   #/agents/:id/chat/new          a new conversation (created only when the first message is sent)
//   #/agents/:id/:tab              tasks | knowledge | tools | activity
// Older tab names still work: skills, connect → tools; lessons → knowledge; workflows → tasks;
// colleagues → chat with About open. #/agents/:id/tasks/recurring opens the recurring tasks.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ago, api, fmtDateTime, toDate, useApi } from '../api.js';
import { Avatar, Badge, Empty, Icon, Loading, Modal, PLATFORM_LABELS, runTone } from '../components/ui.jsx';
import { AgentForm } from '../components/forms.jsx';
import { usePref, useTaskUI } from '../components/work.jsx';
import Chat from '../components/Chat.jsx';
import Capabilities from '../components/Capabilities.jsx';
import WorkOverview from '../components/WorkOverview.jsx';
import ConversationHistory from '../components/ConversationHistory.jsx';
import ContextViewer, { MIN_WIDTH } from '../components/ContextViewer.jsx';
import { TaskCard } from '../components/TaskViews.jsx';
import { RecurringSection } from '../components/Recurring.jsx';
import Markdown from '../components/Markdown.jsx';
import { LESSON_LIMITS } from '../../shared/lessons.js';

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

const SOURCE = { manual: 'Added here', rejection: 'From a rejection', slack: 'From Slack', task: 'From a task', chat: 'From a conversation', agent: 'Proposed by the agent' };

/** Where a lesson came from: its task, or the chat it was proposed in. */
function sourceLink(l, agent) {
  if (l.task_id && l.task_title) return <a href={`#/tasks/${l.task_id}`}>{l.task_title}</a>;
  if (l.chat_id) return <a href={`#/agents/${agent.id}/chat/${l.chat_id}`}>open conversation</a>;
  if (l.run_kind === 'chat' && String(l.run_origin ?? '').startsWith('slack:')) return <span>a Slack thread</span>;
  return null;
}

function Meta({ l, agent, children }) {
  const link = sourceLink(l, agent);
  return (
    <div className="muted small">
      #{l.id} · {SOURCE[l.source] ?? l.source}
      {l.created_by && l.source !== 'agent' && ` by ${l.created_by}`}
      {link && <> · {link}</>}
      {' · '}
      {ago(l.created_at)}
      {children}
    </div>
  );
}

/** What this agent has learned. Approved, active lessons go into its instructions; proposals wait here for a person. */
function Lessons({ agent }) {
  const { data, reload } = useApi(`/agents/${agent.id}/lessons`, ['lesson']);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const act = (fn) => async (...args) => {
    try {
      setError('');
      await fn(...args);
    } catch (err) {
      setError(err.message);
    }
    reload();
  };
  const add = act(async (e) => {
    e.preventDefault();
    await api(`/agents/${agent.id}/lessons`, { method: 'POST', body: { text } });
    setText('');
  });
  const edit = act(async (l) => {
    const next = prompt('Edit the lesson', l.text);
    if (next != null && next.trim() && next !== l.text) await api(`/lessons/${l.id}`, { method: 'PATCH', body: { text: next } });
  });
  const approve = act((l, reword) => {
    const next = reword ? prompt('Edit, then approve', l.text) : l.text;
    if (next == null || !next.trim()) return;
    return api(`/lessons/${l.id}/approve`, { method: 'POST', body: { text: next } });
  });
  const reject = act((l) => {
    const note = prompt(`Reject this lesson? ${agent.name} will see your reason so it doesn't propose it again (optional).`, '');
    if (note == null) return;
    return api(`/lessons/${l.id}/reject`, { method: 'POST', body: { note } });
  });
  const proposal = act((l, accept) => api(`/lessons/${l.id}/proposal`, { method: 'POST', body: { accept } }));
  const trust = act(async (on) => {
    if (on && !confirm(`Approve everything ${agent.name} proposes automatically, without anyone checking it first?`)) return;
    await api(`/agents/${agent.id}/trust-lessons`, { method: 'PUT', body: { trust: on } });
  });

  if (!data) return <Loading />;
  const pending = data.filter((l) => l.status === 'pending_approval');
  const approved = data.filter((l) => l.status === 'approved');
  const rejected = data.filter((l) => l.status === 'rejected');
  const inForce = approved.filter((l) => l.active);
  const { SOFT_CAP, MAX_IN_PROMPT } = LESSON_LIMITS;
  // Past the soft cap: the ones used least recently (or never) are the first to consider removing.
  const stalest = [...inForce].sort((a, b) => String(a.last_used_at ?? a.created_at).localeCompare(String(b.last_used_at ?? b.created_at))).slice(0, inForce.length - SOFT_CAP);
  const used = (l) => (l.use_count ? ` · used ${l.use_count}×, last ${ago(l.last_used_at)}` : ' · not used yet');

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
        {agent.name} follows the approved lessons on every task and chat. Lessons are also saved when you reject something with a reason or start a chat message with “remember:”. {agent.name} can
        also propose lessons itself, from what you tell it or from its own mistakes: those wait here until an approver or owner approves them.
      </p>
      <label className="lesson-trust small">
        <input type="checkbox" checked={Boolean(agent.trust_lessons)} onChange={(e) => trust(e.target.checked)} /> Always trust {agent.name}'s lessons (approve them without asking)
      </label>

      {pending.length > 0 && (
        <section className="lesson-section">
          <h3>Waiting for your approval ({pending.length})</h3>
          <ul className="lesson-list">
            {pending.map((l) => (
              <li key={l.id} className="pending">
                <div className="grow">
                  {l.title && <div className="strong">{l.title}</div>}
                  <div className="pre-wrap">{l.text}</div>
                  {l.reason && <div className="lesson-reason small">Why: {l.reason}</div>}
                  <Meta l={l} agent={agent} />
                </div>
                <div className="lesson-actions">
                  <button className="btn btn-sm btn-primary" onClick={() => approve(l, false)}>
                    Approve
                  </button>
                  <button className="btn btn-sm" onClick={() => approve(l, true)}>
                    Edit & approve
                  </button>
                  <button className="btn btn-sm btn-danger-ghost" onClick={() => reject(l)}>
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {inForce.length > SOFT_CAP && (
        <div className="warn-note small">
          {agent.name} has {inForce.length} lessons in force; aim for {SOFT_CAP} or fewer, since every lesson goes into every chat and task.
          {inForce.length > MAX_IN_PROMPT && ` Only the newest ${MAX_IN_PROMPT} are used right now: the oldest ${inForce.length - MAX_IN_PROMPT} are left out.`} Least used first:{' '}
          {stalest.map((l) => `#${l.id}`).join(', ')}.
        </div>
      )}

      {approved.length === 0 && pending.length === 0 ? (
        <Empty title="Nothing learned yet">Use “Save as lesson” on a chat message, add one here, or reject a change with a reason.</Empty>
      ) : (
        approved.length > 0 && (
          <ul className="lesson-list">
            {approved.map((l) => (
              <li key={l.id} className={`${l.active ? '' : 'off'} ${stalest.includes(l) ? 'stale' : ''}`}>
                <div className="grow">
                  {l.title && <div className="strong">{l.title}</div>}
                  <div className="pre-wrap">{l.text}</div>
                  {l.proposed_text && (
                    <div className="lesson-proposal small">
                      <div>
                        <strong>{agent.name} suggests:</strong> {l.proposed_text}
                        {l.proposed_reason && <span className="muted"> (why: {l.proposed_reason})</span>}
                      </div>
                      <button className="btn btn-sm btn-primary" onClick={() => proposal(l, true)}>
                        Use this wording
                      </button>
                      <button className="btn btn-sm" onClick={() => proposal(l, false)}>
                        Keep as is
                      </button>
                    </div>
                  )}
                  <Meta l={l} agent={agent}>
                    {l.source === 'agent' && l.reviewed_by && ` · approved by ${l.reviewed_by}`}
                    {used(l)}
                  </Meta>
                </div>
                <button className="btn btn-sm" onClick={() => edit(l)}>
                  Edit
                </button>
                <button className="btn btn-sm" onClick={act(() => api(`/lessons/${l.id}`, { method: 'PATCH', body: { active: !l.active } }))}>
                  {l.active ? 'Switch off' : 'Switch on'}
                </button>
                <button className="icon-btn" aria-label="Delete lesson" onClick={act(() => confirm('Delete this lesson?') && api(`/lessons/${l.id}`, { method: 'DELETE' }))}>
                  <Icon name="trash" size={16} />
                </button>
              </li>
            ))}
          </ul>
        )
      )}

      {rejected.length > 0 && (
        <details className="lesson-section">
          <summary className="muted small">Rejected ({rejected.length}): {agent.name} is shown these so it doesn't propose them again</summary>
          <ul className="lesson-list">
            {rejected.map((l) => (
              <li key={l.id} className="rejected">
                <div className="grow">
                  {l.title && <div className="strong">{l.title}</div>}
                  <div className="pre-wrap">{l.text}</div>
                  <Meta l={l} agent={agent}>
                    {` · rejected${l.reviewed_by ? ` by ${l.reviewed_by}` : ''}`}
                    {l.review_note && `: “${l.review_note}”`}
                  </Meta>
                </div>
                <button className="btn btn-sm" onClick={() => approve(l, false)}>
                  Approve after all
                </button>
                <button className="icon-btn" aria-label="Delete lesson" onClick={act(() => confirm('Delete this rejected lesson? The agent could then propose it again.') && api(`/lessons/${l.id}`, { method: 'DELETE' }))}>
                  <Icon name="trash" size={16} />
                </button>
              </li>
            ))}
          </ul>
        </details>
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

const HISTORY_WIDTH = 288;
const CHAT_MIN = 440;

/** The width of an element, kept up to date. */
function useWidth(ref) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  });
  return w;
}

function ArchiveConfirm({ chat, warnings, onKeep, onArchive }) {
  const keep = useRef(null);
  useEffect(() => keep.current?.focus(), []);
  return (
    <Modal title="Archive this conversation?" onClose={onKeep}>
      <div className="form">
        <p className="muted small">“{chat.title}” will leave your active conversations. Nothing stops or changes:</p>
        <ul className="archive-warnings">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
        <div className="form-actions">
          <button ref={keep} type="button" className="btn" onClick={onKeep}>
            Keep open
          </button>
          <button type="button" className="btn btn-primary" onClick={onArchive}>
            Archive anyway
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default function AgentDetail({ id, meta, tab: routeTab, param }) {
  const { data: agent, setData, error: agentError } = useApi(`/agents/${id}`, ['agent']);
  const { data: me } = useApi('/me');
  const { data: tasks } = useApi(`/tasks?agent_id=${id}`, ['task']);
  const { data: recurring } = useApi(`/workflows?agent_id=${id}`, ['workflow']);
  const { data: lessons } = useApi(`/agents/${id}/lessons`, ['lesson']);
  const [modal, setModal] = useState(null);
  const [about, setAbout] = useState(routeTab === 'colleagues');
  const [actionError, setActionError] = useState('');
  const { openComposer, openTask } = useTaskUI();

  // The old Colleagues link opens About; going to another section closes it.
  useEffect(() => setAbout(routeTab === 'colleagues'), [routeTab, param]);
  const tab = ALIASES[routeTab] ?? (TABS.some(([k]) => k === routeTab) ? routeTab : 'chat');
  const chatParam = tab === 'chat' && routeTab === 'chat' ? param : undefined;
  const selectedChat = chatParam === 'new' ? 'new' : chatParam ? Number(chatParam) : undefined;
  const routeChat = useRef(selectedChat);
  routeChat.current = selectedChat;

  // The conversation the chat is showing (it tells us), for the Work overview and archiving.
  const [shownChat, setShownChat] = useState(null);
  const [shown, setShown] = useState(null);
  const onShownChat = useCallback((chatId, chat) => (setShownChat(chatId), setShown(chat ?? null)), []);

  const { data: ws, error: wsError, reload: reloadWs } = useApi(`/agents/${id}/workspace${shownChat ? `?chat_id=${shownChat}` : ''}`, ['run', 'task', 'agent', 'workflow', 'chat']);

  const go = useCallback((t, extra) => {
    location.hash = `#/agents/${id}${t === 'chat' && !extra ? '' : `/${t}`}${extra ? `/${extra}` : ''}`;
  }, [id]);
  const selectChat = useCallback((chatId) => (location.hash = `#/agents/${id}/chat/${chatId ?? 'new'}`), [id]);

  // ------------------------------------------------ layout: history | chat | side panel
  const body = useRef(null);
  const bodyWidth = useWidth(body);
  const historyFits = useWide('(min-width: 1024px)');
  const [historyPref, setHistoryPref] = usePref('agentHistory', 'open');
  const [historyDrawer, setHistoryDrawer] = useState(false);
  const historyInline = historyFits && historyPref === 'open';
  const [overviewPref, setOverviewPref] = usePref('workPanel', 'open');
  const [ctxWidth, setCtxWidth] = usePref('ctxWidth', 440);
  const [ctxItems, setCtxItems] = useState([]);
  const [ctxActive, setCtxActive] = useState(null);
  const [ctxDrawer, setCtxDrawer] = useState(false);
  const available = (bodyWidth || 0) - (historyInline ? HISTORY_WIDTH : 0) - CHAT_MIN;
  const viewerInline = bodyWidth > 0 && available >= MIN_WIDTH;
  const viewerWidth = Math.max(MIN_WIDTH, Math.min(ctxWidth, available));
  const opener = useRef(null);
  // Closing a pane puts focus back where it was opened from (or on the button that reopens it).
  const restoreFocus = () =>
    setTimeout(() => (opener.current?.isConnected ? opener.current : document.querySelector('.chat-head [aria-label="Work overview"]'))?.focus(), 0);

  const overviewItem = { key: 'overview', kind: 'overview', title: 'Work overview' };
  const items = [...(overviewPref === 'open' ? [overviewItem] : []), ...ctxItems];
  const viewerShown = tab === 'chat' && items.length > 0 && (viewerInline || ctxDrawer);

  const openItem = (item) => {
    const from = document.activeElement;
    if (from && from !== document.body && !from.closest?.('.ws-viewer, .ws-viewer-drawer')) opener.current = from;
    if (item.kind === 'overview') setOverviewPref('open');
    else setCtxItems((list) => (list.some((i) => i.key === item.key) ? list : [...list, item].slice(-5)));
    setCtxActive(item.key);
    if (!viewerInline) setCtxDrawer(true);
  };
  const taskTitle = (taskId) => tasks?.find((t) => t.id === Number(taskId))?.title ?? ws?.current_tasks?.find((t) => t.id === Number(taskId))?.title ?? `Task #${taskId}`;
  const openFile = (ref, filename) => openItem({ key: `file:${ref}`, kind: 'file', fileRef: ref, title: filename || 'File' });
  const openTaskHere = (taskId) => openItem({ key: `task:${taskId}`, kind: 'task', taskId: Number(taskId), title: taskTitle(taskId) });
  const closeItem = (key) => {
    if (key === 'overview') setOverviewPref('closed');
    else setCtxItems((list) => list.filter((i) => i.key !== key));
    if (items.length <= 1) (setCtxDrawer(false), restoreFocus());
  };
  const closeAll = () => {
    setOverviewPref('closed');
    setCtxItems([]);
    setCtxDrawer(false);
    restoreFocus();
  };
  const toggleOverview = () => {
    if (viewerShown && overviewPref === 'open' && (ctxActive === 'overview' || !ctxItems.length)) closeItem('overview');
    else openItem(overviewItem);
  };

  // "Discuss": a reference chip in the composer. On a narrow screen, back to the chat to write.
  const [referenceRequest, setReferenceRequest] = useState(null);
  const discuss = (ref) => {
    setReferenceRequest({ nonce: Date.now(), ...ref });
    if (!viewerInline) setCtxDrawer(false);
  };

  // Escape closes a drawer (the side panel inline stays until closed with its button).
  useEffect(() => {
    if (!historyDrawer && !(ctxDrawer && !viewerInline)) return;
    const esc = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (ctxDrawer && !viewerInline) (setCtxDrawer(false), restoreFocus());
      else if (historyDrawer) (setHistoryDrawer(false), restoreFocus());
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [historyDrawer, ctxDrawer, viewerInline]);

  // ------------------------------------------------ conversation actions (history rows and the chat header)
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((n) => n + 1);
  const [toast, setToast] = useState(null);
  const [confirmArchive, setConfirmArchive] = useState(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.undo ? 10000 : 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const archive = async (c, { force = false } = {}) => {
    let res;
    try {
      res = await api(`/chats/${c.id}/archive`, { method: 'POST', body: force ? { force: true } : {} });
    } catch (err) {
      if (err.status === 409 && err.data?.warnings?.length) return setConfirmArchive({ chat: c, warnings: err.data.warnings });
      return setToast({ tone: 'red', text: `Couldn't archive “${c.title}”: ${err.message}` });
    }
    setConfirmArchive(null);
    bump();
    // The open conversation: move to the latest active one (or the empty state; nothing is created).
    let next = null;
    if (c.id === shownChat) {
      const page = await api(`/agents/${id}/conversations?filter=active&limit=1`).catch(() => null);
      next = page?.chats?.find((x) => x.id !== c.id)?.id ?? 'new';
      selectChat(next);
    }
    setToast({ text: `Archived “${c.title}”.`, undo: { chat: c, seq: res.archive_seq, next } });
  };
  const undo = async ({ chat, seq, next }) => {
    setToast(null);
    try {
      const r = await api(`/chats/${chat.id}/restore`, { method: 'POST', body: { seq } });
      bump();
      if (r.stale) return setToast({ text: `“${chat.title}” was changed since, so it was left as it is.` });
      // Back to it only if the person is still where archiving took them.
      if (next != null && String(routeChat.current ?? 'new') === String(next)) selectChat(chat.id);
    } catch (err) {
      setToast({ tone: 'red', text: `Couldn't undo: ${err.message}` });
    }
  };
  const restore = async (c) => {
    try {
      await api(`/chats/${c.id}/restore`, { method: 'POST', body: {} });
      bump();
      setToast({ text: `Restored “${c.title}” to your active conversations.` });
    } catch (err) {
      setToast({ tone: 'red', text: `Couldn't restore: ${err.message}` });
    }
  };
  const actions = {
    rename: async (c, title) => {
      await api(`/chats/${c.id}`, { method: 'PATCH', body: { title } });
      bump();
    },
    share: async (c) => {
      await api(`/chats/${c.id}`, { method: 'PATCH', body: { visibility: c.visibility === 'shared' ? 'private' : 'shared' } });
      bump();
    },
    archive,
    restore,
  };
  const pickChat = (chatId) => {
    selectChat(chatId);
    if (historyDrawer) setHistoryDrawer(false);
  };
  const newConversation = () => {
    pickChat('new');
    setTimeout(() => document.querySelector('.chat-box textarea')?.focus(), 50);
  };

  if (agentError) return <Empty title="Agent not found">It may have been deleted. <a href="#/agents">Back to Team & agents</a></Empty>;
  if (!agent) return <Loading />;
  const activeRecurring = recurring?.filter((w) => w.status !== 'ended').length ?? 0;
  const taskView = tab === 'tasks' && (param === 'recurring' || routeTab === 'workflows') ? 'recurring' : 'tasks';
  const openTasks = tasks?.filter((t) => t.status !== 'done') ?? [];
  const doneTasks = tasks?.filter((t) => t.status === 'done') ?? [];
  // Lessons the agent proposed, and new wordings it suggested, waiting for a person.
  const waitingLessons = lessons?.filter((l) => l.status === 'pending_approval' || l.proposed_text).length ?? 0;
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
    setCtxDrawer(false);
    go('tasks', 'recurring');
  };

  const status = ws?.status;
  const paused = agent.status === 'paused';
  const isHuman = agent.platform === 'human';
  const overview = (
    <WorkOverview agent={agent} data={ws} error={wsError} chatId={shownChat} onRetry={reloadWs} onViewRecurring={viewRecurring} onOpenTask={openTaskHere} onOpenFile={openFile} />
  );
  const history = (drawer) => (
    <ConversationHistory
      agent={agent}
      currentId={shownChat}
      onSelect={pickChat}
      onNew={newConversation}
      actions={actions}
      refreshKey={refreshKey}
      drawer={drawer}
      onCollapse={drawer ? undefined : () => setHistoryPref('closed')}
      onClose={drawer ? () => (setHistoryDrawer(false), restoreFocus()) : undefined}
    />
  );
  const viewer = (mode) => (
    <ContextViewer
      items={items}
      active={ctxActive}
      onActivate={setCtxActive}
      onCloseItem={closeItem}
      onCloseAll={closeAll}
      mode={mode}
      width={viewerWidth}
      maxWidth={Math.max(MIN_WIDTH, available)}
      onResize={setCtxWidth}
      overview={overview}
      me={me}
      onOpenFile={openFile}
      onOpenTask={openTaskHere}
      onDiscuss={discuss}
    />
  );

  return (
    <div className="agent-ws">
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
                  {k === 'knowledge' && waitingLessons > 0 && (
                    <span className="tab-count" title="Lessons waiting for approval">
                      {waitingLessons}
                    </span>
                  )}
                </button>
              ))}
            </nav>
          </div>
        </header>

        {tab === 'chat' && (
          <div className="ws-body" ref={body}>
            {historyInline && (
              <aside className="ws-history" aria-labelledby="ch-title" style={{ width: HISTORY_WIDTH }}>
                {history(false)}
              </aside>
            )}
            <Chat
              agent={agent}
              claudeReady={meta?.claude}
              chatId={selectedChat}
              onSelectChat={selectChat}
              onShownChat={onShownChat}
              workspace
              actions={actions}
              refreshKey={refreshKey}
              onOpenFile={openFile}
              onOpenTask={openTaskHere}
              referenceRequest={referenceRequest}
              headerStart={
                !historyInline && (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label="Show conversations"
                      onClick={(e) => {
                        if (historyFits) setHistoryPref('open');
                        else ((opener.current = e.currentTarget), setHistoryDrawer(true));
                      }}
                    >
                      <Icon name="sidebar" size={15} /> <span className="hide-sm">Conversations</span>
                    </button>
                    <button type="button" className="btn btn-sm icon-only" aria-label="New conversation" title="New conversation" onClick={newConversation}>
                      <Icon name="plus" size={15} />
                    </button>
                  </>
                )
              }
              toolbar={
                <button type="button" className={`btn btn-sm ${viewerShown && overviewPref === 'open' ? 'on' : ''}`} onClick={toggleOverview} aria-pressed={viewerShown && overviewPref === 'open'} aria-label="Work overview">
                  <Icon name="panel" size={15} /> <span className="hide-sm">Work overview</span>
                </button>
              }
            />
            {viewerShown && viewerInline && (
              <aside className="ws-viewer" style={{ width: viewerWidth }} aria-label="Beside the conversation">
                {viewer('inline')}
              </aside>
            )}
            {toast && (
              <div className={`toast ws-toast tone-${toast.tone ?? 'neutral'}`} role="status">
                <span>{toast.text}</span>
                {toast.undo && (
                  <button type="button" className="link-btn" onClick={() => undo(toast.undo)}>
                    Undo
                  </button>
                )}
                <button type="button" className="icon-btn sm" aria-label="Dismiss" onClick={() => setToast(null)}>
                  <Icon name="x" size={14} />
                </button>
              </div>
            )}
          </div>
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

      {tab === 'chat' && historyDrawer && !historyInline && (
        <>
          <div className="drawer-backdrop" onClick={() => (setHistoryDrawer(false), restoreFocus())} />
          <aside className="ws-history-drawer" role="dialog" aria-modal="true" aria-labelledby="ch-title">
            {history(true)}
          </aside>
        </>
      )}
      {viewerShown && !viewerInline && (
        <>
          <div className="drawer-backdrop" onClick={() => (setCtxDrawer(false), restoreFocus())} />
          <aside className="task-panel ws-viewer-drawer" role="dialog" aria-modal="true" aria-label="Beside the conversation">
            {viewer('drawer')}
          </aside>
        </>
      )}

      {confirmArchive && (
        <ArchiveConfirm
          chat={confirmArchive.chat}
          warnings={confirmArchive.warnings}
          onKeep={() => setConfirmArchive(null)}
          onArchive={() => archive(confirmArchive.chat, { force: true })}
        />
      )}
      {about && <About agent={agent} status={status} onClose={() => setAbout(false)} />}
      {modal?.kind === 'agent' && <AgentForm agent={agent} onClose={() => setModal(null)} onSaved={setData} />}
    </div>
  );
}
