import { useState } from 'react';
import { ago, api, useApi } from '../api.js';
import { Badge, Loading, PageHeader } from '../components/ui.jsx';
import { BriefSettings, NotificationSettings } from '../components/Notifications.jsx';

const HOW = {
  anthropic: 'Create a key at console.anthropic.com (a workspace with Managed Agents access) and add it in Railway as ANTHROPIC_API_KEY.',
  odoo: 'In Odoo: click your avatar → My Profile → Account Security → New API Key (use a user with accounting rights on all companies). Add it in Railway as ODOO_API_KEY. Optional: ODOO_URL (default https://presentail.odoo.com) and ODOO_DB (default presentail). The key stays in Hive; agents never see it.',
  wafeq: 'In Wafeq: Settings → API keys → create a key. Add it in Railway as WAFEQ_API_KEY. It is stored in an Anthropic vault; agents never see it.',
  slack: 'At api.slack.com/apps: Create app → From scratch → OAuth & Permissions → add the chat:write scope → Install to workspace. Copy the Bot token (xoxb-…) into SLACK_BOT_TOKEN. Put your Slack member ID (Profile → ⋯ → Copy member ID) or a channel ID into SLACK_ALERT_CHANNEL; for a channel, invite the app to it first.',
  google: 'See DEPLOY.md → Continue with Google.',
};

function OdooLog() {
  const { data } = useApi('/odoo/actions', ['run']);
  if (!data?.length) return <p className="muted small">No changes yet. Every Odoo change an agent makes shows up here, with who approved it.</p>;
  return (
    <div className="table-wrap">
      <table className="audit">
        <thead>
          <tr>
            <th>When</th>
            <th>Agent</th>
            <th>Call</th>
            <th>Company</th>
            <th>Status</th>
            <th>Approved by</th>
          </tr>
        </thead>
        <tbody>
          {data.map((a) => (
            <tr key={a.id} title={a.result || ''}>
              <td className="nowrap">{ago(a.created_at)}</td>
              <td>{a.task_id ? <a className="link" href={`#/tasks/${a.task_id}`}>{a.agent_name}</a> : a.agent_name}</td>
              <td className="mono">{a.model}.{a.method}</td>
              <td>{a.company ?? '—'}</td>
              <td>
                <Badge tone={{ executed: 'green', pending: 'amber', rejected: 'neutral', refused: 'red', failed: 'red' }[a.status] ?? 'neutral'}>{a.status}</Badge>
              </td>
              <td>{a.approved_by ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Settings() {
  const { data } = useApi('/settings');
  const { data: setup } = useApi('/setup', ['setup']);
  const [slack, setSlack] = useState(null);
  const [odoo, setOdoo] = useState(null);
  const testOdoo = async () => {
    setOdoo({ busy: true });
    try {
      setOdoo(await api('/settings/odoo/test', { method: 'POST' }));
    } catch (err) {
      setOdoo({ error: err.message });
    }
  };
  if (!data) return <Loading />;
  const test = async () => {
    setSlack('Sending…');
    try {
      await api('/settings/slack/test', { method: 'POST' });
      setSlack('Sent. Check Slack.');
    } catch (err) {
      setSlack(err.message);
    }
  };
  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="What Hive is connected to. Secrets are set as Railway variables and never shown here."
      >
        {setup?.hidden && setup.done < setup.total && (
            <button className="btn" onClick={() => api('/setup', { method: 'POST', body: { hidden: false } }).then(() => (location.hash = '#/'))}>
              Show setup checklist ({setup.done}/{setup.total})
            </button>
        )}
      </PageHeader>
      <div className="settings-list">
        {data.connections.map((c) => (
          <section key={c.key} className="card settings-row">
            <div className="grow">
              <div className="check-title">
                {c.name} {c.connected ? <Badge tone="green">connected</Badge> : <Badge tone="amber">not connected</Badge>}
              </div>
              <div className="row-sub">{c.purpose}</div>
              {!c.connected && (
                <details className="settings-how">
                  <summary>How to connect</summary>
                  <p>{HOW[c.key]}</p>
                  <p className="muted small">
                    Railway variable: <code>{c.env}</code>
                  </p>
                </details>
              )}
            </div>
            {c.key === 'odoo' && c.connected && (
              <div className="settings-action">
                <button className="btn btn-sm" onClick={testOdoo}>
                  {odoo?.busy ? 'Testing…' : 'Test connection'}
                </button>
                {odoo?.error && <span className="small text-red">{odoo.error}</span>}
                {odoo?.companies && (
                  <span className="small muted">
                    ✓ {odoo.db} · {odoo.companies.map((co) => co.name).join(', ')}
                  </span>
                )}
              </div>
            )}
            {c.key === 'slack' && c.connected && (
              <div className="settings-action">
                <button className="btn btn-sm" onClick={test}>
                  Send test alert
                </button>
                {slack && <span className="small muted">{slack}</span>}
              </div>
            )}
          </section>
        ))}
      </div>
      <NotificationSettings />
      <BriefSettings />
      <section className="card settings-note">
        <h2>Odoo changes by agents</h2>
        <p className="muted small">Reads aren't listed. Hover a row to see what Odoo returned.</p>
        <OdooLog />
      </section>
      <section className="card settings-note">
        <h2>Slack alerts</h2>
        <p className="muted">When Slack is connected, Hive messages you when:</p>
        <ul className="muted">
          <li>🟡 an agent needs your approval before posting or running a command</li>
          <li>✅ an agent finishes a turn on a task and is waiting for your review</li>
          <li>🔴 an agent gets stuck, or a scheduled workflow fails</li>
        </ul>
        <p className="muted small">Each alert has a button that opens the task in Hive.</p>
        <h3>Approve from Slack</h3>
        {data.slack?.buttons && data.slack.approvers > 0 ? (
          <p className="muted">✅ On. Approval alerts have Approve and Reject buttons; the alert updates to show who decided.</p>
        ) : (
          <ol className="muted small">
            <li>
              In your Slack app: <b>Interactivity &amp; Shortcuts</b> → turn on → Request URL <code>{data.slack?.interactivity_url}</code> → Save.
            </li>
            <li>
              <b>Basic Information</b> → copy the <b>Signing Secret</b> into Railway as <code>SLACK_SIGNING_SECRET</code>.
            </li>
            <li>
              If alerts go to a channel, set <code>SLACK_APPROVERS</code> to the member IDs allowed to approve (comma-separated). If they go to your DMs, you're the approver automatically.
            </li>
          </ol>
        )}
        <h3>Talk to agents in Slack</h3>
        <p className="muted">
          DM the Hive app with an agent's name first, e.g. <i>Ledger: can you do Careem for August?</i> The agent answers in the thread under its own name and face. Attach files to give it a task; progress and approvals come back to the same thread. Only people with a Presentail email can use it.
        </p>
        {data.slack?.conversations ? (
          <p className="muted">✅ On. Hive has received messages from Slack.</p>
        ) : (
          <ol className="muted small">
            <li>
              <b>OAuth &amp; Permissions</b> → Bot Token Scopes: <code>chat:write</code>, <code>chat:write.customize</code>, <code>im:history</code>, <code>app_mentions:read</code>, <code>channels:history</code>, <code>files:read</code>, <code>users:read</code>, <code>users:read.email</code>.
            </li>
            <li>
              <b>Event Subscriptions</b> → on → Request URL <code>{data.slack?.events_url}</code> → Subscribe to bot events: <code>message.im</code>, <code>app_mention</code>, <code>message.channels</code> → Save.
            </li>
            <li>
              <b>App Home</b> → tick "Allow users to send Slash commands and messages from the messages tab".
            </li>
            <li>Reinstall the app to your workspace (Slack asks after scope changes). It needs <code>SLACK_SIGNING_SECRET</code> too.</li>
          </ol>
        )}
        <h3>Agents talking to each other</h3>
        <p className="muted">
          Agents can message each other (e.g. Ledger asks Kyros for an intercompany balance). Every exchange is on the agents' <b>Colleagues</b> tab
          {data.slack?.agents_channel ? ', and posted to your agents channel in Slack.' : '. To see them in Slack too, create a channel such as #hive-agents, invite the Hive app, and put its ID in SLACK_AGENTS_CHANNEL.'}
        </p>
      </section>
    </>
  );
}
