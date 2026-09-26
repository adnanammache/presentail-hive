import { Icon } from '../components/ui.jsx';
import WorkView from '../components/TaskViews.jsx';
import { useTaskUI } from '../components/work.jsx';

/** All tasks (everything you can see) or My tasks (assigned to you). */
export default function AllTasks({ mine }) {
  const { openComposer } = useTaskUI();
  return (
    <WorkView
      key={mine ? 'mine' : 'all'}
      scope={mine ? { mine: true } : {}}
      prefKey={mine ? 'my-tasks' : 'all-tasks'}
      header={() => (
        <div className="page-head work-head">
          <div>
            <h1>{mine ? 'My tasks' : 'All tasks'}</h1>
            <p className="page-sub">{mine ? 'Work assigned to you.' : 'Work across your people, agents and projects.'}</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => openComposer({ ...(mine ? { assignee: 'me' } : {}) })}>
            <Icon name="plus" size={16} /> New task
          </button>
        </div>
      )}
    />
  );
}
