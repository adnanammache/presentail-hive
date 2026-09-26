import { useContext, useEffect, useRef, useState } from 'react';
import { LiveContext, api, toDate, useApi } from '../api.js';
import { Avatar, Icon } from './ui.jsx';

function ApprovalButtons({ meta }) {
  const [state, setState] = useState(null);
  const answer = async (allow) => {
    try {
      await api(`/runs/${meta.run_id}/confirm`, { method: 'POST', body: { event_id: meta.event_id, result: allow ? 'allow' : 'deny' } });
      setState(allow ? 'Approved' : 'Rejected');
    } catch (err) {
      setState(err.message);
    }
  };
  if (state) return <div className="small strong">{state}</div>;
  return (
    <div className="approval-actions">
      <button className="btn btn-sm btn-danger-ghost" onClick={() => answer(false)}>Reject</button>
      <button className="btn btn-sm btn-primary" onClick={() => answer(true)}>Approve</button>
    </div>
  );
}

function Bubble({ m, agent }) {
  const time = toDate(m.created_at)?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (m.sender === 'system') {
    const meta = m.meta ? JSON.parse(m.meta) : null;
    return (
      <div className="msg-system">
        <span>{m.body}</span>
        <time>{time}</time>
        {meta?.type === 'approval' && <ApprovalButtons meta={meta} />}
      </div>
    );
  }
  const mine = m.sender === 'user';
  const via = mine && m.meta ? JSON.parse(m.meta) : null;
  return (
    <div className={`msg ${mine ? 'mine' : ''}`}>
      {!mine && <Avatar name={agent.name} color={agent.color} size={28} />}
      <div className="bubble">
        <div className="bubble-text">{m.body}</div>
        <time>
          {via?.via === 'slack' && `${via.user ?? 'Someone'} via Slack · `}
          {time}
        </time>
      </div>
    </div>
  );
}

export default function Chat({ agent, claudeReady }) {
  const { data: messages, setData } = useApi(`/agents/${agent.id}/messages`);
  // A managed agent's turn can span several messages (and tool calls between them): keep showing
  // it's typing until its chat run actually stops, not just until the first message arrives.
  const managed = agent.platform === 'managed';
  const { data: chatRun } = useApi(managed ? `/agents/${agent.id}/chat-run` : null, ['run']);
  const working = managed && ['starting', 'running'].includes(chatRun?.status);
  const live = useContext(LiveContext);
  const [draft, setDraft] = useState('');
  const [waiting, setWaiting] = useState(false);
  const scroller = useRef(null);

  useEffect(
    () =>
      live?.on((e) => {
        if (e.type !== 'message' || e.agent_id !== agent.id) return;
        setData((ms) => (ms && !ms.some((m) => m.id === e.message.id) ? [...ms, e.message] : ms));
        if (e.message.sender !== 'user') setWaiting(false);
      }),
    [live, agent.id, setData],
  );
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages?.length, waiting, working]);

  const claudePowered = ['claude', 'managed'].includes(agent.platform);
  const willReply = agent.status !== 'paused' && ((claudePowered && claudeReady) || agent.webhook_url);

  const send = async (e) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    const m = await api(`/agents/${agent.id}/messages`, { method: 'POST', body: { body } });
    setData((ms) => (ms.some((x) => x.id === m.id) ? ms : [...ms, m]));
    if (willReply) setWaiting(true);
  };

  let hint = null;
  if (agent.status === 'paused') hint = `${agent.name} is paused — messages are stored but not delivered.`;
  else if (claudePowered && !claudeReady) hint = 'Set ANTHROPIC_API_KEY on the server so Claude agents can reply.';
  else if (!willReply) hint = `${agent.name} has no webhook — it will pick messages up when it polls the Agent API.`;

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scroller}>
        {messages?.length === 0 && <div className="chat-empty">Start the conversation with {agent.name}.</div>}
        {messages?.map((m) => (
          <Bubble key={m.id} m={m} agent={agent} />
        ))}
        {(waiting || working) && (
          <div className="msg">
            <Avatar name={agent.name} color={agent.color} size={28} />
            <div className="bubble typing">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
      </div>
      {hint && <div className="chat-hint">{hint}</div>}
      <form className="composer" onSubmit={send}>
        <textarea
          rows={1}
          value={draft}
          placeholder={`Message ${agent.name}…`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) send(e);
          }}
        />
        <button className="btn btn-primary" disabled={!draft.trim()} aria-label="Send">
          <Icon name="send" size={16} />
        </button>
      </form>
    </div>
  );
}
