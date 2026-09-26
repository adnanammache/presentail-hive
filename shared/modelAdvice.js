// Which Claude model suits an agent, from its job title and description (plus whether it can change
// the books). Simple rules on purpose: instant, free, and the same answer every time.
//
//   Opus 5     money and judgement: accounting, tax, audit, reconciliations, anything that writes to
//              Odoo or Wafeq. Mistakes are expensive, so pay for the careful model.
//   Sonnet 5   everyday knowledge work: coordination, procurement, design, writing.
//   Haiku 4.5  quick, repetitive work: briefs, triage, reminders, lookups.

const RULES = [
  {
    model: 'claude-opus-5',
    why: 'accounting, tax and engineering work need careful, accurate reasoning',
    words: /\b(account|accountant|accounting|audit|auditor|tax|vat|reconcil\w*|month-?end|bookkeep\w*|ledger|invoice|bills?|payroll|finance|financial|treasury|legal|contract|compliance|odoo|wafeq|engineer\w*|developer|coding|software)\b/i,
  },
  {
    model: 'claude-haiku-4-5',
    why: 'short, repetitive work: speed and low cost matter more than depth',
    words: /\b(brief|briefer|summar\w*|triage|inbox|remind\w*|notif\w*|lookup|faq|tagg?\w*|classif\w*|digest|scheduler?)\b/i,
  },
  {
    model: 'claude-sonnet-5',
    why: 'everyday coordination and creative work: good quality at a lower price',
    words: /\b(chief|executive|assistant|procure\w*|supplier|purchas\w*|project|coordinat\w*|manager|design\w*|brand|menu|packaging|marketing|social|copy\w*|content|writer|research\w*|operations|support|customer)\b/i,
  },
];

/**
 * @param {{title?: string, description?: string, integrations?: string[]|string}} agent
 * @returns {{ model: string, why: string }}
 */
export function recommendModel({ title = '', description = '', integrations = [] } = {}) {
  const list = Array.isArray(integrations) ? integrations : (() => { try { return JSON.parse(integrations || '[]'); } catch { return []; } })();
  if (list.some((k) => k === 'odoo' || k === 'wafeq')) return { model: 'claude-opus-5', why: 'it can change the books (Odoo/Wafeq), so accuracy comes first' };
  // The title says what the job is; the description only breaks ties.
  for (const text of [title, `${title} ${description}`]) {
    for (const r of RULES) if (r.words.test(text)) return { model: r.model, why: r.why };
  }
  return { model: 'claude-opus-5', why: 'a safe default for work that hasn’t been described yet' };
}
