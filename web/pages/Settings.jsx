import { useState } from 'react';
import { api, useApi } from '../api.js';
import { Badge, Loading, PageHeader } from '../components/ui.jsx';

const HOW = {
  anthropic: 'Create a key at console.anthropic.com (a workspace with Managed Agents access) and add it in Railway as ANTHROPIC_API_KEY.',
  wafeq: 'In Wafeq: Settings → API keys → create a key. Add it in Railway as WAFEQ_API_KEY. It is stored in an Anthropic vault; agents never see it.',
  slack: 'At api.slack.com/apps: Create app → From scratch → OAuth & Permissions → add the chat:write scope → Install to workspace. Copy the Bot token (xoxb-…) into SLACK_BOT_TOKEN. Put your Slack member ID (Profile → ⋯ → Copy member ID) or a channel ID into SLACK_ALERT_CHANNEL; for a channel, invite the app to it first.',
  google: 'See DEPLOY.md → Continue with Google.',
};

export default function Settings() {
  const { data } = useApi('/settings');
  const [slack, setSlack] = useState(null);
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
      <PageHeader title="Settings" subtitle="What Hive is connected to. Secrets are set as Railway variables and never shown here." />
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
      <section className="card settings-note">
        <h2>Slack alerts</h2>
        <p className="muted">When Slack is connected, Hive messages you when:</p>
        <ul className="muted">
          <li>🟡 an agent needs your approval before posting or running a command</li>
          <li>✅ an agent finishes a turn on a task and is waiting for your review</li>
          <li>🔴 an agent gets stuck, or a scheduled workflow fails</li>
        </ul>
        <p className="muted small">Each alert has a button that opens the task in Hive.</p>
      </section>
    </>
  );
}
