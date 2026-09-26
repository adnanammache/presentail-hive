// Server-sent events: every mutation broadcasts a small event so open dashboards refresh live.
const clients = new Set();

export function subscribe(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // proxies must pass events through as they happen, not buffer them
  });
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

export function emit(type, data = {}) {
  broadcast(type, data);
  emitLocal(type, data);
}

/** To open dashboards only. Everyone connected gets it, so send ids, never private content. */
export function broadcast(type, data = {}) {
  const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of clients) res.write(payload);
}

// In-process listeners (e.g. forwarding an agent's reply to the Slack thread it came from).
const listeners = new Set();
export const onEvent = (fn) => (listeners.add(fn), () => listeners.delete(fn));
export function emitLocal(type, data) {
  for (const fn of listeners) {
    try {
      fn(type, data);
    } catch (err) {
      console.error('[events]', err.message);
    }
  }
}
