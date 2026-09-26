import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Keeps a scrolling list pinned to its newest item, but only while the reader is already at the
 * bottom: someone reading older messages is never pulled down. Returns the ref for the scroller,
 * its onScroll handler, whether new items arrived out of view, and a way to jump to them.
 * `key` changes whenever there's something new; `reset` starts over (e.g. another conversation).
 */
export default function useStickToBottom(key, reset) {
  const ref = useRef(null);
  const pinned = useRef(true);
  const first = useRef(true);
  const lastTop = useRef(0);
  const [unseen, setUnseen] = useState(false);

  const toBottom = useCallback((smooth = true) => {
    const el = ref.current;
    if (!el) return;
    pinned.current = true;
    setUnseen(false);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  useEffect(() => {
    first.current = true;
    pinned.current = true;
  }, [reset]);

  useEffect(() => {
    if (key == null) return;
    if (first.current) {
      first.current = false;
      toBottom(false);
    } else if (pinned.current) toBottom();
    else setUnseen(true);
  }, [key, toBottom]);

  // A banner or hint appearing shrinks the list: stay on the newest message if you were there.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    const up = el.scrollTop < lastTop.current;
    lastTop.current = el.scrollTop;
    // Scrolling up means reading; our own smooth scroll only ever moves down.
    if (atBottom) {
      pinned.current = true;
      setUnseen(false);
    } else if (up) pinned.current = false;
  }, []);

  return { ref, onScroll, unseen, toBottom, pin: () => (pinned.current = true) };
}
