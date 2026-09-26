// The agent workspace's conversation history: every conversation this person may see with the agent,
// Active or Archived (their own choice), searchable, grouped by date and loaded a page at a time.
// Each row shows the title, time, a preview (or what is waiting in it), unread messages, and why it
// came back to Active; its menu renames, shares, archives or restores. All from
// /agents/:id/conversations, which only returns conversations this person may see.
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { LiveContext, api } from '../api.js';
import { Icon } from './ui.jsx';
import Menu from './Menu.jsx';
import { RESURFACED, rowTime, withGroups } from './chatUtil.js';

const FILTERS = [
  ['active', 'Active'],
  ['archived', 'Archived'],
  ['all', 'All'],
];
const PAGE = 30;
const ATTENTION_TONE = { approval: 'amber', review: 'amber', input: 'amber', failed: 'red', working: 'blue' };

function Row({ c, on, filter, onSelect, actions }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(c.title);
  const [error, setError] = useState('');
  const rename = async (e) => {
    e.preventDefault();
    try {
      await actions.rename(c, name);
      setRenaming(false);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  };
  if (renaming)
    return (
      <li className="ch-row renaming">
        <form className="ch-rename" onSubmit={rename}>
          <input
            autoFocus
            value={name}
            maxLength={80}
            aria-label="Conversation name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setRenaming(false))}
          />
          <button className="btn btn-sm btn-primary" disabled={!name.trim()}>
            Save
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setRenaming(false)}>
            Cancel
          </button>
          {error && <span className="text-red small">{error}</span>}
        </form>
      </li>
    );
  const at = filter === 'archived' ? c.archived_at : c.last_message_at ?? c.created_at;
  const status = c.attention;
  const describe = [c.title, c.unread ? `${c.unread} unread` : null, status?.label, c.archived && filter !== 'archived' ? 'archived' : null].filter(Boolean).join(', ');
  return (
    <li className={`ch-row ${on ? 'on' : ''} ${c.unread ? 'has-unread' : ''}`}>
      <button type="button" className="ch-main" aria-current={on ? 'true' : undefined} aria-label={describe} onClick={() => onSelect(c.id)}>
        <span className={`ch-dot ${c.unread ? 'unread' : ''}`} aria-hidden="true" />
        <span className="grow ch-text">
          <span className="ch-title clamp-1">{c.title}</span>
          {status ? (
            <span className={`ch-attn tone-${ATTENTION_TONE[status.kind] ?? 'neutral'}`}>{status.label}</span>
          ) : c.preview ? (
            <span className="ch-preview clamp-1">{c.preview.text}</span>
          ) : (
            <span className="ch-preview muted">No messages yet</span>
          )}
          <span className="ch-tags">
            {c.source === 'slack' && <span className="ch-tag">Slack</span>}
            {c.visibility === 'shared' && (
              <span className="ch-tag" title={c.audience?.label}>
                <Icon name="users" size={11} /> Shared
              </span>
            )}
            {c.archived && filter === 'all' && <span className="ch-tag">Archived</span>}
            {c.resurfaced && !c.archived && <span className="ch-back">Returned to active: {RESURFACED[c.resurfaced.reason] ?? 'new activity'}</span>}
          </span>
        </span>
        <span className="ch-side">
          <time className="ch-time" dateTime={at ?? undefined} title={filter === 'archived' ? 'When you archived it' : 'Latest activity'}>
            {rowTime(at)}
          </time>
          {c.unread > 0 && (
            <span className="ch-count" aria-hidden="true">
              {c.unread > 99 ? '99+' : c.unread}
            </span>
          )}
        </span>
      </button>
      <Menu
        className="ch-menu"
        label={`Actions for “${c.title}”`}
        items={[
          { label: 'Rename', icon: 'edit', hidden: !c.can_manage, onSelect: () => (setName(c.title), setRenaming(true)) },
          { label: c.visibility === 'shared' ? 'Make private' : 'Share with the workspace', icon: c.visibility === 'shared' ? 'lock' : 'users', hidden: !c.can_manage, onSelect: () => actions.share(c) },
          c.can_manage ? 'sep' : null,
          c.archived ? { label: 'Restore', icon: 'archive', onSelect: () => actions.restore(c) } : { label: 'Archive', icon: 'archive', onSelect: () => actions.archive(c) },
        ]}
      />
    </li>
  );
}

/**
 * refreshKey: bump to reload after an action elsewhere. onCollapse: hide the panel (wide screens);
 * onClose: close the drawer (narrow screens).
 */
export default function ConversationHistory({ agent, currentId, onSelect, onNew, actions, refreshKey, onCollapse, onClose, drawer }) {
  const live = useContext(LiveContext);
  const [filter, setFilter] = useState('active');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [list, setList] = useState({ chats: null, next: null, loading: false, error: '' });
  const loaded = useRef(0);
  const seq = useRef(0);
  const sentinel = useRef(null);
  const scroller = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const params = useCallback((extra) => {
    const p = new URLSearchParams({ filter, ...(query ? { q: query } : {}), ...extra });
    return `/agents/${agent.id}/conversations?${p}`;
  }, [agent.id, filter, query]);

  /** First page again; after a live change, as many rows as were loaded (so the list doesn't jump). */
  const reload = useCallback(async ({ keep } = {}) => {
    const mine = ++seq.current;
    setList((l) => ({ ...l, loading: true, error: '', ...(keep ? {} : { chats: null }) }));
    try {
      const page = await api(params({ limit: String(Math.min(100, Math.max(PAGE, keep ? loaded.current : PAGE))) }));
      if (mine !== seq.current) return; // a newer request (filter or search changed) wins
      loaded.current = page.chats.length;
      setList({ chats: page.chats, next: page.next_cursor, loading: false, error: '' });
    } catch (err) {
      if (mine === seq.current) setList((l) => ({ ...l, loading: false, error: err.message }));
    }
  }, [params]);

  const more = useCallback(async () => {
    if (!list.next || list.loading) return;
    const mine = seq.current;
    setList((l) => ({ ...l, loading: true }));
    try {
      const page = await api(params({ limit: String(PAGE), cursor: list.next }));
      if (mine !== seq.current) return;
      setList((l) => {
        const known = new Set(l.chats.map((c) => c.id));
        const chats = [...l.chats, ...page.chats.filter((c) => !known.has(c.id))];
        loaded.current = chats.length;
        return { chats, next: page.next_cursor, loading: false, error: '' };
      });
    } catch (err) {
      setList((l) => ({ ...l, loading: false, error: err.message }));
    }
  }, [list.next, list.loading, params]);

  useEffect(() => {
    reload();
  }, [reload]);
  useEffect(() => {
    if (refreshKey) reload({ keep: true });
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live: conversations change when messages arrive, runs move, tasks change or someone archives.
  useEffect(() => {
    if (!live) return;
    let timer;
    return live.on((e) => {
      if (!['*', 'chat', 'message', 'run', 'task'].includes(e.type)) return;
      if (e.agent_id != null && e.agent_id !== agent.id && e.type !== 'task') return;
      clearTimeout(timer);
      timer = setTimeout(() => reload({ keep: true }), 400);
    });
  }, [live, agent.id, reload]);

  // Load the next page when the end of the list scrolls into view (the button does the same).
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !list.next || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && more(), { root: scroller.current, rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, [list.next, more]);

  const rows = list.chats ? withGroups(list.chats, filter) : [];
  return (
    <div className="ch-panel">
      <div className="ch-head">
        <h2 id="ch-title">Conversations</h2>
        {(onCollapse || onClose) && (
          <button type="button" className="icon-btn" onClick={onClose ?? onCollapse} aria-label={drawer ? 'Close conversations' : 'Hide conversations'} title={drawer ? 'Close' : 'Hide conversations'}>
            <Icon name={drawer ? 'x' : 'sidebar'} size={16} />
          </button>
        )}
      </div>
      <button type="button" className="btn btn-primary ch-new" onClick={onNew}>
        <Icon name="plus" size={16} /> New conversation
      </button>
      <div className="ch-search">
        <Icon name="search" size={15} />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search conversations…" aria-label="Search conversations" />
      </div>
      <div className="segmented ch-filter" role="radiogroup" aria-label="Show">
        {FILTERS.map(([k, l]) => (
          <button key={k} type="button" role="radio" aria-checked={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
            {l}
          </button>
        ))}
      </div>
      {query && filter !== 'all' && (
        <p className="ch-scope small muted">
          Searching {filter} conversations.{' '}
          <button type="button" className="link-btn" onClick={() => setFilter('all')}>
            Search all
          </button>
        </p>
      )}
      <div className="ch-scroll" ref={scroller}>
        {list.error && (
          <div className="wo-error small" role="alert">
            Couldn't load conversations: {list.error}{' '}
            <button type="button" className="link-btn" onClick={() => reload()}>
              Try again
            </button>
          </div>
        )}
        {!list.chats && !list.error && <p className="muted small ch-empty">Loading…</p>}
        {list.chats?.length === 0 && (
          <p className="muted small ch-empty">
            {query ? `Nothing matches “${query}”.` : filter === 'archived' ? 'Nothing archived. Archive finished conversations to tidy this list; they stay searchable.' : filter === 'active' ? `No active conversations with ${agent.name}.` : 'No conversations yet.'}
          </p>
        )}
        <ul className="ch-list" aria-labelledby="ch-title">
          {rows.map(({ chat, group }) => (
            <FragmentRow key={chat.id} group={group}>
              <Row c={chat} on={chat.id === currentId} filter={filter} onSelect={onSelect} actions={actions} />
            </FragmentRow>
          ))}
        </ul>
        {list.next && (
          <div ref={sentinel} className="ch-more">
            <button type="button" className="btn btn-sm" onClick={more} disabled={list.loading}>
              {list.loading ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function FragmentRow({ group, children }) {
  return (
    <>
      {group && (
        <li className="ch-group" role="presentation">
          {group}
        </li>
      )}
      {children}
    </>
  );
}
