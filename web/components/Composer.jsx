// The New task composer: a floating, non-modal panel in the bottom-right (a full-screen sheet on
// phones). Its draft is saved on the server for the signed-in person, so minimizing, closing or
// reloading never loses it; it never appears on a board or notifies anyone until it's submitted.
//
// What the main button does depends on who it's for:
//   nobody     "Create task"      creates it, notifies nobody, starts nothing
//   a person   "Create & assign"  creates it and notifies them (they haven't started yet)
//   an agent   "Create & start"   creates it and asks the agent to start; "Save task" doesn't start it
import { useEffect, useRef, useState } from 'react';
import { api, fmtDay, useApi } from '../api.js';
import { DateInput, Icon } from './ui.jsx';
import { AssigneePicker, PRIORITY_LABELS, STAGES, useAssignees } from './work.jsx';
import { SCHEDULE_DEFAULTS, ScheduleFields, formFromTemplate, scheduleBody, withDue } from './schedule.jsx';

const newKey = () => `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const BLANK = {
  title: '', description: '', done_definition: '', assignee: null, project_id: '', due_date: '', priority: 'medium', status: 'backlog',
  entity_id: '', reviewer: null, needs_approval: false, template_id: '', links: [], ...SCHEDULE_DEFAULTS,
};
const hasContent = (v, files) => Boolean(v?.title?.trim() || v?.description?.trim() || v?.done_definition?.trim() || v?.links?.length || files?.length);

async function uploadDraftFile(file) {
  const res = await fetch('/api/task-draft/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Couldn't attach ${file.name}`);
  return data;
}

export default function Composer({ request, onClosed, onCreated }) {
  // request: { nonce, defaults } each time someone asks to open it.
  const [mode, setMode] = useState('closed'); // closed | open | minimized
  const [expanded, setExpanded] = useState(false);
  const [values, setValues] = useState(null); // null until the draft is loaded
  const [files, setFiles] = useState([]);
  const [save, setSave] = useState({ state: 'idle' }); // idle | saving | saved | error
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [link, setLink] = useState('');
  const [uploading, setUploading] = useState(false);
  const dirty = useRef(false);
  const title = useRef(null);
  const saveTimer = useRef(null);
  const { people, agents } = useAssignees();
  const { data: projects } = useApi(mode === 'closed' ? null : '/projects', ['project']);
  const { data: entities } = useApi(mode === 'closed' ? null : '/entities', ['entity']);
  const { data: templates } = useApi(mode === 'closed' ? null : '/task-templates', ['template']);

  // Open (or bring back) the composer, restoring the saved draft.
  useEffect(() => {
    if (!request) return;
    setMode('open');
    setError('');
    (async () => {
      let draft = { data: null, files: [] };
      try {
        draft = await api('/task-draft');
      } catch (err) {
        setSave({ state: 'error', message: `Couldn't load your draft: ${err.message}` });
      }
      const d = request.defaults ?? {};
      if (hasContent(draft.data, draft.files)) {
        setValues({ ...BLANK, ...draft.data });
        setNote(draft.data.project_id && d.project_id && String(draft.data.project_id) !== String(d.project_id) ? 'Restored your unsent draft. Discard it to start a new task here.' : 'Restored your unsent draft.');
        setSave({ state: 'saved' });
      } else {
        const preset = {
          ...BLANK,
          client_key: newKey(),
          ...(d.project_id ? { project_id: String(d.project_id) } : {}),
          ...(d.status ? { status: d.status } : {}),
          ...(d.assignee ? { assignee: d.assignee } : {}),
          ...(d.title ? { title: d.title } : {}),
          ...(d.description ? { description: d.description } : {}),
          ...(d.due_date ? { due_date: d.due_date } : {}),
          ...(d.close_item_id ? { close_item_id: d.close_item_id, period: d.period, files_hint: d.files_hint } : {}),
        };
        setValues(preset);
        setNote('');
        setSave({ state: 'idle' });
        dirty.current = Boolean(d.title || d.description);
      }
      setFiles(draft.files ?? []);
      setTimeout(() => title.current?.focus(), 30);
    })();
  }, [request?.nonce]);

  const put = (patch) => {
    dirty.current = true;
    setValues((v) => ({ ...v, ...(typeof patch === 'function' ? patch(v) : patch) }));
  };

  // Save the draft a moment after each change. "Draft saved" only once the server has it.
  const saveNow = async (v = values) => {
    clearTimeout(saveTimer.current);
    if (!v || !dirty.current) return true;
    setSave({ state: 'saving' });
    try {
      await api('/task-draft', { method: 'PUT', body: { data: v } });
      dirty.current = false;
      setSave({ state: 'saved' });
      return true;
    } catch (err) {
      setSave({ state: 'error', message: err.message });
      return false;
    }
  };
  useEffect(() => {
    if (!values || !dirty.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveNow(values), 800);
    return () => clearTimeout(saveTimer.current);
  }, [values]);

  const close = async () => {
    await saveNow();
    setMode('closed');
    onClosed?.();
  };
  const discard = async () => {
    if (hasContent(values, files) && !confirm('Discard this draft? Its text and attached files are deleted.')) return;
    clearTimeout(saveTimer.current);
    await api('/task-draft', { method: 'DELETE' }).catch(() => {});
    dirty.current = false;
    setFiles([]);
    setValues({ ...BLANK, client_key: newKey() });
    setNote('');
    setSave({ state: 'idle' });
    setMode('closed');
    onClosed?.();
  };

  const attach = async (list) => {
    setUploading(true);
    setError('');
    try {
      for (const f of list) {
        const saved = await uploadDraftFile(f);
        setFiles((x) => [...x, saved]);
      }
      dirty.current = true;
      await saveNow();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };
  const addLink = () => {
    const url = link.trim();
    if (!url) return;
    if (!/^https?:\/\/\S+$/i.test(url)) return setError('Links must start with http:// or https://');
    put((v) => ({ links: [...(v.links ?? []), { url, label: '' }] }));
    setLink('');
    setError('');
  };

  const who = values?.assignee ? [...people, ...agents].find((x) => x.ref === values.assignee) : null;
  const kind = who?.type === 'agent' ? 'agent' : who?.type === 'user' ? 'person' : 'none';

  const submit = async ({ start }) => {
    if (busy) return;
    if (!values.title.trim()) {
      setError('Give the task a title');
      title.current?.focus();
      return;
    }
    if (values.start_mode === 'date' && !values.start_on && !start) return setError('Pick the start date, or set Start to “When started”');
    setBusy(true);
    setError('');
    clearTimeout(saveTimer.current);
    const v = values;
    const reviewer = v.reviewer;
    const body = {
      title: v.title.trim(),
      description: v.description,
      done_definition: v.done_definition,
      assignee: v.assignee || null,
      project_id: v.project_id ? Number(v.project_id) : null,
      priority: v.priority,
      status: start ? undefined : v.start_mode === 'date' && v.start_on ? undefined : v.status,
      entity_id: v.entity_id ? Number(v.entity_id) : null,
      needs_approval: Boolean(v.needs_approval),
      reviewer_email: reviewer?.startsWith('user:') ? reviewer.slice(5) : null,
      handoff_agent_id: reviewer?.startsWith('agent:') ? Number(reviewer.slice(6)) : null,
      links: v.links,
      draft_file_ids: files.map((f) => f.id),
      client_key: v.client_key || newKey(),
      from_draft: true,
      start: Boolean(start),
      ...scheduleBody(v),
      ...(v.close_item_id ? { close_item_id: v.close_item_id, period: v.period } : {}),
    };
    try {
      const task = await api('/tasks', { method: 'POST', body });
      dirty.current = false;
      setFiles([]);
      setValues({ ...BLANK, client_key: newKey() });
      setNote('');
      setSave({ state: 'idle' });
      setMode('closed');
      onCreated?.(task);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Escape minimizes (the draft stays).
  const onKey = (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      setMode('minimized');
    }
  };

  if (mode === 'closed' || !values) return null;

  const saveText = { saving: 'Saving…', saved: 'Draft saved', error: "Couldn't save draft", idle: '' }[save.state];
  const project = projects?.find((p) => String(p.id) === String(values.project_id));

  if (mode === 'minimized')
    return (
      <div className="task-composer-min" role="region" aria-label="New task (minimized)">
        <button type="button" className="composer-min-open" onClick={() => (setMode('open'), setTimeout(() => title.current?.focus(), 30))}>
          <Icon name="plus" size={15} /> <span className="clamp-1">{values.title.trim() || 'New task'}</span>
        </button>
        <span className="small muted">{saveText}</span>
        <button type="button" className="icon-btn sm" aria-label="Close composer (keeps the draft)" onClick={close}>
          <Icon name="x" size={15} />
        </button>
      </div>
    );

  const primary =
    kind === 'agent'
      ? { label: busy ? 'Starting…' : `Create & start`, start: true }
      : kind === 'person'
        ? { label: busy ? 'Assigning…' : 'Create & assign', start: false }
        : { label: busy ? 'Creating…' : 'Create task', start: false };

  return (
    <section className={`task-composer ${expanded ? 'expanded' : ''}`} role="dialog" aria-modal="false" aria-labelledby="composer-title" onKeyDown={onKey}>
      <header className="composer-head">
        <h2 id="composer-title">New task</h2>
        <span className={`draft-state ${save.state}`} role="status" aria-live="polite" title={save.message}>
          {saveText}
        </span>
        <span className="spacer" />
        <button type="button" className="icon-btn sm" aria-label="Minimize" title="Minimize" onClick={() => setMode('minimized')}>
          <Icon name="minimize" size={15} />
        </button>
        <button type="button" className="icon-btn sm composer-expand" aria-label={expanded ? 'Shrink' : 'Expand'} title={expanded ? 'Shrink' : 'Expand'} onClick={() => setExpanded((x) => !x)}>
          <Icon name={expanded ? 'collapse' : 'expand'} size={15} />
        </button>
        <button type="button" className="icon-btn sm" aria-label="Close (keeps the draft)" title="Close (keeps the draft)" onClick={close}>
          <Icon name="x" size={15} />
        </button>
      </header>

      <div className="composer-body">
        {note && (
          <div className="composer-note small">
            {note}{' '}
            <button type="button" className="link-btn" onClick={discard}>
              Discard draft
            </button>
          </div>
        )}
        <label className="field">
          <span className="field-label">Task title</span>
          <input ref={title} value={values.title} onChange={(e) => put({ title: e.target.value })} placeholder="What needs doing?" maxLength={300} />
        </label>
        <div className="composer-row">
          <div className="field">
            <label className="field-label" htmlFor="composer-assignee">
              Assign to
            </label>
            <AssigneePicker id="composer-assignee" value={values.assignee} onChange={(ref) => put({ assignee: ref })} />
          </div>
          <label className="field">
            <span className="field-label">Project</span>
            <select value={values.project_id} onChange={(e) => put({ project_id: e.target.value })}>
              <option value="">No project</option>
              {projects
                ?.filter((p) => p.can_contribute || String(p.id) === String(values.project_id))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span className="field-label">Description</span>
          <textarea
            rows={expanded ? 8 : 3}
            value={values.description}
            onChange={(e) => put({ description: e.target.value })}
            placeholder={expanded ? 'The brief: context, amounts, links, what good looks like…' : 'Add details, context or steps…'}
          />
        </label>
        {expanded && (
          <label className="field">
            <span className="field-label">Expected result (optional)</span>
            <input value={values.done_definition} onChange={(e) => put({ done_definition: e.target.value })} placeholder="e.g. Return drafted in Wafeq, summary sent to me." />
          </label>
        )}
        <div className="field">
          <span className="field-label">Files and links</span>
          <div className="attach-row">
            {files.map((f) => (
              <span key={f.id} className="file-chip">
                <Icon name="paperclip" size={13} /> {f.filename}
                <button type="button" aria-label={`Remove ${f.filename}`} onClick={() => api(`/task-draft/files/${f.id}`, { method: 'DELETE' }).then(() => setFiles((x) => x.filter((y) => y.id !== f.id)))}>
                  <Icon name="x" size={12} />
                </button>
              </span>
            ))}
            {values.links?.map((l, i) => (
              <span key={`${l.url}-${i}`} className="file-chip">
                <Icon name="link" size={13} /> <span className="clamp-1">{l.url.replace(/^https?:\/\//, '')}</span>
                <button type="button" aria-label={`Remove link ${l.url}`} onClick={() => put((v) => ({ links: v.links.filter((_, j) => j !== i) }))}>
                  <Icon name="x" size={12} />
                </button>
              </span>
            ))}
            <label className="attach-drop">
              <Icon name="paperclip" size={14} /> {uploading ? 'Uploading…' : 'Add files'}
              <input type="file" multiple hidden onChange={(e) => (attach([...e.target.files]), (e.target.value = ''))} />
            </label>
            <span className="link-add">
              <Icon name="link" size={14} />
              <input value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addLink())} placeholder="Paste a link" aria-label="Link" />
              {link && (
                <button type="button" className="link-btn" onClick={addLink}>
                  Add
                </button>
              )}
            </span>
          </div>
          {values.files_hint && <span className="field-hint">Attach: {values.files_hint}</span>}
        </div>
        <div className="composer-row">
          <div className="field">
            <span className="field-label">Due date</span>
            <DateInput value={values.due_date} onChange={(d) => put((v) => withDue(v, d))} label="Due date" placeholder="No due date" clearable />
          </div>
          <label className="field">
            <span className="field-label">Priority</span>
            <select value={values.priority} onChange={(e) => put({ priority: e.target.value })}>
              {Object.entries(PRIORITY_LABELS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>

        <button type="button" className="more-toggle" aria-expanded={more} onClick={() => setMore((m) => !m)}>
          <Icon name="chevron" size={14} /> More options
        </button>
        {more && (
          <div className="composer-more">
            {templates?.length > 0 && (
              <label className="field">
                <span className="field-label">Start from template</span>
                <select
                  value={values.template_id}
                  onChange={(e) => {
                    const t = templates.find((x) => String(x.id) === e.target.value);
                    if (t) put((v) => formFromTemplate(t, v));
                  }}
                >
                  <option value="">None</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!expanded && (
              <label className="field">
                <span className="field-label">Expected result</span>
                <input value={values.done_definition} onChange={(e) => put({ done_definition: e.target.value })} placeholder="e.g. Return drafted in Wafeq, summary sent to me." />
              </label>
            )}
            <div className="composer-row">
              <label className="field">
                <span className="field-label">Stage</span>
                <select value={values.status} onChange={(e) => put({ status: e.target.value })} disabled={kind === 'agent'} title={kind === 'agent' ? '“Create & start” puts it In progress; “Save task” keeps this stage.' : undefined}>
                  {STAGES.filter((s) => ['backlog', 'ready'].includes(s.id)).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Entity</span>
                <select value={values.entity_id} onChange={(e) => put({ entity_id: e.target.value })}>
                  <option value="">All / not entity-specific</option>
                  {entities?.map((en) => (
                    <option key={en.id} value={en.id}>
                      {en.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="field">
              <span className="field-label">Reviewer</span>
              <AssigneePicker label="Reviewer" value={values.reviewer} onChange={(ref) => put({ reviewer: ref })} />
              <span className="field-hint">Who checks the work in Needs review. If nobody is set, it comes back to you.</span>
            </div>
            <ScheduleFields values={values} put={put} canStart={kind === 'agent'} />
          </div>
        )}
      </div>

      <footer className="composer-foot">
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        {kind === 'person' && <p className="composer-hint small muted">{who.name} will be notified. They haven't started yet.</p>}
        {kind === 'agent' && (
          <p className="composer-hint small muted">
            {values.start_mode === 'date' && values.start_on
              ? `“Save task” schedules ${who.name} to start on ${fmtDay(values.start_on)} (8:00 Dubai). “Create & start” starts now.`
              : `“Create & start” asks ${who.name} to begin now. “Save task” saves it without starting.`}
          </p>
        )}
        {project && <p className="composer-hint small muted">In {project.name}.</p>}
        <div className="composer-actions">
          {kind === 'agent' ? (
            <>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={async () => (await saveNow(), setMode('closed'), onClosed?.())}>
                Save draft
              </button>
              <span className="spacer" />
              <button type="button" className="btn" disabled={busy} onClick={() => submit({ start: false })}>
                Save task
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={async () => (await saveNow(), setMode('closed'), onClosed?.())}>
                Save draft
              </button>
              <span className="spacer" />
            </>
          )}
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => submit({ start: primary.start })}>
            {primary.label}
          </button>
        </div>
      </footer>
    </section>
  );
}
