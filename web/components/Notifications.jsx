import { useEffect, useState } from 'react';
import { ago, api, fmtDateTime, useApi } from '../api.js';
import { PersonAvatar, usePeopleUI } from './work.jsx';
import { InviteDialog } from '../pages/Agents.jsx';
import { Icon } from './ui.jsx';

const b64ToBytes = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone;

/** Settings: turn phone/desktop notifications on for this device. */
export function NotificationSettings() {
  const { data, reload } = useApi('/push');
  const [sub, setSub] = useState(undefined);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!supported()) return setSub(null);
    navigator.serviceWorker.getRegistration().then((reg) => (reg ? reg.pushManager.getSubscription() : null)).then(setSub, () => setSub(null));
  }, []);

  const enable = async () => {
    setMsg('');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return setMsg('Notifications are blocked for Hive. Allow them in your browser or phone settings.');
      const reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register('/sw.js'));
      await navigator.serviceWorker.ready;
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(data.public_key) });
      await api('/push/subscribe', { method: 'POST', body: { subscription: s.toJSON() } });
      setSub(s);
      reload();
      setMsg('On. Sending a test…');
      await api('/push/test', { method: 'POST' });
      setMsg('On for this device.');
    } catch (err) {
      setMsg(err.message);
    }
  };
  const disable = async () => {
    await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
    await sub.unsubscribe().catch(() => {});
    setSub(null);
    reload();
    setMsg('Off for this device.');
  };

  return (
    <section className="card settings-note">
      <h2>Notifications on this device</h2>
      <p className="muted">Get a notification when an agent needs your approval, finishes, gets stuck, or when the daily brief arrives. Tapping it opens the right page.</p>
      {!supported() ? (
        isIOS() && !standalone() ? (
          <p className="notice warn">On iPhone, first add Hive to your Home Screen (Share → Add to Home Screen), then open it from there and come back here.</p>
        ) : (
          <p className="muted small">This browser doesn't support notifications.</p>
        )
      ) : sub === undefined ? null : sub ? (
        <div className="row-gap">
          <span className="badge badge-green">On for this device</span>
          <button className="btn btn-sm" onClick={() => api('/push/test', { method: 'POST' }).then(() => setMsg('Sent.'))}>
            Send a test
          </button>
          <button className="btn btn-sm" onClick={disable}>
            Turn off
          </button>
        </div>
      ) : (
        <button className="btn btn-primary" onClick={enable} disabled={!data}>
          Turn on notifications
        </button>
      )}
      {msg && <p className="small muted">{msg}</p>}
      {data && <p className="small muted">{data.devices} device{data.devices === 1 ? '' : 's'} signed up.</p>}
    </section>
  );
}

const ZONES = ['Asia/Dubai', 'Asia/Beirut', 'Asia/Nicosia', 'Europe/London', 'UTC'];
const DAYS = [
  ['1-5', 'Mon–Fri'],
  ['1-6', 'Mon–Sat'],
  ['*', 'Every day'],
];

/** Settings: when the daily brief goes out. */
export function BriefSettings() {
  const { data, setData } = useApi('/brief', ['brief']);
  const [err, setErr] = useState('');
  if (!data) return null;
  const c = data.config;
  const save = (patch) =>
    api('/brief/config', { method: 'PUT', body: patch }).then(
      (r) => (setErr(''), setData({ ...data, ...r })),
      (e) => setErr(e.message),
    );
  return (
    <section className="card settings-note">
      <h2>Daily brief</h2>
      <p className="muted">Your Chief of Staff posts a brief to the dashboard, their Inbox thread, Slack and your notifications.</p>
      <div className="brief-config">
        <label className="check">
          <input type="checkbox" checked={c.enabled} onChange={(e) => save({ enabled: e.target.checked })} /> Send automatically
        </label>
        <label>
          At <input type="time" value={c.time} onChange={(e) => e.target.value && save({ time: e.target.value })} disabled={!c.enabled} />
        </label>
        <select value={c.days} onChange={(e) => save({ days: e.target.value })} disabled={!c.enabled} aria-label="Days">
          {DAYS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select value={c.timezone} onChange={(e) => save({ timezone: e.target.value })} disabled={!c.enabled} aria-label="Time zone">
          {[...new Set([c.timezone, ...ZONES])].map((z) => (
            <option key={z}>{z}</option>
          ))}
        </select>
      </div>
      {err && <p className="small" style={{ color: 'var(--red)' }}>{err}</p>}
    </section>
  );
}

const size = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Settings: the database backups Hive keeps, and a way to download one. */
export function BackupSettings() {
  const { data, reload } = useApi('/backups');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const now = async () => {
    setBusy(true);
    setErr('');
    try {
      await api('/backups', { method: 'POST' });
      await reload();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card settings-note">
      <h2>Backups</h2>
      <p className="muted">
        Hive saves a full copy of its database every night at 03:15 (Dubai) and keeps the last 14. They live on the same Railway volume, so download one now and then and keep it somewhere else, such as Google Drive.
      </p>
      <div className="row-gap">
        <button className="btn" onClick={now} disabled={busy}>
          {busy ? 'Backing up…' : 'Back up now'}
        </button>
        {data?.[0] && (
          <a className="btn btn-primary" href={`/api/backups/${data[0].name}`} download>
            Download latest
          </a>
        )}
      </div>
      {err && <p className="small" style={{ color: 'var(--red)' }}>{err}</p>}
      {data?.length > 0 && (
        <ul className="list compact backup-list">
          {data.map((b) => (
            <li key={b.name} className="list-row">
              <span className="grow">{new Date(b.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
              <span className="muted small">{size(b.size)}</span>
              <a className="link small" href={`/api/backups/${b.name}`} download>
                Download
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">To restore: stop the service in Railway, replace hive.db on the volume with the backup file, then start it again.</p>
    </section>
  );
}

const DOT = { ok: 'ok', down: 'down', warn: 'warn', unknown: 'unknown', off: 'off' };
const STATE = { ok: 'Working', down: 'Not working', warn: 'Needs a look', unknown: 'Not checked yet', off: 'Not connected' };

/** Settings: is each connection working, when did it last work, and the last error. */
export function HealthCard() {
  const { data, setData } = useApi('/health', ['health', 'run']);
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    try {
      setData(await api('/health/check', { method: 'POST' }));
    } finally {
      setChecking(false);
    }
  };
  if (!data) return null;
  return (
    <section className="card health-card">
      <header className="card-head">
        <h2>System health</h2>
        <button className="btn btn-sm" onClick={check} disabled={checking}>
          {checking ? 'Checking…' : 'Check now'}
        </button>
      </header>
      <ul className="health-list">
        {data.rows.map((r) => (
          <li key={r.key}>
            <i className={`health-dot ${DOT[r.state]}`} aria-hidden="true" />
            <div className="grow">
              <div className="row-title">
                {r.name} <span className={`health-state ${r.state}`}>{STATE[r.state]}</span>
              </div>
              <div className="row-sub">
                {r.state === 'off' ? (
                  <>Set {r.env} in Railway to connect.</>
                ) : (
                  <>
                    {r.detail && <>{r.detail}. </>}
                    {r.last_ok && <>Last worked {ago(r.last_ok)}. </>}
                    {r.last_error && (r.state !== 'ok' || (r.last_error_at && r.last_error_at > (r.last_ok ?? ''))) && (
                      <span className="health-error">
                        Last error {ago(r.last_error_at)}: {r.last_error}
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Dashboard: a banner when a connection is down. */
export function HealthBanner() {
  const { data } = useApi('/health', ['health']);
  if (!data?.down?.length) return null;
  return (
    <a className="notice warn health-banner" href="#/settings">
      ⚠️ {data.down.join(' and ')} {data.down.length === 1 ? "isn't" : "aren't"} working right now. Agents that need {data.down.length === 1 ? 'it' : 'them'} will fail. See System health in Settings.
    </a>
  );
}

const ROLE_HELP = {
  owner: 'Everything: agents, teams, budgets, settings, backups and people',
  approver: 'Approves agents’ actions and teaches them, plus everything a member can do',
  member: 'Views, chats with agents, and gives and manages tasks',
};

/** Settings (owners): who uses Hive and what they may do. */
/** Settings → People (owners): pending invitations, workspace roles, and turning access off or on. */
export function PeopleSettings({ me }) {
  const isOwner = me?.role === 'owner';
  const { data: people, reload } = useApi(isOwner ? '/people?all=1' : null, ['user']);
  const { data: inv, reload: reloadInv } = useApi(isOwner ? '/invitations' : null, ['invite', 'user']);
  const { data: teams } = useApi('/teams', ['agent']);
  const { data: users } = useApi(isOwner ? '/users' : null, ['user']);
  const [err, setErr] = useState('');
  const [note, setNote] = useState(null); // { text, link?, tasks? }
  const [inviting, setInviting] = useState(false);
  const { openPerson } = usePeopleUI();
  if (!isOwner || !people) return null;
  const act = async (fn) => {
    setErr('');
    try {
      const r = await fn();
      reload();
      reloadInv();
      return r;
    } catch (e) {
      setErr(e.message);
    }
  };
  const approverTeams = (email) => users?.find((u) => u.email === email)?.teams ?? [];
  const toggleTeam = (p, id) => {
    const cur = approverTeams(p.email);
    return act(() => api(`/users/${encodeURIComponent(p.email)}`, { method: 'PATCH', body: { teams: cur.includes(id) ? cur.filter((t) => t !== id) : [...cur, id] } }));
  };
  const pending = (inv?.invitations ?? []).filter((i) => ['pending', 'expired'].includes(i.status));
  return (
    <section className="card settings-note people-admin">
      <div className="settings-head">
        <div>
          <h2>People</h2>
          <p className="muted small">Everyone with access to Hive. Teams are organised on Team &amp; agents.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setInviting(true)}>
          <Icon name="plus" size={15} /> Invite people
        </button>
      </div>
      {inv && !inv.email_configured && (
        <div className="small note-box">
          <span>
            Invitation emails are off: set <code>RESEND_API_KEY</code> and <code>MAIL_FROM</code> in Railway to send them. Until then Hive gives you the link to share yourself.
          </span>
        </div>
      )}
      {note && (
        <div className="note-box small" role="status">
          {note.text}
          {note.link && (
            <div className="field-pair">
              <input readOnly value={note.link} aria-label="Invitation link" onFocus={(e) => e.target.select()} />
              <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(note.link)}>
                Copy link
              </button>
            </div>
          )}
          {note.tasks?.length > 0 && (
            <ul>
              {note.tasks.map((t) => (
                <li key={t.id}>
                  <a href={`#/tasks/${t.id}`}>{t.title}</a>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="link-btn" onClick={() => setNote(null)}>
            Dismiss
          </button>
        </div>
      )}
      {pending.length > 0 && (
        <>
          <h3 className="sub-head">Pending invitations</h3>
          <ul className="people">
            {pending.map((i) => (
              <li key={i.id}>
                <div className="grow">
                  <div className="row-title">
                    {i.email} <span className={`type-tag ${i.status === 'expired' ? 'off' : 'person'}`}>{i.status === 'expired' ? 'Expired' : 'Pending'}</span>
                  </div>
                  <div className="row-sub">
                    {i.role} · invited by {i.invited_by} {ago(i.created_at)} · {i.sent_at ? 'emailed' : i.send_error ? 'not emailed' : 'not emailed yet'}
                    {i.status === 'pending' ? ` · expires ${fmtDateTime(i.expires_at)}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    act(() => api(`/invitations/${i.id}/resend`, { method: 'POST' })).then(
                      (r) => r && setNote({ text: r.delivery.sent ? `Sent a new invitation to ${i.email}. The old link no longer works.` : `New link for ${i.email} (not emailed: ${r.delivery.error}). The old link no longer works.`, link: r.delivery.link }),
                    )
                  }
                >
                  Resend
                </button>
                <button type="button" className="btn btn-sm btn-danger-ghost" onClick={() => confirm(`Revoke the invitation for ${i.email}?`) && act(() => api(`/invitations/${i.id}`, { method: 'DELETE' }))}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3 className="sub-head">Members</h3>
      <ul className="people">
        {people.map((u) => (
          <li key={u.email} className={u.status !== 'active' ? 'inactive' : ''}>
            <PersonAvatar name={u.name} photo={u.avatar_url} size={32} />
            <div className="grow">
              <div className="row-title">
                <button type="button" className="link-btn" onClick={(e) => openPerson(u.email, e.currentTarget)}>
                  {u.name}
                </button>{' '}
                {u.email === me.email && <span className="muted small">(you)</span>}
                {u.status !== 'active' && <span className="type-tag off">Access off</span>}
              </div>
              <div className="row-sub">
                {u.email === 'admin@local' ? 'Local admin' : u.email} · last seen {ago(u.last_seen_at)}
                {u.open_tasks > 0 ? ` · ${u.open_tasks} open task${u.open_tasks === 1 ? '' : 's'}` : ''}
              </div>
              {u.role === 'approver' && (
                <div className="people-teams">
                  <span className="muted small">Approves for:</span>
                  {teams?.map((t) => (
                    <button key={t.id} type="button" className={`chip ${approverTeams(u.email).includes(t.id) ? 'on' : ''}`} onClick={() => toggleTeam(u, t.id)}>
                      {t.name}
                    </button>
                  ))}
                  {!approverTeams(u.email).length && <span className="muted small">all departments</span>}
                </div>
              )}
            </div>
            <select value={u.role} disabled={u.status !== 'active'} onChange={(e) => act(() => api(`/users/${encodeURIComponent(u.email)}`, { method: 'PATCH', body: { role: e.target.value } }))} aria-label={`Role for ${u.name}`} title={ROLE_HELP[u.role]}>
              <option value="owner">Owner</option>
              <option value="approver">Approver</option>
              <option value="member">Member</option>
            </select>
            {u.email !== me.email &&
              (u.status === 'active' ? (
                <button
                  type="button"
                  className="btn btn-sm btn-danger-ghost"
                  onClick={() =>
                    confirm(`Turn off ${u.name}'s access? They can't sign in or be given new work. Their tasks, comments and history stay.`) &&
                    act(() => api(`/people/${encodeURIComponent(u.email)}/deactivate`, { method: 'POST' })).then(
                      (r) => r && setNote({ text: r.needs_reassigning.length ? `${u.name}'s access is off. These open tasks are still assigned to them. Reassign them:` : `${u.name}'s access is off.`, tasks: r.needs_reassigning }),
                    )
                  }
                >
                  Turn off access
                </button>
              ) : (
                <button type="button" className="btn btn-sm" onClick={() => act(() => api(`/people/${encodeURIComponent(u.email)}/reactivate`, { method: 'POST' }))}>
                  Turn access on
                </button>
              ))}
          </li>
        ))}
      </ul>
      {err && <p className="small" style={{ color: 'var(--red)' }}>{err}</p>}
      <ul className="muted small role-help">
        {Object.entries(ROLE_HELP).map(([k, v]) => (
          <li key={k}>
            <b>{k[0].toUpperCase() + k.slice(1)}:</b> {v}
          </li>
        ))}
      </ul>
      {inviting && <InviteDialog onClose={() => (setInviting(false), reloadInv())} />}
    </section>
  );
}
