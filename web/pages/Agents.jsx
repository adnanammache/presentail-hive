// Team & agents: the everyday directory. Teams hold people and AI agents together; every card says
// which it is in words (agents may have human names and portraits).
import { useEffect, useMemo, useRef, useState } from 'react';
import { ago, api, useApi } from '../api.js';
import { Avatar, Badge, Empty, Icon, Loading, Modal, PLATFORM_LABELS, agentTone } from '../components/ui.jsx';
import { AgentForm, TeamForm } from '../components/forms.jsx';
import { money } from '../components/Spend.jsx';
import { PersonAvatar, usePeopleUI, useTaskUI } from '../components/work.jsx';
import BotAvatar from '../components/BotAvatar.jsx';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const counts = (people, agents) => `${plural(people, 'person', 'people')} · ${plural(agents, 'AI agent', 'AI agents')}`;

function CardMenu({ label, items }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector('[role=menuitem]')?.focus();
    const away = (e) => !box.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  if (!items.length) return null;
  return (
    <div className="card-menu" ref={box} onClick={(e) => (e.preventDefault(), e.stopPropagation())} onKeyDown={(e) => e.key === 'Escape' && (setOpen(false), box.current.querySelector('button')?.focus())}>
      <button type="button" className="icon-btn sm" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen((o) => !o)}>
        <Icon name="dots" size={16} />
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" className={it.danger ? 'danger' : ''} onClick={() => (setOpen(false), it.onClick())}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PersonCard({ p, menu }) {
  const { openPerson } = usePeopleUI();
  return (
    <article className="member-card" role="button" tabIndex={0} onClick={(e) => openPerson(p.email, e.currentTarget)} onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && openPerson(p.email, e.currentTarget)} aria-label={`${p.name}, person${p.team_role === 'lead' ? ', team lead' : ''}`}>
      <PersonAvatar name={p.name} photo={p.avatar_url} size={56} />
      <div className="grow member-main">
        <div className="member-name">
          <strong className="clamp-1">{p.name}</strong>
          <span className="type-tag person">Person</span>
          {p.team_role === 'lead' && <span className="type-tag lead">Team lead</span>}
        </div>
        <div className="member-title clamp-1">{p.title || <span className="muted">No job title yet</span>}</div>
        <div className="member-meta">
          <Icon name="mytasks" size={14} /> {plural(p.open_tasks ?? 0, 'open task', 'open tasks')}
        </div>
      </div>
      {menu}
    </article>
  );
}

function AgentCard({ a, menu }) {
  return (
    <a className="member-card agent" href={`#/agents/${a.id}`} aria-label={`${a.name}, AI agent`}>
      <BotAvatar id={a.id} name={a.name} color={a.color} size={56} />
      <div className="grow member-main">
        <div className="member-name">
          <strong className="clamp-1">{a.name}</strong>
          <span className="type-tag agent">
            <Icon name="bot" size={11} />
            AI agent
          </span>
          {a.status !== 'idle' && <Badge tone={agentTone[a.status]}>{a.status === 'paused' ? 'Not set up' : a.status}</Badge>}
        </div>
        <div className="member-title clamp-1">{a.title || 'No title'}</div>
        <div className="member-meta">
          <Icon name="mytasks" size={14} /> {plural(a.open_tasks ?? 0, 'open task', 'open tasks')}
          <span className="dot-sep" aria-hidden="true">·</span>
          <span>{PLATFORM_LABELS[a.platform]}</span>
          {a.month_cents > 0 && (
            <>
              <span className="dot-sep" aria-hidden="true">·</span>
              <span title="AI spend this month">{money(a.month_cents)}</span>
            </>
          )}
        </div>
      </div>
      {menu}
    </a>
  );
}

/** Pick people and agents to add. Existing members are marked; nothing happens until you confirm. */
function AddMemberDialog({ team, agents, people, viewer, onClose }) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(new Set());
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const isOwner = viewer.can_manage_org;
  const onTeamPeople = new Set(team.people.map((p) => p.email));
  const onTeamAgents = new Set(team.agent_ids);
  const match = (name, extra = '') => !q || `${name} ${extra}`.toLowerCase().includes(q.toLowerCase());
  const toggle = (key) => setPicked((s) => {
    const n = new Set(s);
    n.has(key) ? n.delete(key) : n.add(key);
    return n;
  });
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await api(`/teams/${team.id}/members`, { method: 'POST', body: { members: [...picked].map((k) => ({ type: k.startsWith('agent:') ? 'agent' : 'user', ref: k.replace(/^(agent|user):/, '') })) } });
      onClose();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };
  const row = ({ key, name, detail, avatar, already, disabledNote, tag }) => (
    <label key={key} className={`member-row ${already ? 'already' : ''}`}>
      <input type="checkbox" checked={already || picked.has(key)} disabled={already || Boolean(disabledNote)} onChange={() => toggle(key)} />
      {avatar}
      <span className="grow">
        {name}
        <span className="muted small"> · {detail}</span>
        {disabledNote && <span className="muted small"> · {disabledNote}</span>}
      </span>
      {already ? <span className="type-tag person">Already on {team.name}</span> : tag}
    </label>
  );
  return (
    <Modal title={`Add members to ${team.name}`} onClose={onClose}>
      <div className="form">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people and agents" aria-label="Search people and agents" autoFocus />
        <div className="member-list tall">
          {people.some((p) => match(p.name, p.title)) && <div className="picker-group">People</div>}
          {people.filter((p) => match(p.name, p.title)).map((p) =>
            row({ key: `user:${p.email}`, name: p.name, detail: p.title || p.email, avatar: <PersonAvatar name={p.name} photo={p.avatar_url} size={26} />, already: onTeamPeople.has(p.email) }),
          )}
          {agents.some((a) => match(a.name, a.title)) && <div className="picker-group">AI agents</div>}
          {!people.some((p) => match(p.name, p.title)) && !agents.some((a) => match(a.name, a.title)) && <p className="muted small">No one matches “{q}”.</p>}
          {agents.filter((a) => match(a.name, a.title)).map((a) =>
            row({
              key: `agent:${a.id}`,
              name: a.name,
              detail: a.title || 'AI agent',
              avatar: <BotAvatar id={a.id} name={a.name} color={a.color} size={26} />,
              already: onTeamAgents.has(a.id),
              disabledNote: !isOwner ? 'only owners move agents' : null,
              tag: (
                <span className="type-tag agent">
                  <Icon name="bot" size={11} />
                  {a.team_id && a.team_id !== team.id ? `moves from ${a.team_name}` : 'AI agent'}
                </span>
              ),
            }),
          )}
        </div>
        <p className="field-hint">Joining a team doesn't start an agent, assign work, change anyone's role or give new system access.</p>
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!picked.size || saving} onClick={save}>
            {saving ? 'Adding…' : picked.size ? `Add ${picked.size}` : 'Add'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Invite someone by email. Says honestly whether the email went out; otherwise gives the link to share. */
export function InviteDialog({ onClose }) {
  const { data: teams } = useApi('/teams', ['agent']);
  const { data: people } = useApi('/people', ['user']);
  const { data: setup } = useApi('/invitations', ['invite']);
  const [v, setV] = useState({ email: '', role: 'member', teams: new Set(), title: '', manager_email: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(null);
  const [copied, setCopied] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      setDone(await api('/invitations', { method: 'POST', body: { ...v, teams: [...v.teams], manager_email: v.manager_email || null } }));
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };
  if (done)
    return (
      <Modal title="Invitation created" onClose={onClose}>
        <div className="form">
          {done.delivery.sent ? (
            <p>
              <Icon name="check" size={15} /> Invitation emailed to <b>{done.invite.email}</b>. It expires in 7 days.
            </p>
          ) : (
            <>
              <p>
                The invitation for <b>{done.invite.email}</b> is ready, but <b>it wasn't emailed</b>: {done.delivery.error}
              </p>
              <p className="small muted">Send them this link yourself. It works once, only for {done.invite.email}, and expires in 7 days.</p>
            </>
          )}
          <div className="field-pair">
            <input readOnly value={done.delivery.link} aria-label="Invitation link" onFocus={(e) => e.target.select()} />
            <button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(done.delivery.link).then(() => setCopied(true))}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
          <div className="form-actions">
            <span className="spacer" />
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </Modal>
    );
  return (
    <Modal title="Invite people" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Email address</span>
          <input type="email" required autoFocus value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} placeholder="name@presentail.com" />
        </label>
        <div className="grid-2">
          <label className="field">
            <span className="field-label">Workspace role</span>
            <select value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })}>
              <option value="member">Member</option>
              <option value="approver">Approver</option>
              <option value="owner">Owner</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Job title (optional)</span>
            <input value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} maxLength={80} />
          </label>
        </div>
        <fieldset className="form-section">
          <legend>Teams (optional)</legend>
          <div className="chips">
            {teams?.map((t) => (
              <label key={t.id} className={`chip ${v.teams.has(t.id) ? 'on' : ''}`}>
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={v.teams.has(t.id)}
                  onChange={() => setV((x) => {
                    const s = new Set(x.teams);
                    s.has(t.id) ? s.delete(t.id) : s.add(t.id);
                    return { ...x, teams: s };
                  })}
                />
                {t.name}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span className="field-label">Manager (optional)</span>
          <select value={v.manager_email} onChange={(e) => setV({ ...v, manager_email: e.target.value })}>
            <option value="">Not set</option>
            {people?.map((p) => (
              <option key={p.email} value={p.email}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {setup && !setup.google && <div className="note-box small">Google sign-in isn't set up here, so invited people can't accept yet. Invitations work once it is.</div>}
        {setup && !setup.email_configured && <p className="field-hint">Invitation emails are off (no email service set up). You'll get a link to send yourself.</p>}
        <p className="field-hint">They join when they sign in with this email. Until then they're listed as pending in Settings → People and can't be given tasks.</p>
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={saving}>
            {saving ? 'Inviting…' : 'Invite'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function Agents() {
  const { data: dir, error } = useApi('/directory', ['agent', 'user', 'task', 'team']);
  const { data: agents } = useApi('/agents', ['agent', 'task', 'workflow']);
  const { data: people } = useApi('/people', ['user']);
  const { data: teamRows } = useApi('/teams', ['agent']);
  const { openComposer } = useTaskUI();
  const [q, setQ] = useState('');
  const [show, setShow] = useState('everyone');
  const [modal, setModal] = useState(null);
  const [msg, setMsg] = useState('');
  const byId = useMemo(() => new Map((agents ?? []).map((a) => [a.id, a])), [agents]);

  if (error) return <div className="form-error">Couldn't load the directory: {error}</div>;
  if (!dir || !agents) return <Loading />;
  const v = dir.viewer;
  const term = q.trim().toLowerCase();
  const personMatch = (p) => !term || `${p.name} ${p.title} ${p.email}`.toLowerCase().includes(term);
  const agentMatch = (a) => !term || `${a.name} ${a.title}`.toLowerCase().includes(term);
  const teamMatch = (t) => term && t.name.toLowerCase().includes(term);
  const remove = async (team, type, ref, name) => {
    if (!confirm(`Take ${name} off ${team.name}? Their account, tasks and history stay as they are.`)) return;
    setMsg('');
    try {
      await api(`/teams/${team.id}/members/${type}/${encodeURIComponent(ref)}`, { method: 'DELETE' });
    } catch (err) {
      setMsg(err.message);
    }
  };
  const setLead = async (team, email, role) => {
    setMsg('');
    try {
      await api(`/teams/${team.id}/members/user/${encodeURIComponent(email)}`, { method: 'PATCH', body: { role } });
    } catch (err) {
      setMsg(err.message);
    }
  };

  const sections = dir.teams
    .map((t) => {
      const all = teamMatch(t);
      const ps = show === 'agents' ? [] : t.people.filter((p) => all || personMatch(p));
      const as = show === 'people' ? [] : t.agent_ids.map((id) => byId.get(id)).filter(Boolean).filter((a) => all || agentMatch(a));
      return { t, ps, as, visible: !term || all || ps.length + as.length > 0 };
    })
    .filter((s) => s.visible);
  const loosePeople = show === 'agents' ? [] : dir.unassigned_people.filter(personMatch);
  const looseAgents = show === 'people' ? [] : dir.unassigned_agent_ids.map((id) => byId.get(id)).filter(Boolean).filter(agentMatch);
  const canManage = (team) => v.can_manage_org || v.lead_of.includes(team.id);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Team &amp; agents</h1>
          <p className="page-sub">
            {counts(dir.totals.people, dir.totals.agents)} · {plural(dir.totals.teams, 'team', 'teams')}
          </p>
        </div>
        <div className="page-actions">
          {v.can_invite && (
            <button type="button" className="btn btn-primary" onClick={() => setModal({ kind: 'invite' })}>
              <Icon name="plus" size={16} /> Invite people
            </button>
          )}
          {v.can_manage_org && (
            <>
              <button type="button" className="btn" onClick={() => setModal({ kind: 'team' })}>
                <Icon name="plus" size={16} /> New team
              </button>
              <button type="button" className="btn" onClick={() => setModal({ kind: 'agent' })}>
                <Icon name="plus" size={16} /> New agent
              </button>
            </>
          )}
        </div>
      </div>
      <div className="filters">
        <label className="search-box wide">
          <Icon name="search" size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people, agents, or teams" aria-label="Search people, agents, or teams" />
        </label>
        <div className="segmented" role="radiogroup" aria-label="Show">
          {[
            ['everyone', 'Everyone'],
            ['people', 'People'],
            ['agents', 'AI agents'],
          ].map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={show === k} className={show === k ? 'on' : ''} onClick={() => setShow(k)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {msg && (
        <div className="form-error" role="alert">
          {msg}
        </div>
      )}

      {dir.teams.length === 0 && !term && (
        <Empty title="No teams yet">{v.can_manage_org ? 'Create a team (e.g. Accounting), then add people and agents to it.' : 'An owner can create teams.'}</Empty>
      )}
      {term && sections.length === 0 && loosePeople.length === 0 && looseAgents.length === 0 && <Empty title={`Nothing matches “${q}”`}>Try a name, a job title or a team.</Empty>}

      {sections.map(({ t, ps, as }) => (
        <section key={t.id} className="dir-team" style={{ '--c': t.color }}>
          <header className="dir-team-head">
            <span className="team-dot" aria-hidden="true" />
            <div className="grow">
              <h2>{t.name}</h2>
              <p className="muted small">
                {counts(t.people.length, t.agent_ids.length)}
                {t.description ? ` · ${t.description}` : ''}
              </p>
            </div>
            {canManage(t) && (
              <button type="button" className="btn" onClick={() => setModal({ kind: 'add', team: t })}>
                <Icon name="plus" size={15} /> Add member
              </button>
            )}
            <CardMenu
              label={`${t.name} options`}
              items={
                v.can_manage_org
                  ? [
                      { label: 'Edit team', onClick: () => setModal({ kind: 'team', team: teamRows?.find((x) => x.id === t.id) ?? t }) },
                      { label: 'New agent in this team', onClick: () => setModal({ kind: 'agent', defaults: { team_id: t.id, color: t.color } }) },
                    ]
                  : []
              }
            />
          </header>
          {ps.length + as.length === 0 ? (
            <p className="team-empty">{t.people.length + t.agent_ids.length === 0 ? `No one on ${t.name} yet.` : 'No matches in this team.'}</p>
          ) : (
            <div className="member-grid">
              {ps.map((p) => (
                <PersonCard
                  key={p.email}
                  p={p}
                  menu={
                    <CardMenu
                      label={`Options for ${p.name}`}
                      items={[
                        ...(p.status === 'active' ? [{ label: 'Assign task', onClick: () => openComposer({ assignee: `user:${p.email}` }) }] : []),
                        ...(v.can_manage_org ? [{ label: p.team_role === 'lead' ? 'Make member' : 'Make team lead', onClick: () => setLead(t, p.email, p.team_role === 'lead' ? 'member' : 'lead') }] : []),
                        ...(canManage(t) && (p.team_role !== 'lead' || v.can_manage_org) ? [{ label: `Remove from ${t.name}`, danger: true, onClick: () => remove(t, 'user', p.email, p.name) }] : []),
                      ]}
                    />
                  }
                />
              ))}
              {as.map((a) => (
                <AgentCard
                  key={a.id}
                  a={a}
                  menu={
                    <CardMenu
                      label={`Options for ${a.name}`}
                      items={[
                        { label: 'Assign task', onClick: () => openComposer({ assignee: `agent:${a.id}` }) },
                        ...(v.can_manage_org ? [{ label: `Remove from ${t.name}`, danger: true, onClick: () => remove(t, 'agent', a.id, a.name) }] : []),
                      ]}
                    />
                  }
                />
              ))}
            </div>
          )}
        </section>
      ))}

      {(loosePeople.length > 0 || looseAgents.length > 0) && (
        <section className="dir-team" style={{ '--c': '#94a3b8' }}>
          <header className="dir-team-head">
            <span className="team-dot" aria-hidden="true" />
            <div className="grow">
              <h2>Unassigned to a team</h2>
              <p className="muted small">{counts(dir.unassigned_people.length, dir.unassigned_agent_ids.length)}</p>
            </div>
          </header>
          <div className="member-grid">
            {loosePeople.map((p) => (
              <PersonCard key={p.email} p={p} menu={p.status === 'active' ? <CardMenu label={`Options for ${p.name}`} items={[{ label: 'Assign task', onClick: () => openComposer({ assignee: `user:${p.email}` }) }]} /> : null} />
            ))}
            {looseAgents.map((a) => (
              <AgentCard key={a.id} a={a} menu={<CardMenu label={`Options for ${a.name}`} items={[{ label: 'Assign task', onClick: () => openComposer({ assignee: `agent:${a.id}` }) }]} />} />
            ))}
          </div>
        </section>
      )}

      {modal?.kind === 'add' && <AddMemberDialog team={dir.teams.find((t) => t.id === modal.team.id) ?? modal.team} agents={agents} people={people ?? []} viewer={v} onClose={() => setModal(null)} />}
      {modal?.kind === 'invite' && <InviteDialog onClose={() => setModal(null)} />}
      {modal?.kind === 'team' && <TeamForm team={modal.team} onClose={() => setModal(null)} />}
      {modal?.kind === 'agent' && <AgentForm defaults={modal.defaults} onClose={() => setModal(null)} onSaved={(a) => (location.hash = `#/agents/${a.id}`)} />}
    </>
  );
}
