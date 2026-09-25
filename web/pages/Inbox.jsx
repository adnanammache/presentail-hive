import { ago, useApi } from '../api.js';
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
        {sorted.map((a) => (
          <a key={a.id} href={`#/inbox/${a.id}`} className={`inbox-item ${current?.id === a.id ? 'on' : ''}`}>
            <Avatar name={a.name} color={a.color} size={36} status={a.status} />
            <div className="grow">
              <div className="inbox-row">
                <strong>{a.name}</strong>
                <span className="muted small">{a.last_message_at ? ago(a.last_message_at) : ''}</span>
              </div>
              <div className="row-sub clamp-1">{a.last_message ?? a.role}</div>
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
                <div className="muted small">{current.role}</div>
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
