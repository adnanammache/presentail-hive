import { StrictMode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LiveContext, PhotosContext, photoUrl, useApi, useLiveSource } from './api.js';
import { Icon } from './components/ui.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Agents from './pages/Agents.jsx';
import AgentDetail from './pages/AgentDetail.jsx';
import Close from './pages/Close.jsx';
import AllTasks from './pages/AllTasks.jsx';
import Projects from './pages/Projects.jsx';
import Project from './pages/Project.jsx';
import Composer from './components/Composer.jsx';
import TaskPanel from './components/TaskPanel.jsx';
import { PeopleUIContext, PersonAvatar, TaskUIContext, usePeopleUI } from './components/work.jsx';
import { PreferencesPanel, ProfilePanel } from './components/Profile.jsx';
import Workflows from './pages/Workflows.jsx';
import Inbox from './pages/Inbox.jsx';
import OrgChart from './pages/OrgChart.jsx';
import Settings from './pages/Settings.jsx';
import HiveMap from './pages/HiveMap.jsx';
import { RecurringDetails } from './components/Recurring.jsx';
import './styles.css';

function useHashRoute() {
  const read = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parts;
}

// Work first; the rest of Hive after.
const NAV = [
  ['', 'home', 'Dashboard'],
  ['my-tasks', 'mytasks', 'My tasks'],
  ['tasks', 'list', 'All tasks'],
  ['projects', 'folder', 'Projects'],
  ['agents', 'users', 'Team & agents'],
  ['inbox', 'inbox', 'Inbox'],
];
const MORE = [
  ['close', 'check', 'Month-end'],
  ['workflows', 'repeat', 'Recurring'],
  ['map', 'hex', 'Hive map'],
  ['org', 'org', 'Org chart'],
  ['settings', 'key', 'Settings'],
];

/** Your name and photo in the sidebar: a menu with My profile, Preferences and Sign out. */
function ProfileMenu({ me }) {
  const { openPerson, openPreferences } = usePeopleUI();
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const trigger = useRef(null);
  const items = () => [...(box.current?.querySelectorAll('[role=menuitem]') ?? [])];
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const away = (e) => !box.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const onKey = (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') (e.preventDefault(), list[(i + 1) % list.length]?.focus());
    else if (e.key === 'ArrowUp') (e.preventDefault(), list[(i - 1 + list.length) % list.length]?.focus());
    else if (e.key === 'Home') (e.preventDefault(), list[0]?.focus());
    else if (e.key === 'End') (e.preventDefault(), list.at(-1)?.focus());
    else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
  };
  const choose = (fn) => () => {
    setOpen(false);
    fn(trigger.current);
  };
  return (
    <div className="me-menu" ref={box} onKeyDown={onKey}>
      <button
        ref={trigger}
        type="button"
        className="me"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === 'ArrowUp' && (e.preventDefault(), setOpen(true))}
      >
        <PersonAvatar name={me.name} photo={me.avatar_url} size={32} />
        <span className="grow me-text">
          <span className="me-name clamp-1">{me.name}</span>
          {me.title && <span className="me-sub clamp-1">{me.title}</span>}
        </span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="menu me-pop" role="menu" aria-label="Your account">
          <button type="button" role="menuitem" onClick={choose((t) => openPerson(null, t))}>
            <Icon name="user" size={15} /> My profile
          </button>
          <button type="button" role="menuitem" onClick={choose((t) => openPreferences(t))}>
            <Icon name="key" size={15} /> Preferences
          </button>
          {me.auth === 'google' && (
            <a role="menuitem" href="/auth/logout" className="menu-link">
              <Icon name="x" size={15} /> Sign out
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/** Profile and preferences panels, above every page. Focus goes back to what opened them. */
function PeopleUI({ children }) {
  const [panel, setPanel] = useState(null); // { kind: 'person', email } | { kind: 'prefs' }
  const returnTo = useRef(null);
  const openPerson = useCallback((email, from) => {
    returnTo.current = from ?? document.activeElement;
    setPanel({ kind: 'person', email: email ?? null });
  }, []);
  const openPreferences = useCallback((from) => {
    returnTo.current = from ?? document.activeElement;
    setPanel({ kind: 'prefs' });
  }, []);
  const close = useCallback(() => {
    setPanel(null);
    setTimeout(() => returnTo.current?.focus?.(), 0);
  }, []);
  const value = useMemo(() => ({ openPerson, openPreferences }), [openPerson, openPreferences]);
  return (
    <PeopleUIContext.Provider value={value}>
      {children}
      {panel?.kind === 'person' && <ProfilePanel key={panel.email ?? 'me'} email={panel.email} onClose={close} />}
      {panel?.kind === 'prefs' && <PreferencesPanel onClose={close} />}
    </PeopleUIContext.Provider>
  );
}

function Favorites({ section, id }) {
  const { data: favs } = useApi('/projects?favorites=1', ['project']);
  if (!favs?.length) return null;
  return (
    <div className="nav-group">
      <div className="nav-label">Favorites</div>
      {favs.map((p) => (
        <a key={p.id} href={`#/projects/${p.id}`} className={section === 'projects' && Number(id) === p.id ? 'on' : ''}>
          <span className="fav-dot" style={{ background: p.color }} aria-hidden="true" />
          <span className="clamp-1">{p.name}</span>
        </a>
      ))}
    </div>
  );
}

function Shell() {
  const [section = '', id, sub] = useHashRoute();
  const { data: meta } = useApi('/meta');
  const { data: me } = useApi('/me', ['user']);
  const { data: overview } = useApi('/overview', ['task']);
  const [navOpen, setNavOpen] = useState(false);
  const live = useContext(LiveContext);
  useEffect(() => setNavOpen(false), [section, id]);

  let page;
  if (section === 'agents' && id) page = <AgentDetail key={id} id={id} meta={meta} initialTab={sub} />;
  else if (section === 'agents') page = <Agents />;
  else if (section === 'org') page = <OrgChart me={me} />;
  else if (section === 'map') page = <HiveMap />;
  else if (section === 'tasks') page = <AllTasks />;
  else if (section === 'my-tasks') page = <AllTasks mine />;
  else if (section === 'projects' && id) page = <Project key={id} id={id} tab={sub} />;
  else if (section === 'projects') page = <Projects />;
  else if (section === 'close') page = <Close />;
  else if (section === 'settings') page = <Settings />;
  else if (section === 'workflows') page = <Workflows />;
  else if (section === 'inbox') page = <Inbox id={id} meta={meta} />;
  else page = <Dashboard />;

  const needsYou = overview ? overview.stats.tasks_review + overview.stats.tasks_blocked : 0;

  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" />
          <span>
            Presentail <strong>Hive</strong>
          </span>
        </div>
        <nav aria-label="Main">
          {NAV.map(([path, icon, label]) => (
            <a key={path} href={`#/${path}`} className={section === path ? 'on' : ''} aria-current={section === path ? 'page' : undefined}>
              <Icon name={icon} />
              <span>{label}</span>
              {path === 'tasks' && needsYou > 0 && <span className="nav-count" title="Needs review or blocked">{needsYou}</span>}
            </a>
          ))}
          <Favorites section={section} id={id} />
          <div className="nav-group">
            <div className="nav-label">Operations</div>
            {MORE.map(([path, icon, label]) => (
              <a key={path} href={`#/${path}`} className={section === path ? 'on' : ''} aria-current={section === path ? 'page' : undefined}>
                <Icon name={icon} />
                <span>{label}</span>
              </a>
            ))}
          </div>
        </nav>
        <div className="sidebar-foot">
          {me && <ProfileMenu me={me} />}
          <span className={`live ${live.connected ? 'on' : ''}`} /> {live.connected ? 'Live' : 'Reconnecting…'}
          {meta && !meta.claude && <div className="warn-note">Claude API key not set — Claude agents can’t reply yet.</div>}
        </div>
      </aside>
      <button className="icon-btn nav-toggle" onClick={() => setNavOpen((o) => !o)} aria-label="Menu">
        <Icon name="menu" />
      </button>
      <main className={`main ${section === 'inbox' || section === 'map' || (section === 'agents' && id) ? 'main-flush' : ''} ${['tasks', 'my-tasks'].includes(section) || (section === 'projects' && id && (!sub || sub === 'board' || sub === 'list')) ? 'main-work' : ''}`}>{page}</main>
    </div>
  );
}

function Photos({ children }) {
  const { data: agents, reload } = useApi('/agents', ['agent']);
  const value = useMemo(() => {
    const byId = new Map();
    const byName = new Map();
    for (const a of agents ?? []) {
      const url = photoUrl(a);
      if (url) byId.set(a.id, url), byName.set(a.name, url);
    }
    return { byId, byName, reload };
  }, [agents, reload]);
  return <PhotosContext.Provider value={value}>{children}</PhotosContext.Provider>;
}

/**
 * The composer, the task panel and a recurring task's details live above every page.
 * #/tasks/42 opens task 42; #/workflows/7 opens recurring task 7 (the link agents give people).
 */
function TaskUI({ children }) {
  const [section, id] = useHashRoute();
  const { data: me } = useApi('/me');
  const [request, setRequest] = useState(null);
  const [panelId, setPanelId] = useState(null);
  const [scheduleId, setScheduleId] = useState(null);
  const [toast, setToast] = useState(null);
  useEffect(() => {
    if (section === 'tasks' && id) setPanelId(Number(id));
    if (section === 'workflows' && id) setScheduleId(Number(id));
  }, [section, id]);
  const openSchedule = useCallback((sid) => setScheduleId(Number(sid)), []);
  const closeSchedule = useCallback(() => {
    setScheduleId(null);
    if (location.hash.match(/^#\/workflows\/\d+/)) history.replaceState(null, '', '#/workflows');
  }, []);
  const openComposer = useCallback(
    (defaults = {}) => setRequest({ nonce: Date.now(), defaults: { ...defaults, assignee: defaults.assignee === 'me' ? (me?.email ? `user:${me.email}` : null) : defaults.assignee } }),
    [me?.email],
  );
  const openTask = useCallback((t) => setPanelId(Number(typeof t === 'object' ? t.id : t)), []);
  const closeTask = useCallback(() => {
    setPanelId(null);
    if (location.hash.match(/^#\/tasks\/\d+/)) history.replaceState(null, '', '#/tasks');
  }, []);
  const created = (task) => {
    if (task.start && !task.start.ok) {
      setToast({ tone: 'red', text: `“${task.title}” was created, but ${task.agent_name ?? 'the agent'} couldn't start: ${task.start.error.replace(/\.$/, '')}. You can retry from the task.` });
      setPanelId(task.id);
    } else
      setToast({
        tone: 'green',
        text: task.start?.ok ? `Created “${task.title}” and started ${task.agent_name}.` : task.assignee?.type === 'user' ? `Created “${task.title}” and assigned it to ${task.assignee.name}.` : `Created “${task.title}”.`,
        taskId: task.id,
      });
  };
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);
  const value = useMemo(() => ({ openComposer, openTask, openSchedule }), [openComposer, openTask, openSchedule]);
  return (
    <TaskUIContext.Provider value={value}>
      {children}
      {panelId && <TaskPanel taskId={panelId} onClose={closeTask} me={me} />}
      {scheduleId && !panelId && <RecurringDetails id={scheduleId} onClose={closeSchedule} />}
      <Composer request={request} onCreated={created} />
      {toast && (
        <div className={`toast tone-${toast.tone}`} role="status">
          <span>{toast.text}</span>
          {toast.taskId && (
            <button type="button" className="link-btn" onClick={() => (setPanelId(toast.taskId), setToast(null))}>
              Open
            </button>
          )}
          <button type="button" className="icon-btn sm" aria-label="Dismiss" onClick={() => setToast(null)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
    </TaskUIContext.Provider>
  );
}

function App() {
  const live = useLiveSource();
  return (
    <LiveContext.Provider value={live}>
      <Photos>
        <TaskUI>
          <PeopleUI>
            <Shell />
          </PeopleUI>
        </TaskUI>
      </Photos>
    </LiveContext.Provider>
  );
}

// Installable as an app (Add to Home Screen).
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
