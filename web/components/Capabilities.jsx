import { useEffect, useState } from 'react';
import { api, useApi } from '../api.js';
import { Badge, Icon, Loading } from './ui.jsx';

const list = (json) => {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

function CheckCard({ checked, onChange, title, children, aside, disabled }) {
  return (
    <label className={`check-card ${checked ? 'on' : ''} ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <div className="grow">
        <div className="check-title">
          {title} {aside}
        </div>
        <div className="row-sub">{children}</div>
      </div>
    </label>
  );
}

/** The agent's "Skills & tools" tab: what it knows, what it can reach, and when it must ask. */
export default function Capabilities({ agent, onSaved }) {
  const { data: caps } = useApi('/capabilities');
  const [skills, setSkills] = useState(list(agent.skills));
  const [integrations, setIntegrations] = useState(list(agent.integrations));
  const [approval, setApproval] = useState(agent.approval || 'agent_asks');
  const [state, setState] = useState({ saving: false, error: null, saved: false });

  useEffect(() => {
    setSkills(list(agent.skills));
    setIntegrations(list(agent.integrations));
    setApproval(agent.approval || 'agent_asks');
  }, [agent.id, agent.skills, agent.integrations, agent.approval]);

  if (!caps) return <Loading />;
  const managed = agent.platform === 'managed';
  const dirty = JSON.stringify([skills, integrations, approval]) !== JSON.stringify([list(agent.skills), list(agent.integrations), agent.approval || 'agent_asks']);

  const toggleSkill = (skill, on) => {
    setSkills((s) => (on ? [...s, skill.key] : s.filter((k) => k !== skill.key)));
    // A skill that needs a system brings that integration along.
    if (on) setIntegrations((i) => [...new Set([...i, ...(skill.integrations || [])])]);
  };

  const save = async () => {
    setState({ saving: true, error: null, saved: false });
    try {
      let saved = await api(`/agents/${agent.id}`, { method: 'PATCH', body: { skills, integrations, approval, ...(managed ? {} : { platform: 'managed' }) } });
      if (caps.managed) saved = await api(`/agents/${agent.id}/sync`, { method: 'POST' });
      onSaved?.(saved);
      setState({ saving: false, error: null, saved: true });
    } catch (err) {
      setState({ saving: false, error: err.message, saved: false });
    }
  };

  const presentail = caps.skills.filter((s) => s.source === 'presentail');
  const builtin = caps.skills.filter((s) => s.source !== 'presentail');

  return (
    <div className="caps">
      {!managed && (
        <div className="notice">
          <Icon name="sparkles" />
          <div>
            <strong>{agent.name} is chat-only today.</strong> Giving it skills and tools turns it into a <em>Claude Managed Agent</em>: it gets its own
            sandbox, runs your procedures, and does real work on tasks. Saving below makes the switch.
          </div>
        </div>
      )}
      {!caps.managed && <div className="notice warn">Set ANTHROPIC_API_KEY in Railway so agents can run. You can still prepare their skills now.</div>}

      <section>
        <h3>Skills</h3>
        <p className="muted small">Procedures {agent.name} follows. Presentail's own skills live in the Hive repo under agent-skills/.</p>
        <div className="check-grid">
          {presentail.map((s) => (
            <CheckCard key={s.key} checked={skills.includes(s.key)} onChange={(on) => toggleSkill(s, on)} title={s.name} aside={s.integrations.length ? <Badge tone="blue">{s.integrations.join(', ')}</Badge> : null}>
              {s.description}
            </CheckCard>
          ))}
        </div>
        <h4 className="muted small caps-sub">Built-in</h4>
        <div className="check-grid">
          {builtin.map((s) => (
            <CheckCard key={s.key} checked={skills.includes(s.key)} onChange={(on) => toggleSkill(s, on)} title={s.name}>
              {s.description}
            </CheckCard>
          ))}
        </div>
      </section>

      <section>
        <h3>Tools & systems</h3>
        <p className="muted small">Every agent gets a private sandbox (files, Python, command line). Tick the business systems it may reach.</p>
        <div className="check-grid">
          {caps.integrations.map((i) => (
            <CheckCard
              key={i.key}
              checked={integrations.includes(i.key)}
              onChange={(on) => setIntegrations((list) => (on ? [...list, i.key] : list.filter((k) => k !== i.key)))}
              title={i.name}
              aside={i.configured ? <Badge tone="green">connected</Badge> : <Badge tone="amber">needs {i.env}</Badge>}
            >
              {i.description}
            </CheckCard>
          ))}
          <div className="check-card disabled">
            <div className="grow">
              <div className="check-title">Odoo, Google Drive, Gmail, Slack, Asana</div>
              <div className="row-sub">Coming next, as each team's agents go live.</div>
            </div>
          </div>
        </div>
      </section>

      <section>
        <h3>Approvals</h3>
        <div className="check-grid">
          <label className={`check-card ${approval === 'agent_asks' ? 'on' : ''}`}>
            <input type="radio" name="approval" checked={approval === 'agent_asks'} onChange={() => setApproval('agent_asks')} />
            <div className="grow">
              <div className="check-title">Ask before posting (recommended)</div>
              <div className="row-sub">It does a dry run, shows you the totals, and waits for your go-ahead before writing to any live system.</div>
            </div>
          </label>
          <label className={`check-card ${approval === 'every_command' ? 'on' : ''}`}>
            <input type="radio" name="approval" checked={approval === 'every_command'} onChange={() => setApproval('every_command')} />
            <div className="grow">
              <div className="check-title">Ask before every command</div>
              <div className="row-sub">Every command and file change waits for Approve / Reject in Hive. Slower, maximum control.</div>
            </div>
          </label>
        </div>
      </section>

      <footer className="caps-foot">
        <div className="grow small">
          {state.error ? (
            <span className="text-red">{state.error}</span>
          ) : agent.ma_sync_error ? (
            <span className="text-red">Last sync failed: {agent.ma_sync_error}</span>
          ) : agent.ma_agent_id ? (
            <span className="muted">
              Live on Claude Managed Agents · version {agent.ma_agent_version}
              {state.saved ? ' · saved just now' : ''}
            </span>
          ) : (
            <span className="muted">Not set up on Claude Managed Agents yet.</span>
          )}
        </div>
        <button className="btn btn-primary" onClick={save} disabled={state.saving || (!dirty && managed && agent.ma_agent_id && !agent.ma_sync_error)}>
          {state.saving ? 'Saving…' : managed ? 'Save & sync' : 'Make it a Managed Agent'}
        </button>
      </footer>
    </div>
  );
}

