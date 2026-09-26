import { useEffect, useState } from 'react';
import { api, fmtDateTime, useApi, useReloadPhotos } from '../api.js';
import { Field, Icon, Modal, PLATFORM_LABELS } from './ui.jsx';
import { recommendModel } from '../../shared/modelAdvice.js';
import BotAvatar from './BotAvatar.jsx';

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#3b82f6', '#ec4899', '#14b8a6'];

function useForm(initial) {
  const [values, setValues] = useState(initial);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (key) => (e) => setValues((v) => ({ ...v, [key]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));
  const submit = (fn) => async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await fn(values);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };
  return { values, set, submit, error, saving, setValues, setError };
}

function Actions({ saving, error, label = 'Save', onDelete }) {
  return (
    <>
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        {onDelete && (
          <button type="button" className="btn btn-danger-ghost" onClick={onDelete}>
            Delete
          </button>
        )}
        <span className="spacer" />
        <button className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : label}
        </button>
      </div>
    </>
  );
}

function AgentSelect({ value, onChange, allowNone = true }) {
  const { data: agents } = useApi('/agents', ['agent']);
  return (
    <select value={value ?? ''} onChange={onChange}>
      {allowNone && <option value="">Unassigned</option>}
      {agents?.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}

const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

// ---------------- Team ----------------
export function TeamForm({ team, onClose, onSaved }) {
  const { values, set, submit, error, saving } = useForm({ name: '', description: '', color: COLORS[1], ...team, budget: team?.budget_cents != null ? team.budget_cents / 100 : '' });
  const save = submit(async (v) => {
    const body = { name: v.name, description: v.description, color: v.color, budget: v.budget };
    const saved = team ? await api(`/teams/${team.id}`, { method: 'PATCH', body }) : await api('/teams', { method: 'POST', body });
    onSaved?.(saved);
    onClose();
  });
  const remove = async () => {
    if (!confirm(`Delete the ${team.name} team? Its agents stay, but without a team.`)) return;
    await api(`/teams/${team.id}`, { method: 'DELETE' });
    onClose();
  };
  return (
    <Modal title={team ? `Edit ${team.name}` : 'New team'} onClose={onClose}>
      <form onSubmit={save} className="form">
        <Field label="Team name">
          <input value={values.name} onChange={set('name')} required autoFocus placeholder="e.g. Finance" />
        </Field>
        <Field label="What this team does">
          <textarea rows={2} value={values.description} onChange={set('description')} />
        </Field>
        <Field label="Monthly AI budget (USD)" hint="For the whole team. Alert at 80%; new runs pause at 100% until you raise it. Leave empty for no limit.">
          <input type="number" min="0" step="1" inputMode="decimal" value={values.budget} onChange={set('budget')} placeholder="No limit" />
        </Field>
        <Field label="Colour">
          <Swatches value={values.color} onChange={set('color')} />
        </Field>
        <Actions saving={saving} error={error} label={team ? 'Save' : 'Create team'} onDelete={team ? remove : null} />
      </form>
    </Modal>
  );
}

function Swatches({ value, onChange }) {
  return (
    <div className="swatches">
      {COLORS.map((c) => (
        <button type="button" key={c} className={`swatch ${value === c ? 'on' : ''}`} style={{ background: c }} onClick={() => onChange(c)} aria-label={c} />
      ))}
    </div>
  );
}

// ---------------- Agent ----------------
const NEW_TEAM = '__new';

export function AgentForm({ agent, defaults = {}, onClose, onSaved }) {
  const { data: teams } = useApi('/teams', ['agent']);
  const { data: modelList } = useApi('/models');
  const models = modelList?.models ?? [];
  const { data: allAgents } = useApi('/agents', ['agent']);
  const { values, set, submit, error, saving } = useForm({
    name: '', title: '', team_id: '', new_team: '', description: '', platform: 'claude', model: '', system_prompt: '', webhook_url: '', color: COLORS[0], status: 'idle', reviewer_id: '',
    ...defaults,
    ...agent,
    budget: agent?.budget_cents != null ? agent.budget_cents / 100 : '',
  });
  const rec = recommendModel({ title: values.title, description: values.description, integrations: values.integrations });
  const save = submit(async (v) => {
    let teamId = v.team_id;
    if (teamId === NEW_TEAM) {
      if (!v.new_team.trim()) throw new Error('Give the new team a name');
      teamId = (await api('/teams', { method: 'POST', body: { name: v.new_team, color: v.color } })).id;
    }
    const body = {
      name: v.name, title: v.title, team_id: numOrNull(teamId), description: v.description, platform: v.platform,
      model: v.model, system_prompt: v.system_prompt, webhook_url: v.webhook_url, color: v.color, status: v.status,
      reviewer_id: numOrNull(v.reviewer_id),
      budget: v.budget,
    };
    const saved = agent ? await api(`/agents/${agent.id}`, { method: 'PATCH', body }) : await api('/agents', { method: 'POST', body });
    onSaved?.(saved);
    onClose();
  });
  const [current, setCurrent] = useState(agent);
  return (
    <Modal title={agent ? `Edit ${agent.name}` : 'New agent'} onClose={onClose} wide>
      <form onSubmit={save} className="form">
        {current ? (
          <div className="field">
            <span className="field-label">Photo</span>
            <PhotoField agent={current} onChange={(a) => (setCurrent(a), onSaved?.(a))} />
          </div>
        ) : (
          <p className="muted small">You can add a photo once the agent is created.</p>
        )}
        <div className="grid-2">
          <Field label="Name">
            <input value={values.name} onChange={set('name')} required autoFocus placeholder="e.g. Ledger" />
          </Field>
          <Field label="Title" hint="Their job title, e.g. Month-End Accountant.">
            <input value={values.title} onChange={set('title')} required placeholder="e.g. Month-End Accountant (UAE)" />
          </Field>
          <Field label="Team">
            <select value={values.team_id ?? ''} onChange={set('team_id')} required={!agent}>
              <option value="" disabled>
                Choose a team…
              </option>
              {teams?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
              <option value={NEW_TEAM}>+ New team…</option>
            </select>
          </Field>
          {values.team_id === NEW_TEAM ? (
            <Field label="New team name">
              <input value={values.new_team} onChange={set('new_team')} autoFocus placeholder="e.g. Operations" />
            </Field>
          ) : (
            <span className="grid-spacer" />
          )}
          <Field label="Platform" hint="Claude Managed Agents do real work with skills and tools; set them up in the agent's Skills & tools tab.">
            <select value={values.platform} onChange={set('platform')}>
              {Object.entries(PLATFORM_LABELS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select value={values.status} onChange={set('status')}>
              <option value="active">Active</option>
              <option value="idle">Idle</option>
              <option value="paused">Paused (receives nothing)</option>
              <option value="error">Error</option>
            </select>
          </Field>
        </div>
        <Field label="Description">
          <textarea rows={2} value={values.description} onChange={set('description')} />
        </Field>
        <Field label="Monthly AI budget (USD)" hint="Alert at 80%; new runs pause at 100% until you raise it. Leave empty for no limit.">
          <input type="number" min="0" step="1" inputMode="decimal" value={values.budget} onChange={set('budget')} placeholder="No limit" />
        </Field>
        <Field label="Work reviewed by" hint="When this agent finishes a task, it goes to this agent to check before it comes to you.">
          <select value={values.reviewer_id ?? ''} onChange={set('reviewer_id')}>
            <option value="">Nobody, it comes straight to me</option>
            {allAgents
              ?.filter((a) => a.id !== agent?.id)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.title}
                </option>
              ))}
          </select>
        </Field>
        {['claude', 'managed'].includes(values.platform) ? (
          <>
            <Field label="Model" hint={<ModelHint models={models} value={values.model} rec={rec} onUse={() => set('model')(rec.model)} />}>
              <ModelSelect models={models} value={values.model} onChange={set('model')} recommended={rec.model} />
            </Field>
            <Field label="System prompt">
              <textarea rows={4} value={values.system_prompt} onChange={set('system_prompt')} placeholder="You are … Your job is …" />
            </Field>
          </>
        ) : (
          <Field label="Webhook URL" hint="Messages, tasks and workflow runs are POSTed here as JSON. Reply with {&quot;reply&quot;: &quot;…&quot;} to answer in the chat.">
            <input type="url" value={values.webhook_url} onChange={set('webhook_url')} placeholder="https://hook.eu1.make.com/…" />
          </Field>
        )}
        <Field label="Colour">
          <Swatches value={values.color} onChange={set('color')} />
        </Field>
        <Actions saving={saving} error={error} label={agent ? 'Save' : 'Add agent'} />
      </form>
    </Modal>
  );
}

// ---------------- Photo ----------------
/** Centre-crop to a square and shrink to 512px in the browser, so uploads are small and uniform. */
async function squarePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That file isn't an image this browser can read"));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const out = Math.min(512, side);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = out;
    canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'; // PNG keeps transparency
    return await new Promise((resolve) => canvas.toBlob(resolve, type, 0.88));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Upload or remove the agent's photo; it replaces the robot face everywhere, Slack included. */
function PhotoField({ agent, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reloadPhotos = useReloadPhotos();
  const done = (a) => (onChange(a), reloadPhotos());
  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      const blob = await squarePhoto(file);
      done(await api(`/agents/${agent.id}/photo`, { method: 'POST', raw: blob }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => done(await api(`/agents/${agent.id}/photo`, { method: 'DELETE' }));
  return (
    <div className="photo-field">
      <BotAvatar id={agent.id} name={agent.name} color={agent.color} size={64} />
      <div className="photo-actions">
        <label className={`btn btn-sm ${busy ? 'disabled' : ''}`}>
          {busy ? 'Uploading…' : agent.photo_version ? 'Change photo' : 'Upload photo'}
          <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={pick} disabled={busy} />
        </label>
        {agent.photo_version ? (
          <button type="button" className="btn btn-sm btn-danger-ghost" onClick={remove}>
            Remove
          </button>
        ) : null}
        <span className="muted small">PNG, JPEG or WebP. Cropped to a square. Shown in Hive and Slack.</span>
        {error && <span className="small" style={{ color: 'var(--red)' }}>{error}</span>}
      </div>
    </div>
  );
}

// ---------------- Models ----------------
const effectiveModel = (models, value) => models.find((x) => x.id === value) ?? models.find((x) => x.default);

/** What the chosen model is for, and which one suits this agent (with a one-click switch). */
function ModelHint({ models, value, rec, onUse }) {
  const m = effectiveModel(models, value);
  const recName = models.find((x) => x.id === rec.model)?.name ?? rec.model;
  const usingRec = (m?.id ?? '') === rec.model;
  return (
    <>
      {m && [m.note, m.price && `${m.price} per million tokens (in / out)`].filter(Boolean).join(' · ')}
      <span className={`model-rec ${usingRec ? 'ok' : ''}`}>
        {usingRec ? '★ Recommended for this agent: ' : `★ Recommended for this agent: ${recName}, `}
        {rec.why}.
        {!usingRec && (
          <button type="button" className="linkish model-use" onClick={onUse}>
            Use {recName}
          </button>
        )}
      </span>
    </>
  );
}

/** Claude models from Anthropic's live list; "Default" follows Hive's default model. */
function ModelSelect({ models, value, onChange, recommended }) {
  const def = models.find((m) => m.default);
  const known = !value || models.some((m) => m.id === value);
  const star = (id) => (id === recommended ? ' · ★ Recommended' : '');
  return (
    <select value={value ?? ''} onChange={onChange}>
      <option value="">
        Default{def ? ` (${def.name})` : ''}
        {def ? star(def.id) : ''}
      </option>
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
          {m.price ? ` · ${m.price}` : ''}
          {star(m.id)}
        </option>
      ))}
      {!known && <option value={value}>{value} (current)</option>}
    </select>
  );
}

// ---------------- Task ----------------
/** Turn a correction on this task into something the agent remembers. */
export function TeachBar({ agent, taskId }) {
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const teach = async () => {
    await api(`/agents/${agent.id}/lessons`, { method: 'POST', body: { text, task_id: taskId } });
    setSaved(text);
    setText('');
  };
  return (
    <div className="handoff-bar teach-bar">
      <span>🧠</span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), text.trim() && teach())}
        placeholder={saved ? `${agent.name} will remember: "${saved}"` : `Something ${agent.name} should remember next time?`}
        aria-label={`Teach ${agent.name}`}
      />
      <button type="button" className="btn btn-sm" disabled={!text.trim()} onClick={teach}>
        Teach
      </button>
    </div>
  );
}

/** Where this task sits in a review chain, and a one-click hand-off. */
export function HandoffBar({ taskId }) {
  const { data: t } = useApi(`/tasks/${taskId}`, ['task']);
  const { data: agents } = useApi('/agents', ['agent']);
  const [to, setTo] = useState('');
  const [msg, setMsg] = useState('');
  if (!t) return null;
  if (t.parent_task_id)
    return (
      <div className="handoff-bar">
        🔎 This is a review of <a href={`#/tasks/${t.parent_task_id}`}>{t.parent_title}</a>. The verdict is added to that task.
      </div>
    );
  if (t.handoff_task_id)
    return (
      <div className="handoff-bar">
        → Handed to <b>{t.handoff_agent_name}</b> for review:{' '}
        <a href={`#/tasks/${t.handoff_task_id}`}>
          {{ todo: 'waiting to start', in_progress: 'reviewing now', review: 'review needs you', blocked: 'review blocked', done: 'review done' }[t.handoff_status] ?? 'open the review'}
        </a>
      </div>
    );
  if (!t.agent_id || t.status === 'done') return null;
  const pick = to || t.reviewer_id || '';
  const send = async () => {
    setMsg('');
    try {
      await api(`/tasks/${taskId}/handoff`, { method: 'POST', body: { agent_id: Number(pick) } });
    } catch (err) {
      setMsg(err.message);
    }
  };
  return (
    <div className="handoff-bar">
      <span>Hand off for review to</span>
      <select value={pick} onChange={(e) => setTo(e.target.value)} aria-label="Reviewer">
        <option value="" disabled>
          Choose…
        </option>
        {agents
          ?.filter((a) => a.id !== t.agent_id)
          .map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {a.title}
            </option>
          ))}
      </select>
      <button type="button" className="btn btn-sm" disabled={!pick} onClick={send}>
        Send now
      </button>
      {msg && <span className="small" style={{ color: 'var(--red)' }}>{msg}</span>}
    </div>
  );
}

// ---------------- Workflow ----------------
const PRESETS = [
  { label: 'Every weekday 8:00', value: '0 8 * * 1-5' },
  { label: 'Every day 9:00', value: '0 9 * * *' },
  { label: 'Every Monday 9:00', value: '0 9 * * 1' },
  { label: '1st of month 9:00', value: '0 9 1 * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 15 min', value: '*/15 * * * *' },
];
const TIMEZONES = ['Asia/Dubai', 'Asia/Beirut', 'Europe/Nicosia', 'Europe/London', 'UTC', 'America/New_York'];

export function WorkflowForm({ workflow, defaults = {}, onClose }) {
  const { values, set, submit, error, saving } = useForm({
    name: '', description: '', agent_id: '', schedule: '0 9 * * 1-5', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', instructions: '', enabled: true,
    ...defaults,
    ...workflow,
  });
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    const t = setTimeout(() => api('/schedule/preview', { method: 'POST', body: { schedule: values.schedule, timezone: values.timezone } }).then(setPreview, () => {}), 250);
    return () => clearTimeout(t);
  }, [values.schedule, values.timezone]);

  const save = submit(async (v) => {
    const body = { name: v.name, description: v.description, agent_id: numOrNull(v.agent_id), schedule: v.schedule.trim(), timezone: v.timezone, instructions: v.instructions, enabled: Boolean(v.enabled) };
    if (workflow) await api(`/workflows/${workflow.id}`, { method: 'PATCH', body });
    else await api('/workflows', { method: 'POST', body });
    onClose();
  });
  const remove = async () => {
    if (!confirm('Delete this workflow and its run history?')) return;
    await api(`/workflows/${workflow.id}`, { method: 'DELETE' });
    onClose();
  };
  const tzs = TIMEZONES.includes(values.timezone) ? TIMEZONES : [values.timezone, ...TIMEZONES];
  return (
    <Modal title={workflow ? `Edit “${workflow.name}”` : 'New recurring workflow'} onClose={onClose} wide>
      <form onSubmit={save} className="form">
        <div className="grid-2">
          <Field label="Name">
            <input value={values.name} onChange={set('name')} required autoFocus={!workflow} placeholder="e.g. Talabat month-end" />
          </Field>
          <Field label="Agent">
            <AgentSelect value={values.agent_id} onChange={set('agent_id')} />
          </Field>
        </div>
        <Field label="Short description">
          <input value={values.description} onChange={set('description')} />
        </Field>
        <Field label="Instructions sent on every run" hint="Each run creates a task with these instructions and sends it to the agent.">
          <textarea rows={4} value={values.instructions} onChange={set('instructions')} />
        </Field>
        <div className="grid-2">
          <Field label="Schedule (cron)" hint="minute hour day-of-month month day-of-week">
            <input value={values.schedule} onChange={set('schedule')} className="mono" required />
          </Field>
          <Field label="Timezone">
            <select value={values.timezone} onChange={set('timezone')}>
              {tzs.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="chips">
          {PRESETS.map((p) => (
            <button type="button" key={p.value} className={`chip ${values.schedule === p.value ? 'on' : ''}`} onClick={() => set('schedule')(p.value)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className={`schedule-preview ${preview?.ok === false ? 'bad' : ''}`}>
          {preview?.ok === false ? preview.error : preview?.next?.length ? <>Next runs ({values.timezone}): {preview.next.map((d) => fmtDateTime(d, values.timezone)).join(' · ')}</> : '…'}
        </div>
        <label className="toggle-row">
          <input type="checkbox" checked={Boolean(values.enabled)} onChange={set('enabled')} /> Enabled
        </label>
        <Actions saving={saving} error={error} label={workflow ? 'Save' : 'Create workflow'} onDelete={workflow ? remove : null} />
      </form>
    </Modal>
  );
}
