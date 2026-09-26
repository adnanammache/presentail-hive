import { useEffect, useState } from 'react';
import { addDaysISO, api, daysBetweenISO, dubaiToday, fmtDateTime, fmtDay, useApi } from '../api.js';
import { DateInput, Field, Icon, Modal, PLATFORM_LABELS, TASK_COLUMNS } from './ui.jsx';
import TaskRun, { uploadFiles } from './TaskRun.jsx';
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
  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      const blob = await squarePhoto(file);
      onChange(await api(`/agents/${agent.id}/photo`, { method: 'POST', raw: blob }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => onChange(await api(`/agents/${agent.id}/photo`, { method: 'DELETE' }));
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
const REMIND_OPTIONS = [
  ['none', 'None'],
  ['0', 'On the day'],
  ['7', '1 week before'],
  ['14', '2 weeks before'],
  ['custom', 'Custom…'],
];
const REPEAT_OPTIONS = [
  ['none', 'Does not repeat'],
  ['monthly', 'Monthly'],
  ['quarterly', 'Quarterly'],
  ['yearly', 'Yearly'],
  ['custom', 'Custom…'],
];
const repeatLabel = (r) => (!r ? '' : r.freq === 'custom' ? (r.every === 1 ? `every ${r.unit}` : `every ${r.every} ${r.unit}s`) : r.freq);

/** The panel's form state for a task (or template) → what the API takes. */
function scheduleBody(v) {
  const due = v.due_date || null;
  const remind =
    v.remind === 'auto' ? (due ? 14 : null) : v.remind === 'none' ? null : v.remind === 'custom' ? (v.remind_custom === '' ? null : Number(v.remind_custom)) : Number(v.remind);
  const repeat = v.repeat_freq === 'none' ? null : v.repeat_freq === 'custom' ? { freq: 'custom', every: Number(v.repeat_every) || 1, unit: v.repeat_unit } : { freq: v.repeat_freq };
  return {
    due_date: due,
    start_on: v.start_mode === 'date' ? v.start_on || null : null,
    remind_days: remind,
    repeat,
    ends_on: repeat ? v.ends_on || null : null,
  };
}

function formFromTask(task) {
  if (!task) return {};
  const r = task.repeat;
  const remind = task.remind_days == null ? 'none' : ['0', '7', '14'].includes(String(task.remind_days)) ? String(task.remind_days) : 'custom';
  return {
    start_mode: task.start_on && task.status === 'scheduled' ? 'date' : task.start_on ? 'date' : 'now',
    remind,
    remind_custom: remind === 'custom' ? String(task.remind_days) : '',
    repeat_freq: r ? r.freq : 'none',
    repeat_every: r?.every ?? 2,
    repeat_unit: r?.unit ?? 'week',
    ends_on: task.series_ends_on ?? '',
    needs_approval: Boolean(task.needs_approval),
    entity_id: task.entity_id ?? '',
  };
}

function formFromTemplate(t, v) {
  return {
    ...v,
    template_id: String(t.id),
    title: t.title || t.name,
    description: t.description ?? '',
    done_definition: t.done_definition ?? '',
    agent_id: t.agent_id ?? '',
    entity_id: t.entity_id ?? '',
    priority: t.priority ?? 'medium',
    repeat_freq: t.repeat ? t.repeat.freq : 'none',
    repeat_every: t.repeat?.every ?? 2,
    repeat_unit: t.repeat?.unit ?? 'week',
    remind: t.remind_days == null ? 'none' : ['0', '7', '14'].includes(String(t.remind_days)) ? String(t.remind_days) : 'custom',
    remind_custom: t.remind_days != null && !['0', '7', '14'].includes(String(t.remind_days)) ? String(t.remind_days) : '',
    needs_approval: Boolean(t.needs_approval),
    start_offset: t.start_offset_days,
    start_mode: t.start_offset_days != null ? 'date' : 'now',
    start_on: t.start_offset_days != null && v.due_date ? addDaysISO(v.due_date, -t.start_offset_days) : '',
  };
}

export function TaskForm({ task, defaults = {}, onClose }) {
  const { data: agents } = useApi('/agents', ['agent']);
  const { data: entities } = useApi('/entities', ['entity']);
  const { data: templates, reload: reloadTemplates } = useApi(task ? null : '/task-templates', ['template']);
  const [newFiles, setNewFiles] = useState([]);
  const [askScope, setAskScope] = useState(null); // the changes waiting for "Only this one" / "This and future ones"
  const [note, setNote] = useState('');
  const { values, set, submit, error, saving, setValues, setError } = useForm({
    title: '', description: '', done_definition: '', status: 'todo', priority: 'medium', agent_id: '', due_date: '', result: '', handoff_agent_id: '',
    entity_id: '', start_mode: 'now', start_on: '', remind: 'auto', remind_custom: '', repeat_freq: 'none', repeat_every: 2, repeat_unit: 'week',
    ends_on: '', needs_approval: true, start_offset: null, template_id: '',
    ...defaults,
    ...task,
    ...formFromTask(task),
  });
  const put = (key, value) => setValues((v) => ({ ...v, [key]: value }));
  const agent = agents?.find((a) => a.id === Number(values.agent_id));
  const defaultReviewer = agents?.find((a) => a.id === agent?.reviewer_id);
  const managed = agent?.platform === 'managed';
  const sched = scheduleBody(values);
  const repeating = Boolean(sched.repeat);

  // A template's start offset follows the due date: "start 18 days before it's due".
  const setDue = (due) =>
    setValues((v) => ({ ...v, due_date: due ?? '', ...(v.start_offset != null && due ? { start_mode: 'date', start_on: addDaysISO(due, -v.start_offset) } : {}) }));
  const setStart = (d) => setValues((v) => ({ ...v, start_on: d ?? '', start_offset: null }));

  const body = (v) => ({
    title: v.title, description: v.description, done_definition: v.done_definition, priority: v.priority, agent_id: numOrNull(v.agent_id),
    handoff_agent_id: numOrNull(v.handoff_agent_id), entity_id: numOrNull(v.entity_id), needs_approval: Boolean(v.needs_approval),
    ...scheduleBody(v),
  });

  const create = async (v, startNow) => {
    if (v.start_mode === 'date' && !v.start_on && !startNow) throw new Error('Pick the start date, or set Start to Now');
    const b = { ...body(v), status: v.status, start_now: startNow, ...(v.close_item_id ? { close_item_id: v.close_item_id, period: v.period } : {}) };
    if (managed) {
      // Managed agents need their files before they start.
      const created = await api('/tasks', { method: 'POST', body: { ...b, dispatch: false } });
      if (newFiles.length) await uploadFiles(created.id, newFiles);
      if (created.status !== 'scheduled' && agent.status !== 'paused') await api(`/tasks/${created.id}/runs`, { method: 'POST' });
    } else await api('/tasks', { method: 'POST', body: b });
    onClose();
  };

  const original = task ? { ...body({ ...values, ...task, ...formFromTask(task) }), status: task.status, result: task.result ?? '' } : null;
  const changes = (v) => {
    const now = { ...body(v), status: v.status, result: v.result ?? '' };
    return Object.fromEntries(Object.entries(now).filter(([k, x]) => JSON.stringify(x ?? null) !== JSON.stringify(original[k] ?? null)));
  };
  const saveEdit = async (changed, scope) => {
    if (Object.keys(changed).length) await api(`/tasks/${task.id}`, { method: 'PATCH', body: { ...changed, ...(scope ? { scope } : {}) } });
    onClose();
  };
  const save = submit(async (v) => {
    if (!task) return create(v, false);
    const changed = changes(v);
    // Only send what you changed: an agent may have updated status/result while this was open.
    const seriesChange = Object.keys(changed).some((k) => !['status', 'result'].includes(k));
    if (task.series_id && task.repeat && seriesChange && !('repeat' in changed)) return setAskScope(changed);
    return saveEdit(changed, 'repeat' in changed ? 'future' : undefined);
  });
  const startNow = submit((v) => create(v, true));

  const remove = async () => {
    if (!confirm('Delete this task?')) return;
    const stop = task.series_id && task.repeat && confirm('This task repeats. Stop the repeats too?\n\nOK: no more new ones.\nCancel: delete only this one; the next one is still created on schedule.');
    await api(`/tasks/${task.id}${stop ? '?stop_series=1' : ''}`, { method: 'DELETE' });
    onClose();
  };

  const saveTemplate = async () => {
    const name = prompt('Name this template', values.title || '');
    if (!name?.trim()) return;
    const v = values;
    const s = scheduleBody(v);
    const offset = v.start_mode === 'date' && v.start_on && v.due_date ? daysBetweenISO(v.start_on, v.due_date) : v.start_offset ?? null;
    try {
      const t = await api('/task-templates', {
        method: 'POST',
        body: {
          name, title: v.title, description: v.description, done_definition: v.done_definition, priority: v.priority, agent_id: numOrNull(v.agent_id),
          entity_id: numOrNull(v.entity_id), repeat: s.repeat, start_offset_days: offset != null && offset >= 0 ? offset : null, remind_days: s.remind_days, needs_approval: Boolean(v.needs_approval),
        },
      });
      await reloadTemplates();
      put('template_id', String(t.id));
    } catch (err) {
      setError(err.message);
    }
  };

  // What happens when you press Create (Dubai time: a start date today means 8:00 today).
  const dubaiHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  const waits = values.start_mode === 'date' && sched.start_on && (sched.start_on > dubaiToday() || (sched.start_on === dubaiToday() && dubaiHour < 8));
  const startText =
    !task &&
    (!agent
      ? waits
        ? `No agent yet: the task waits in Scheduled until ${fmtDay(sched.start_on)}.`
        : 'No agent yet: the task waits in To do.'
      : waits
        ? `${agent.name} will start on ${fmtDay(sched.start_on)} (8:00 Dubai time). "Create & start now" starts right away.`
        : `${agent.name} starts as soon as you create the task.`);
  const offsetNow = sched.due_date && (sched.start_on || !task) ? daysBetweenISO(sched.start_on || dubaiToday(), sched.due_date) : null;

  return (
    <Modal title={task ? `Task #${task.id}` : 'New task'} onClose={onClose} wide>
      <form onSubmit={save} className="form task-form">
        {!task && templates?.length > 0 && (
          <Field label="Start from template">
            <select
              value={values.template_id}
              onChange={(e) => {
                const t = templates.find((x) => String(x.id) === e.target.value);
                if (t) setValues((v) => formFromTemplate(t, v));
                else put('template_id', '');
              }}
            >
              <option value="">Blank task</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Title">
          <input value={values.title} onChange={set('title')} required autoFocus={!task} />
        </Field>
        <Field label="Instructions">
          <textarea rows={4} value={values.description} onChange={set('description')} placeholder="What should the agent do? Include links, amounts, deadlines…" />
        </Field>
        <Field label="Definition of done (optional)">
          <input value={values.done_definition} onChange={set('done_definition')} placeholder="e.g. Return drafted in Wafeq, summary sent to me." />
        </Field>
        <div className={task ? 'grid-4' : 'grid-3'}>
          <Field label="Agent">
            <AgentSelect value={values.agent_id} onChange={set('agent_id')} />
          </Field>
          <Field label="Entity">
            <select value={values.entity_id ?? ''} onChange={set('entity_id')}>
              <option value="">All / not entity-specific</option>
              {entities?.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select value={values.priority} onChange={set('priority')}>
              {['low', 'medium', 'high', 'urgent'].map((p) => (
                <option key={p} value={p}>
                  {p[0].toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
          </Field>
          {task && (
            <Field label="Status">
              <select value={values.status} onChange={set('status')}>
                {TASK_COLUMNS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        {values.agent_id && !task?.parent_task_id && (
          <Field label="Reviewed by" hint="When the agent says it's finished, this agent checks the work before it comes back to you.">
            <select value={values.handoff_agent_id ?? ''} onChange={set('handoff_agent_id')}>
              <option value="">{defaultReviewer ? `${defaultReviewer.name} (${agent.name}'s usual reviewer)` : 'Nobody, it comes straight to me'}</option>
              {agents
                ?.filter((a) => a.id !== Number(values.agent_id) && a.id !== defaultReviewer?.id)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.title}
                  </option>
                ))}
            </select>
          </Field>
        )}

        {!task?.parent_task_id && (
          <fieldset className="form-section">
            <legend>Schedule</legend>
            <div className="grid-3">
              <div className="field">
                <span className="field-label">Start</span>
                <div className="field-pair">
                  <select value={values.start_mode} onChange={set('start_mode')} aria-label="Start">
                    <option value="now">Now</option>
                    <option value="date">On a date</option>
                  </select>
                  {values.start_mode === 'date' && <DateInput value={values.start_on} onChange={setStart} label="Start date" />}
                </div>
              </div>
              <div className="field">
                <span className="field-label">Due</span>
                <DateInput value={values.due_date} onChange={setDue} label="Due date" placeholder="No due date" clearable />
              </div>
              <div className="field">
                <span className="field-label">Remind me</span>
                <div className="field-pair">
                  <select
                    value={values.remind === 'auto' ? (values.due_date ? '14' : 'none') : values.remind}
                    onChange={set('remind')}
                    aria-label="Remind me"
                    disabled={!values.due_date}
                    title={values.due_date ? undefined : 'Set a due date first'}
                  >
                    {REMIND_OPTIONS.map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                  {values.remind === 'custom' && (
                    <span className="inline-num">
                      <input type="number" min="0" max="365" value={values.remind_custom} onChange={set('remind_custom')} aria-label="Days before" /> days before
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="grid-3">
              <div className="field">
                <span className="field-label">Repeat</span>
                <div className="field-pair">
                  <select value={values.repeat_freq} onChange={set('repeat_freq')} aria-label="Repeat">
                    {REPEAT_OPTIONS.map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                  {values.repeat_freq === 'custom' && (
                    <span className="inline-num">
                      every <input type="number" min="1" max="366" value={values.repeat_every} onChange={set('repeat_every')} aria-label="Repeat every" />
                      <select value={values.repeat_unit} onChange={set('repeat_unit')} aria-label="Repeat unit">
                        <option value="day">days</option>
                        <option value="week">weeks</option>
                        <option value="month">months</option>
                      </select>
                    </span>
                  )}
                </div>
              </div>
              {repeating && (
                <div className="field">
                  <span className="field-label">Ends on (optional)</span>
                  <DateInput value={values.ends_on} onChange={(d) => put('ends_on', d ?? '')} label="Ends on" placeholder="Never" clearable />
                </div>
              )}
            </div>
            {repeating && (
              <p className="field-hint">
                {!values.due_date
                  ? 'Set a due date: it decides when each repeat is due.'
                  : `Repeats ${repeatLabel(sched.repeat)}. When this one is done, or its due date passes, the next one is created${
                      offsetNow != null && (values.start_mode === 'date' || !task) ? `, starting ${offsetNow === 0 ? 'on its due date' : `${offsetNow} day${offsetNow === 1 ? '' : 's'} before it's due`}` : ''
                    }.`}
              </p>
            )}
            {values.start_offset != null && !values.due_date && <p className="field-hint">This template starts {values.start_offset} days before the due date. Set the due date to fill in the start.</p>}
            <label className="check">
              <input type="checkbox" checked={Boolean(values.needs_approval)} onChange={set('needs_approval')} />
              Needs my approval before submitting or paying anything
            </label>
          </fieldset>
        )}

        {task?.series_id && <SeriesBar task={task} />}
        {task?.status === 'waiting_approval' && (
          <div className="approval task-approval">
            <div className="small strong">{task.agent_name ?? 'The agent'} is waiting for your approval before submitting or paying anything.</div>
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the agent (needed to send back)" />
            <div className="approval-actions">
              <button
                type="button"
                className="btn btn-sm btn-danger-ghost"
                disabled={!note.trim()}
                onClick={() => api(`/tasks/${task.id}/send-back`, { method: 'POST', body: { note } }).then(onClose, (e) => setError(e.message))}
              >
                Send back
              </button>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => api(`/tasks/${task.id}/approve`, { method: 'POST', body: { note } }).then(onClose, (e) => setError(e.message))}>
                <Icon name="check" size={13} /> Approve
              </button>
            </div>
          </div>
        )}
        {task?.approved_at && <p className="muted small">✓ Approved by {task.approved_by} on {fmtDateTime(task.approved_at, 'Asia/Dubai')}.</p>}
        {task && <HandoffBar taskId={task.id} />}
        {task && agent && <TeachBar agent={agent} taskId={task.id} />}
        {task && (
          <Field label="Result / agent report">
            <textarea rows={4} value={values.result} onChange={set('result')} placeholder="The agent's output lands here." />
          </Field>
        )}
        {!task && managed && (
          <Field label="Files for the agent" hint={values.files_hint ? `Attach: ${values.files_hint}` : "Statements, invoices, spreadsheets. They're placed in the agent's workspace."}>
            <div className="run-files">
              {newFiles.map((f) => (
                <span key={f.name} className="file-chip">
                  <Icon name="paperclip" size={13} /> {f.name}
                  <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setNewFiles((l) => l.filter((x) => x !== f))}>
                    <Icon name="x" size={12} />
                  </button>
                </span>
              ))}
              <label className="btn btn-sm">
                <Icon name="paperclip" size={14} /> Attach files
                <input type="file" multiple hidden onChange={(e) => setNewFiles((l) => [...l, ...e.target.files])} />
              </label>
            </div>
          </Field>
        )}
        {task?.workflow_name && <p className="muted small">Created by workflow “{task.workflow_name}”.</p>}
        {task?.status === 'scheduled' && task.start_on && <p className="muted small">Scheduled: {task.agent_name ?? 'the agent'} starts on {fmtDay(task.start_on)} at 8:00 Dubai time.</p>}
        {startText && <p className="muted small">{startText}</p>}

        {error && <div className="form-error">{error}</div>}
        {askScope ? (
          <div className="form-actions scope-ask">
            <span className="small strong">This task repeats. Apply your changes to:</span>
            <span className="spacer" />
            <button type="button" className="btn" disabled={saving} onClick={() => saveEdit(askScope, 'this').catch((e) => setError(e.message))}>
              Only this one
            </button>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => saveEdit(askScope, 'future').catch((e) => setError(e.message))}>
              This and future ones
            </button>
          </div>
        ) : (
          <div className="form-actions">
            {task ? (
              <button type="button" className="btn btn-danger-ghost" onClick={remove}>
                Delete
              </button>
            ) : (
              <button type="button" className="btn btn-ghost" onClick={saveTemplate}>
                Save as template
              </button>
            )}
            <span className="spacer" />
            {!task && (
              <button type="button" className="btn" disabled={saving} onClick={startNow}>
                Create &amp; start now
              </button>
            )}
            <button className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : task ? 'Save' : 'Create'}
            </button>
          </div>
        )}
      </form>
      {task && managed && Number(task.agent_id) === agent.id && <TaskRun task={task} agentName={agent.name} />}
    </Modal>
  );
}

/** Where this task sits in its repeating series, with links to the others. */
function SeriesBar({ task }) {
  const { data: siblings } = useApi(`/tasks?series_id=${task.series_id}`, ['task']);
  const list = (siblings ?? []).slice().sort((a, b) => a.series_index - b.series_index);
  return (
    <div className="handoff-bar series-bar">
      <Icon name="repeat" size={14} />
      <span>
        {task.repeat ? `Repeats ${repeatLabel(task.repeat)}` : 'Was a repeating task (stopped)'} · #{task.series_index}
        {task.series_ends_on ? ` · until ${fmtDay(task.series_ends_on)}` : ''}
      </span>
      {list.length > 1 && (
        <span className="series-links">
          {list.map((t) =>
            t.id === task.id ? (
              <b key={t.id}>{fmtDay(t.due_date)}</b>
            ) : (
              <a key={t.id} href={`#/tasks/${t.id}`} title={t.status}>
                {fmtDay(t.due_date)}
              </a>
            ),
          )}
        </span>
      )}
    </div>
  );
}

/** Turn a correction on this task into something the agent remembers. */
function TeachBar({ agent, taskId }) {
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
function HandoffBar({ taskId }) {
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
