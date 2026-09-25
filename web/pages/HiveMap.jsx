import { useEffect, useMemo, useRef, useState } from 'react';
import { ago, api, useApi } from '../api.js';
import { Badge, Icon, Loading, PLATFORM_LABELS, agentTone } from '../components/ui.jsx';
import BotAvatar, { BotFace } from '../components/BotAvatar.jsx';
import { TaskForm } from '../components/forms.jsx';
import { money } from '../components/Spend.jsx';

// ---- geometry: flat-topped hexagons on an axial grid ----
const CELL = 92; // distance between agent centres (token + its name label)
const TOKEN = 31;
const hexPoints = (r) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 180) * (60 * i);
    return `${(r * Math.cos(a)).toFixed(1)},${(r * Math.sin(a)).toFixed(1)}`;
  }).join(' ');

/** Axial hex spiral: 1, then rings of 6, 12, 18… positions around the centre. */
function spiral(n) {
  const dirs = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const out = [[0, 0]];
  for (let ring = 1; out.length < n; ring++) {
    let q = -ring, r = ring; // start at direction 4 * ring
    for (let side = 0; side < 6 && out.length < n; side++) {
      for (let step = 0; step < ring && out.length < n; step++) {
        out.push([q, r]);
        q += dirs[side][0];
        r += dirs[side][1];
      }
    }
  }
  return out.slice(0, n);
}
const axialToXY = ([q, r], size) => [size * 1.5 * q, size * Math.sqrt(3) * (r + q / 2)];

function mood(a) {
  if (a.status === 'paused') return 'paused';
  if (a.pending_approvals > 0) return 'waiting';
  if (a.running_runs > 0 || a.status === 'active') return 'working';
  if (a.status === 'error') return 'error';
  return 'idle';
}
const MOOD_LABEL = { working: 'Working', waiting: 'Needs you', idle: 'Ready', paused: 'Not set up', error: 'Error' };

function layout(teams, agents) {
  const groups = [...teams.map((t) => ({ team: t, members: agents.filter((a) => a.team_id === t.id) }))];
  const loose = agents.filter((a) => !a.team_id);
  if (loose.length) groups.push({ team: { id: 0, name: 'No team', color: '#94a3b8' }, members: loose });

  const clusters = groups.map((g) => {
    let cells = spiral(Math.max(1, g.members.length)).map((c) => axialToXY(c, CELL / Math.sqrt(3)));
    // Centre the group in its zone (a partial ring would otherwise sit off to one side).
    const mx = cells.reduce((t, [x]) => t + x, 0) / cells.length;
    const my = cells.reduce((t, [, y]) => t + y, 0) / cells.length;
    cells = cells.map(([x, y]) => [x - mx, y - my]);
    const reach = Math.max(...cells.map(([x, y]) => Math.hypot(x, y))) + CELL * 0.85;
    return { ...g, cells, radius: Math.max(reach, CELL * 1.15) };
  });
  // Departments sit on a ring around the Presentail hub, spaced by their size.
  const total = clusters.reduce((t, c) => t + c.radius * 2 + 40, 0);
  const ringR = Math.max(260, total / (2 * Math.PI));
  let angle = -Math.PI / 2;
  for (const c of clusters) {
    const span = (c.radius * 2 + 40) / ringR;
    angle += span / 2;
    c.cx = Math.cos(angle) * (ringR + c.radius * 0.35);
    c.cy = Math.sin(angle) * (ringR + c.radius * 0.35);
    angle += span / 2;
  }
  const pad = 30;
  const box = {
    x0: Math.min(-100, ...clusters.map((c) => c.cx - c.radius)) - pad,
    x1: Math.max(100, ...clusters.map((c) => c.cx + c.radius)) + pad,
    y0: Math.min(-100, ...clusters.map((c) => c.cy - c.radius * 0.87 - 34)) - pad, // room for the team label
    y1: Math.max(110, ...clusters.map((c) => c.cy + c.radius * 0.87)) + pad,
  };
  return { clusters, box, extent: `${box.x0},${box.x1},${box.y0},${box.y1}` };
}

function AgentToken({ a, x, y, selected, dim, onSelect, ghost }) {
  const m = mood(a);
  return (
    <g
      data-agent={a.id}
      className={`map-agent mood-${m} ${selected ? 'selected' : ''} ${dim ? 'dim' : ''} ${ghost ? 'ghost' : ''}`}
      transform={`translate(${x} ${y})`}
      onClick={(e) => (e.stopPropagation(), onSelect(a, e))}
      role="button"
      tabIndex={0}
      aria-label={`${a.name}, ${a.title}: ${MOOD_LABEL[m]}`}
      onKeyDown={(e) => e.key === 'Enter' && onSelect(a)}
    >
      <polygon points={hexPoints(TOKEN)} className="map-cell" style={{ '--c': a.color }} />
      {m === 'working' && <polygon points={hexPoints(TOKEN)} className="map-pulse" style={{ '--c': a.color }} />}
      <g transform="translate(-22 -24) scale(0.44)">
        <BotFace name={a.name} color={a.color} mood={m === 'paused' ? 'paused' : m} />
      </g>
      {m === 'waiting' && (
        <g transform="translate(20 -23)">
          <circle r="8" className="map-flag" />
          <text className="map-flag-text" textAnchor="middle" dy="3.5">
            {a.pending_approvals}
          </text>
        </g>
      )}
      <text className="map-name" y="44" textAnchor="middle">
        {a.name.length > 14 ? a.name.slice(0, 13) + '…' : a.name}
      </text>
    </g>
  );
}

function Panel({ a, onClose, onAssign }) {
  const m = mood(a);
  let skills = [];
  try {
    skills = JSON.parse(a.skills || '[]');
  } catch {}
  return (
    <aside className="map-panel" aria-label={`${a.name} details`}>
      <button className="icon-btn map-close" onClick={onClose} aria-label="Close">
        <Icon name="x" />
      </button>
      <div className="map-panel-head">
        <BotAvatar name={a.name} color={a.color} size={64} mood={m === 'paused' ? 'paused' : m} />
        <div>
          <h2>{a.name}</h2>
          <div className="muted">{a.title}</div>
          <div className="hero-meta">
            <Badge tone={{ working: 'blue', waiting: 'amber', idle: 'green', paused: 'neutral', error: 'red' }[m]}>{MOOD_LABEL[m]}</Badge>
            {a.team_name && <span className="team-chip" style={{ '--c': a.team_color }}>{a.team_name}</span>}
          </div>
        </div>
      </div>
      {a.description && <p className="map-desc">{a.description}</p>}
      <dl className="map-facts">
        <div>
          <dt>Open tasks</dt>
          <dd>{a.open_tasks}</dd>
        </div>
        <div>
          <dt>This month</dt>
          <dd>
            {money(a.month_cents || 0)}
            {a.budget_cents != null && <span className="muted"> / {money(a.budget_cents)}</span>}
          </dd>
        </div>
        <div>
          <dt>Runs on</dt>
          <dd>{PLATFORM_LABELS[a.platform]}</dd>
        </div>
        <div>
          <dt>Last active</dt>
          <dd>{ago(a.last_seen_at)}</dd>
        </div>
      </dl>
      {skills.length > 0 && (
        <div className="map-skills">
          {skills.map((s) => (
            <span key={s} className="pill">
              {s.replace(/^anthropic:/, '').replace(/-/g, ' ')}
            </span>
          ))}
        </div>
      )}
      {a.pending_approvals > 0 && (
        <a className="notice warn map-notice" href={`#/agents/${a.id}`}>
          {a.name} is waiting for your approval.
        </a>
      )}
      <div className="map-actions">
        <a className="btn" href={`#/inbox/${a.id}`}>
          <Icon name="chat" size={16} /> Message
        </a>
        <button className="btn" onClick={() => onAssign(a)}>
          <Icon name="plus" size={16} /> Assign task
        </button>
        <a className="btn btn-primary" href={`#/agents/${a.id}`}>
          Open
        </a>
      </div>
    </aside>
  );
}

function TeamPanel({ c, onClose, onSelectAgent }) {
  const counts = c.members.reduce((t, a) => ((t[mood(a)] = (t[mood(a)] || 0) + 1), t), {});
  const open = c.members.reduce((t, a) => t + (a.open_tasks || 0), 0);
  const spend = c.members.reduce((t, a) => t + (a.month_cents || 0), 0);
  return (
    <aside className="map-panel" aria-label={`${c.team.name} details`}>
      <button className="icon-btn map-close" onClick={onClose} aria-label="Close">
        <Icon name="x" />
      </button>
      <div className="map-panel-head">
        <svg width="52" height="52" viewBox="-30 -30 60 60" aria-hidden="true">
          <polygon points={hexPoints(28)} fill={c.team.color} opacity="0.2" stroke={c.team.color} strokeWidth="2" />
        </svg>
        <div>
          <h2>{c.team.name}</h2>
          <div className="muted">
            {c.members.length} agent{c.members.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>
      <dl className="map-facts">
        <div>
          <dt>Working</dt>
          <dd>{counts.working || 0}</dd>
        </div>
        <div>
          <dt>Needs you</dt>
          <dd>{counts.waiting || 0}</dd>
        </div>
        <div>
          <dt>Open tasks</dt>
          <dd>{open}</dd>
        </div>
        <div>
          <dt>This month</dt>
          <dd>{money(spend)}</dd>
        </div>
      </dl>
      <ul className="list map-team-list">
        {c.members.map((a) => (
          <li key={a.id}>
            <button className="list-row clickable linkish" onClick={() => onSelectAgent(a)}>
              <BotAvatar name={a.name} color={a.color} size={30} mood={mood(a) === 'paused' ? 'paused' : mood(a)} />
              <div className="grow">
                <div className="row-title">{a.name}</div>
                <div className="row-sub">{a.title}</div>
              </div>
              <span className="muted small">{MOOD_LABEL[mood(a)]}</span>
            </button>
          </li>
        ))}
      </ul>
      {c.team.id > 0 && (
        <a className="btn" href="#/org">
          Open in org chart
        </a>
      )}
    </aside>
  );
}

function Feed() {
  const { data } = useApi('/activity?limit=6', ['activity']);
  const [open, setOpen] = useState(() => window.innerWidth > 900);
  if (!data?.length) return null;
  return (
    <div className={`map-feed ${open ? 'open' : ''}`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <button className="map-feed-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="live on" /> Happening now
      </button>
      {open && (
        <ul>
          {data.map((e) => (
            <li key={e.id}>
              {e.agent_name && <b style={{ color: e.agent_color }}>{e.agent_name} </b>}
              <span>{e.agent_name && e.text.startsWith(e.agent_name) ? e.text.slice(e.agent_name.length).trimStart() : e.text}</span>
              <span className="muted"> · {ago(e.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function HiveMap() {
  const { data: agents } = useApi('/agents', ['agent', 'task', 'run']);
  const { data: teams } = useApi('/teams', ['agent']);
  const [view, setView] = useState(null); // { x, y, k }
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [assigning, setAssigning] = useState(null);
  const [teamSel, setTeamSel] = useState(null); // team id whose panel is open
  const [moving, setMoving] = useState(null); // { agent, x, y } while an agent is being moved
  const [toast, setToast] = useState(null);
  const hold = useRef(null);
  const box = useRef(null);
  const pointers = useRef(new Map());
  const gesture = useRef(null);

  const map = useMemo(() => (agents && teams ? layout(teams, agents) : null), [agents, teams]);

  const fit = () => {
    const el = box.current;
    if (!el || !map) return;
    const { width, height } = el.getBoundingClientRect();
    const { x0, x1, y0, y1 } = map.box;
    const k = Math.max(0.2, Math.min(width / (x1 - x0), (height - 50) / (y1 - y0), 1.6)); // 50: legend strip
    setView({ x: width / 2 - ((x0 + x1) / 2) * k, y: (height - 50) / 2 - ((y0 + y1) / 2) * k, k });
  };
  useEffect(fit, [map?.extent]);
  useEffect(() => {
    const onResize = () => fit();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  const zoomAt = (factor, cx, cy) =>
    setView((v) => {
      const k = Math.max(0.2, Math.min(3, v.k * factor));
      const f = k / v.k;
      return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
    });

  const local = (e) => {
    const r = box.current.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const onWheel = (e) => {
    e.preventDefault();
    const [x, y] = local(e);
    zoomAt(Math.exp(-e.deltaY * 0.0015), x, y);
  };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  // Capture the pointer only once it actually drags, so plain clicks still reach the agent tokens.
  const dragged = useRef(false);
  const toWorld = ([sx, sy]) => [(sx - view.x) / view.k, (sy - view.y) / view.k];
  const zoneAt = ([wx, wy]) =>
    map.clusters.find((c) => Math.hypot(wx - c.cx, wy - c.cy) < c.radius * 0.9) ?? null;

  // Hold an agent (~0.4s) to pick it up, then drop it on another department to move it there.
  const onPointerDown = (e) => {
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 1) dragged.current = 0;
    gesture.current = null;
    clearTimeout(hold.current);
    const id = Number(e.target.closest?.('[data-agent]')?.getAttribute('data-agent'));
    if (id && pointers.current.size === 1) {
      const pointerId = e.pointerId;
      hold.current = setTimeout(() => {
        const agent = agents.find((a) => a.id === id);
        if (!agent || dragged.current === true) return;
        dragged.current = true; // swallow the click that follows
        box.current.setPointerCapture?.(pointerId);
        const [x, y] = toWorld(pointers.current.get(pointerId));
        setMoving({ agent, x, y });
        navigator.vibrate?.(15);
      }, 420);
    }
  };
  const onPointerMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    const prev = pointers.current.get(e.pointerId);
    const now = local(e);
    pointers.current.set(e.pointerId, now);
    if (moving) {
      const [x, y] = toWorld(now);
      setMoving((m) => m && { ...m, x, y });
      return;
    }
    if (dragged.current !== true) {
      dragged.current += Math.hypot(now[0] - prev[0], now[1] - prev[1]);
      if (dragged.current < 5) return;
      dragged.current = true;
      clearTimeout(hold.current);
      box.current.setPointerCapture?.(e.pointerId);
    }
    if (pointers.current.size === 1) {
      setView((v) => ({ ...v, x: v.x + now[0] - prev[0], y: v.y + now[1] - prev[1] }));
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (gesture.current) zoomAt(dist / gesture.current, mid[0], mid[1]);
      gesture.current = dist;
    }
  };
  const moveAgent = async (agent, teamId, undo) => {
    try {
      await api(`/agents/${agent.id}`, { method: 'PATCH', body: { team_id: teamId || null } });
      const name = teamId ? teams.find((t) => t.id === teamId)?.name : 'No team';
      setToast(undo ? null : { text: `Moved ${agent.name} to ${name}`, undo: () => moveAgent(agent, agent.team_id, true) });
    } catch (err) {
      setToast({ text: err.message });
    }
  };
  const onPointerUp = (e) => {
    clearTimeout(hold.current);
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
    if (moving) {
      const zone = zoneAt([moving.x, moving.y]);
      const target = zone ? zone.team.id || 0 : null;
      if (zone && target !== (moving.agent.team_id || 0)) moveAgent(moving.agent, target);
      setMoving(null);
    }
  };
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  if (!agents || !teams) return <Loading />;

  // Dashed arrows from each agent to the agent who reviews its work.
  const where = new Map();
  for (const c of map?.clusters ?? []) c.members.forEach((a, i) => where.set(a.id, [c.cx + c.cells[i][0], c.cy + c.cells[i][1]]));
  const reviewLinks = agents
    .filter((a) => a.reviewer_id && where.has(a.id) && where.has(a.reviewer_id))
    .map((a) => {
      const [x1, y1] = where.get(a.id);
      const [x2, y2] = where.get(a.reviewer_id);
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const [ux, uy] = [(x2 - x1) / len, (y2 - y1) / len];
      const [sx, sy, ex, ey] = [x1 + ux * 34, y1 + uy * 34, x2 - ux * 36, y2 - uy * 36]; // start/end at the token edges
      const bend = Math.min(60, len * 0.25);
      const [mx, my] = [(sx + ex) / 2 - uy * bend, (sy + ey) / 2 + ux * bend];
      const reviewer = agents.find((x) => x.id === a.reviewer_id);
      return { key: a.id, d: `M${sx} ${sy} Q${mx} ${my} ${ex} ${ey}`, title: `${reviewer?.name} reviews ${a.name}'s work` };
    });

  const q = query.trim().toLowerCase();
  const matches = (a) =>
    (!q || `${a.name} ${a.title} ${a.team_name ?? ''}`.toLowerCase().includes(q)) &&
    (filter === 'all' || mood(a) === filter || (filter === 'live' && a.platform === 'managed' && a.status !== 'paused'));
  const counts = agents.reduce((c, a) => ((c[mood(a)] = (c[mood(a)] || 0) + 1), c), {});
  const live = agents.filter((a) => a.platform === 'managed' && a.status !== 'paused').length;
  const FILTERS = [
    ['all', `All ${agents.length}`],
    ['working', `Working ${counts.working || 0}`],
    ['waiting', `Needs you ${counts.waiting || 0}`],
    ['live', `Live ${live}`],
    ['paused', `Not set up ${counts.paused || 0}`],
  ];

  return (
    <div className="map-page">
      <div className="map-toolbar">
        <h1>Hive map</h1>
        <div className="map-search">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find an agent, title or team…" aria-label="Search agents" />
        </div>
        <div className="chips">
          {FILTERS.map(([key, label]) => (
            <button key={key} className={`chip ${filter === key ? 'on' : ''}`} onClick={() => setFilter(key)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={box}
        className="map-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={() => dragged.current !== true && (setSelected(null), setTeamSel(null))}
      >
        {view && map && (
          <svg width="100%" height="100%" role="img" aria-label="Map of Presentail's AI agents grouped by department">
            <defs>
              <pattern id="honeycomb" width="42" height="72.7" patternUnits="userSpaceOnUse" patternTransform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                <path d="M21 0 L42 12.1 L42 36.4 L21 48.5 L0 36.4 L0 12.1 Z M21 48.5 L21 72.7" className="map-comb" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#honeycomb)" />
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              {map.clusters.map((c) => (
                <line key={`l${c.team.id}`} x1="0" y1="0" x2={c.cx} y2={c.cy} className="map-link" />
              ))}
              <defs>
                <marker id="review-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0 0 L10 5 L0 10 z" className="map-review-head" />
                </marker>
              </defs>
              <g className="map-hub">
                <polygon points={hexPoints(58)} />
                <polygon points={hexPoints(22)} className="map-hub-core" />
                <text y="84" textAnchor="middle" className="map-hub-label">
                  Presentail
                </text>
              </g>
              {map.clusters.map((c) => (
                <g
                  key={c.team.id}
                  transform={`translate(${c.cx} ${c.cy})`}
                  style={{ '--c': c.team.color }}
                  className={`map-zone-g ${moving && zoneAt([moving.x, moving.y]) === c ? 'drop' : ''} ${teamSel === c.team.id ? 'selected' : ''}`}
                >
                  <polygon
                    points={hexPoints(c.radius)}
                    className="map-zone"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (dragged.current === true) return;
                      setSelected(null);
                      setTeamSel(c.team.id);
                    }}
                  />
                  <text
                    y={-c.radius * 0.87 - 12}
                    textAnchor="middle"
                    className="map-zone-label"
                    onClick={(e) => (e.stopPropagation(), setSelected(null), setTeamSel(c.team.id))}
                  >
                    {c.team.name}
                    <tspan className="map-zone-count"> · {c.members.length}</tspan>
                  </text>
                  {c.members.map((a, i) => (
                    <AgentToken key={a.id} a={a} x={c.cells[i][0]} y={c.cells[i][1]} selected={selected?.id === a.id} dim={!matches(a) || moving?.agent.id === a.id} onSelect={(a) => dragged.current !== true && (setTeamSel(null), setSelected(a))} />
                  ))}
                  {c.members.length === 0 && (
                    <text textAnchor="middle" className="map-empty">
                      No agents yet
                    </text>
                  )}
                </g>
              ))}
              {reviewLinks.map((l) => (
                <path key={l.key} d={l.d} className="map-review" markerEnd="url(#review-arrow)">
                  <title>{l.title}</title>
                </path>
              ))}
              {moving && <AgentToken a={moving.agent} x={moving.x} y={moving.y} ghost onSelect={() => {}} />}
            </g>
          </svg>
        )}

        <div className="map-zoom" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" aria-label="Zoom in" onClick={() => zoomAt(1.25, box.current.clientWidth / 2, box.current.clientHeight / 2)}>
            <Icon name="plus" />
          </button>
          <button className="icon-btn" aria-label="Zoom out" onClick={() => zoomAt(0.8, box.current.clientWidth / 2, box.current.clientHeight / 2)}>
            <span className="map-minus">−</span>
          </button>
          <button className="icon-btn" aria-label="Fit to screen" onClick={fit}>
            <Icon name="home" size={16} />
          </button>
        </div>

        <div className="map-legend" aria-hidden="true">
          <span><i className="lg working" /> Working</span>
          <span><i className="lg waiting" /> Needs you</span>
          <span><i className="lg idle" /> Ready</span>
          <span><i className="lg paused" /> Not set up</span>
          {reviewLinks.length > 0 && <span><i className="lg-review" /> Reviews</span>}
          <span className="map-hint">Hold an agent to move it</span>
        </div>

        <Feed />

        {teamSel !== null && !selected && map && (() => {
          const c = map.clusters.find((x) => x.team.id === teamSel);
          return c ? (
            <div onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
              <TeamPanel c={c} onClose={() => setTeamSel(null)} onSelectAgent={(a) => (setTeamSel(null), setSelected(a))} />
            </div>
          ) : null;
        })()}

        {toast && (
          <div className="map-toast" role="status" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            {toast.text}
            {toast.undo && (
              <button className="link" onClick={toast.undo}>
                Undo
              </button>
            )}
          </div>
        )}

        {selected && (
          <div onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            <Panel a={agents.find((x) => x.id === selected.id) ?? selected} onClose={() => setSelected(null)} onAssign={setAssigning} />
          </div>
        )}
      </div>
      {assigning && <TaskForm defaults={{ agent_id: assigning.id }} onClose={() => setAssigning(null)} />}
    </div>
  );
}
