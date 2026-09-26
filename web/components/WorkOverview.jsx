// The Work overview next to a conversation: the task(s) linked to it, what's coming up for the agent,
// and recent files. All from /agents/:id/workspace (real tasks, schedules and stored files).
import { fmtDay, toDate } from '../api.js';
import { Badge, Icon, statusLabel } from './ui.jsx';
import { useTaskUI } from './work.jsx';
import { fileSize } from './Chat.jsx';

const BLOCKER = { info: 'Waiting for input', approval: 'Waiting for approval', failed: 'Execution failed' };
const TONE = { review: 'amber', waiting_approval: 'amber', in_progress: 'blue', done: 'green', scheduled: 'neutral', ready: 'neutral', backlog: 'neutral' };

export const viewerZone = (tz) => tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function when(item, tz) {
  if (item.date_only) return `${item.at_kind === 'due' ? 'Due' : 'Starts'} ${fmtDay(item.at, { year: false })}`;
  const d = toDate(item.at);
  return `Next run ${d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz })}`;
}

function fileIcon(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  if (['xlsx', 'xls', 'csv'].includes(ext)) return { cls: 'sheet', label: 'X' };
  if (ext === 'pdf') return { cls: 'pdf', label: 'PDF' };
  if (['doc', 'docx'].includes(ext)) return { cls: 'doc', label: 'W' };
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return { cls: 'img', label: 'IMG' };
  return { cls: 'other', label: ext.slice(0, 4).toUpperCase() || 'FILE' };
}

function Section({ title, children, action }) {
  return (
    <section className="wo-section">
      <div className="wo-section-head">
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export default function WorkOverview({ agent, data, error, chatId, onClose, onViewRecurring, onRetry }) {
  const { openTask, openComposer } = useTaskUI();
  const tz = viewerZone(data?.timezone);
  const createTask = () => openComposer({ assignee: `agent:${agent.id}`, ...(chatId ? { source_chat_id: chatId } : {}) });
  return (
    <div className="work-overview">
      <header className="wo-head">
        <h2 id="wo-title">Work overview</h2>
        {onClose && (
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Hide work overview" title="Hide">
            <Icon name="x" size={16} />
          </button>
        )}
      </header>
      {error && (
        <div className="wo-error small">
          Couldn't load the work overview.{' '}
          <button type="button" className="link-btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {!data && !error && <div className="wo-loading muted small">Loading…</div>}
      {data && (
        <>
          <Section title={data.current_tasks.length > 1 ? 'Tasks from this conversation' : 'Current task'}>
            {!chatId && <p className="wo-empty">Open a conversation to see the task it's about.</p>}
            {chatId && data.current_tasks.length === 0 && (
              <div className="wo-empty">
                <p>No task is linked to this conversation yet.</p>
                <button type="button" className="btn btn-sm" onClick={createTask}>
                  <Icon name="plus" size={14} /> Create task
                </button>
              </div>
            )}
            {data.current_tasks.map((t) => (
              <div key={t.id} className="wo-task">
                <span className="wo-task-icon" aria-hidden="true">
                  <Icon name="file" size={18} />
                </span>
                <div className="grow">
                  <div className="wo-task-title">{t.title}</div>
                  <div className="wo-badges">
                    {t.blocker ? <Badge tone={t.blocker.kind === 'failed' ? 'red' : 'amber'}>{BLOCKER[t.blocker.kind]}</Badge> : <Badge tone={TONE[t.status] ?? 'neutral'}>{statusLabel(t.status)}</Badge>}
                    {t.needs_me && <Badge tone="amber">Needs you</Badge>}
                  </div>
                  {t.blocker?.reason && <p className="wo-reason clamp-2">{t.blocker.reason}</p>}
                  {t.assignee && <div className="muted small">Assigned to {t.assignee.name}</div>}
                  <button type="button" className="link-btn wo-open" onClick={() => openTask(t.id)}>
                    Open task <Icon name="arrow" size={14} />
                  </button>
                </div>
              </div>
            ))}
          </Section>

          <Section title="Upcoming">
            {data.upcoming.length === 0 && <p className="wo-empty">Nothing scheduled for {agent.name}.</p>}
            {data.upcoming.map((u) => (
              <button
                type="button"
                key={`${u.kind}-${u.id}-${u.at_kind}`}
                className="wo-item"
                onClick={() => (u.kind === 'task' ? openTask(u.id) : onViewRecurring())}
              >
                <Icon name="calendar" size={18} />
                <span className="grow">
                  <span className="wo-item-title clamp-1">{u.title}</span>
                  <span className={`wo-when ${u.overdue ? 'overdue' : ''}`}>
                    {when(u, tz)}
                    {u.overdue ? ' · overdue' : ''}
                  </span>
                </span>
                {u.recurring && (
                  <span className="wo-recurring" title="Repeats">
                    <Icon name="repeat" size={13} /> Recurring
                  </span>
                )}
              </button>
            ))}
            <button type="button" className="link-btn wo-more" onClick={onViewRecurring}>
              View recurring tasks <Icon name="arrow" size={14} />
            </button>
          </Section>

          <Section title="Recent files">
            {data.files.scope === 'agent' && <p className="wo-scope muted small">Nothing in this conversation yet. From {agent.name}'s recent tasks:</p>}
            {data.files.items.length === 0 && <p className="wo-empty">No files yet. Files you send here and files {agent.name} produces show up here.</p>}
            {data.files.items.map((f) => {
              const icon = fileIcon(f.filename);
              return (
                <div key={f.key} className="wo-file">
                  <span className={`file-badge ${icon.cls}`} aria-hidden="true">
                    {icon.label}
                  </span>
                  <span className="grow">
                    <span className="wo-item-title clamp-1" title={f.filename}>
                      {f.filename}
                    </span>
                    <span className="muted small">
                      {f.kind === 'deliverable' ? 'From the agent' : f.kind === 'task' ? 'Task file' : 'Shared here'} · {fmtDay(toDate(f.at)?.toISOString().slice(0, 10), { year: false })}
                      {f.size ? ` · ${fileSize(f.size)}` : ''}
                    </span>
                  </span>
                  <a className="btn btn-sm" href={f.url} download={f.filename} aria-label={`Download ${f.filename}`}>
                    <Icon name="download" size={14} />
                  </a>
                </div>
              );
            })}
          </Section>
          <p className="wo-tz muted small">All times in {tz}</p>
        </>
      )}
    </div>
  );
}
