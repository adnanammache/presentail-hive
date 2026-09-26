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

const fileSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function Bubble({ m, agent }) {
  const time = toDate(m.created_at)?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const meta = m.meta ? JSON.parse(m.meta) : null;
  if (m.sender === 'system') {
    return (
      <div className="msg-system">
        <span>{m.body}</span>
        <time>{time}</time>
        {meta?.type === 'approval' && <ApprovalButtons meta={meta} />}
      </div>
    );
  }
  const mine = m.sender === 'user';
  const files = meta?.files ?? [];
  const recording = files.find((f) => f.voice);
  const attached = files.filter((f) => !f.voice);
  return (
    <div className={`msg ${mine ? 'mine' : ''}`}>
      {!mine && <Avatar name={agent.name} color={agent.color} size={28} />}
      <div className="bubble">
        {meta?.voice && (
          <div className="bubble-voice">
            <span className="voice-label">
              <Icon name="mic" size={13} /> Voice note
            </span>
            {recording && <audio controls preload="none" src={`/api/chat-files/${recording.id}`} />}
          </div>
        )}
        <div className="bubble-text">{m.body}</div>
        {attached.length > 0 && (
          <div className="bubble-files">
            {attached.map((f) => (
              <a key={f.id} className="bubble-file" href={`/api/chat-files/${f.id}`} download={f.filename}>
                <Icon name="file" size={14} />
                <span className="grow">{f.filename}</span>
                <span className="bubble-file-size">{fileSize(f.size)}</span>
              </a>
            ))}
          </div>
        )}
        <time>
          {mine && meta?.via === 'slack' && `${meta.user ?? 'Someone'} via Slack · `}
          {time}
        </time>
      </div>
    </div>
  );
}

/** Upload one file for the chat; it is sent with the next message. */
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

/**
 * A voice note: records the audio (kept in Hive to play back) and transcribes it live with the
 * browser's speech recognition. The transcript is what the agent reads.
 */
function useVoiceNote() {
  const [state, setState] = useState(null); // { seconds, text } while recording
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
    // Chrome ends recognition after a pause: carry on until the person stops.
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

  /** Stop recording. Returns { blob, text } (after the last words are transcribed), or null if cancelled. */
  const stop = async (keep) => {
    const v = ref.current;
    if (!v) return null;
    ref.current = null;
    v.active = false;
    clearInterval(v.timer);
    const ended = new Promise((resolve) => {
      v.ended = resolve;
      setTimeout(resolve, 2500); // don't wait forever for the last words
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

export default function Chat({ agent, claudeReady }) {
  const { data: messages, setData } = useApi(`/agents/${agent.id}/messages`);
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
  }, [messages?.length, waiting]);

  const claudePowered = ['claude', 'managed'].includes(agent.platform);
  const willReply = agent.status !== 'paused' && ((claudePowered && claudeReady) || agent.webhook_url);
  const [files, setFiles] = useState([]); // staged, not yet uploaded
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const picker = useRef(null);
  const voice = useVoiceNote();

  const addFiles = (list) => {
    const picked = [...(list ?? [])];
    const tooBig = picked.find((f) => f.size > MAX_FILE);
    if (tooBig) setError(`${tooBig.name} is over 50 MB.`);
    else setError('');
    setFiles((fs) => [...fs, ...picked.filter((f) => f.size <= MAX_FILE)]);
  };

  const post = async (body, fileIds = [], extra = {}) => {
    const m = await api(`/agents/${agent.id}/messages`, { method: 'POST', body: { body, file_ids: fileIds, ...extra } });
    setData((ms) => (ms.some((x) => x.id === m.id) ? ms : [...ms, m]));
    if (willReply) setWaiting(true);
  };

  const send = async (e) => {
    e.preventDefault();
    const body = draft.trim();
    if ((!body && !files.length) || busy) return;
    setBusy(true);
    setError('');
    try {
      const ids = [];
      for (const f of files) ids.push((await uploadChatFile(agent.id, f, f.name)).id);
      await post(body, ids);
      setDraft('');
      setFiles([]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const startVoice = async () => {
    setError('');
    try {
      await voice.start();
    } catch (err) {
      setError(err.name === 'NotAllowedError' ? 'Allow the microphone for this site to record a voice note.' : err.message);
    }
  };
  const finishVoice = async (keep) => {
    setBusy(keep);
    try {
      const note = await voice.stop(keep);
      if (!note) return;
      if (!note.text) throw new Error("Couldn't make out any words. Try again a little closer to the mic.");
      const ext = note.blob.type.includes('mp4') ? 'm4a' : note.blob.type.includes('ogg') ? 'ogg' : 'webm';
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      const audio = await uploadChatFile(agent.id, note.blob, `Voice note ${stamp}.${ext}`, true);
      await post(note.text, [audio.id], { voice: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  let hint = null;
  if (agent.status === 'paused') hint = `${agent.name} is paused — messages are stored but not delivered.`;
  else if (claudePowered && !claudeReady) hint = 'Set ANTHROPIC_API_KEY on the server so Claude agents can reply.';
  else if (!willReply) hint = `${agent.name} has no webhook — it will pick messages up when it polls the Agent API.`;

  return (
    <div
      className="chat"
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        addFiles(e.dataTransfer.files);
      }}
    >
      <div className="chat-scroll" ref={scroller}>
        {messages?.length === 0 && <div className="chat-empty">Start the conversation with {agent.name}.</div>}
        {messages?.map((m) => (
          <Bubble key={m.id} m={m} agent={agent} />
        ))}
        {waiting && (
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
      {error && <div className="chat-hint chat-error">{error}</div>}
      {files.length > 0 && (
        <div className="chat-staged">
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="chat-chip">
              <Icon name="file" size={13} />
              {f.name}
              <span className="muted">{fileSize(f.size)}</span>
              <button type="button" className="icon-btn" aria-label={`Remove ${f.name}`} onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}>
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {voice.recording ? (
        <div className="composer voice-bar">
          <button type="button" className="btn" onClick={() => finishVoice(false)} aria-label="Cancel voice note">
            <Icon name="x" size={16} />
          </button>
          <div className="voice-live grow">
            <span className="rec-dot" />
            <span className="voice-time">
              {Math.floor(voice.recording.seconds / 60)}:{String(voice.recording.seconds % 60).padStart(2, '0')}
            </span>
            <span className={voice.recording.text ? '' : 'muted'}>{voice.recording.text ? (voice.recording.text.length > 120 ? `…${voice.recording.text.slice(-120)}` : voice.recording.text) : 'Listening…'}</span>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => finishVoice(true)} aria-label="Send voice note">
            <Icon name="send" size={16} />
          </button>
        </div>
      ) : (
        <form className="composer" onSubmit={send}>
          <input ref={picker} type="file" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
          <button type="button" className="btn btn-ghost" onClick={() => picker.current?.click()} aria-label="Attach files" title="Attach files" disabled={busy}>
            <Icon name="paperclip" size={16} />
          </button>
          <textarea
            rows={1}
            value={draft}
            placeholder={busy ? 'Sending…' : `Message ${agent.name}…  (start with "remember:" to teach it)`}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => e.clipboardData.files.length && (e.preventDefault(), addFiles(e.clipboardData.files))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) send(e);
            }}
          />
          {canRecord && !draft.trim() && !files.length ? (
            <button type="button" className="btn btn-primary" onClick={startVoice} aria-label="Record a voice note" title="Record a voice note" disabled={busy}>
              <Icon name="mic" size={16} />
            </button>
          ) : (
            <button className="btn btn-primary" disabled={busy || (!draft.trim() && !files.length)} aria-label="Send">
              <Icon name="send" size={16} />
            </button>
          )}
        </form>
      )}
    </div>
  );
}
