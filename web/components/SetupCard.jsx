import { useState } from 'react';
import { api, useApi } from '../api.js';
import { Icon } from './ui.jsx';

/** "Your setup checklist": ticks itself off as Hive sees each step done. */
export default function SetupCard() {
  const { data, setData } = useApi('/setup', ['setup', 'agent', 'run', 'task']);
  const [showDone, setShowDone] = useState(false);
  if (!data || data.hidden || data.done === data.total) return null;

  const post = (body) => api('/setup', { method: 'POST', body }).then(setData);
  const todo = data.items.filter((i) => !i.done);
  const done = data.items.filter((i) => i.done);
  const pct = Math.round((data.done / data.total) * 100);

  const Row = ({ i }) => (
    <li className={`setup-item ${i.done ? 'done' : ''}`}>
      {i.manual ? (
        <button className="setup-tick" onClick={() => post({ key: i.key, done: !i.done })} aria-label={i.done ? `Mark "${i.title}" not done` : `Mark "${i.title}" done`}>
          {i.done && <Icon name="check" size={14} />}
        </button>
      ) : (
        <span className="setup-tick auto" title={i.done ? 'Done' : 'Ticks itself once Hive sees it done'}>
          {i.done && <Icon name="check" size={14} />}
        </span>
      )}
      <div className="grow">
        <div className="row-title">{i.href && !i.done ? <a href={i.href}>{i.title}</a> : i.title}</div>
        {!i.done && <div className="row-sub">{i.detail}</div>}
        {i.progress && <div className="row-sub">Live: {i.progress}</div>}
      </div>
    </li>
  );

  return (
    <section className="card setup-card">
      <header className="card-head">
        <h2>Your setup checklist</h2>
        <span className="muted small">
          {data.done} of {data.total} done
        </span>
        <button className="link setup-hide" onClick={() => post({ hidden: true })}>
          Hide
        </button>
      </header>
      <div className="setup-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <ul className="list setup-list">
        {todo.map((i) => (
          <Row key={i.key} i={i} />
        ))}
      </ul>
      {done.length > 0 && (
        <>
          <button className="link setup-toggle" onClick={() => setShowDone((v) => !v)}>
            {showDone ? 'Hide' : 'Show'} {done.length} done
          </button>
          {showDone && (
            <ul className="list setup-list">
              {done.map((i) => (
                <Row key={i.key} i={i} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
