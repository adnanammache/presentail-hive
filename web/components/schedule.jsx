// Start date, repeat, reminder and "needs my approval": shared by the composer and the task panel.
import { addDaysISO, daysBetweenISO, dubaiToday, fmtDay, useApi } from '../api.js';
import { DateInput, Icon } from './ui.jsx';

export const REMIND_OPTIONS = [
  ['none', 'None'],
  ['0', 'On the day'],
  ['7', '1 week before'],
  ['14', '2 weeks before'],
  ['custom', 'Custom…'],
];
export const REPEAT_OPTIONS = [
  ['none', 'Does not repeat'],
  ['monthly', 'Monthly'],
  ['quarterly', 'Quarterly'],
  ['yearly', 'Yearly'],
  ['custom', 'Custom…'],
];
export const repeatLabel = (r) => (!r ? '' : r.freq === 'custom' ? (r.every === 1 ? `every ${r.unit}` : `every ${r.every} ${r.unit}s`) : r.freq);

export const SCHEDULE_DEFAULTS = { start_mode: 'now', start_on: '', remind: 'auto', remind_custom: '', repeat_freq: 'none', repeat_every: 2, repeat_unit: 'week', ends_on: '', start_offset: null };

/** Form state → what the API takes. */
export function scheduleBody(v) {
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

/** A task → form state. */
export function formFromTask(task) {
  if (!task) return {};
  const r = task.repeat;
  const remind = task.remind_days == null ? 'none' : ['0', '7', '14'].includes(String(task.remind_days)) ? String(task.remind_days) : 'custom';
  return {
    start_mode: task.start_on ? 'date' : 'now',
    start_on: task.start_on ?? '',
    due_date: task.due_date ?? '',
    remind,
    remind_custom: remind === 'custom' ? String(task.remind_days) : '',
    repeat_freq: r ? r.freq : 'none',
    repeat_every: r?.every ?? 2,
    repeat_unit: r?.unit ?? 'week',
    ends_on: task.series_ends_on ?? '',
    start_offset: null,
  };
}

/** A template fills everything it has; you can still change it all. */
export function formFromTemplate(t, v) {
  return {
    ...v,
    template_id: String(t.id),
    title: t.title || t.name,
    description: t.description ?? '',
    done_definition: t.done_definition ?? '',
    assignee: t.agent_id ? `agent:${t.agent_id}` : v.assignee,
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

/** Set the due date, moving a template's start date with it ("start 18 days before it's due"). */
export const withDue = (v, due) => ({ ...v, due_date: due ?? '', ...(v.start_offset != null && due ? { start_mode: 'date', start_on: addDaysISO(due, -v.start_offset) } : {}) });

/**
 * Start, reminder, repeat, ends on, approval. `values`/`put(patch)` are the form's.
 * `showDue` adds the due date (the composer has it elsewhere). `canStart` shows Start.
 */
export function ScheduleFields({ values, put, showDue, canStart = true, locked }) {
  const sched = scheduleBody(values);
  const repeating = Boolean(sched.repeat);
  const offsetNow = sched.due_date ? daysBetweenISO(sched.start_on || dubaiToday(), sched.due_date) : null;
  return (
    <>
      <div className="grid-3">
        {canStart && (
          <div className="field">
            <span className="field-label">Start</span>
            <div className="field-pair">
              <select value={values.start_mode} onChange={(e) => put({ start_mode: e.target.value })} aria-label="Start" disabled={locked}>
                <option value="now">When started</option>
                <option value="date">On a date</option>
              </select>
              {values.start_mode === 'date' && <DateInput value={values.start_on} onChange={(d) => put({ start_on: d ?? '', start_offset: null })} label="Start date" />}
            </div>
          </div>
        )}
        {showDue && (
          <div className="field">
            <span className="field-label">Due</span>
            <DateInput value={values.due_date} onChange={(d) => put(withDue(values, d))} label="Due date" placeholder="No due date" clearable />
          </div>
        )}
        <div className="field">
          <span className="field-label">Remind me</span>
          <div className="field-pair">
            <select
              value={values.remind === 'auto' ? (values.due_date ? '14' : 'none') : values.remind}
              onChange={(e) => put({ remind: e.target.value })}
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
                <input type="number" min="0" max="365" value={values.remind_custom} onChange={(e) => put({ remind_custom: e.target.value })} aria-label="Days before" /> days before
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="grid-3">
        <div className="field">
          <span className="field-label">Repeat</span>
          <div className="field-pair">
            <select value={values.repeat_freq} onChange={(e) => put({ repeat_freq: e.target.value })} aria-label="Repeat">
              {REPEAT_OPTIONS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            {values.repeat_freq === 'custom' && (
              <span className="inline-num">
                every <input type="number" min="1" max="366" value={values.repeat_every} onChange={(e) => put({ repeat_every: e.target.value })} aria-label="Repeat every" />
                <select value={values.repeat_unit} onChange={(e) => put({ repeat_unit: e.target.value })} aria-label="Repeat unit">
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
            <DateInput value={values.ends_on} onChange={(d) => put({ ends_on: d ?? '' })} label="Ends on" placeholder="Never" clearable />
          </div>
        )}
      </div>
      {repeating && (
        <p className="field-hint">
          {!values.due_date
            ? 'Set a due date: it decides when each repeat is due.'
            : `Repeats ${repeatLabel(sched.repeat)}. When this one is done, or its due date passes, the next one is created${
                values.start_mode === 'date' && offsetNow != null ? `, starting ${offsetNow === 0 ? 'on its due date' : `${offsetNow} day${offsetNow === 1 ? '' : 's'} before it's due`}` : ''
              }.`}
        </p>
      )}
      {values.start_offset != null && !values.due_date && <p className="field-hint">This template starts {values.start_offset} days before the due date. Set the due date to fill in the start.</p>}
      <label className="check">
        <input type="checkbox" checked={Boolean(values.needs_approval)} onChange={(e) => put({ needs_approval: e.target.checked })} />
        Needs my approval before submitting or paying anything
      </label>
    </>
  );
}

/** Where this task sits in its repeating series, with links to the others. */
export function SeriesBar({ task }) {
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
