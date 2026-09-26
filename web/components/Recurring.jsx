// Recurring tasks: the list (an agent's Tasks → Recurring, the Workflows page, My tasks), the
// create/edit form with the People / AI agents picker, and the details with run history.
// One source of truth on the server: /api/workflows (see server/schedules.js).
import { useEffect, useId, useMemo, useState } from 'react';
import { ago, api, fmtDay, useApi } from '../api.js';
import { Badge, DateInput, Empty, Field, Icon, Loading, Modal } from './ui.jsx';
import { AssigneeChip, AssigneePicker, useTaskUI } from './work.jsx';

export const RECUR_STATUS = {
  active: { label: 'Active', tone: 'green' },
  paused: { label: 'Paused', tone: 'amber' },
  ended: { label: 'Ended', tone: 'neutral' },
  error: { label: 'Error', tone: 'red' },
};
const OUTCOMES = {
  done: { label: 'Done', tone: 'green' },
  open: { label: 'Open', tone: 'blue' },
  pending: { label: 'Due', tone: 'blue' },
  retrying: { label: 'Retrying start', tone: 'amber' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'red' },
};
const TRIGGERS = { schedule: 'Scheduled', catchup: 'Late (Hive was offline)', manual: 'Run now', api: 'API' };
const MODE_SHORT = { create_and_start: 'Create & start', create_only: 'Create only' };
const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TIMEZONES = ['Asia/Dubai', 'Asia/Beirut', 'Europe/Nicosia', 'Europe/London', 'UTC', 'America/New_York'];
const WORKSPACE_TZ = 'Asia/Dubai';

/** "Mon 5 Oct, 9:00 AM" in the schedule's own zone. */
export const fmtIn = (iso, tz) =>
  iso ? new Date(iso).toLocaleString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).replace(' at ', ', ') : '—';

// ---------------------------------------------------------------- actions

function useActions(onDone) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const act = (fn) => async () => {
    setBusy(true);
    setError(null);
    try {
      onDone?.(await fn());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return {
    error,
    busy,
    clear: () => setError(null),
    pause: (s) => act(() => api(`/workflows/${s.id}/pause`, { method: 'POST' })),
    resume: (s) => act(() => api(`/workflows/${s.id}/resume`, { method: 'POST' })),
    runNow: (s) => act(() => api(`/workflows/${s.id}/run`, { method: 'POST', body: { key: `ui-${s.id}-${Date.now()}` } })),
    cancel: (s) => act(() => (confirm(`Cancel “${s.title}”?\n\nNo more tasks will be created. Tasks it already made, and their history, stay.`) ? api(`/workflows/${s.id}/cancel`, { method: 'POST' }) : null)),
  };
}

function ActionButtons({ s, actions, onEdit, onOpen, compact }) {
  return (
    <>
      {onOpen && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onOpen(s)}>
          Details
        </button>
      )}
      {s.can_manage && s.status !== 'ended' && (
        <>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onEdit(s)}>
            <Icon name="edit" size={14} /> Edit
          </button>
          {s.status === 'active' ? (
            <button type="button" className="btn btn-sm btn-ghost" disabled={actions.busy} onClick={actions.pause(s)}>
              Pause
            </button>
          ) : (
            <button type="button" className="btn btn-sm btn-ghost" disabled={actions.busy} onClick={actions.resume(s)}>
              Resume
            </button>
          )}
          <button type="button" className="btn btn-sm" disabled={actions.busy} onClick={actions.runNow(s)} title="Create an extra task now; the regular schedule doesn't move">
            <Icon name="play" size={14} /> Run now
          </button>
          {!compact && (
            <button type="button" className="btn btn-sm btn-danger-ghost" disabled={actions.busy} onClick={actions.cancel(s)}>
              Cancel recurrence
            </button>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- list

/** The table of recurring tasks. */
export function RecurringList({ schedules, onOpen, onEdit, hideAssignee }) {
  const actions = useActions();
  return (
    <>
      {actions.error && (
        <div className="form-error" role="alert">
          {actions.error}{' '}
          <button type="button" className="link-btn" onClick={actions.clear}>
            Dismiss
          </button>
        </div>
      )}
      <div className="table-wrap">
        <table className="table recurring-table">
          <thead>
            <tr>
              <th>Recurring task</th>
              {!hideAssignee && <th>Assigned to</th>}
              <th>Frequency</th>
              <th>Next run</th>
              <th>Last run</th>
              <th>Status</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => (
              <tr key={s.id} className={s.status === 'ended' ? 'disabled' : ''}>
                <td>
                  <button type="button" className="linkish row-title" onClick={() => onOpen(s)}>
                    {s.title}
                  </button>
                  <div className="row-sub">
                    {MODE_SHORT[s.mode]}
                    {s.project && <> · {s.project.name}</>}
                    {s.created_by && <> · by {s.created_by.name}</>}
                  </div>
                </td>
                {!hideAssignee && (
                  <td>
                    <AssigneeChip assignee={s.assignee} size={22} compact />
                  </td>
                )}
                <td>
                  {s.recurrence}
                  <div className="row-sub">{s.timezone}</div>
                </td>
                <td>
                  {s.next_run_at ? (
                    <>
                      {fmtIn(s.next_run_at, s.timezone)}
                      <div className="row-sub">{s.timezone}</div>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  {s.last_run ? (
                    <>
                      <Badge tone={OUTCOMES[s.last_run.outcome]?.tone}>{OUTCOMES[s.last_run.outcome]?.label ?? s.last_run.outcome}</Badge>
                      <div className="row-sub">{fmtIn(s.last_run.scheduled_for ?? s.last_run.started_at, s.timezone)}</div>
                    </>
                  ) : (
                    <span className="muted">Never</span>
                  )}
                </td>
                <td>
                  <Badge tone={RECUR_STATUS[s.status]?.tone}>{RECUR_STATUS[s.status]?.label ?? s.status}</Badge>
                  {(s.status_reason && s.status === 'error') || s.warning ? <div className="row-sub text-red">{s.status === 'error' ? s.status_reason : s.warning}</div> : null}
                </td>
                <td className="actions">
                  <ActionButtons s={s} actions={actions} onEdit={onEdit} compact />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * A list with its own New / Edit / Details handling. `query` filters it (e.g. "agent_id=3");
 * `defaults` pre-fill a new one (e.g. the agent as assignee).
 */
export function RecurringSection({ query = '', defaults, emptyText, hideAssignee, newLabel = 'New recurring task' }) {
  const { data: schedules } = useApi(`/workflows${query ? `?${query}` : ''}`, ['workflow', 'task']);
  const { openSchedule } = useTaskUI();
  const [editing, setEditing] = useState(null);
  return (
    <div className="recurring">
      <div className="tab-actions">
        <p className="muted small grow">Each occurrence creates a normal task. Edits apply to future occurrences only.</p>
        <button type="button" className="btn btn-primary" onClick={() => setEditing({ defaults })}>
          <Icon name="plus" size={16} /> {newLabel}
        </button>
      </div>
      {!schedules ? (
        <Loading />
      ) : schedules.length === 0 ? (
        <Empty title="No recurring tasks">{emptyText ?? 'Set one up here, or ask an agent in chat, e.g. “Every Monday at 9 AM, check outstanding supplier invoices.”'}</Empty>
      ) : (
        <RecurringList schedules={schedules} hideAssignee={hideAssignee} onOpen={(s) => openSchedule(s.id)} onEdit={(s) => setEditing({ schedule: s })} />
      )}
      {editing && <RecurringForm schedule={editing.schedule} defaults={editing.defaults} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- form

const blank = {
  title: '', instructions: '', expected_result: '', assignee: null, mode: 'create_and_start', project_id: '',
  freq: 'weekly', time: '09:00', interval: 1, weekdays: ['mon'], only_weekdays: false, month_day: '1', months: [], month: '1', start_month: '', missing_day: 'last_day', cron: '',
  timezone: WORKSPACE_TZ, starts_on: '', end_kind: 'never', ends_on: '', max_occurrences: '',
  deadline_kind: 'none', deadline_days: 0, period_kind: 'none', period_months: 3, period_anchor: '12',
  overlap_policy: '', missed_policy: 'run_latest', priority: 'medium', needs_approval: false, remind_days: '',
};

function formFrom(s) {
  if (!s) return blank;
  const r = s.rule ?? {};
  return {
    ...blank,
    title: s.title, instructions: s.instructions ?? '', expected_result: s.expected_result ?? '', assignee: s.assignee?.ref ?? null, mode: s.mode,
    project_id: s.project_id ?? '', timezone: s.timezone, starts_on: s.starts_on ?? '',
    freq: r.freq === 'daily' || r.freq === 'weekly' || r.freq === 'monthly' || r.freq === 'quarterly' || r.freq === 'yearly' ? r.freq : 'cron',
    cron: r.freq === 'cron' ? r.expr : '',
    time: r.time ?? '09:00', interval: r.interval ?? 1,
    weekdays: r.weekdays ?? ['mon'], only_weekdays: r.freq === 'daily' && Boolean(r.weekdays),
    month_day: String(r.month_day ?? 1), months: r.freq === 'monthly' ? r.months ?? [] : [], month: String(r.months?.[0] ?? 1), start_month: r.freq === 'quarterly' ? String(r.months?.[0] ?? '') : '',
    missing_day: r.missing_day ?? 'last_day',
    end_kind: s.ends_on ? 'on' : s.max_occurrences ? 'after' : 'never', ends_on: s.ends_on ?? '', max_occurrences: s.max_occurrences ?? '',
    deadline_kind: s.deadline_rule?.kind ?? 'none', deadline_days: s.deadline_rule?.days ?? 0,
    period_kind: s.period_rule?.kind ?? 'none', period_months: s.period_rule?.months ?? 3, period_anchor: String(s.period_rule?.anchor_month ?? 12),
    overlap_policy: s.overlap_policy, missed_policy: s.missed_policy, priority: s.priority, needs_approval: s.needs_approval, remind_days: s.remind_days ?? '',
  };
}

function ruleFrom(v) {
  const time = v.time || '09:00';
  if (v.freq === 'cron') return { freq: 'cron', expr: v.cron };
  if (v.freq === 'daily') return v.only_weekdays ? { freq: 'daily', time, weekdays: v.weekdays } : { freq: 'daily', time, interval: Number(v.interval) || 1 };
  if (v.freq === 'weekly') return { freq: 'weekly', time, weekdays: v.weekdays, interval: Number(v.interval) || 1 };
  const month_day = v.month_day === 'last' ? 'last' : Number(v.month_day);
  const missing = month_day !== 'last' && month_day >= 29 ? { missing_day: v.missing_day } : {};
  if (v.freq === 'monthly') return { freq: 'monthly', time, month_day, ...(v.months.length && v.months.length < 12 ? { months: v.months } : {}), ...missing };
  if (v.freq === 'quarterly') return { freq: 'quarterly', time, month_day, ...(v.start_month ? { start_month: Number(v.start_month) } : {}), ...missing };
  return { freq: 'yearly', time, month_day, month: Number(v.month), ...missing };
}
const periodFrom = (v) =>
  v.period_kind === 'none' ? null : v.period_kind === 'previous_months' ? { kind: 'previous_months', months: Number(v.period_months) } : v.period_kind === 'anchored' ? { kind: 'anchored', months: Number(v.period_months), anchor_month: Number(v.period_anchor) } : { kind: v.period_kind };
const deadlineFrom = (v) => (v.deadline_kind === 'none' ? null : { kind: v.deadline_kind, days: Number(v.deadline_days) || 0 });

function Toggles({ options, value, onChange, label }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map(([k, l]) => {
        const on = value.includes(k);
        return (
          <button type="button" key={k} className={`chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== k) : [...value, k])}>
            {l}
          </button>
        );
      })}
    </div>
  );
}

/** Create or edit a recurring task. */
export function RecurringForm({ schedule, defaults, onClose, onSaved }) {
  const [v, setV] = useState(() => ({ ...formFrom(schedule), ...(schedule ? {} : defaults ?? {}) }));
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null);
  const [clientKey] = useState(() => `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const { data: projects } = useApi('/projects');
  const put = (k) => (e) => setV((x) => ({ ...x, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));
  const ids = { assignee: useId() };
  const person = String(v.assignee ?? '').startsWith('user:');
  const mode = person ? 'create_only' : v.mode;
  const overlap = v.overlap_policy || (person ? 'always_create' : 'skip_if_running');
  const rule = useMemo(() => ruleFrom(v), [v]);
  const period = periodFrom(v);
  const deadline = deadlineFrom(v);

  useEffect(() => {
    const t = setTimeout(() => {
      api('/schedule/preview', {
        method: 'POST',
        body: { rule, timezone: v.timezone, starts_on: v.starts_on || undefined, ends_on: v.end_kind === 'on' ? v.ends_on || undefined : undefined, period_rule: period, deadline_rule: deadline, count: 5, max_occurrences: v.end_kind === 'after' ? v.max_occurrences || undefined : undefined },
      }).then(setPreview, (err) => setPreview({ ok: false, error: err.message }));
    }, 250);
    return () => clearTimeout(t);
  }, [JSON.stringify(rule), v.timezone, v.starts_on, v.ends_on, v.end_kind, v.max_occurrences, JSON.stringify(period), JSON.stringify(deadline)]);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const body = {
      title: v.title.trim(), instructions: v.instructions, expected_result: v.expected_result, assignee: v.assignee, mode, project_id: v.project_id ? Number(v.project_id) : null,
      rule, timezone: v.timezone, starts_on: v.starts_on || null, ends_on: v.end_kind === 'on' ? v.ends_on || null : null, max_occurrences: v.end_kind === 'after' ? Number(v.max_occurrences) || null : null,
      deadline_rule: deadline, period_rule: period, overlap_policy: overlap, missed_policy: v.missed_policy, priority: v.priority, needs_approval: v.needs_approval,
      remind_days: deadline && v.remind_days !== '' ? Number(v.remind_days) : null,
    };
    try {
      const saved = schedule ? await api(`/workflows/${schedule.id}`, { method: 'PATCH', body }) : await api('/workflows', { method: 'POST', body: { ...body, client_key: clientKey } });
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const tzs = TIMEZONES.includes(v.timezone) ? TIMEZONES : [v.timezone, ...TIMEZONES];
  const dayNum = v.month_day === 'last' ? 0 : Number(v.month_day);
  return (
    <Modal title={schedule ? `Edit “${schedule.title}”` : 'New recurring task'} onClose={onClose} wide>
      <form onSubmit={save} className="form recurring-form">
        {schedule && <p className="notice small">Changes apply to future occurrences only. Tasks already created keep their instructions and dates.</p>}
        <Field label="Title">
          <input value={v.title} onChange={put('title')} required autoFocus={!schedule} placeholder="e.g. Outstanding supplier invoices summary" />
        </Field>
        <div className="grid-2">
          <div className="field">
            <label className="field-label" htmlFor={ids.assignee}>
              Assigned to
            </label>
            <AssigneePicker id={ids.assignee} value={v.assignee} allowNone={false} onChange={(ref) => setV((x) => ({ ...x, assignee: ref, overlap_policy: '' }))} />
          </div>
          <fieldset className="field">
            <legend className="field-label">Each time</legend>
            <label className="toggle-row">
              <input type="radio" name="mode" checked={mode === 'create_and_start'} disabled={person} onChange={() => setV((x) => ({ ...x, mode: 'create_and_start' }))} /> Create the task and start the agent
            </label>
            <label className="toggle-row">
              <input type="radio" name="mode" checked={mode === 'create_only'} onChange={() => setV((x) => ({ ...x, mode: 'create_only' }))} /> Create the task only
            </label>
            {person && <span className="field-hint">People get the task and a notification; nothing starts automatically.</span>}
          </fieldset>
        </div>
        <Field label="Instructions" hint="What to do each time. You can use {{period_label}}, {{period_start}}, {{period_end}}, {{scheduled_date}} and {{due_date}}.">
          <textarea rows={4} value={v.instructions} onChange={put('instructions')} />
        </Field>
        <div className="grid-2">
          <Field label="Expected result (optional)">
            <input value={v.expected_result} onChange={put('expected_result')} placeholder="e.g. Summary by supplier, with ageing" />
          </Field>
          <Field label="Project (optional)">
            <select value={v.project_id} onChange={put('project_id')}>
              <option value="">No project</option>
              {projects
                ?.filter((p) => p.can_contribute || String(p.id) === String(v.project_id))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </Field>
        </div>

        <h3 className="form-heading">When</h3>
        <div className="grid-3">
          <Field label="Repeats">
            <select value={v.freq} onChange={put('freq')}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
              {v.freq === 'cron' && <option value="cron">Custom (cron, older workflow)</option>}
            </select>
          </Field>
          <Field label="At">
            <input type="time" value={v.time} onChange={put('time')} disabled={v.freq === 'cron'} />
          </Field>
          <Field label="Time zone">
            <select value={v.timezone} onChange={put('timezone')}>
              {tzs.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
        </div>
        {v.freq === 'cron' && (
          <Field label="Cron expression" hint="minute hour day-of-month month day-of-week. Choose a frequency above to switch to a simple schedule.">
            <input className="mono" value={v.cron} onChange={put('cron')} />
          </Field>
        )}
        {v.freq === 'daily' && (
          <div className="grid-2">
            <label className="toggle-row">
              <input type="checkbox" checked={v.only_weekdays} onChange={put('only_weekdays')} /> Only on selected days
            </label>
            {v.only_weekdays ? (
              <Toggles label="Days" options={DAYS} value={v.weekdays} onChange={put('weekdays')} />
            ) : (
              <Field label="Every how many days">
                <input type="number" min="1" max="365" value={v.interval} onChange={put('interval')} />
              </Field>
            )}
          </div>
        )}
        {v.freq === 'weekly' && (
          <div className="grid-2">
            <div className="field">
              <span className="field-label">On</span>
              <Toggles label="Days of the week" options={DAYS} value={v.weekdays} onChange={put('weekdays')} />
            </div>
            <Field label="Every how many weeks">
              <input type="number" min="1" max="52" value={v.interval} onChange={put('interval')} />
            </Field>
          </div>
        )}
        {['monthly', 'quarterly', 'yearly'].includes(v.freq) && (
          <div className="grid-3">
            {v.freq === 'yearly' && (
              <Field label="Month">
                <select value={v.month} onChange={put('month')}>
                  {MONTHS.map((m, i) => (
                    <option key={m} value={i + 1}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Day of the month">
              <select value={v.month_day} onChange={put('month_day')}>
                {Array.from({ length: 31 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>
                    {i + 1}
                  </option>
                ))}
                <option value="last">Last day</option>
              </select>
            </Field>
            {v.freq === 'quarterly' && (
              <Field label="First quarter month" hint="Then every 3 months">
                <select value={v.start_month} onChange={put('start_month')}>
                  <option value="">The start date's month</option>
                  {MONTHS.map((m, i) => (
                    <option key={m} value={i + 1}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {dayNum >= 29 && (
              <Field label="Months without that day">
                <select value={v.missing_day} onChange={put('missing_day')}>
                  <option value="last_day">Use the last day of the month</option>
                  <option value="skip">Skip that month</option>
                </select>
              </Field>
            )}
          </div>
        )}
        {v.freq === 'monthly' && (
          <div className="field">
            <span className="field-label">Only in these months (none selected = every month)</span>
            <Toggles label="Months" options={MONTHS.map((m, i) => [i + 1, m])} value={v.months} onChange={put('months')} />
          </div>
        )}
        <div className="grid-3">
          <Field label="Starts" hint="Never backdated: a past date starts from the next occurrence.">
            <DateInput value={v.starts_on || null} onChange={(d) => setV((x) => ({ ...x, starts_on: d ?? '' }))} placeholder="Today" clearable label="Start date" />
          </Field>
          <Field label="Ends">
            <select value={v.end_kind} onChange={put('end_kind')}>
              <option value="never">Never</option>
              <option value="on">On a date</option>
              <option value="after">After a number of times</option>
            </select>
          </Field>
          {v.end_kind === 'on' && (
            <Field label="Last date">
              <DateInput value={v.ends_on || null} onChange={(d) => setV((x) => ({ ...x, ends_on: d ?? '' }))} label="End date" />
            </Field>
          )}
          {v.end_kind === 'after' && (
            <Field label="Occurrences">
              <input type="number" min="1" value={v.max_occurrences} onChange={put('max_occurrences')} />
            </Field>
          )}
        </div>

        <h3 className="form-heading">Deadline and reporting period</h3>
        <div className="grid-2">
          <Field label="Reporting period" hint="Which data each occurrence covers. It's fixed per occurrence, even if a start is retried later.">
            <select value={v.period_kind} onChange={put('period_kind')}>
              <option value="none">None</option>
              <option value="previous_week">Previous week (Mon–Sun)</option>
              <option value="previous_month">Previous calendar month</option>
              <option value="previous_quarter">Previous calendar quarter</option>
              <option value="previous_year">Previous calendar year</option>
              <option value="previous_months">Previous n months</option>
              <option value="anchored">Fixed periods of n months</option>
            </select>
          </Field>
          <Field label="Due date" hint="When the result is needed, separate from when the task starts.">
            <select value={v.deadline_kind} onChange={put('deadline_kind')}>
              <option value="none">No due date</option>
              <option value="days_after_start">Days after it starts</option>
              <option value="days_after_period_end" disabled={v.period_kind === 'none'}>
                Days after the reporting period ends
              </option>
            </select>
          </Field>
        </div>
        {(['previous_months', 'anchored'].includes(v.period_kind) || v.deadline_kind !== 'none') && (
          <div className="grid-3">
            {['previous_months', 'anchored'].includes(v.period_kind) && (
              <Field label="Months per period">
                <input type="number" min="1" max={v.period_kind === 'anchored' ? 12 : 24} value={v.period_months} onChange={put('period_months')} />
              </Field>
            )}
            {v.period_kind === 'anchored' && (
              <Field label="A period starts in" hint="e.g. 3 months from Dec: Dec–Feb, Mar–May, Jun–Aug, Sep–Nov">
                <select value={v.period_anchor} onChange={put('period_anchor')}>
                  {MONTHS.map((m, i) => (
                    <option key={m} value={i + 1}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {v.deadline_kind !== 'none' && (
              <>
                <Field label="Days">
                  <input type="number" min="0" max="365" value={v.deadline_days} onChange={put('deadline_days')} />
                </Field>
                <Field label="Remind before due (days)">
                  <input type="number" min="0" max="365" value={v.remind_days} onChange={put('remind_days')} placeholder="No reminder" />
                </Field>
              </>
            )}
          </div>
        )}

        <div className={`schedule-preview ${preview?.ok === false ? 'bad' : ''}`} aria-live="polite">
          {preview?.ok === false ? (
            preview.error
          ) : preview?.next ? (
            <>
              <strong>{preview.recurrence}</strong> · {preview.timezone}
              {preview.notes?.length > 0 && <div className="small">{preview.notes.join(' ')}</div>}
              <ul className="preview-list">
                {preview.next.map((n) => (
                  <li key={n.at}>
                    {n.local}
                    {n.period && <span className="muted"> · covers {n.period.label}</span>}
                    {n.due_date && <span className="muted"> · due {fmtDay(n.due_date)}</span>}
                  </li>
                ))}
                {preview.next.length === 0 && <li>No occurrences: check the end date.</li>}
              </ul>
            </>
          ) : (
            '…'
          )}
        </div>

        <details className="form-more">
          <summary>More options</summary>
          <div className="grid-2">
            <Field label="If the previous one isn't finished">
              <select value={overlap} onChange={put('overlap_policy')}>
                {!person && <option value="skip_if_running">Skip while the previous run is still running</option>}
                <option value="skip_if_open">Skip while the previous task is still open</option>
                <option value="always_create">Create it anyway</option>
              </select>
            </Field>
            <Field label="If Hive was offline when it was due">
              <select value={v.missed_policy} onChange={put('missed_policy')}>
                <option value="run_latest">Create only the latest missed one</option>
                <option value="skip_all">Skip missed ones</option>
              </select>
            </Field>
            <Field label="Priority">
              <select value={v.priority} onChange={put('priority')}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </Field>
            <label className="toggle-row">
              <input type="checkbox" checked={Boolean(v.needs_approval)} onChange={put('needs_approval')} /> Each task stops for approval before anything is submitted or paid
            </label>
          </div>
        </details>

        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={saving || !v.assignee}>
            {saving ? 'Saving…' : schedule ? 'Save changes' : 'Create recurring task'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- details

/** Everything about one recurring task: rules, next occurrences, history with links to its tasks. */
export function RecurringDetails({ id, onClose }) {
  const { data: s, error: loadError, reload } = useApi(`/workflows/${id}`, ['workflow', 'task', 'run']);
  const { openTask } = useTaskUI();
  const [editing, setEditing] = useState(false);
  const actions = useActions(() => reload());
  if (loadError) return <Modal title="Recurring task" onClose={onClose}>{loadError}</Modal>;
  if (!s) return <Modal title="Recurring task" onClose={onClose}><Loading /></Modal>;
  if (editing) return <RecurringForm schedule={s} onClose={() => setEditing(false)} onSaved={() => reload()} />;
  const via = s.created_by?.type === 'agent' && s.authorized_by ? ` at ${s.authorized_by.name}'s request` : '';
  return (
    <Modal title={s.title} onClose={onClose} wide>
      <div className="recurring-detail">
        <div className="row-gap">
          <Badge tone={RECUR_STATUS[s.status]?.tone}>{RECUR_STATUS[s.status]?.label}</Badge>
          <span className="pill">{MODE_SHORT[s.mode]}</span>
          {s.project && <span className="pill">{s.project.name}</span>}
          <span className="spacer" />
          <ActionButtons s={s} actions={actions} onEdit={() => setEditing(true)} />
        </div>
        {actions.error && <div className="form-error" role="alert">{actions.error}</div>}
        {s.status === 'error' && s.status_reason && (
          <p className="notice notice-red" role="alert">
            <strong>Suspended:</strong> {s.status_reason}. Nothing is delivered until someone who manages it fixes this and resumes it.
          </p>
        )}
        {s.warning && <p className="notice" role="status">The next occurrence won't be delivered as things stand: {s.warning}.</p>}

        <dl className="kv recurring-kv">
          <dt>Assigned to</dt>
          <dd><AssigneeChip assignee={s.assignee} size={22} /></dd>
          <dt>Created by</dt>
          <dd>{s.created_by?.name ?? '—'}{via}{s.created_at && <span className="muted small"> · {ago(s.created_at)}</span>}</dd>
          <dt>Repeats</dt>
          <dd>{s.recurrence}</dd>
          <dt>Time zone</dt>
          <dd>{s.timezone}</dd>
          <dt>Runs</dt>
          <dd>
            From {fmtDay(s.starts_on)}
            {s.ends_on ? ` until ${fmtDay(s.ends_on)}` : ''}
            {s.max_occurrences ? ` · ${s.occurrence_count} of ${s.max_occurrences} done` : ''}
          </dd>
          <dt>Each time</dt>
          <dd>{s.mode_label}</dd>
          <dt>Due date</dt>
          <dd>{s.deadline_label}</dd>
          <dt>Covers</dt>
          <dd>{s.period_label}</dd>
          <dt>Missed runs</dt>
          <dd>{s.missed_label}</dd>
          <dt>Overlap</dt>
          <dd>{s.overlap_label}</dd>
        </dl>

        <h3 className="section-title">Instructions</h3>
        <p className="pre">{s.instructions || <span className="muted">None</span>}</p>
        {s.expected_result && (
          <>
            <h3 className="section-title">Expected result</h3>
            <p className="pre">{s.expected_result}</p>
          </>
        )}

        <h3 className="section-title">Next occurrences</h3>
        {s.upcoming.length === 0 ? (
          <p className="muted small">None scheduled{s.status !== 'active' ? ` (${RECUR_STATUS[s.status]?.label.toLowerCase()})` : ''}.</p>
        ) : (
          <ul className="preview-list">
            {s.upcoming.map((n) => (
              <li key={n.at}>
                {n.local}
                {n.period && <span className="muted"> · covers {n.period.label}</span>}
                {n.due_date && <span className="muted"> · due {fmtDay(n.due_date)}</span>}
              </li>
            ))}
          </ul>
        )}

        <h3 className="section-title">Run history</h3>
        {s.runs.length === 0 ? (
          <p className="muted small">No runs yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Scheduled for</th>
                  <th>Outcome</th>
                  <th>Task</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {s.runs.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {fmtIn(r.scheduled_for ?? r.started_at, s.timezone)}
                      <div className="row-sub">{TRIGGERS[r.trigger] ?? r.trigger}</div>
                    </td>
                    <td>
                      <Badge tone={OUTCOMES[r.outcome]?.tone}>{OUTCOMES[r.outcome]?.label ?? r.outcome}</Badge>
                    </td>
                    <td>
                      {r.task_id ? (
                        <button type="button" className="linkish" onClick={() => openTask(r.task_id)}>
                          #{r.task_id} {r.task_title ? `· ${r.task_title}` : ''}
                        </button>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="small">
                      {r.skip_reason && <div>{r.skip_reason}</div>}
                      {r.period_start && <div className="muted">Covers {fmtDay(r.period_start)} – {fmtDay(r.period_end)}</div>}
                      {r.dispatch_status && r.dispatch_status !== 'none' && (
                        <div className="muted">
                          Start: {r.dispatch_status}
                          {r.attempts > 1 ? ` after ${r.attempts} attempts` : ''}
                          {r.execution_status ? ` · agent: ${r.execution_status}` : ''}
                        </div>
                      )}
                      {r.task_status && <div className="muted">Task: {r.task_status.replace('_', ' ')}</div>}
                      {r.last_error && <div className="text-red">{r.last_error}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {s.events.length > 0 && (
          <details className="panel-section">
            <summary>
              <h3>Activity</h3>
            </summary>
            <ul className="timeline small">
              {s.events.map((e, i) => (
                <li key={i}>
                  <span className="muted">{ago(e.created_at)}</span> · {e.actor}: {e.text}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Modal>
  );
}
