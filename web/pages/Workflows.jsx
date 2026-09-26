import { useState } from 'react';
import { PageHeader } from '../components/ui.jsx';
import { RecurringSection } from '../components/Recurring.jsx';

const VIEWS = [
  ['', 'All I can see'],
  ['assignee=me', 'Assigned to me'],
  ['created_by=me', 'Set up by me'],
];

/** Every recurring task you can see. #/workflows/12 opens recurring task 12 (see TaskUI in main.jsx). */
export default function Workflows() {
  const [view, setView] = useState('');
  return (
    <>
      <PageHeader title="Recurring tasks" subtitle="Schedules that create a task for a person or an agent each time they come round. Agents can set these up from a chat, too." />
      <div className="segmented" role="tablist" aria-label="Which recurring tasks">
        {VIEWS.map(([q, label]) => (
          <button key={q} type="button" role="tab" aria-selected={view === q} className={view === q ? 'on' : ''} onClick={() => setView(q)}>
            {label}
          </button>
        ))}
      </div>
      <RecurringSection key={view} query={view} />
    </>
  );
}
