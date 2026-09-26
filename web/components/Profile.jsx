// Profiles: your own (editable) and other people's (read-only), in a right-side panel. Personal
// details (Profile tab) are kept apart from organisation (Membership tab), which only owners change.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, useApi } from '../api.js';
import { Icon, Modal } from './ui.jsx';
import { DueLabel, PersonAvatar, stageLabel, usePref, useTaskUI } from './work.jsx';
import { NotificationSettings } from './Notifications.jsx';

const ROLE_LABEL = { owner: 'Owner', approver: 'Approver', member: 'Member' };
const TIMEZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['Asia/Dubai', 'Asia/Beirut', 'Europe/Nicosia', 'Europe/London', 'UTC', 'America/New_York'];
  }
})();

/** Upload with the right type; the server checks what the bytes really are. */
async function putPhoto(email, blob) {
  const res = await fetch(`/api/people/${encodeURIComponent(email)}/photo`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data;
}

/**
 * Crop a photo to a square: drag (or use the arrow keys) to position, slider to zoom. Produces a
 * 512×512 JPEG, so what's stored is small and always square.
 */
function CropDialog({ file, onCancel, onDone }) {
  const [src, setSrc] = useState(null);
  const [img, setImg] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const drag = useRef(null);
  const FRAME = 260;
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const base = img ? FRAME / Math.min(img.naturalWidth, img.naturalHeight) : 1; // cover the frame at zoom 1
  const scale = base * zoom;
  const w = img ? img.naturalWidth * scale : 0;
  const h = img ? img.naturalHeight * scale : 0;
  const clamp = (p) => ({ x: Math.min(0, Math.max(FRAME - w, p.x)), y: Math.min(0, Math.max(FRAME - h, p.y)) });
  useEffect(() => {
    if (img) setPos((p) => clamp(p.x === 0 && p.y === 0 ? { x: (FRAME - w) / 2, y: (FRAME - h) / 2 } : p));
  }, [img, zoom]);
  const move = (dx, dy) => setPos((p) => clamp({ x: p.x + dx, y: p.y + dy }));
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 512;
      const k = 512 / FRAME;
      canvas.getContext('2d').drawImage(img, pos.x * k, pos.y * k, w * k, h * k);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
      await onDone(blob);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Crop your photo" onClose={onCancel}>
      <div className="crop">
        <div
          className="crop-frame"
          style={{ width: FRAME, height: FRAME }}
          tabIndex={0}
          role="application"
          aria-label="Photo position. Drag, or use the arrow keys to move it."
          onPointerDown={(e) => {
            drag.current = { x: e.clientX, y: e.clientY };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            move(e.clientX - drag.current.x, e.clientY - drag.current.y);
            drag.current = { x: e.clientX, y: e.clientY };
          }}
          onPointerUp={() => (drag.current = null)}
          onKeyDown={(e) => {
            const d = { ArrowLeft: [8, 0], ArrowRight: [-8, 0], ArrowUp: [0, 8], ArrowDown: [0, -8] }[e.key];
            if (d) (e.preventDefault(), move(...d));
          }}
        >
          {src && (
            <img
              src={src}
              alt=""
              draggable={false}
              onLoad={(e) => setImg(e.currentTarget)}
              onError={() => setError("That file couldn't be opened as an image.")}
              style={{ width: w || undefined, height: h || undefined, transform: `translate(${pos.x}px, ${pos.y}px)` }}
            />
          )}
          <span className="crop-ring" aria-hidden="true" />
        </div>
        <label className="field crop-zoom">
          <span className="field-label">Zoom</span>
          <input type="range" min="1" max="3" step="0.01" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!img || busy} onClick={save}>
            {busy ? 'Saving…' : 'Use this photo'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function PhotoControls({ person, onChanged, children }) {
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const input = useRef(null);
  const run = async (fn) => {
    setError('');
    try {
      onChanged(await fn());
    } catch (err) {
      setError(err.message);
    }
  };
  const pick = (f) => {
    if (!f) return;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) return setError('Use a PNG, JPEG or WebP image.');
    if (f.size > 15 * 1024 * 1024) return setError('That file is too large.');
    setFile(f);
  };
  return (
    <div className="photo-controls">
      <div className="photo-wrap">
        <PersonAvatar name={person.name} photo={person.avatar_url} size={96} />
        <button type="button" className="photo-cam" aria-label="Change photo" onClick={() => input.current?.click()}>
          <Icon name="camera" size={16} />
        </button>
      </div>
      <div className="photo-actions">
        {children}
        <button type="button" className="link-btn" onClick={() => input.current?.click()}>
          <Icon name="camera" size={15} /> {person.avatar_url ? 'Change photo' : 'Add a photo'}
        </button>
        {person.avatar_url && (
          <button type="button" className="link-btn muted-link" onClick={() => run(() => api(`/people/${encodeURIComponent(person.email)}/photo`, { method: 'DELETE' }))}>
            Remove photo
          </button>
        )}
        {person.has_account_photo && person.photo_source !== 'provider' && person.photo_source !== null && (
          <button type="button" className="link-btn muted-link" onClick={() => run(() => api(`/people/${encodeURIComponent(person.email)}/photo/account`, { method: 'POST' }))}>
            Use account photo
          </button>
        )}
        {error && <span className="text-red small">{error}</span>}
      </div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => (pick(e.target.files[0]), (e.target.value = ''))} />
      {file && (
        <CropDialog
          file={file}
          onCancel={() => setFile(null)}
          onDone={async (blob) => {
            const saved = await putPhoto(person.email, blob);
            setFile(null);
            onChanged(saved);
          }}
        />
      )}
    </div>
  );
}

/** Your own details. Unsaved edits are never dropped silently. */
function ProfileForm({ person, onSaved, setDirty, onCancel }) {
  const initial = useMemo(() => ({ name: person.name, title: person.title ?? '', bio: person.bio ?? '', timezone: person.timezone ?? '' }), [person]);
  const [v, setV] = useState(initial);
  const [state, setState] = useState({ kind: 'idle' });
  useEffect(() => setV(initial), [initial]);
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  useEffect(() => setDirty(dirty), [dirty]);
  const save = async (e) => {
    e.preventDefault();
    setState({ kind: 'saving' });
    try {
      const saved = await api(`/people/${encodeURIComponent(person.email)}`, { method: 'PATCH', body: { ...v, timezone: v.timezone || null } });
      onSaved(saved);
      setState({ kind: 'saved' });
    } catch (err) {
      setState({ kind: 'error', message: err.message });
    }
  };
  return (
    <form className="form profile-form" onSubmit={save}>
      <label className="field">
        <span className="field-label">Display name</span>
        <input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required maxLength={80} />
      </label>
      <label className="field">
        <span className="field-label">Job title</span>
        <input value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} maxLength={80} placeholder="e.g. Finance Manager" />
      </label>
      <label className="field">
        <span className="field-label">About</span>
        <textarea rows={3} value={v.bio} onChange={(e) => setV({ ...v, bio: e.target.value })} maxLength={600} placeholder="What you look after, how to work with you" />
      </label>
      <label className="field">
        <span className="field-label">Timezone</span>
        <select value={v.timezone} onChange={(e) => setV({ ...v, timezone: e.target.value })}>
          <option value="">Not set</option>
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Email</span>
        <input value={person.email === 'admin@local' ? 'Local admin (no email)' : person.email} readOnly aria-readonly="true" className="readonly" />
        <span className="field-hint">Your email comes from your sign-in account and can't be changed here.</span>
      </label>
      <div className="panel-savebar">
        <span className={`small save-state ${state.kind}`} role="status" aria-live="polite">
          {state.kind === 'saving' ? 'Saving…' : state.kind === 'saved' && !dirty ? 'Saved' : state.kind === 'error' ? state.message : dirty ? 'Unsaved changes' : ''}
        </span>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => (dirty ? setV(initial) : onCancel())}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!dirty || state.kind === 'saving'}>
          Save changes
        </button>
      </div>
    </form>
  );
}

/** Teams, team roles, workspace role and manager. Read-only unless you're an owner and choose to edit. */
function Membership({ person, me, onSaved, setDirty }) {
  const { data: teams } = useApi('/teams', ['agent']);
  const { data: people } = useApi('/people', ['user']);
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(null);
  const [state, setState] = useState({ kind: 'idle' });
  const start = () => {
    setV({ role: person.role, manager_email: person.manager?.email ?? '', teams: person.teams.map((t) => ({ team_id: t.id, role: t.role })) });
    setEditing(true);
    setDirty(true);
  };
  const stop = () => (setEditing(false), setDirty(false), setState({ kind: 'idle' }));
  const save = async () => {
    setState({ kind: 'saving' });
    try {
      const saved = await api(`/people/${encodeURIComponent(person.email)}/membership`, { method: 'PATCH', body: { ...v, manager_email: v.manager_email || null } });
      onSaved(saved);
      stop();
    } catch (err) {
      setState({ kind: 'error', message: err.message });
    }
  };
  const teamName = (id) => teams?.find((t) => t.id === id)?.name ?? `Team ${id}`;
  if (!editing)
    return (
      <div className="membership">
        <dl className="kv">
          <dt>Teams</dt>
          <dd>
            {person.teams.length ? (
              <span className="chips">
                {person.teams.map((t) => (
                  <span key={t.id} className="team-chip">
                    <span className="team-dot sm" style={{ background: t.color }} aria-hidden="true" />
                    {t.name}
                    {t.role === 'lead' && <span className="type-tag lead">Team lead</span>}
                  </span>
                ))}
              </span>
            ) : (
              <span className="muted">No team yet</span>
            )}
          </dd>
          <dt>Workspace role</dt>
          <dd>{ROLE_LABEL[person.role] ?? person.role}</dd>
          <dt>Manager</dt>
          <dd>{person.manager ? person.manager.name : <span className="muted">Not set</span>}</dd>
          <dt>Status</dt>
          <dd>{person.status === 'active' ? 'Active' : 'Access turned off'}</dd>
        </dl>
        {me?.role === 'owner' ? (
          <button type="button" className="btn" onClick={start}>
            <Icon name="key" size={15} /> Manage membership
          </button>
        ) : (
          <p className="muted small">Only workspace owners change teams, roles and managers.</p>
        )}
      </div>
    );
  const onTeams = new Set(v.teams.map((t) => t.team_id));
  return (
    <div className="membership editing">
      <div className="field">
        <span className="field-label">Teams</span>
        <ul className="member-team-list">
          {v.teams.map((t) => (
            <li key={t.team_id}>
              <span className="grow">{teamName(t.team_id)}</span>
              <select value={t.role} aria-label={`Role in ${teamName(t.team_id)}`} onChange={(e) => setV({ ...v, teams: v.teams.map((x) => (x.team_id === t.team_id ? { ...x, role: e.target.value } : x)) })}>
                <option value="member">Member</option>
                <option value="lead">Team lead</option>
              </select>
              <button type="button" className="icon-btn sm" aria-label={`Remove from ${teamName(t.team_id)}`} onClick={() => setV({ ...v, teams: v.teams.filter((x) => x.team_id !== t.team_id) })}>
                <Icon name="x" size={14} />
              </button>
            </li>
          ))}
        </ul>
        <select value="" aria-label="Add to team" onChange={(e) => e.target.value && setV({ ...v, teams: [...v.teams, { team_id: Number(e.target.value), role: 'member' }] })}>
          <option value="">Add to a team…</option>
          {teams?.filter((t) => !onTeams.has(t.id)).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <span className="field-hint">A team lead can add and remove people on their team. It grants no other permissions.</span>
      </div>
      <label className="field">
        <span className="field-label">Workspace role</span>
        <select value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })}>
          <option value="member">Member: tasks, chat and projects</option>
          <option value="approver">Approver: also approves agents' actions</option>
          <option value="owner">Owner: everything, including people and settings</option>
        </select>
      </label>
      <label className="field">
        <span className="field-label">Manager</span>
        <select value={v.manager_email} onChange={(e) => setV({ ...v, manager_email: e.target.value })}>
          <option value="">Not set</option>
          {people?.filter((p) => p.email !== person.email).map((p) => (
            <option key={p.email} value={p.email}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div className="panel-savebar">
        <span className={`small save-state ${state.kind}`} role="status" aria-live="polite">
          {state.kind === 'saving' ? 'Saving…' : state.kind === 'error' ? state.message : ''}
        </span>
        <span className="spacer" />
        <button type="button" className="btn" onClick={stop}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={state.kind === 'saving'} onClick={save}>
          Save membership
        </button>
      </div>
    </div>
  );
}

function PersonTasks({ person }) {
  const { data: tasks } = useApi(`/tasks?assignee=${encodeURIComponent(`user:${person.email}`)}`, ['task']);
  const { openTask } = useTaskUI();
  const open = (tasks ?? []).filter((t) => t.status !== 'done');
  if (!tasks) return <p className="muted small">Loading…</p>;
  if (!open.length) return <p className="muted small">No open tasks.</p>;
  return (
    <ul className="person-tasks">
      {open.slice(0, 12).map((t) => (
        <li key={t.id}>
          <button type="button" className="link-btn" onClick={() => openTask(t.id)}>
            {t.title}
          </button>
          <span className={`stage-pill stage-${t.stage}`}>{stageLabel(t.stage)}</span>
          <DueLabel date={t.due_date} done={false} />
        </li>
      ))}
      {open.length > 12 && <li className="muted small">and {open.length - 12} more</li>}
    </ul>
  );
}

/**
 * The profile panel. `email` null means you. Escape closes (asking first if there are unsaved
 * changes); focus returns to whatever opened it.
 */
export function ProfilePanel({ email, onClose }) {
  const { data: me } = useApi('/me', ['user']);
  const target = email ?? me?.email;
  const { data: loaded, error, setData } = useApi(target ? `/people/${encodeURIComponent(target)}` : null, ['user']);
  const { openComposer } = useTaskUI();
  const [tab, setTab] = useState('profile');
  const [dirty, setDirty] = useState(false);
  const panel = useRef(null);
  const person = loaded;
  const isMe = person?.is_me;
  const close = () => {
    if (dirty && !confirm('You have unsaved changes. Discard them?')) return;
    onClose();
  };
  useEffect(() => {
    panel.current?.focus();
  }, [target]);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.modal-backdrop') && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  useEffect(() => {
    if (!dirty) return;
    const warn = (e) => (e.preventDefault(), (e.returnValue = ''));
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  return (
    <aside className="task-panel profile-panel" role="dialog" aria-modal="false" aria-labelledby="profile-title" ref={panel} tabIndex={-1}>
      <header className="panel-head">
        <h2 id="profile-title" className="panel-heading">
          {isMe || !email ? 'My profile' : person?.name ?? 'Profile'}
        </h2>
        <span className="spacer" />
        <button type="button" className="icon-btn" aria-label="Close profile" onClick={close}>
          <Icon name="x" />
        </button>
      </header>
      <div className="panel-body">
        {error && <div className="form-error">{error}</div>}
        {!person ? (
          !error && <p className="muted">Loading…</p>
        ) : (
          <>
            <div className="profile-hero">
              {(() => {
                const who = (
                  <div className="grow">
                    <div className="profile-name">
                      {person.name}
                      <span className="type-tag person">Person</span>
                      {person.role === 'owner' && <span className="type-tag lead">Owner</span>}
                      {person.status !== 'active' && <span className="type-tag off">Access off</span>}
                    </div>
                    {person.title && <div className="muted">{person.title}</div>}
                  </div>
                );
                return isMe ? (
                  <PhotoControls person={person} onChanged={(p) => setData((x) => ({ ...x, ...p }))}>
                    {who}
                  </PhotoControls>
                ) : (
                  <>
                    <PersonAvatar name={person.name} photo={person.avatar_url} size={96} />
                    {who}
                  </>
                );
              })()}
            </div>
            {!isMe && (
              <div className="panel-actions">
                {person.status === 'active' && (
                  <button type="button" className="btn btn-primary" onClick={() => openComposer({ assignee: `user:${person.email}` })}>
                    <Icon name="plus" size={15} /> Assign task
                  </button>
                )}
              </div>
            )}
            <div className="tabs" role="tablist" aria-label="Profile sections">
              {[
                ['profile', 'Profile'],
                ['membership', 'Membership'],
                ...(!isMe ? [['tasks', `Tasks${person.open_tasks ? ` (${person.open_tasks})` : ''}`]] : []),
              ].map(([k, l]) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={tab === k}
                  className={tab === k ? 'on' : ''}
                  onClick={() => (dirty && tab !== k && !confirm('You have unsaved changes. Discard them?') ? null : (setDirty(false), setTab(k)))}
                >
                  {l}
                </button>
              ))}
            </div>
            {tab === 'profile' &&
              (isMe ? (
                <ProfileForm person={person} onSaved={(p) => setData(p)} setDirty={setDirty} onCancel={close} />
              ) : (
                <dl className="kv profile-read">
                  <dt>Job title</dt>
                  <dd>{person.title || <span className="muted">Not set</span>}</dd>
                  <dt>About</dt>
                  <dd className="pre">{person.bio || <span className="muted">Nothing yet</span>}</dd>
                  <dt>Timezone</dt>
                  <dd>{person.timezone?.replace(/_/g, ' ') || <span className="muted">Not set</span>}</dd>
                  <dt>Manager</dt>
                  <dd>{person.manager?.name ?? <span className="muted">Not set</span>}</dd>
                </dl>
              ))}
            {tab === 'membership' && <Membership person={person} me={me} onSaved={(p) => setData(p)} setDirty={setDirty} />}
            {tab === 'tasks' && <PersonTasks person={person} />}
          </>
        )}
      </div>
    </aside>
  );
}

/** Preferences that exist today: phone/desktop notifications and how task pages open. */
export function PreferencesPanel({ onClose }) {
  const [allView, setAllView] = usePref('all-tasks:view', 'board');
  const [myView, setMyView] = usePref('my-tasks:view', 'board');
  const panel = useRef(null);
  useEffect(() => panel.current?.focus(), []);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <aside className="task-panel profile-panel" role="dialog" aria-modal="false" aria-labelledby="prefs-title" ref={panel} tabIndex={-1}>
      <header className="panel-head">
        <h2 id="prefs-title" className="panel-heading">
          Preferences
        </h2>
        <span className="spacer" />
        <button type="button" className="icon-btn" aria-label="Close preferences" onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>
      <div className="panel-body">
        <section className="panel-section">
          <h3>Task views on this device</h3>
          {[
            ['All tasks', allView, setAllView],
            ['My tasks', myView, setMyView],
          ].map(([label, value, set]) => (
            <label key={label} className="field pref-row">
              <span className="field-label">{label} opens as</span>
              <select value={value} onChange={(e) => set(e.target.value)}>
                <option value="board">Board</option>
                <option value="list">List</option>
              </select>
            </label>
          ))}
        </section>
        <NotificationSettings />
      </div>
    </aside>
  );
}
