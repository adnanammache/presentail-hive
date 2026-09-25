// Server-sent events: every mutation broadcasts a small event so open dashboards refresh live.
const clients = new Set();

export function subscribe(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

export function emit(type, data = {}) {
  const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of clients) res.write(payload);
}
