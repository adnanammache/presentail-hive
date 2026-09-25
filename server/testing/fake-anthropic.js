// A small in-memory stand-in for the parts of the Anthropic SDK that managed.js uses.
// Push responders onto `client.script`; each one answers the next events.send() call.
export function fakeAnthropic() {
  const calls = { skills: [], skillVersions: [], agentsCreate: [], agentsUpdate: [], credentials: [], environments: [], sessions: [], sent: [], uploads: [] };
  const sessions = new Map(); // id -> { history: [], listeners: Set }
  let n = 0;
  const id = (p) => `${p}_${++n}`;

  function emitTo(sid, events) {
    const s = sessions.get(sid);
    for (const ev of events) {
      const full = { id: ev.id ?? id('sevt'), processed_at: new Date().toISOString(), ...ev };
      s.history.push(full);
      for (const push of s.listeners) push(full);
    }
  }

  const script = []; // responses to send(): (sid, events) => events to emit
  const client = {
    calls,
    script,
    outputs: {}, // session id -> [{ id, filename, mime_type, size_bytes }]
    skills: {
      create: async ({ files, display_name }) => {
        calls.skills.push({ names: files.map((f) => f.name), display_name });
        return { id: id('skill') };
      },
      versions: { create: async (skillId, { files }) => (calls.skillVersions.push({ skillId, names: files.map((f) => f.name) }), { version: 2 }) },
    },
    beta: {
      environments: {
        create: async (p) => (calls.environments.push(p), { id: id('env') }),
        update: async (envId, p) => (calls.environments.push({ update: envId, ...p }), { id: envId }),
        list: async function* () {},
      },
      vaults: {
        create: async () => ({ id: id('vlt') }),
        credentials: {
          create: async (vaultId, p) => (calls.credentials.push({ vaultId, ...p }), { id: id('cred') }),
          archive: async () => ({}),
        },
      },
      agents: {
        create: async (p) => (calls.agentsCreate.push(p), { id: id('agent'), version: 1 }),
        update: async (agentId, p) => (calls.agentsUpdate.push({ agentId, ...p }), { id: agentId, version: p.version + 1 }),
        retrieve: async (agentId) => ({ id: agentId, version: 1 }),
      },
      files: {
        upload: async ({ file }) => (calls.uploads.push(file.name), { id: id('file') }),
        // Files the agent "saved" to /mnt/session/outputs/, per session.
        list: async function* ({ scope_id }) {
          for (const f of client.outputs[scope_id] ?? []) yield f;
        },
        download: async (fileId) => new Response(`contents of ${fileId}`),
      },
      sessions: {
        create: async (p) => {
          const sid = id('sesn');
          sessions.set(sid, { history: [], listeners: new Set() });
          calls.sessions.push({ sid, ...p });
          return { id: sid };
        },
        events: {
          list: (sid) => [...sessions.get(sid).history],
          send: async (sid, { events }) => {
            calls.sent.push({ sid, events });
            const respond = script.shift();
            if (respond) setTimeout(() => emitTo(sid, respond(events)), 5);
            return {};
          },
          stream: async (sid) => {
            const queue = [];
            let wake;
            const s = sessions.get(sid);
            const push = (ev) => (queue.push(ev), wake?.());
            s.listeners.add(push);
            const controller = new AbortController();
            controller.signal.addEventListener('abort', () => (s.listeners.delete(push), wake?.()));
            return {
              controller,
              async *[Symbol.asyncIterator]() {
                while (!controller.signal.aborted) {
                  if (!queue.length) await new Promise((r) => (wake = r));
                  while (queue.length) yield queue.shift();
                }
              },
            };
          },
        },
      },
    },
  };
  return client;
}
