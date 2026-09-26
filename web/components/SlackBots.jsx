// Settings → Slack bots: every agent as its own bot in Slack. Owners only.
import { useEffect, useState } from 'react';
import { api, useApi } from '../api.js';
import { Badge, Icon } from './ui.jsx';
import BotAvatar from './BotAvatar.jsx';

const STATE = {
  none: { tone: 'neutral', label: 'Not in Slack' },
  created: { tone: 'amber', label: 'Waiting for install' },
  installed: { tone: 'green', label: 'In Slack' },
};

/** Slack sends people back to /?slack=installed (or ?slack_error=…); show it once, then tidy the address. */
function useReturnNotice() {
  const [notice] = useState(() => {
    const q = new URLSearchParams(location.search);
    if (q.get('slack') === 'installed') return { ok: true, text: 'Installed. The bots are in Slack now: find them under Apps, or DM them by name.' };
    if (q.get('slack_error')) return { ok: false, text: q.get('slack_error') };
    return null;
  });
  useEffect(() => {
    if (location.search) history.replaceState(null, '', `${location.pathname}${location.hash}`);
  }, []);
  return notice;
}

export default function SlackBots() {
  const { data, reload, setData } = useApi('/slack/bots', ['slack_bots', 'agent']);
  const returned = useReturnNotice();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);

  const act = async (key, fn) => {
    setBusy(key);
    setMsg(null);
    try {
      const res = await fn();
      if (res?.agents) setData(res);
      if (res?.failed?.length) setMsg({ ok: false, text: `Couldn't create: ${res.failed.map((f) => `${f.name} (${f.error})`).join('; ')}` });
      return res;
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy('');
    }
  };
  const install = (agentId) =>
    act(`install-${agentId ?? 'all'}`, async () => {
      const { url } = await api('/slack/bots/install', { method: 'POST', body: agentId ? { agent_id: agentId } : {} });
      location.href = url; // Slack's Allow page; it sends you back here when done
    });

  if (!data) return null;
  const notice = msg ?? returned;
  const missing = data.agents.filter((a) => a.state === 'none').length;
  const waiting = data.agents.filter((a) => a.state === 'created').length;

  return (
    <section className="card settings-note slack-bots" aria-labelledby="slack-bots-title">
      <h2 id="slack-bots-title">Agents in Slack</h2>
      <p className="muted">
        Each agent gets its own bot in Slack, with its own name and photo. Anyone at Presentail can DM it, @mention it, or add it to a channel with{' '}
        <code>/invite @{data.agents[0]?.name ?? 'Ledger'}</code>. Sending files gives it a task, and approvals come with buttons. Everything also shows up in Hive.
      </p>
      {notice && (
        <p className={`notice ${notice.ok ? '' : 'warn'}`} role="status">
          {notice.text}
        </p>
      )}

      {!data.connected ? (
        <>
          <h3>Connect Hive to Slack (once)</h3>
          <ol className="muted small">
            <li>
              Signed in to Slack as an admin, open <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">api.slack.com/apps</a>.
            </li>
            <li>
              Under <b>Your App Configuration Tokens</b>, click <b>Generate Token</b> and pick the Presentail workspace.
            </li>
            <li>
              Copy the <b>Refresh Token</b> (it starts with <code>xoxe-</code>) and paste it here. Hive keeps it up to date by itself after that.
            </li>
          </ol>
          <form
            className="row-gap"
            onSubmit={(e) => {
              e.preventDefault();
              act('connect', () => api('/slack/bots/connect', { method: 'POST', body: { token } })).then((r) => r && setToken(''));
            }}
          >
            <input className="grow" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="xoxe-…" aria-label="Slack refresh token" />
            <button className="btn btn-primary" disabled={!token.trim() || busy === 'connect'}>
              {busy === 'connect' ? 'Connecting…' : 'Connect'}
            </button>
          </form>
        </>
      ) : (
        <>
          <div className="row-gap slack-bots-actions">
            <span className="muted small">
              {data.counts.installed} of {data.counts.total} agents in Slack
            </span>
            <span className="grow" />
            {missing > 0 && (
              <button className="btn" disabled={Boolean(busy)} onClick={() => act('create', () => api('/slack/bots/create', { method: 'POST', body: {} }))}>
                {busy === 'create' ? 'Creating…' : `Create ${missing === data.agents.length ? 'bots for all agents' : `${missing} missing bot${missing === 1 ? '' : 's'}`}`}
              </button>
            )}
            {waiting > 0 && (
              <button className="btn btn-primary" disabled={Boolean(busy)} onClick={() => install(null)}>
                {waiting === 1 ? 'Install in Slack' : `Install all ${waiting} in Slack`}
              </button>
            )}
          </div>
          {waiting > 0 && (
            <p className="muted small">Slack asks you to press <b>Allow</b> once per agent. Hive takes you from one to the next and brings you back here at the end.</p>
          )}
          <ul className="slack-bot-list">
            {data.agents.map((a) => {
              const s = STATE[a.state];
              return (
                <li key={a.agent_id} className="slack-bot-row">
                  <BotAvatar id={a.agent_id} name={a.name} color={a.color} size={32} />
                  <div className="grow">
                    <div className="slack-bot-name">
                      {a.name} <Badge tone={s.tone}>{s.label}</Badge>
                    </div>
                    <div className="muted small clamp-1">
                      {a.title}
                      {a.agent_status === 'paused' && ' · not set up in Hive yet, so it will say so in Slack'}
                    </div>
                    {a.error && <div className="small text-red">{a.error}</div>}
                  </div>
                  <div className="row-gap">
                    {a.state === 'none' && (
                      <button className="btn btn-sm" disabled={Boolean(busy)} onClick={() => act(`create-${a.agent_id}`, () => api('/slack/bots/create', { method: 'POST', body: { agent_id: a.agent_id } }))}>
                        {busy === `create-${a.agent_id}` ? 'Creating…' : 'Create'}
                      </button>
                    )}
                    {a.state === 'created' && (
                      <button className="btn btn-sm" disabled={Boolean(busy)} onClick={() => install(a.agent_id)}>
                        Install
                      </button>
                    )}
                    {a.slack_url && (
                      <a className="btn btn-sm" href={a.slack_url} target="_blank" rel="noreferrer">
                        Open in Slack
                      </a>
                    )}
                    {a.state !== 'none' && (
                      <>
                        <button className="icon-btn" title="Update name and photo in Slack" aria-label={`Update ${a.name} in Slack`} disabled={Boolean(busy)} onClick={() => act(`sync-${a.agent_id}`, () => api(`/slack/bots/${a.agent_id}/sync`, { method: 'POST' }))}>
                          <Icon name="repeat" size={16} />
                        </button>
                        <button
                          className="icon-btn"
                          title="Remove from Slack"
                          aria-label={`Remove ${a.name} from Slack`}
                          disabled={Boolean(busy)}
                          onClick={() => confirm(`Remove ${a.name}'s bot from Slack? Its Slack conversations stay in Hive.`) && act(`remove-${a.agent_id}`, () => api(`/slack/bots/${a.agent_id}`, { method: 'DELETE' }))}
                        >
                          <Icon name="trash" size={16} />
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="muted small">
            Renaming an agent or changing its photo in Hive updates its bot in Slack too.{' '}
            <button className="link-btn" onClick={() => confirm('Disconnect? The bots stay in Slack and keep working; Hive just stops being able to create or update them.') && act('disconnect', () => api('/slack/bots/connect', { method: 'DELETE' })).then(reload)}>
              Disconnect
            </button>
          </p>
        </>
      )}
    </section>
  );
}
