import { ago, api, useApi } from '../api.js';
import { Avatar, Empty, Loading } from '../components/ui.jsx';
import Chat from '../components/Chat.jsx';

export default function Inbox({ id, meta }) {
  const { data: agents } = useApi('/agents', ['agent', 'message']);
  if (!agents) return <Loading />;
  const sorted = [...agents].sort((a, b) => (b.last_message_at ?? '').localeCompare(a.last_message_at ?? ''));
  const current = agents.find((a) => a.id === Number(id)) ?? sorted[0];
  return (
    <div className="inbox">
      <aside className="inbox-list">
        <h1 className="inbox-title">Inbox</h1>
        <Reminders />
        {sorted.map((a) => (
          <a key={a.id} href={`#/inbox/${a.id}`} className={`inbox-item ${current?.id === a.id ? 'on' : ''}`}>
            <Avatar name={a.name} color={a.color} size={36} status={a.status} />
            <div className="grow">
              <div className="inbox-row">
                <strong>{a.name}</strong>
                <span className="muted small">{a.last_message_at ? ago(a.last_message_at) : ''}</span>
              </div>
              <div className="row-sub clamp-1">{a.last_message ?? a.title}</div>
            </div>
          </a>
        ))}
      </aside>
      <section className="inbox-chat">
        {current ? (
          <>
            <header className="inbox-chat-head">
              <Avatar name={current.name} color={current.color} size={32} status={current.status} />
              <div className="grow">
                <strong>{current.name}</strong>
                <div className="muted small">{current.title}{current.team_name ? ` · ${current.team_name}` : ''}</div>
              </div>
              <a className="btn btn-sm" href={`#/agents/${current.id}`}>
                Open agent
              </a>
            </header>
            <Chat key={current.id} agent={current} claudeReady={meta?.claude} />
          </>
        ) : (
          <Empty title="No agents yet" />
        )}
      </section>
    </div>
  );
}

/** Due-date reminders for tasks, above the conversations. */
function Reminders() {
  const { data: reminders } = useApi('/reminders', ['reminder', 'task']);
  if (!reminders?.length) return null;
  const dismiss = (id) => api(`/reminders/${id}/read`, { method: 'POST' });
  return (
    <div className="reminders">
      <div className="reminders-head small strong">For you: assignments and reminders</div>
      {reminders.map((r) => (
        <div key={r.id} className="reminder">
          <a href={`#/tasks/${r.task_id}`} className="grow">
            <div className="clamp-2">{r.text}</div>
            <div className="muted small">{ago(r.created_at)}</div>
          </a>
          <button type="button" className="icon-btn sm" aria-label="Dismiss reminder" title="Dismiss" onClick={() => dismiss(r.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
