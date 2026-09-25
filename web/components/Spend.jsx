import { useState } from 'react';
import { useApi } from '../api.js';

export const money = (cents) => (cents >= 100000 ? `$${Math.round(cents / 100).toLocaleString()}` : `$${(cents / 100).toFixed(2)}`);

function last30(daily) {
  const byDay = Object.fromEntries(daily.map((d) => [d.day, d]));
  const out = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    out.push({ day: d, cents: byDay[d]?.cents ?? 0, runs: byDay[d]?.runs ?? 0 });
  }
  return out;
}

/** Daily spend, last 30 days: one series, one colour, hover for the exact figure. */
function DailyBars({ daily }) {
  const days = last30(daily);
  const [hover, setHover] = useState(null);
  const max = Math.max(...days.map((d) => d.cents), 1);
  const W = 300, H = 64, slot = W / days.length, bar = slot - 2;
  const label = (d) => new Date(d.day + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const shown = hover ?? days.at(-1);
  return (
    <figure className="spend-chart">
      <figcaption className="small muted">
        {label(shown)}: <strong className="text">{money(shown.cents)}</strong> · {shown.runs} {shown.runs === 1 ? 'run' : 'runs'}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Daily AI spend over the last 30 days" onMouseLeave={() => setHover(null)}>
        <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} className="spend-axis" />
        {days.map((d, i) => {
          const h = d.cents ? Math.max(2, (d.cents / max) * (H - 4)) : 0;
          return (
            <g key={d.day} onMouseEnter={() => setHover(d)}>
              <rect x={i * slot} y="0" width={slot} height={H} fill="transparent" />
              {h > 0 && <rect x={i * slot + 1} y={H - h} width={bar} height={h} rx="2" className={`spend-bar ${hover?.day === d.day ? 'on' : ''}`} />}
            </g>
          );
        })}
      </svg>
      <div className="spend-range small muted">
        <span>{label(days[0])}</span>
        <span>Today</span>
      </div>
    </figure>
  );
}

function Ranked({ rows }) {
  const max = Math.max(...rows.map((r) => r.cents), 1);
  return (
    <ul className="ranked">
      {rows.map((r) => (
        <li key={r.id} title={`${r.name}: ${money(r.cents)}`}>
          <span className="ranked-name clamp-1">
            <i style={{ background: r.color }} />
            {r.name}
          </span>
          <span className="ranked-bar">
            <span style={{ width: `${Math.max(3, (r.cents / max) * 100)}%` }} />
          </span>
          <span className="ranked-value">{money(r.cents)}</span>
        </li>
      ))}
    </ul>
  );
}

export default function SpendCard() {
  const { data } = useApi('/spend', ['run']);
  if (!data) return null;
  const delta = data.last_month_cents ? Math.round(((data.month_cents - data.last_month_cents) / data.last_month_cents) * 100) : null;
  return (
    <section className="card spend">
      <header className="card-head">
        <h2>AI spend</h2>
        <span className="muted small">list price · Claude Managed Agents</span>
      </header>
      <div className="spend-hero">
        <span className="spend-number">{money(data.month_cents)}</span>
        <span className="muted small">
          this month · {data.runs_this_month} {data.runs_this_month === 1 ? 'run' : 'runs'}
          {delta !== null && ` · ${delta >= 0 ? '+' : ''}${delta}% vs last month (${money(data.last_month_cents)})`}
        </span>
      </div>
      {data.runs_this_month === 0 && data.daily.length === 0 ? (
        <p className="muted small">No agent runs yet. Costs appear here as soon as an agent works on a task.</p>
      ) : (
        <>
          <DailyBars daily={data.daily} />
          {data.by_team.length > 0 && (
            <div className="spend-split">
              <div>
                <h3 className="small muted">By team</h3>
                <Ranked rows={data.by_team} />
              </div>
              <div>
                <h3 className="small muted">By agent</h3>
                <Ranked rows={data.by_agent.slice(0, 6)} />
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
