import { StrictMode, useContext, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LiveContext, useApi, useLiveSource } from './api.js';
import { Icon } from './components/ui.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Agents from './pages/Agents.jsx';
import AgentDetail from './pages/AgentDetail.jsx';
import Tasks from './pages/Tasks.jsx';
import Workflows from './pages/Workflows.jsx';
import Inbox from './pages/Inbox.jsx';
import OrgChart from './pages/OrgChart.jsx';
import Settings from './pages/Settings.jsx';
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

const NAV = [
  ['', 'home', 'Dashboard'],
  ['org', 'org', 'Org chart'],
  ['agents', 'bot', 'Agents'],
  ['tasks', 'board', 'Tasks'],
  ['workflows', 'repeat', 'Workflows'],
  ['inbox', 'chat', 'Inbox'],
  ['settings', 'key', 'Settings'],
];

function Shell() {
  const [section = '', id] = useHashRoute();
  const { data: meta } = useApi('/meta');
  const { data: me } = useApi('/me');
  const { data: overview } = useApi('/overview', ['task']);
  const [navOpen, setNavOpen] = useState(false);
  const live = useContext(LiveContext);
  useEffect(() => setNavOpen(false), [section, id]);

  let page;
  if (section === 'agents' && id) page = <AgentDetail key={id} id={id} meta={meta} />;
  else if (section === 'agents') page = <Agents />;
  else if (section === 'org') page = <OrgChart me={me} />;
  else if (section === 'tasks') page = <Tasks openId={id} />;
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
        <nav>
          {NAV.map(([path, icon, label]) => (
            <a key={path} href={`#/${path}`} className={section === path ? 'on' : ''}>
              <Icon name={icon} />
              <span>{label}</span>
              {path === 'tasks' && needsYou > 0 && <span className="nav-count">{needsYou}</span>}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          {me?.auth === 'google' && (
            <div className="me">
              {me.picture ? <img src={me.picture} alt="" referrerPolicy="no-referrer" /> : <span className="me-initial">{me.name[0]}</span>}
              <div className="grow">
                <div className="me-name clamp-1">{me.name}</div>
                <a href="/auth/logout" className="link small">
                  Sign out
                </a>
              </div>
            </div>
          )}
          <span className={`live ${live.connected ? 'on' : ''}`} /> {live.connected ? 'Live' : 'Reconnecting…'}
          {meta && !meta.claude && <div className="warn-note">Claude API key not set — Claude agents can’t reply yet.</div>}
        </div>
      </aside>
      <button className="icon-btn nav-toggle" onClick={() => setNavOpen((o) => !o)} aria-label="Menu">
        <Icon name="menu" />
      </button>
      <main className={`main ${section === 'inbox' || (section === 'agents' && id) ? 'main-flush' : ''}`}>{page}</main>
    </div>
  );
}

function App() {
  const live = useLiveSource();
  return (
    <LiveContext.Provider value={live}>
      <Shell />
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
