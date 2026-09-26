import { memo, useContext, useEffect, useState } from 'react';
import { LiveContext, api, toDate, useApi } from '../api.js';
import { Avatar, Icon } from './ui.jsx';
import Markdown from './Markdown.jsx';
import useStickToBottom from './useStickToBottom.js';

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

// Memoised: a new message renders one bubble, not the whole conversation again.
const Bubble = memo(function Bubble({ m, agent }) {
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
        <Markdown text={m.body} className="bubble-text" />
        <time>
          {via?.via === 'slack' && `${via.user ?? 'Someone'} via Slack · `}
          {time}
        </time>
      </div>
    </div>
  );
});

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
  const [error, setError] = useState(null);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!working) setStopping(false);
  }, [working]);

  useEffect(
    () =>
      live?.on((e) => {
        if (e.type !== 'message' || e.agent_id !== agent.id) return;
        setData((ms) => (ms && !ms.some((m) => m.id === e.message.id) ? [...ms, e.message] : ms));
        if (e.message.sender !== 'user') setWaiting(false);
      }),
    [live, agent.id, setData],
  );
  // Follows new messages only while you're at the bottom; reading further up, you stay put.
  const typing = waiting || working;
  const scroll = useStickToBottom(messages ? `${messages.length}:${typing}` : null, agent.id);

  const claudePowered = ['claude', 'managed'].includes(agent.platform);
  const willReply = agent.status !== 'paused' && ((claudePowered && claudeReady) || agent.webhook_url);

  const send = async (e) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    setError(null);
    scroll.pin(); // your own message always brings you back down
    let m;
    try {
      m = await api(`/agents/${agent.id}/messages`, { method: 'POST', body: { body } });
    } catch (err) {
      // Never lose what was typed: put it back (ahead of anything typed since).
      setDraft((d) => (d.trim() ? `${body}\n${d}` : body));
      setError(`Couldn't send: ${err.message}. Your message is back in the box. Try again.`);
      return;
    }
    setData((ms) => (ms.some((x) => x.id === m.id) ? ms : [...ms, m]));
    if (willReply) setWaiting(true);
  };

  const stop = async () => {
    setStopping(true);
    try {
      await api(`/runs/${chatRun.id}/interrupt`, { method: 'POST' });
    } catch (err) {
      setStopping(false);
      setError(`Couldn't stop ${agent.name}: ${err.message}`);
    }
  };

  let hint = null;
  if (agent.status === 'paused') hint = `${agent.name} is paused — messages are stored but not delivered.`;
  else if (claudePowered && !claudeReady) hint = 'Set ANTHROPIC_API_KEY on the server so Claude agents can reply.';
  else if (!willReply) hint = `${agent.name} has no webhook — it will pick messages up when it polls the Agent API.`;

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scroll.ref} onScroll={scroll.onScroll}>
        {messages?.length === 0 && <div className="chat-empty">Start the conversation with {agent.name}.</div>}
        {messages?.map((m) => (
          <Bubble key={m.id} m={m} agent={agent} />
        ))}
        {typing && (
          <div className="msg">
            <Avatar name={agent.name} color={agent.color} size={28} />
            <div className="bubble typing">
              <i />
              <i />
              <i />
            </div>
            {working && chatRun?.id && (
              <button type="button" className="typing-stop" onClick={stop} disabled={stopping}>
                {stopping ? 'Stopping…' : 'Stop'}
              </button>
            )}
          </div>
        )}
      </div>
      {scroll.unseen && (
        <button type="button" className="chat-jump" onClick={() => scroll.toBottom()}>
          New messages ↓
        </button>
      )}
      {error && (
        <div className="chat-hint chat-error" role="alert">
          {error}
        </div>
      )}
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
