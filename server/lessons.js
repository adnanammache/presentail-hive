// Lessons: what an agent should remember from corrections, so mistakes don't repeat.
//
// People add them: in the Lessons tab ("Teach"), by rejecting something with a reason (and
// ticking "remember"), or by starting a chat message (Hive or Slack) with "remember:". Those are
// approved as soon as they're written.
//
// Agents propose them with save_lesson: something a person told them, or a mistake of their own
// they have found. A proposal waits for an approver or owner (status 'pending_approval') unless
// the agent is trusted ("Always trust this agent's lessons"). Only approved, active lessons go
// into the agent's instructions. Rejected ones are kept, and shown to the agent through
// list_lessons, so it doesn't propose them again.
import Anthropic from '@anthropic-ai/sdk';
import { all, get, run } from './db.js';
import { emit } from './events.js';
import { logActivity } from './activity.js';
import { notifyLessonPending } from './notify.js';
import { LESSON_LIMITS } from '../shared/lessons.js';

const { MAX_IN_PROMPT, AGENT_MAX_CHARS, HUMAN_MAX_CHARS } = LESSON_LIMITS;

const byId = (id) => get('SELECT * FROM agent_lessons WHERE id = ?', id);

export const listLessons = (agentId) =>
  all(
    `SELECT l.*, t.title AS task_title, r.kind AS run_kind, r.origin AS run_origin
     FROM agent_lessons l LEFT JOIN tasks t ON t.id = l.task_id LEFT JOIN runs r ON r.id = l.run_id
     WHERE l.agent_id = ?
     ORDER BY CASE l.status WHEN 'pending_approval' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, l.active DESC, l.id DESC`,
    agentId,
  );

/** A lesson a person wrote: approved straight away. */
export function addLesson(agentId, text, { source = 'manual', taskId = null, by = null } = {}) {
  const body = String(text ?? '').trim().slice(0, HUMAN_MAX_CHARS);
  if (!body) throw new Error('The lesson is empty');
  const agent = get('SELECT id, name FROM agents WHERE id = ?', agentId);
  if (!agent) throw new Error('Unknown agent');
  const dup = get("SELECT id FROM agent_lessons WHERE agent_id = ? AND lower(text) = lower(?) AND active = 1 AND status = 'approved'", agentId, body);
  if (dup) return byId(dup.id);
  const id = Number(run('INSERT INTO agent_lessons (agent_id, text, source, task_id, created_by) VALUES (?, ?, ?, ?, ?)', agentId, body, source, taskId, by).lastInsertRowid);
  logActivity(agentId, 'agent', `${agent.name} learned: ${body.slice(0, 140)}${by ? ` (from ${by})` : ''}`);
  emit('lesson', { agent_id: agentId });
  return byId(id);
}

export function updateLesson(id, { text, active }) {
  const l = byId(id);
  if (!l) throw new Error('Lesson not found');
  if (text !== undefined) {
    if (!String(text).trim()) throw new Error('The lesson is empty');
    run('UPDATE agent_lessons SET text = ? WHERE id = ?', String(text).trim().slice(0, HUMAN_MAX_CHARS), id);
  }
  if (active !== undefined) run('UPDATE agent_lessons SET active = ? WHERE id = ?', active ? 1 : 0, id);
  emit('lesson', { agent_id: l.agent_id });
  return byId(id);
}

export function deleteLesson(id) {
  const l = get('SELECT agent_id FROM agent_lessons WHERE id = ?', id);
  run('DELETE FROM agent_lessons WHERE id = ?', id);
  if (l) emit('lesson', { agent_id: l.agent_id });
}

// ---------------------------------------------------------------- reviewing what agents propose

/** Approve a proposed lesson, optionally reworded ("Edit & approve"). It applies from the agent's next turn. */
export function approveLesson(id, { text, by } = {}) {
  const l = byId(id);
  if (!l) throw new Error('Lesson not found');
  if (l.status === 'approved') throw new Error('This lesson is already approved');
  const body = text === undefined ? l.text : String(text).trim().slice(0, HUMAN_MAX_CHARS);
  if (!body) throw new Error('The lesson is empty');
  run(
    "UPDATE agent_lessons SET status = 'approved', active = 1, text = ?, reviewed_by = ?, reviewed_at = datetime('now'), review_note = NULL WHERE id = ?",
    body, by ?? null, id,
  );
  const agent = get('SELECT name FROM agents WHERE id = ?', l.agent_id);
  logActivity(l.agent_id, 'agent', `${agent?.name ?? 'Agent'} learned: ${body.slice(0, 140)}${by ? ` (approved by ${by})` : ''}`);
  emit('lesson', { agent_id: l.agent_id });
  return byId(id);
}

/** Reject a proposed lesson. It is kept, with the reason, so the agent sees it and doesn't propose it again. */
export function rejectLesson(id, { note, by } = {}) {
  const l = byId(id);
  if (!l) throw new Error('Lesson not found');
  if (l.status !== 'pending_approval') throw new Error('Only a lesson waiting for approval can be rejected. Pause or delete it instead.');
  run(
    "UPDATE agent_lessons SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ?",
    by ?? null, String(note ?? '').trim().slice(0, 500) || null, id,
  );
  emit('lesson', { agent_id: l.agent_id });
  return byId(id);
}

/** The agent offered a better wording for an existing lesson: use it, or keep the lesson as it is. */
export function resolveProposal(id, { accept, by } = {}) {
  const l = byId(id);
  if (!l?.proposed_text) throw new Error('There is no suggested wording for this lesson');
  if (accept) {
    run("UPDATE agent_lessons SET text = proposed_text, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?", by ?? null, id);
  }
  run('UPDATE agent_lessons SET proposed_text = NULL, proposed_reason = NULL WHERE id = ?', id);
  emit('lesson', { agent_id: l.agent_id });
  return byId(id);
}

/** "Always trust this agent's lessons": its proposals are approved without a person. */
export function setTrustLessons(agentId, trust) {
  run('UPDATE agents SET trust_lessons = ? WHERE id = ?', trust ? 1 : 0, agentId);
  emit('agent', { agent_id: agentId });
  emit('lesson', { agent_id: agentId });
}

// ---------------------------------------------------------------- what the agent is told

const inPrompt = (agentId) =>
  all("SELECT id, text FROM agent_lessons WHERE agent_id = ? AND active = 1 AND status = 'approved' ORDER BY id DESC LIMIT ?", agentId, MAX_IN_PROMPT).reverse();

const line = (l) => `- [#${l.id}] ${l.text.replace(/\n+/g, ' ')}`;

/** The block added to the agent's instructions (empty when it has no lessons). Pending and rejected lessons never appear. */
export function lessonsBlock(agentId) {
  const rows = inPrompt(agentId);
  if (!rows.length) return '';
  return [
    '## Lessons from past corrections',
    'Presentail taught you these after earlier work. Always follow them; they override your skills where they differ. Each has a number, e.g. #12.',
    ...rows.map(line),
  ].join('\n');
}

/** The ids of the lessons going into the agent's instructions now (what a new session is given). */
export const lessonIdsInForce = (agentId) => inPrompt(agentId).map((l) => l.id);

/** For sessions started before Hive kept track: the lessons in force when `since` was. */
export const lessonIdsKnownAt = (agentId, since) =>
  all("SELECT id FROM agent_lessons WHERE agent_id = ? AND status = 'approved' AND active = 1 AND COALESCE(reviewed_at, created_at) <= ?", agentId, since).map((l) => l.id);

/** Lessons in force that a running session hasn't been given (approved or switched back on since it started). */
export function unseenLessons(agentId, known) {
  const seen = new Set(known);
  return inPrompt(agentId).filter((l) => !seen.has(l.id));
}

export const newLessonsNote = (lessons) =>
  ['[Hive] New lessons were approved for you since this conversation started. Follow them from now on:', ...lessons.map(line)].join('\n');

/** "remember: …" / "lesson: …" at the start of a message. */
export const REMEMBER = /^(?:please\s+)?(?:remember|lesson|note for next time)\s*(?:that\b|[:,-])\s*/i;

// ---------------------------------------------------------------- quality: short, specific, not a duplicate

const STOP = new Set(
  'a an the and or but if then so of to in on at for from by with as is are was were be been being it its this that these those you your we our they their i my me do does did not no yes can could should would will just also more most very any all each every when where which who what how than there here into onto about over under up down out'.split(' '),
);
const stem = (w) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

/** The words that carry meaning, lightly stemmed ("invoices" and "invoice" match). */
export function contentWords(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9_\-.]+/)
      .map((w) => w.replace(/^[-.]+|[-.]+$/g, ''))
      .filter((w) => w.length > 1 && !STOP.has(w))
      .map(stem),
  );
}

/** How alike two lessons' wording is: dice (0..1, same words overall) and overlap (0..1, one's words inside the other). */
export function similarity(a, b) {
  const A = contentWords(a);
  const B = contentWords(b);
  if (!A.size || !B.size) return { dice: 0, overlap: 0 };
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return { dice: (2 * shared) / (A.size + B.size), overlap: shared / Math.min(A.size, B.size) };
}

const SAME_WORDING = 0.75; // dice at or above this is the same lesson, AI or not
const WORTH_ASKING = 0.34; // overlap at or above this is worth a closer look

const VAGUE = [
  /\bbe (?:more |extra |very )?(?:careful|thorough|accurate|diligent|precise|attentive)\b/i,
  /\b(?:pay (?:more )?attention|do better|avoid (?:mistakes|errors)|double[- ]check everything|check (?:your|my) work)\b/i,
];

/** Why this text can't be a lesson, or null. Lessons agents propose must be short and specific. */
export function lessonProblem(text) {
  if (!text) return 'The lesson is empty.';
  if (text.length > AGENT_MAX_CHARS) return `Too long (${text.length} characters, the limit is ${AGENT_MAX_CHARS}). Keep one rule per lesson, in one or two sentences.`;
  const words = contentWords(text).size;
  if (words < 4 || (VAGUE.some((re) => re.test(text)) && words < 8)) {
    return 'Too vague to act on. Say exactly what to do, where and when, so it makes sense on its own. For example: "UAE sales in Wafeq sit in two places: Cash invoices (`simplified-invoices`) and Invoices (`invoices`). Always check both." Not: "Be more careful with revenue."';
  }
  return null;
}

// Deciding whether wording that differs means the same thing: a quick question to a small model.
// Tests replace it (setLessonJudge); null means wording only.
let judge = defaultJudge;
export const setLessonJudge = (fn) => (judge = fn);

let anthropic;
const JUDGE_MODEL = 'claude-haiku-4-5';

async function defaultJudge(text, candidates) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  anthropic ??= new Anthropic({ maxRetries: 0, timeout: 8000 });
  const response = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 200,
    system: 'You compare a lesson an AI agent wants to save with the lessons it already has. Reply with one JSON object and nothing else.',
    messages: [
      {
        role: 'user',
        content: [
          'Existing lessons:',
          ...candidates.map((c) => `#${c.id}: ${c.text}`),
          '',
          `Proposed lesson: ${text}`,
          '',
          'Is the proposed lesson the same rule as one of the existing lessons, even if worded differently? A different account, entity, system, period or step is a different rule.',
          'Reply as {"duplicate_of": <the existing lesson number, or null>, "adds_detail": <true only if it is the same rule and the proposal adds useful specifics the existing one lacks>}',
        ].join('\n'),
      },
    ],
  });
  return parseVerdict(response.content.filter((b) => b.type === 'text').map((b) => b.text).join(''), candidates);
}

/** The judge's JSON answer, checked against the lessons it was shown. Exported for tests. */
export function parseVerdict(raw, candidates) {
  const json = String(raw ?? '').match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    const id = Number(String(v.duplicate_of ?? '').replace('#', ''));
    const hit = candidates.find((c) => c.id === id);
    return { duplicate_of: hit ? hit.id : null, adds_detail: Boolean(hit && v.adds_detail) };
  } catch {
    return null;
  }
}

/**
 * The existing lesson (approved, waiting or rejected) this proposal repeats, or null. Same wording
 * is caught here; different wording that may mean the same is put to the judge. If the judge can't
 * answer, only the wording counts.
 */
export async function findDuplicate(agentId, text) {
  const existing = all('SELECT * FROM agent_lessons WHERE agent_id = ? ORDER BY id DESC', agentId);
  const scored = existing.map((l) => ({ l, ...similarity(text, l.text) }));
  const exact = scored.find((s) => s.l.text.trim().toLowerCase() === text.trim().toLowerCase());
  if (exact) return { lesson: exact.l, addsDetail: false };
  const same = scored.filter((s) => s.dice >= SAME_WORDING).sort((a, b) => b.dice - a.dice)[0];
  const addsDetail = (l) => {
    const mine = contentWords(text);
    for (const w of contentWords(l.text)) mine.delete(w);
    return mine.size >= 2;
  };
  if (same) return { lesson: same.l, addsDetail: addsDetail(same.l) };
  const candidates = scored.filter((s) => s.overlap >= WORTH_ASKING).sort((a, b) => b.overlap - a.overlap).slice(0, 12).map((s) => s.l);
  if (!candidates.length || !judge) return null;
  let verdict = null;
  try {
    verdict = await judge(text, candidates.map((c) => ({ id: c.id, text: c.text })));
  } catch (err) {
    console.error('[lessons] duplicate check:', err.message);
  }
  const hit = verdict?.duplicate_of ? candidates.find((c) => c.id === verdict.duplicate_of) : null;
  return hit ? { lesson: hit, addsDetail: Boolean(verdict.adds_detail) } : null;
}

// ---------------------------------------------------------------- tools the agent calls

export const SAVE_LESSON_TOOL = {
  type: 'custom',
  name: 'save_lesson',
  description: [
    'Propose a lesson for yourself: a lasting rule you should follow in every future chat and task. Use it when a person tells you a lasting fact, rule or preference about your work,',
    'and when you find a mistake of your own that would happen again (e.g. you checked one place for data that lives in two). Not for one-off instructions about the current job.',
    'Write it as a short imperative rule that makes sense on its own, with the specifics (system, endpoint, account, entity, period), e.g. "UAE sales in Wafeq sit in two places:',
    `Cash invoices (\`simplified-invoices\`) and Invoices (\`invoices\`). Always check both." Not "Be more careful with revenue." At most ${AGENT_MAX_CHARS} characters, one rule per call.`,
    'Call list_lessons first if you are not sure whether you already know it. A person usually approves it before it applies; the result says whether it was saved, is pending, or was not saved. Always tell the user which.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: `The lesson: imperative, self-contained, specific, at most ${AGENT_MAX_CHARS} characters` },
      reason: { type: 'string', description: 'What happened that produced it: who told you, or what went wrong and how you found out' },
      scope: { type: 'string', enum: ['self'], description: 'Who it applies to. Only "self" (you) for now.' },
    },
    required: ['text', 'reason'],
  },
};

export const LIST_LESSONS_TOOL = {
  type: 'custom',
  name: 'list_lessons',
  description:
    'List your lessons: the ones in force, the ones waiting for approval, and the ones people rejected (with their reason). Check it before proposing a lesson so you do not repeat one, and never propose a rejected one again.',
  input_schema: { type: 'object', properties: {} },
};

export const LESSON_APPLIED_TOOL = {
  type: 'custom',
  name: 'lesson_applied',
  description:
    'Say which of your lessons (by number, e.g. 12 for #12) changed what you did in this chat or task. Hive uses it to find lessons that no longer matter. Call it once per turn at most, only for lessons you actually applied.',
  input_schema: {
    type: 'object',
    properties: { ids: { type: 'array', items: { type: 'integer' }, description: 'Lesson numbers you applied' } },
    required: ['ids'],
  },
};

export const LESSON_TOOLS = [SAVE_LESSON_TOOL, LIST_LESSONS_TOOL, LESSON_APPLIED_TOOL];
export const LESSON_TOOL_NAMES = new Set(LESSON_TOOLS.map((t) => t.name));

const quote = (t) => `“${t}”`;

/**
 * The agent called save_lesson. Returns what to tell the agent (`text`), and a note for the people
 * following along (`note`, `meta`), so nobody is left thinking a lesson was saved when it wasn't.
 */
export async function proposeLesson(r, input) {
  const agent = get('SELECT id, name, trust_lessons FROM agents WHERE id = ?', r.agent_id);
  if (!agent) return { text: 'Unknown agent.', isError: true };
  const notSaved = (why, text = why) => ({ text, isError: true, note: `🧠 ${agent?.name ?? 'The agent'} tried to save a lesson, but it was not saved: ${why}` });
  if (r.kind === 'consult') return { text: 'Another agent asked you this, so there is nothing to save here.', isError: true };
  if (input?.scope && input.scope !== 'self') return notSaved('lessons can only be proposed for the agent itself.', 'scope must be "self": you can only propose lessons for yourself.');
  const text = String(input?.text ?? input?.lesson ?? '').replace(/\s+/g, ' ').trim(); // "lesson": chats set up before this tool changed
  const reason = String(input?.reason ?? '').trim().slice(0, 500) || null;
  const problem = lessonProblem(text);
  if (problem) return notSaved(problem.split('. ')[0].replace(/\.?$/, '.'), `Not saved. ${problem}`);

  const dup = await findDuplicate(r.agent_id, text);
  if (dup) {
    const l = dup.lesson;
    if (l.status === 'rejected') {
      return notSaved(
        `a person rejected the same lesson before (#${l.id}).`,
        `Not saved: ${l.reviewed_by ?? 'a person'} rejected this before as #${l.id}${l.review_note ? ` (“${l.review_note}”)` : ''}. Do not propose it again.`,
      );
    }
    if (l.status === 'pending_approval') {
      return { text: `Not saved: it is already waiting for approval as #${l.id}: ${quote(l.text)}. Tell the user it is pending.`, note: `🧠 That lesson is already waiting for approval (#${l.id}).` };
    }
    if (dup.addsDetail && text !== l.text) {
      run('UPDATE agent_lessons SET proposed_text = ?, proposed_reason = ? WHERE id = ?', text, reason, l.id);
      emit('lesson', { agent_id: r.agent_id });
      notifyLessonPending(byId(l.id), { edit: true });
      return {
        text: `You already have this as lesson #${l.id}: ${quote(l.text)}. Your wording adds detail, so it has been offered to a person as a new wording for #${l.id}. Nothing new was created; until they accept it, #${l.id} applies as it is. Tell the user.`,
        note: `🧠 ${agent.name} suggested a new wording for lesson #${l.id}: ${quote(text)}. Accept or dismiss it in the Lessons tab.`,
        meta: { type: 'lesson', lesson_id: l.id, edit: true },
      };
    }
    return { text: `Not saved: you already have this as lesson #${l.id}${l.active ? '' : ' (paused by a person)'}: ${quote(l.text)}.`, note: `🧠 Already a lesson (#${l.id}), so nothing new was saved.` };
  }

  const trusted = Boolean(agent.trust_lessons);
  const id = Number(
    run(
      `INSERT INTO agent_lessons (agent_id, text, source, task_id, run_id, created_by, reason, status, reviewed_by, reviewed_at)
       VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?, ${trusted ? "datetime('now')" : 'NULL'})`,
      r.agent_id, text, r.task_id ?? null, r.id ?? null, agent.name, reason, trusted ? 'approved' : 'pending_approval', trusted ? 'Trusted (automatic)' : null,
    ).lastInsertRowid,
  );
  emit('lesson', { agent_id: r.agent_id });
  if (trusted) {
    logActivity(r.agent_id, 'agent', `${agent.name} learned: ${text.slice(0, 140)} (trusted, approved automatically)`);
    return {
      text: `Saved as lesson #${id}. You are trusted, so it is approved and applies to every future chat and task. Tell the user what you saved.`,
      note: `🧠 Saved as lesson #${id}: ${quote(text)}. It applies from now on. Edit or remove it in the Lessons tab.`,
    };
  }
  logActivity(r.agent_id, 'agent', `${agent.name} proposed a lesson: ${text.slice(0, 140)}`);
  notifyLessonPending(byId(id));
  return {
    text: `Proposed as lesson #${id}. It is waiting for an approver or owner and does NOT apply yet. Tell the user it is pending approval.`,
    note: `🧠 ${agent.name} proposed a lesson (waiting for approval): ${quote(text)}${reason ? `\nWhy: ${reason}` : ''}`,
    meta: { type: 'lesson', lesson_id: id },
  };
}

/** list_lessons: what the agent knows, what's waiting, and what was turned down. */
export function describeLessons(agentId) {
  const rows = all('SELECT * FROM agent_lessons WHERE agent_id = ? ORDER BY id', agentId);
  const section = (title, list, fmt) => (list.length ? [`${title}:`, ...list.map(fmt), ''] : []);
  const approved = rows.filter((l) => l.status === 'approved');
  const out = [
    ...section('In force', approved.filter((l) => l.active), (l) => `- #${l.id}: ${l.text}`),
    ...section('Paused by a person (not in force)', approved.filter((l) => !l.active), (l) => `- #${l.id}: ${l.text}`),
    ...section('Waiting for approval', rows.filter((l) => l.status === 'pending_approval'), (l) => `- #${l.id}: ${l.text}`),
    ...section('Rejected (never propose these again)', rows.filter((l) => l.status === 'rejected'), (l) => `- #${l.id}: ${l.text}${l.review_note ? ` (reason: ${l.review_note})` : ''}`),
  ];
  return out.length ? out.join('\n').trim() : 'You have no lessons yet.';
}

/** lesson_applied: note when lessons were last relevant, so stale ones can be found. */
export function markApplied(agentId, ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map((x) => Number(String(x).replace('#', ''))).filter(Number.isInteger))].slice(0, 40);
  if (!list.length) return { text: 'Give the lesson numbers, e.g. [12].', isError: true };
  const n = run(
    `UPDATE agent_lessons SET use_count = use_count + 1, last_used_at = datetime('now')
     WHERE agent_id = ? AND status = 'approved' AND id IN (${list.map(() => '?').join(',')})`,
    agentId, ...list,
  ).changes;
  return n ? { text: `Noted: ${n} lesson${n === 1 ? '' : 's'}.` } : { text: 'None of those are lessons in force for you.', isError: true };
}

/** Answer one of the lesson tools for a run. */
export async function handleLessonTool(r, name, input) {
  if (name === 'save_lesson') return proposeLesson(r, input);
  if (name === 'list_lessons') return { text: describeLessons(r.agent_id) };
  if (name === 'lesson_applied') return markApplied(r.agent_id, input?.ids);
  return { text: `Unknown tool ${name}`, isError: true };
}
