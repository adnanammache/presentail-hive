import { useState } from 'react';
import { ago, api, fmtDateTime, until, useApi } from '../api.js';
import { Avatar, Badge, Empty, Icon, Loading, Modal, PageHeader, runTone } from '../components/ui.jsx';
import { WorkflowForm } from '../components/forms.jsx';

function Runs({ workflow, onClose }) {
  const { data: runs } = useApi(`/workflows/${workflow.id}/runs`, ['workflow', 'task']);
  return (
    <Modal title={`Runs · ${workflow.name}`} onClose={onClose} wide>
      {!runs ? (
        <Loading />
      ) : runs.length === 0 ? (
        <Empty title="No runs yet">Use “Run now” to try it.</Empty>
      ) : (
        <ul className="list">
          {runs.map((r) => (
            <li key={r.id} className="list-row top">
              <Badge tone={runTone[r.status]}>{r.status}</Badge>
              <div className="grow">
                <div className="row-title">
                  {fmtDateTime(r.started_at)} <span className="muted small">· {r.trigger}</span>
                </div>
                {r.output && <div className="row-sub pre">{r.output}</div>}
              </div>
              {r.task_id && (
                <a className="link small nowrap" href={`#/tasks`}>
                  task #{r.task_id}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export function WorkflowList({ workflows, onEdit, onRuns }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Workflow</th>
            <th>Agent</th>
            <th>Schedule</th>
            <th>Next run</th>
            <th>Last run</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {workflows.map((w) => (
            <tr key={w.id} className={w.enabled ? '' : 'disabled'}>
              <td>
                <button className="linkish row-title" onClick={() => onEdit(w)}>
                  {w.name}
                </button>
                <div className="row-sub">{w.description}</div>
              </td>
              <td>
                {w.agent_name ? (
                  <a className="inline-agent" href={`#/agents/${w.agent_id}`}>
                    <Avatar name={w.agent_name} color={w.agent_color} size={22} /> {w.agent_name}
                  </a>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>
                <code>{w.schedule}</code>
                <div className="row-sub">{w.timezone}</div>
              </td>
              <td>
                {w.enabled ? (
                  <>
                    {until(w.next_run_at)}
                    <div className="row-sub">{fmtDateTime(w.next_run_at, w.timezone)}</div>
                  </>
                ) : (
                  <Badge>paused</Badge>
                )}
              </td>
              <td>
                {w.last_status ? <Badge tone={runTone[w.last_status]}>{w.last_status}</Badge> : <span className="muted">never</span>}
                {w.last_run_at && <div className="row-sub">{ago(w.last_run_at)}</div>}
              </td>
              <td className="actions">
                <button className="btn btn-sm" onClick={() => api(`/workflows/${w.id}/run`, { method: 'POST' })} title="Run now">
                  <Icon name="play" size={14} /> Run
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => onRuns(w)}>
                  History ({w.run_count})
                </button>
                <label className="switch" title={w.enabled ? 'Disable' : 'Enable'}>
                  <input type="checkbox" checked={w.enabled} onChange={(e) => api(`/workflows/${w.id}`, { method: 'PATCH', body: { enabled: e.target.checked } })} />
                  <span />
                </label>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Workflows() {
  const { data: workflows } = useApi('/workflows', ['workflow']);
  const [editing, setEditing] = useState(null);
  const [runsFor, setRunsFor] = useState(null);
  return (
    <>
      <PageHeader title="Recurring workflows" subtitle="Each run creates a task for the agent and sends it the instructions.">
        <button className="btn btn-primary" onClick={() => setEditing({})}>
          <Icon name="plus" size={16} /> New workflow
        </button>
      </PageHeader>
      {!workflows ? (
        <Loading />
      ) : workflows.length === 0 ? (
        <Empty title="No workflows yet">Schedule recurring work — month-end closes, daily briefs, weekly reports.</Empty>
      ) : (
        <WorkflowList workflows={workflows} onEdit={setEditing} onRuns={setRunsFor} />
      )}
      {editing && <WorkflowForm workflow={editing.id ? editing : null} onClose={() => setEditing(null)} />}
      {runsFor && <Runs workflow={runsFor} onClose={() => setRunsFor(null)} />}
    </>
  );
}
