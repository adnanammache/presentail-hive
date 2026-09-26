// Shared pieces of the task views: stages, who a task belongs to, and the assignee picker.
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { fmtDay, useApi } from '../api.js';
import { Avatar, Icon } from './ui.jsx';
import BotAvatar from './BotAvatar.jsx';

export const STAGES = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'ready', label: 'Ready' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'review', label: 'Needs review' },
  { id: 'done', label: 'Done' },
];
export const stageLabel = (id) => STAGES.find((s) => s.id === id)?.label ?? id;
export const BLOCKERS = {
  info: { label: 'Waiting for information', short: 'Needs info', icon: 'alert' },
  approval: { label: 'Waiting for approval', short: 'Needs approval', icon: 'clock' },
  failed: { label: 'Execution failed', short: 'Failed', icon: 'alert' },
};
export const PRIORITY_LABELS = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };

/** Opens the composer and the task panel from anywhere. */
export const TaskUIContext = createContext({ openComposer: () => {}, openTask: () => {}, openSchedule: () => {} });
export const useTaskUI = () => useContext(TaskUIContext);

/** A per-browser preference (view mode, filters), safe when storage is unavailable. */
export function usePref(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const v = localStorage.getItem(`hive:${key}`);
      return v === null ? initial : JSON.parse(v);
    } catch {
      return initial;
    }
  });
  const set = (v) =>
    setValue((old) => {
      const next = typeof v === 'function' ? v(old) : v;
      try {
        localStorage.setItem(`hive:${key}`, JSON.stringify(next));
      } catch {}
      return next;
    });
  return [value, set];
}

/**
 * A person's avatar, used on every screen: their photo (uploaded, else their sign-in account's,
 * resolved by the server) or their initials. Never an agent's picture, even with the same name.
 */
export function PersonAvatar({ name = '?', size = 24, photo }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [photo]);
  const initials = name.split(/[\s.@]+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  if (photo && !broken)
    return <img className="person-avatar photo" src={photo} alt="" width={size} height={size} style={{ width: size, height: size }} referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  return (
    <span className="person-avatar" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden="true">
      {initials}
    </span>
  );
}

/** Avatar + name + a "Person" / "AI agent" label: never colour alone. */
export function AssigneeChip({ assignee, size = 24, compact }) {
  if (!assignee)
    return (
      <span className="assignee-chip unassigned">
        <span className="person-avatar none" style={{ width: size, height: size }} aria-hidden="true" />
        <span className="muted">Unassigned</span>
      </span>
    );
  const agent = assignee.type === 'agent';
  return (
    <span className="assignee-chip">
      {agent ? <BotAvatar id={assignee.id} name={assignee.name} color={assignee.color} size={size} /> : <PersonAvatar name={assignee.name} size={size} photo={assignee.avatar_url} />}
      <span className="assignee-name clamp-1">{assignee.name}</span>
      {!compact && (
        <span className={`type-tag ${agent ? 'agent' : 'person'}`}>
          {agent && <Icon name="bot" size={11} />}
          {agent ? 'AI agent' : 'Person'}
        </span>
      )}
    </span>
  );
}

/** Everyone who can be assigned: people (users) and AI agents, with unambiguous refs. */
export function useAssignees() {
  const { data: people } = useApi('/people', ['user']);
  const { data: agents } = useApi('/agents', ['agent']);
  return useMemo(
    () => ({
      loading: !people || !agents,
      people: (people ?? []).map((p) => ({ type: 'user', ref: `user:${p.email}`, email: p.email, name: p.name || p.email, detail: p.title || (p.role === 'owner' ? 'Owner' : p.role === 'approver' ? 'Approver' : 'Member'), avatar_url: p.avatar_url })),
      agents: (agents ?? []).map((a) => ({ type: 'agent', ref: `agent:${a.id}`, id: a.id, name: a.name, detail: [a.title, a.team_name].filter(Boolean).join(' · '), color: a.color, status: a.status })),
    }),
    [people, agents],
  );
}

/**
 * Pick a person or an AI agent (or nobody). Searchable, grouped, keyboard operable:
 * ↑/↓ to move, Enter to choose, Escape to close.
 */
export function AssigneePicker({ value, onChange, label = 'Assign to', allowNone = true, onlyPeople, disabledReason, id: idProp }) {
  const { people, agents } = useAssignees();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef(null);
  const search = useRef(null);
  const listId = useId();
  const all = [...people, ...(onlyPeople ? [] : agents)];
  const selected = all.find((x) => x.ref === value) ?? null;
  const match = (x) => !q || `${x.name} ${x.detail ?? ''} ${x.email ?? ''}`.toLowerCase().includes(q.toLowerCase());
  const groups = [
    ...(allowNone ? [{ label: null, items: [{ ref: '', name: 'Unassigned', type: 'none' }].filter(() => !q) }] : []),
    { label: 'People', items: people.filter(match) },
    ...(onlyPeople ? [] : [{ label: 'AI agents', items: agents.filter(match) }]),
  ];
  const flat = groups.flatMap((g) => g.items);
  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, flat.findIndex((x) => x.ref === (value ?? ''))));
    search.current?.focus();
    const away = (e) => !box.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const choose = (x) => {
    onChange(x.ref || null, x.type === 'none' ? null : x);
    setOpen(false);
    setQ('');
  };
  const key = (e) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), setActive((i) => Math.min(flat.length - 1, i + 1)));
    else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((i) => Math.max(0, i - 1)));
    else if (e.key === 'Enter') (e.preventDefault(), flat[active] && choose(flat[active]));
    else if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), setOpen(false));
  };
  return (
    <div className="picker" ref={box}>
      <button
        type="button"
        id={idProp}
        className="picker-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${selected ? `${selected.name}, ${selected.type === 'agent' ? 'AI agent' : 'person'}` : 'unassigned'}`}
        disabled={Boolean(disabledReason)}
        title={disabledReason}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === 'ArrowDown' && (e.preventDefault(), setOpen(true))}
      >
        <AssigneeChip assignee={selected} size={22} />
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="picker-pop" role="dialog" aria-label={label}>
          <input ref={search} className="picker-search" value={q} placeholder="Search people and agents" aria-label="Search people and agents" aria-controls={listId} onChange={(e) => (setQ(e.target.value), setActive(0))} onKeyDown={key} />
          <ul className="picker-list" role="listbox" id={listId} aria-label={label}>
            {groups.map((g, gi) =>
              g.items.length === 0 ? null : (
                <li key={gi} role="presentation">
                  {g.label && <div className="picker-group">{g.label}</div>}
                  <ul role="presentation">
                    {g.items.map((x) => {
                      const i = flat.indexOf(x);
                      const isSel = (value ?? '') === x.ref;
                      return (
                        <li
                          key={x.ref || 'none'}
                          role="option"
                          aria-selected={isSel}
                          className={`picker-option ${i === active ? 'active' : ''} ${isSel ? 'selected' : ''}`}
                          onMouseEnter={() => setActive(i)}
                          onMouseDown={(e) => (e.preventDefault(), choose(x))}
                        >
                          {x.type === 'agent' ? (
                            <BotAvatar id={x.id} name={x.name} color={x.color} size={26} />
                          ) : x.type === 'user' ? (
                            <PersonAvatar name={x.name} size={26} photo={x.avatar_url} />
                          ) : (
                            <span className="person-avatar none" style={{ width: 26, height: 26 }} aria-hidden="true" />
                          )}
                          <span className="grow">
                            <span className="picker-name">{x.type === 'none' ? 'Unassigned' : x.name}</span>
                            {x.detail && <span className="picker-detail">{x.detail}{x.status === 'paused' ? ' · not set up' : ''}</span>}
                          </span>
                          {x.type === 'agent' && <span className="type-tag agent"><Icon name="bot" size={11} />AI agent</span>}
                          {isSel && <Icon name="check" size={15} />}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ),
            )}
            {flat.length === 0 && <li className="picker-empty muted small">No one matches “{q}”.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

/** "Due 28 Sep" with overdue treatment (text, not just colour). */
export function DueLabel({ date, done }) {
  if (!date) return null;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date());
  const overdue = !done && date < today;
  const text = fmtDay(date, { year: date.slice(0, 4) !== String(new Date().getFullYear()) });
  return (
    <span className={`due ${overdue ? 'overdue' : ''}`}>
      <Icon name="calendar" size={13} />
      {overdue ? `Overdue · ${text}` : `Due ${text}`}
    </span>
  );
}

/** Opens a person's profile panel (yours when no email is given) and your preferences. */
export const PeopleUIContext = createContext({ openPerson: () => {}, openPreferences: () => {} });
export const usePeopleUI = () => useContext(PeopleUIContext);
