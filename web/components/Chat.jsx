// Conversations with an agent: pick or start a conversation, read it (Markdown, the agent's activity
// from its real run events, approvals), and write (files, voice notes, file references, Stop for the
// running turn). Used by the agent workspace (with the history panel, status strip and side panel) and
// the Inbox. Drafts are kept per person and conversation in this browser, and survive switching,
// archiving and restoring.
import { Fragment, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LiveContext, api, toDate, useApi } from '../api.js';
import { Avatar, Icon, Modal } from './ui.jsx';
import { PersonAvatar, useTaskUI } from './work.jsx';
import Markdown from './Markdown.jsx';
import Menu from './Menu.jsx';
import StatusStrip from './StatusStrip.jsx';
import { draftKey, lastChatKey, legacyDraftKey, readDraft, store, writeDraft } from './chatUtil.js';

// ---------------------------------------------------------------- small helpers

export const fileSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const clock = (s) => toDate(s)?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function dayLabel(s) {
  const d = toDate(s);
  if (!d) return '';
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
const firstLine = (text, n = 80) => {
  const line = String(text ?? '').split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) ?? '';
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};
/**
 * Add a message that arrived live: at the end, or, if it was said earlier (a reply picked up late),
 * where it belongs by time (after others from the same second). Duplicates are ignored.
 */
export function addMessage(list, m) {
  if (!list) return list;
  if (list.some((x) => x.id === m.id)) return list;
  let i = list.length;
  while (i > 0 && list[i - 1].created_at > m.created_at) i--;
  return [...list.slice(0, i), m, ...list.slice(i)];
}

const parseMeta = (m) => {
  try {
    return m.meta ? JSON.parse(m.meta) : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- approvals (the existing flow)

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
      <button className="btn btn-sm btn-danger-ghost" onClick={() => answer(false)}>
        Reject
      </button>
      <button className="btn btn-sm btn-primary" onClick={() => answer(true)}>
        Approve
      </button>
    </div>
  );
}

/** A lesson the agent proposed in this chat: approve or reject it right here (or reword it in the Lessons tab). */
function LessonButtons({ meta }) {
  const [state, setState] = useState(null);
  const post = async (path, body, done) => {
    try {
      await api(`/lessons/${meta.lesson_id}/${path}`, { method: 'POST', body });
      setState(done);
    } catch (err) {
      setState(err.message);
    }
  };
  if (state) return <div className="small strong">{state}</div>;
  if (meta.edit) {
    return (
      <div className="approval-actions">
        <button className="btn btn-sm" onClick={() => post('proposal', { accept: false }, 'Kept as it was')}>Keep as is</button>
        <button className="btn btn-sm btn-primary" onClick={() => post('proposal', { accept: true }, 'New wording saved')}>Use this wording</button>
      </div>
    );
  }
  return (
    <div className="approval-actions">
      <button className="btn btn-sm btn-danger-ghost" onClick={() => { const note = prompt('Why not? The agent sees this so it doesn\'t propose it again (optional).', ''); if (note != null) post('reject', { note }, 'Rejected'); }}>Reject</button>
      <button className="btn btn-sm btn-primary" onClick={() => post('approve', {}, 'Approved: it applies from the next message')}>Approve</button>
    </div>
  );
}

// ---------------------------------------------------------------- messages

function MessageActions({ m, onLesson, onTask }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <div className="msg-actions">
      <button type="button" onClick={copy}>
        <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? 'Copied' : 'Copy'}
      </button>
      <button type="button" onClick={() => onLesson(m)}>
        <Icon name="book" size={14} /> Save as lesson
      </button>
      <button type="button" onClick={() => onTask(m)}>
        <Icon name="check" size={14} /> Create task
      </button>
    </div>
  );
}

/** A file (or a passage of one) a message refers to. */
function RefChip({ r, onOpen, onRemove }) {
  const label = (
    <>
      <Icon name="file" size={13} />
      <span className="ref-name clamp-1">{r.filename}</span>
      {r.quote && <span className="ref-quote clamp-2">“{r.quote}”</span>}
    </>
  );
  return (
    <span className={`ref-chip ${r.quote ? 'has-quote' : ''}`}>
      {onOpen ? (
        <button type="button" className="ref-open" onClick={() => onOpen(r.ref, r.filename)} title={`Open ${r.filename} beside the conversation`}>
          {label}
        </button>
      ) : (
        <span className="ref-open">{label}</span>
      )}
      {onRemove && (
        <button type="button" className="icon-btn sm" aria-label={`Remove the reference to ${r.filename}`} onClick={onRemove}>
          <Icon name="x" size={12} />
        </button>
      )}
    </span>
  );
}

function Message({ m, agent, me, people, onLesson, onTask, last, onOpenFile, onOpenTask }) {
  const meta = parseMeta(m);
  if (m.sender === 'system')
    return (
      <div className="msg-system" role="note">
        <span>{m.body}</span>
        <time>{clock(m.created_at)}</time>
        {meta?.type === 'approval' && <ApprovalButtons meta={meta} />}
        {meta?.type === 'lesson' && <LessonButtons meta={meta} />}
        {meta?.type === 'task_created' &&
          (onOpenTask ? (
            <button type="button" className="link-btn link" onClick={() => onOpenTask(meta.task_id)}>
              Open task
            </button>
          ) : (
            <a className="link" href={`#/tasks/${meta.task_id}`}>
              Open task
            </a>
          ))}
      </div>
    );
  const mine = m.sender === 'user';
  const files = meta?.files ?? [];
  const recording = files.find((f) => f.voice);
  const attached = files.filter((f) => !f.voice);
  const byMe = mine && (!meta?.email || meta.email === me?.email);
  const author = mine ? (byMe ? 'You' : meta?.via === 'slack' ? `${meta.user ?? 'Someone'} via Slack` : people?.get(meta?.email)?.name ?? meta?.email ?? 'Someone') : agent.name;
  return (
    <article className={`msg ${mine ? 'mine' : 'theirs'} ${last ? 'last' : ''}`} aria-label={`${author}, ${clock(m.created_at)}`}>
      <div className="msg-avatar">
        {mine ? <PersonAvatar name={byMe ? me?.name ?? 'You' : author} photo={byMe ? me?.avatar_url : people?.get(meta?.email)?.avatar_url} size={32} /> : <Avatar id={agent.id} name={agent.name} color={agent.color} size={32} />}
      </div>
      <div className="msg-col">
        <div className="bubble">
          {meta?.voice && (
            <div className="bubble-voice">
              <span className="voice-label">
                <Icon name="mic" size={13} /> Voice note
              </span>
              {recording && <audio controls preload="none" src={`/api/chat-files/${recording.id}`} />}
            </div>
          )}
          {mine ? <div className="bubble-text">{m.body}</div> : <Markdown text={m.body} />}
          {attached.length > 0 && (
            <div className="bubble-files">
              {attached.map((f) =>
                onOpenFile ? (
                  <div key={f.id} className="bubble-file">
                    <Icon name="file" size={14} />
                    <button type="button" className="grow clamp-1 bubble-file-open" onClick={() => onOpenFile(`chat:${f.id}`, f.filename)} title="Open beside the conversation">
                      {f.filename}
                    </button>
                    <span className="bubble-file-size">{fileSize(f.size)}</span>
                    <a href={`/api/chat-files/${f.id}`} download={f.filename} className="bubble-file-dl" aria-label={`Download ${f.filename}`}>
                      <Icon name="download" size={13} />
                    </a>
                  </div>
                ) : (
                  <a key={f.id} className="bubble-file" href={`/api/chat-files/${f.id}`} download={f.filename}>
                    <Icon name="file" size={14} />
                    <span className="grow clamp-1">{f.filename}</span>
                    <span className="bubble-file-size">{fileSize(f.size)}</span>
                  </a>
                ),
              )}
            </div>
          )}
          {meta?.refs?.length > 0 && (
            <div className="bubble-refs">
              {meta.refs.map((r, i) => (
                <RefChip key={`${r.ref}-${i}`} r={r} onOpen={onOpenFile} />
              ))}
            </div>
          )}
        </div>
        <div className="msg-meta">
          {!byMe && <span className="msg-author">{author}</span>}
          <time dateTime={toDate(m.created_at)?.toISOString()}>{clock(m.created_at)}</time>
        </div>
        <MessageActions m={m} onLesson={onLesson} onTask={onTask} />
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- the agent's activity

const secondsBetween = (a, b) => Math.max(0, Math.round((toDate(b) - toDate(a)) / 1000));
const duration = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

/** One stretch of the agent's work between messages, from its run events. */
function ActivityBlock({ block, agent, onStop }) {
  const [open, setOpen] = useState(false);
  const steps = block.steps;
  const current = steps.at(-1);
  const took = block.finished_at ? secondsBetween(block.started_at, block.finished_at) : 0;
  const title =
    block.state === 'running'
      ? current
        ? `${current.label}${current.detail && current.tool !== 'bash' ? `: ${current.detail}` : ''}`
        : `${agent.name} is working`
      : block.state === 'approval'
        ? 'Waiting for approval'
        : block.state === 'failed'
          ? 'Stopped with an error'
          : steps.length === 1
            ? steps[0].label
            : `${steps.length} steps completed`;
  const sub =
    block.state === 'running'
      ? `Working · step ${steps.length}`
      : block.state === 'approval'
        ? 'Approve or reject the change below to let it continue'
        : block.state === 'failed'
          ? block.error ?? `${block.errors} step${block.errors === 1 ? '' : 's'} failed`
          : `Completed${took >= 1 ? ` in ${duration(took)}` : ''}${block.errors ? ` · ${block.errors} step${block.errors === 1 ? '' : 's'} failed` : ''}`;
  return (
    <div className={`activity activity-${block.state}`}>
      <div className="activity-head">
        <span className="activity-icon" aria-hidden="true">
          {block.state === 'running' ? <span className="spinner" /> : <Icon name={block.state === 'done' ? 'check' : block.state === 'approval' ? 'clock' : 'alert'} size={16} />}
        </span>
        <div className="grow activity-text">
          <div className="activity-title clamp-1">{title}</div>
          <div className="activity-sub">
            <span>{sub}</span>
            {steps.length > 0 && (
              <>
                {' · '}
                <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                  {open ? 'Hide activity' : 'View activity'}
                </button>
              </>
            )}
          </div>
        </div>
        {block.state === 'running' && onStop && (
          <button type="button" className="btn btn-sm" onClick={onStop}>
            <Icon name="stop" size={13} /> Stop
          </button>
        )}
      </div>
      {open && (
        <ol className="activity-steps">
          {steps.map((s, i) => (
            <li key={i} className={s.failed ? 'failed' : ''}>
              <time>{clock(s.at)}</time>
              <span className="grow">
                <strong>{s.label}</strong>
                {s.change && <span className="badge badge-amber">change</span>}
                {s.failed && <span className="badge badge-red">failed</span>}
                {s.detail && <code className="activity-detail">{s.detail}</code>}
              </span>
            </li>
          ))}
          <li className="activity-times muted small">
            Started {clock(block.started_at)}
            {block.state !== 'running' && block.finished_at ? ` · finished ${clock(block.finished_at)}` : ''}
          </li>
        </ol>
      )}
    </div>
  );
}

/** Messages and activity blocks in time order (ties: a person's message, then work, then replies). */
function timeline(messages, blocks) {
  const rank = (i) => (i.kind === 'block' ? 1 : i.m.sender === 'user' ? 0 : 2);
  const items = [...messages.map((m) => ({ kind: 'msg', at: m.created_at, id: m.id, m })), ...blocks.map((b) => ({ kind: 'block', at: b.started_at, id: b.id, b }))];
  return items.sort((a, b) => a.at.localeCompare(b.at) || rank(a) - rank(b) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
}

// ---------------------------------------------------------------- voice notes

async function uploadChatFile(agentId, blob, name, voice = false) {
  const res = await fetch(`/api/agents/${agentId}/chat-files`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(name), ...(voice ? { 'X-Voice': '1' } : {}) },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed for ${name}`);
  return data;
}

const SpeechRecognition = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
const canRecord = Boolean(SpeechRecognition && typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined');
const MAX_FILE = 50 * 1024 * 1024;

/** Records the audio (kept in Hive) and transcribes it live with the browser's speech recognition. */
function useVoiceNote() {
  const [state, setState] = useState(null);
  const ref = useRef(null);
  const start = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    const v = { stream, recorder, chunks, recognition, finals: [], interim: '', active: true, started: Date.now() };
    recognition.onresult = (e) => {
      v.interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) v.finals.push(e.results[i][0].transcript.trim());
        else v.interim += e.results[i][0].transcript;
      }
      setState((s) => s && { ...s, text: [...v.finals, v.interim.trim()].filter(Boolean).join(' ') });
    };
    recognition.onend = () => {
      if (v.active) {
        try {
          recognition.start();
        } catch {
          /* already restarting */
        }
      } else v.ended?.();
    };
    recognition.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') v.error = 'Speech recognition was blocked. Allow the microphone for this site and try again.';
    };
    recorder.start();
    recognition.start();
    v.timer = setInterval(() => setState((s) => s && { ...s, seconds: Math.round((Date.now() - v.started) / 1000) }), 500);
    ref.current = v;
    setState({ seconds: 0, text: '' });
  };
  const stop = async (keep) => {
    const v = ref.current;
    if (!v) return null;
    ref.current = null;
    v.active = false;
    clearInterval(v.timer);
    const ended = new Promise((resolve) => {
      v.ended = resolve;
      setTimeout(resolve, 2500);
    });
    const recorded = new Promise((resolve) => (v.recorder.onstop = resolve));
    v.recognition.stop();
    v.recorder.stop();
    await Promise.all([ended, recorded]);
    v.stream.getTracks().forEach((t) => t.stop());
    setState(null);
    if (v.error) throw new Error(v.error);
    if (!keep) return null;
    const text = [...v.finals, v.interim.trim()].filter(Boolean).join(' ').trim();
    return { blob: new Blob(v.chunks, { type: v.recorder.mimeType || 'audio/webm' }), text };
  };
  useEffect(() => () => ref.current && stop(false), []);
  return { recording: state, start, stop };
}

// ---------------------------------------------------------------- save as lesson

function LessonDialog({ agent, chat, message, onClose }) {
  const [title, setTitle] = useState(firstLine(message.body, 60));
  const [text, setText] = useState(message.body);
  const [state, setState] = useState({ busy: false, error: '', saved: false });
  const save = async (e) => {
    e.preventDefault();
    if (state.busy || state.saved) return;
    setState({ busy: true, error: '', saved: false });
    try {
      await api(`/agents/${agent.id}/lessons`, { method: 'POST', body: { title, text, message_id: message.id } });
      setState({ busy: false, error: '', saved: true });
      setTimeout(onClose, 900);
    } catch (err) {
      setState({ busy: false, error: err.message, saved: false });
    }
  };
  return (
    <Modal title="Save as lesson" onClose={onClose} wide>
      <form className="form" onSubmit={save}>
        <p className="muted small">
          Lessons go into {agent.name}'s instructions for every future chat and task. Edit it into a clear, lasting rule before saving.
        </p>
        <label className="field">
          <span className="field-label">Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="e.g. UAE VAT deadlines" />
        </label>
        <label className="field">
          <span className="field-label">Lesson</span>
          <textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} required />
        </label>
        <dl className="lesson-meta">
          <dt>Saved to</dt>
          <dd>{agent.name}'s knowledge (Lessons)</dd>
          <dt>Source</dt>
          <dd>
            “{chat?.title ?? 'Conversation'}”, {message.sender === 'user' ? 'a message' : `${agent.name}'s message`} at {clock(message.created_at)}
          </dd>
        </dl>
        {state.error && <div className="form-error">{state.error}</div>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!text.trim() || state.busy || state.saved}>
            {state.saved ? 'Saved' : state.busy ? 'Saving…' : 'Save lesson'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- conversation picker

function ConversationPicker({ chats, current, onPick, onChanged }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const box = useRef(null);
  useEffect(() => {
    if (!open) return;
    const away = (e) => !box.current?.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => (document.removeEventListener('mousedown', away), document.removeEventListener('keydown', esc));
  }, [open]);
  const rename = async (e) => {
    e.preventDefault();
    try {
      onChanged(await api(`/chats/${current.id}`, { method: 'PATCH', body: { title: name } }));
      setEditing(false);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  };
  const share = async () => {
    try {
      onChanged(await api(`/chats/${current.id}`, { method: 'PATCH', body: { visibility: current.visibility === 'shared' ? 'private' : 'shared' } }));
    } catch (err) {
      setError(err.message);
    }
  };
  if (editing)
    return (
      <form className="convo-rename" onSubmit={rename}>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Conversation name" maxLength={80} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)} />
        <button className="btn btn-sm btn-primary" disabled={!name.trim()}>
          Save
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>
          Cancel
        </button>
        {error && <span className="text-red small">{error}</span>}
      </form>
    );
  return (
    <div className="convo-picker" ref={box}>
      <button type="button" className="convo-current" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="chat" size={16} />
        <span className="clamp-1">{current ? current.title : 'New conversation'}</span>
        {current && current.visibility === 'shared' && <Icon name="users" size={14} />}
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="menu convo-menu" role="listbox" aria-label="Conversations">
          {current?.can_manage && (
            <>
              <button type="button" onClick={() => (setName(current.title), setEditing(true), setOpen(false))}>
                <Icon name="edit" size={14} /> Rename
              </button>
              <button type="button" onClick={() => (share(), setOpen(false))}>
                <Icon name={current.visibility === 'shared' ? 'lock' : 'users'} size={14} /> {current.visibility === 'shared' ? 'Make private' : 'Share with the team'}
              </button>
              <div className="menu-sep" />
            </>
          )}
          <div className="menu-label">Conversations</div>
          <div className="convo-list">
            {chats.length === 0 && <div className="muted small convo-empty">No conversations yet</div>}
            {chats.map((c) => (
              <button type="button" role="option" aria-selected={c.id === current?.id} key={c.id} className={c.id === current?.id ? 'on' : ''} onClick={() => (onPick(c.id), setOpen(false))}>
                <span className="grow">
                  <span className="clamp-1">{c.title}</span>
                  <span className="muted small">
                    {c.archived ? 'Archived · ' : ''}
                    {c.source === 'slack' ? 'Slack · ' : ''}
                    {c.visibility === 'shared' ? 'Shared · ' : ''}
                    {c.last_message_at ? `${dayLabel(c.last_message_at)} ${clock(c.last_message_at)}` : 'No messages yet'}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      {error && <span className="text-red small">{error}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- the chat

const HEADER_MENU = (current, actions, startRename) => [
  { label: 'Rename', icon: 'edit', hidden: !current?.can_manage, onSelect: startRename },
  current?.can_manage ? 'sep' : null,
  current?.archived
    ? { label: 'Restore', icon: 'archive', hidden: !actions?.restore, onSelect: () => actions.restore(current) }
    : { label: 'Archive', icon: 'archive', hidden: !actions?.archive, onSelect: () => actions.archive(current) },
];

/**
 * chatId / onSelectChat: the selected conversation, when a parent keeps it (the agent page puts it in
 * the address). Without them, the chat keeps it itself (Inbox). toolbar: extra buttons on the right.
 * workspace: the agent workspace layout (title, sharing, status strip; the parent shows the history).
 *   actions: { rename, share, archive, restore } for the open conversation; headerStart: buttons at
 *   the left of the header (show the history); onOpenFile(ref, filename) / onOpenTask(id): open beside
 *   the chat; referenceRequest: { nonce, ref, filename, quote? } adds a file reference to the draft;
 *   refreshKey: bump after the parent changed a conversation.
 */
export default function Chat({
  agent, claudeReady, chatId: selectedProp, onSelectChat, onShownChat, toolbar, compact,
  workspace, actions, headerStart, onOpenFile, onOpenTask, referenceRequest, refreshKey,
}) {
  const live = useContext(LiveContext);
  const { openComposer } = useTaskUI();
  const { data: me } = useApi('/me');
  const { data: peopleList } = useApi('/people');
  const people = useMemo(() => new Map((Array.isArray(peopleList) ? peopleList : peopleList?.people ?? []).map((p) => [p.email, p])), [peopleList]);
  const { data: chats, setData: setChats, reload: reloadChats } = useApi(`/agents/${agent.id}/chats`, ['chat']);
  useEffect(() => {
    if (refreshKey) reloadChats();
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Which conversation: the parent's, else the last one this person opened here, else their latest
  // active one. Archived conversations open only when asked for (a link, the history, search).
  const email = me?.email;
  const [ownSelected, setOwnSelected] = useState(null);
  const wanted = (onSelectChat ? selectedProp : ownSelected) ?? (email ? Number(store.get(lastChatKey(email, agent.id))) || null : null);
  const remembered = !(onSelectChat ? selectedProp : ownSelected);
  const found = chats?.find((c) => c.id === Number(wanted));
  const current = me && chats ? ((remembered && found?.archived ? null : found) ?? (wanted === 'new' ? null : chats.find((c) => !c.archived) ?? null)) : null;
  const chatId = current?.id ?? null;
  const ready = Boolean(chats && me);
  const select = useCallback(
    (id) => {
      if (email) store.set(lastChatKey(email, agent.id), id && id !== 'new' ? String(id) : null);
      if (onSelectChat) onSelectChat(id);
      else setOwnSelected(id);
    },
    [agent.id, onSelectChat, email],
  );
  useEffect(() => {
    if (chatId && email) store.set(lastChatKey(email, agent.id), String(chatId));
    if (ready) onShownChat?.(chatId, current);
  }, [agent.id, chatId, ready, current?.archived, current?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  // Messages of the selected conversation, a page at a time.
  const [thread, setThread] = useState({ chatId: null, messages: [], hasMore: false, loading: false, error: '' });
  const scroller = useRef(null);
  const atBottom = useRef(true);
  const keepFromBottom = useRef(null); // restoring position after loading earlier messages
  const [unseen, setUnseen] = useState(0);

  const load = useCallback(async (id) => {
    if (!id) return setThread({ chatId: null, messages: [], hasMore: false, loading: false, error: '' });
    setThread({ chatId: id, messages: [], hasMore: false, loading: true, error: '' });
    try {
      const page = await api(`/chats/${id}/messages?limit=50`);
      atBottom.current = true;
      setThread((t) => (t.chatId === id ? { chatId: id, messages: page.messages, hasMore: page.has_more, loading: false, error: '' } : t));
    } catch (err) {
      setThread((t) => (t.chatId === id ? { ...t, loading: false, error: err.message } : t));
    }
  }, []);
  useEffect(() => {
    load(chatId);
    setUnseen(0);
  }, [chatId, load]);

  const loadEarlier = async () => {
    if (!thread.hasMore || thread.loading || !thread.messages.length) return;
    const el = scroller.current;
    keepFromBottom.current = el ? el.scrollHeight - el.scrollTop : null;
    setThread((t) => ({ ...t, loading: true }));
    try {
      const page = await api(`/chats/${chatId}/messages?limit=50&before=${thread.messages[0].id}`);
      setThread((t) => (t.chatId === chatId ? { ...t, messages: [...page.messages, ...t.messages], hasMore: page.has_more, loading: false } : t));
    } catch (err) {
      setThread((t) => ({ ...t, loading: false, error: err.message }));
    }
  };
  const fetchNewer = useCallback(async () => {
    const id = chatId;
    if (!id) return;
    const last = thread.messages.at(-1)?.id ?? 0;
    try {
      const page = await api(`/chats/${id}/messages?after=${last}`);
      if (!page.messages.length) return;
      setThread((t) => {
        if (t.chatId !== id) return t;
        const known = new Set(t.messages.map((m) => m.id));
        const fresh = page.messages.filter((m) => !known.has(m.id));
        if (!atBottom.current) setUnseen((n) => n + fresh.filter((m) => m.sender !== 'user').length);
        return { ...t, messages: fresh.reduce(addMessage, t.messages) };
      });
    } catch {
      /* the next event or a reload catches up */
    }
  }, [chatId, thread.messages]);

  // The agent's activity in this conversation, refreshed when its runs change.
  const { data: activity, reload: reloadActivity } = useApi(chatId ? `/chats/${chatId}/activity` : null);

  // Live: new messages in this conversation (ids only; we fetch what we may see), run updates.
  const newerRef = useRef(fetchNewer);
  newerRef.current = fetchNewer;
  useEffect(() => {
    if (!live) return;
    let timer;
    return live.on((e) => {
      if (e.type === 'message' && e.agent_id === agent.id) {
        if (e.chat_id === chatId) newerRef.current();
        reloadChats();
      }
      if (e.type === 'run' && e.agent_id === agent.id && chatId) {
        clearTimeout(timer);
        timer = setTimeout(reloadActivity, 200);
      }
    });
  }, [live, agent.id, chatId, reloadChats, reloadActivity]);
  // After reconnecting, catch up on anything missed.
  useEffect(() => {
    if (live?.connected && chatId) (newerRef.current(), reloadActivity(), reloadChats());
  }, [live?.connected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scrolling: stay at the bottom only if the reader is there; keep position when loading earlier.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keepFromBottom.current != null) {
      el.scrollTop = el.scrollHeight - keepFromBottom.current;
      keepFromBottom.current = null;
    } else if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [thread.messages, activity]);
  const [reading, setReading] = useState(0); // bumps when the reader reaches the bottom
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const was = atBottom.current;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom.current) setUnseen(0);
    if (atBottom.current && !was) setReading((n) => n + 1);
    if (el.scrollTop < 60 && thread.hasMore && !thread.loading) loadEarlier();
  };
  const jumpToLatest = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    atBottom.current = true;
    setUnseen(0);
    setReading((n) => n + 1);
  };

  // Read position: what this person has actually had in view (at the bottom, page visible).
  const readUpTo = useRef({});
  useEffect(() => {
    const lastId = thread.chatId === chatId ? thread.messages.at(-1)?.id : null;
    if (!chatId || !lastId || !atBottom.current || document.visibilityState !== 'visible') return;
    if ((readUpTo.current[chatId] ?? 0) >= lastId) return;
    const t = setTimeout(() => {
      readUpTo.current[chatId] = lastId;
      api(`/chats/${chatId}/read`, { method: 'POST', body: { message_id: lastId } }).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [chatId, thread, reading]);

  // ------------------------------------------------ composing
  // Drafts (text and file references) per person and conversation, in this browser. Staged files
  // stay with their conversation while this page is open.
  const [draft, setDraft] = useState('');
  const [refs, setRefs] = useState([]);
  const [files, setFilesState] = useState([]); // [{ file, uploaded? }]
  const stagedByChat = useRef(new Map());
  const setFiles = (fn) =>
    setFilesState((fs) => {
      const next = typeof fn === 'function' ? fn(fs) : fn;
      stagedByChat.current.set(chatId ?? 'new', next);
      return next;
    });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null); // { text, retry? }
  const sending = useRef(false);
  const picker = useRef(null);
  const input = useRef(null);
  const voice = useVoiceNote();
  useEffect(() => {
    if (!email) return;
    let raw = store.get(draftKey(email, agent.id, chatId));
    if (raw == null && store.get(legacyDraftKey(agent.id, chatId)) != null) {
      // A draft from before drafts were kept per person: it becomes this person's.
      raw = store.get(legacyDraftKey(agent.id, chatId));
      store.set(draftKey(email, agent.id, chatId), writeDraft({ text: raw, refs: [] }));
      store.set(legacyDraftKey(agent.id, chatId), null);
    }
    const d = readDraft(raw);
    setDraft(d.text);
    setRefs(d.refs);
    setFilesState(stagedByChat.current.get(chatId ?? 'new') ?? []);
    setError(null);
  }, [agent.id, chatId, email]);
  const saveDraft = (text, list) => email && store.set(draftKey(email, agent.id, chatId), writeDraft({ text, refs: list }));
  const editDraft = (text) => {
    setDraft(text);
    saveDraft(text, refs);
  };
  const editRefs = (list) => {
    setRefs(list);
    saveDraft(draft, list);
  };
  // "Discuss" in the side panel: a reference chip in the draft, never sent until the person sends it.
  const lastRequest = useRef(null);
  useEffect(() => {
    if (!referenceRequest || referenceRequest.nonce === lastRequest.current || !email) return;
    lastRequest.current = referenceRequest.nonce;
    const { nonce, ...r } = referenceRequest; // eslint-disable-line no-unused-vars
    const same = (x) => x.ref === r.ref && (x.quote ?? '') === (r.quote ?? '');
    const list = refs.some(same) ? refs : [...refs, r].slice(-5);
    editRefs(list);
    setTimeout(() => input.current?.focus(), 30);
  }, [referenceRequest, email]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = activity?.run;
  const working = Boolean(run?.working);
  const claudePowered = ['claude', 'managed'].includes(agent.platform);
  const willReply = agent.status !== 'paused' && ((claudePowered && claudeReady) || agent.webhook_url);
  const archived = Boolean(current?.archived);

  const addFiles = (list) => {
    const picked = [...(list ?? [])];
    const tooBig = picked.find((f) => f.size > MAX_FILE);
    setError(tooBig ? { text: `${tooBig.name} is over 50 MB.` } : null);
    setFiles((fs) => [...fs, ...picked.filter((f) => f.size <= MAX_FILE).map((file) => ({ file }))]);
  };

  /** Make sure there's a conversation to write in (the first message starts one). */
  const ensureChat = async () => {
    if (chatId) return chatId;
    const created = await api(`/agents/${agent.id}/chats`, { method: 'POST', body: {} });
    setChats((cs) => [created, ...(cs ?? [])]);
    // The draft moves with it into the new conversation.
    if (email) {
      store.set(draftKey(email, agent.id, created.id), writeDraft({ text: draft, refs }));
      store.set(draftKey(email, agent.id, 'new'), null);
    }
    stagedByChat.current.set(created.id, stagedByChat.current.get('new') ?? []);
    stagedByChat.current.delete('new');
    select(created.id);
    return created.id;
  };

  const send = async (e) => {
    e?.preventDefault();
    const body = draft.trim();
    if ((!body && !files.length) || sending.current || archived) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const id = await ensureChat();
      const ids = [];
      for (const f of files) {
        if (!f.uploaded) f.uploaded = await uploadChatFile(agent.id, f.file, f.file.name);
        ids.push(f.uploaded.id);
      }
      const m = await api(`/chats/${id}/messages`, { method: 'POST', body: { body, file_ids: ids, refs: refs.map(({ ref, quote }) => ({ ref, ...(quote ? { quote } : {}) })) } });
      atBottom.current = true;
      setThread((t) => (t.chatId === id ? { ...t, messages: addMessage(t.messages, m) } : t));
      setDraft('');
      setRefs([]);
      if (email) store.set(draftKey(email, agent.id, id), null);
      stagedByChat.current.delete(id);
      setFilesState([]);
      setTimeout(reloadActivity, 300);
    } catch (err) {
      // Archived meanwhile (another tab): the draft stays; the banner explains.
      if (err.status === 409) reloadChats();
      setError({ text: `Not sent: ${err.message}`, retry: err.status !== 409 });
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!run?.id) return;
    try {
      await api(`/runs/${run.id}/interrupt`, { method: 'POST' });
      setTimeout(reloadActivity, 300);
    } catch (err) {
      setError({ text: `Couldn't stop: ${err.message}` });
    }
  };

  const startVoice = async () => {
    setError(null);
    try {
      await voice.start();
    } catch (err) {
      setError({ text: err.name === 'NotAllowedError' ? 'Allow the microphone for this site to record a voice note.' : err.message });
    }
  };
  const finishVoice = async (keep) => {
    setBusy(keep);
    try {
      const note = await voice.stop(keep);
      if (!note) return;
      if (!note.text) throw new Error("Couldn't make out any words. Try again a little closer to the mic.");
      const id = await ensureChat();
      const ext = note.blob.type.includes('mp4') ? 'm4a' : note.blob.type.includes('ogg') ? 'ogg' : 'webm';
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      const audio = await uploadChatFile(agent.id, note.blob, `Voice note ${stamp}.${ext}`, true);
      const m = await api(`/chats/${id}/messages`, { method: 'POST', body: { body: note.text, file_ids: [audio.id], voice: true } });
      atBottom.current = true;
      setThread((t) => (t.chatId === id ? { ...t, messages: addMessage(t.messages, m) } : t));
    } catch (err) {
      setError({ text: err.message });
    } finally {
      setBusy(false);
    }
  };

  // ------------------------------------------------ message actions
  const [lessonFrom, setLessonFrom] = useState(null);
  const taskFrom = (m) => {
    const link = `${location.origin}/#/agents/${agent.id}/chat/${chatId}`;
    openComposer({
      assignee: `agent:${agent.id}`,
      title: firstLine(m.body),
      description: m.body,
      source_message_id: m.id,
      links: [{ url: link, label: `Conversation with ${agent.name}: ${current?.title ?? ''}`.trim() }],
    });
  };

  const newConversation = () => {
    select('new');
    setTimeout(() => input.current?.focus(), 30);
  };

  // ------------------------------------------------ the workspace header: title, audience, sharing
  const [renaming, setRenaming] = useState(null);
  const [headError, setHeadError] = useState('');
  useEffect(() => (setRenaming(null), setHeadError('')), [chatId]);
  const doRename = async (e) => {
    e.preventDefault();
    try {
      await actions.rename(current, renaming);
      setRenaming(null);
      setHeadError('');
    } catch (err) {
      setHeadError(err.message);
    }
  };
  const doShare = async () => {
    try {
      await actions.share(current);
      setHeadError('');
    } catch (err) {
      setHeadError(err.message);
    }
  };
  const restoreAndReply = async () => {
    await actions?.restore(current);
    setTimeout(() => input.current?.focus(), 50);
  };

  const items = useMemo(() => timeline(thread.chatId === chatId ? thread.messages : [], activity?.blocks ?? []), [thread, chatId, activity]);
  const lastMsgId = [...items].reverse().find((i) => i.kind === 'msg' && i.m.sender !== 'system')?.id;
  const showTyping = working && !activity?.blocks?.some((b) => b.state === 'running' || b.state === 'approval');

  let hint = null;
  if (agent.status === 'paused') hint = `${agent.name} is paused. Messages are kept but not delivered until it's resumed.`;
  else if (claudePowered && !claudeReady) hint = 'Set ANTHROPIC_API_KEY on the server so Claude agents can reply.';
  else if (!willReply) hint = `${agent.name} has no webhook. It will pick messages up when it polls the Agent API.`;

  const workspaceHeader = (
    <div className="chat-head">
      <div className="chat-col chat-head-row">
        {headerStart}
        {renaming != null ? (
          <form className="convo-rename grow" onSubmit={doRename}>
            <input autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} aria-label="Conversation name" maxLength={80} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setRenaming(null))} />
            <button className="btn btn-sm btn-primary" disabled={!renaming.trim()}>
              Save
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setRenaming(null)}>
              Cancel
            </button>
          </form>
        ) : (
          <div className="grow chat-head-title">
            <h2 className="clamp-1" title={current?.title}>
              {current ? current.title : 'New conversation'}
            </h2>
            {current && (
              <span className={`scope-chip ${current.visibility}`} title={current.audience?.label}>
                <Icon name={current.visibility === 'shared' ? 'users' : 'lock'} size={13} />
                <span>{current.visibility === 'shared' ? current.audience?.label ?? 'Shared' : 'Private'}</span>
                <span className="sr-only">{current.visibility === 'shared' ? '' : current.audience?.label}</span>
              </span>
            )}
            {current?.archived && <span className="chip-soft">Archived</span>}
            {current?.source === 'slack' && <span className="chip-soft">Slack thread</span>}
          </div>
        )}
        {current?.can_manage && actions?.share && renaming == null && (
          <Menu
            label="Sharing"
            icon="users"
            text="Share"
            buttonClass="btn btn-sm"
            items={[
              current.visibility === 'shared'
                ? { label: 'Make private (you and workspace owners)', icon: 'lock', onSelect: doShare }
                : { label: 'Share with everyone in the workspace', icon: 'users', onSelect: doShare },
            ]}
          />
        )}
        {current && renaming == null && <Menu label="Conversation actions" items={HEADER_MENU(current, actions, () => setRenaming(current.title))} buttonClass="btn btn-sm icon-only" />}
        {toolbar}
      </div>
      {headError && (
        <div className="chat-col">
          <div className="chat-hint chat-error" role="alert">
            {headError}
          </div>
        </div>
      )}
    </div>
  );

  let lastDay = '';
  return (
    <div
      className={`chat ${compact ? 'chat-compact' : ''} ${workspace ? 'chat-ws' : ''}`}
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        addFiles(e.dataTransfer.files);
      }}
    >
      {workspace ? (
        workspaceHeader
      ) : (
        <div className="chat-toolbar">
          <div className="chat-col chat-toolbar-row">
            <ConversationPicker
              chats={chats ?? []}
              current={current}
              onPick={select}
              onChanged={(c) => setChats((cs) => cs.map((x) => (x.id === c.id ? c : x)))}
            />
            <div className="grow" />
            {toolbar}
            <button type="button" className="btn btn-primary" onClick={newConversation}>
              <Icon name="plus" size={16} /> <span className="hide-sm">New conversation</span>
            </button>
          </div>
        </div>
      )}

      {workspace && chatId && (
        <div className="chat-col">
          <StatusStrip chatId={chatId} agent={agent} onOpenTask={onOpenTask} onReply={() => input.current?.focus()} />
        </div>
      )}

      <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
        <div className="chat-col chat-thread" aria-live="polite">
          {thread.hasMore && (
            <button type="button" className="btn btn-sm load-earlier" onClick={loadEarlier} disabled={thread.loading}>
              {thread.loading ? 'Loading…' : 'Load earlier messages'}
            </button>
          )}
          {!ready && <div className="chat-empty muted">Loading conversations…</div>}
          {ready && !chatId && (
            <div className="chat-empty">
              <Avatar id={agent.id} name={agent.name} color={agent.color} size={48} />
              <strong>New conversation with {agent.name}</strong>
              <span className="muted small">It starts when you send the first message. Only you (and workspace owners) can see it unless you share it.</span>
            </div>
          )}
          {chatId && thread.loading && !thread.messages.length && <div className="chat-empty muted">Loading messages…</div>}
          {thread.error && (
            <div className="chat-hint chat-error">
              Couldn't load this conversation: {thread.error}{' '}
              <button type="button" className="link-btn" onClick={() => load(chatId)}>
                Try again
              </button>
            </div>
          )}
          {chatId && !thread.loading && !thread.error && thread.messages.length === 0 && <div className="chat-empty muted">No messages yet. Say hello to {agent.name}.</div>}
          {items.map((i) => {
            const day = dayLabel(i.at);
            const sep = day !== lastDay;
            lastDay = day;
            return (
              <Fragment key={`${i.kind}-${i.id}`}>
                {sep && (
                  <div className="day-sep" role="separator">
                    <span>{day}</span>
                  </div>
                )}
                {i.kind === 'msg' ? (
                  <Message m={i.m} agent={agent} me={me} people={people} onLesson={setLessonFrom} onTask={taskFrom} last={i.id === lastMsgId} onOpenFile={onOpenFile} onOpenTask={onOpenTask} />
                ) : (
                  <ActivityBlock block={i.b} agent={agent} onStop={i.b.run_id === run?.id && working ? stop : null} />
                )}
              </Fragment>
            );
          })}
          {showTyping && (
            <div className="msg theirs">
              <div className="msg-avatar">
                <Avatar id={agent.id} name={agent.name} color={agent.color} size={32} />
              </div>
              <div className="bubble typing" aria-label={`${agent.name} is working`}>
                <i />
                <i />
                <i />
              </div>
            </div>
          )}
          {run?.error && !working && !workspace && <div className="chat-hint chat-error">The last run stopped with an error: {run.error}</div>}
        </div>
      </div>

      {unseen > 0 && (
        <button type="button" className="jump-latest" onClick={jumpToLatest}>
          <Icon name="arrowDown" size={14} /> {unseen} new message{unseen === 1 ? '' : 's'}
        </button>
      )}

      <div className="chat-composer">
        <div className="chat-col">
          {archived && (
            <div className="archived-banner" role="status">
              <Icon name="archive" size={18} />
              <div className="grow">
                <strong>Archived</strong>
                <span className="muted small">Restore this conversation to continue chatting.{draft.trim() || refs.length || files.length ? ' Your draft is kept.' : ''}</span>
              </div>
              {actions?.restore && (
                <>
                  <button type="button" className="btn btn-sm" onClick={() => actions.restore(current)}>
                    Restore
                  </button>
                  <button type="button" className="btn btn-sm btn-primary" onClick={restoreAndReply}>
                    Restore and reply
                  </button>
                </>
              )}
            </div>
          )}
          {hint && <div className="chat-hint">{hint}</div>}
          {working && !workspace && (
            <div className="chat-note small">
              {agent.name} is working in this conversation. A message you send now is delivered to the running conversation; Stop ends only this run.
            </div>
          )}
          {error && (
            <div className="chat-hint chat-error" role="alert">
              {error.text}
              {error.retry && (
                <button type="button" className="link-btn" onClick={send}>
                  Retry
                </button>
              )}
            </div>
          )}
          {voice.recording ? (
            <div className="chat-box voice-bar">
              <button type="button" className="btn" onClick={() => finishVoice(false)} aria-label="Cancel voice note">
                <Icon name="x" size={16} />
              </button>
              <div className="voice-live grow">
                <span className="rec-dot" />
                <span className="voice-time">
                  {Math.floor(voice.recording.seconds / 60)}:{String(voice.recording.seconds % 60).padStart(2, '0')}
                </span>
                <span className={voice.recording.text ? '' : 'muted'}>
                  {voice.recording.text ? (voice.recording.text.length > 120 ? `…${voice.recording.text.slice(-120)}` : voice.recording.text) : 'Listening…'}
                </span>
              </div>
              <button type="button" className="btn btn-primary" onClick={() => finishVoice(true)} aria-label="Send voice note">
                <Icon name="send" size={16} />
              </button>
            </div>
          ) : (
            <form className={`chat-box ${archived ? 'is-archived' : ''}`} onSubmit={send}>
              {refs.length > 0 && (
                <div className="chat-staged" aria-label="Referring to">
                  {refs.map((r, i) => (
                    <RefChip key={`${r.ref}-${i}`} r={r} onOpen={onOpenFile} onRemove={() => editRefs(refs.filter((_, j) => j !== i))} />
                  ))}
                </div>
              )}
              {files.length > 0 && (
                <div className="chat-staged">
                  {files.map((f, i) => (
                    <span key={`${f.file.name}-${i}`} className="chat-chip">
                      <Icon name="file" size={13} />
                      <span className="clamp-1">{f.file.name}</span>
                      <span className="muted">{fileSize(f.file.size)}</span>
                      <button type="button" className="icon-btn" aria-label={`Remove ${f.file.name}`} onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}>
                        <Icon name="x" size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <textarea
                ref={input}
                rows={1}
                value={draft}
                placeholder={archived ? 'Restore this conversation to send a message.' : refs.length ? 'What do you want to ask about it?' : `Message ${agent.name}…`}
                aria-label={`Message ${agent.name}`}
                onChange={(e) => editDraft(e.target.value)}
                onPaste={(e) => e.clipboardData.files.length && (e.preventDefault(), addFiles(e.clipboardData.files))}
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter is a new line; never while an input method is composing.
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) send(e);
                }}
              />
              <div className="chat-tools">
                <input ref={picker} type="file" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
                <button type="button" className="icon-btn" onClick={() => picker.current?.click()} aria-label="Attach files" title="Attach files" disabled={busy}>
                  <Icon name="paperclip" size={18} />
                </button>
                {canRecord && (
                  <button type="button" className="icon-btn" onClick={startVoice} aria-label="Record a voice note" title="Record a voice note" disabled={busy || archived}>
                    <Icon name="mic" size={18} />
                  </button>
                )}
                <div className="grow" />
                {working && !workspace && (
                  <button type="button" className="btn btn-sm" onClick={stop} title="Stop this conversation's run (the agent stays on)">
                    <Icon name="stop" size={13} /> Stop
                  </button>
                )}
                <button
                  className="btn btn-primary send-btn"
                  disabled={busy || archived || (!draft.trim() && !files.length)}
                  aria-label="Send message"
                  title={archived ? 'Restore this conversation to send' : 'Send'}
                >
                  {busy ? <span className="spinner light" /> : <Icon name="send" size={18} />}
                </button>
              </div>
            </form>
          )}
          <div className="chat-keys">Enter to send · Shift + Enter for a new line</div>
        </div>
      </div>

      {lessonFrom && <LessonDialog agent={agent} chat={current} message={lessonFrom} onClose={() => setLessonFrom(null)} />}
    </div>
  );
}
