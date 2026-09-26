// Dates for repeating and scheduled tasks. Everything is a plain calendar date (YYYY-MM-DD) in
// Dubai time: "due 28 Oct" means 28 Oct in Dubai, whatever the server's clock says.
export const TZ = 'Asia/Dubai';
export const START_HOUR = 8; // scheduled tasks start, and reminders go out, at 8:00 Dubai time

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (s) => typeof s === 'string' && DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Today's date and the hour, in Dubai. */
export function dubaiNow(now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

const toUTC = (s) => new Date(`${s}T00:00:00Z`);
const fromUTC = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => fromUTC(new Date(toUTC(s).getTime() + n * 86400000));
export const daysBetween = (from, to) => Math.round((toUTC(to) - toUTC(from)) / 86400000);
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // m is 0-based

/** "28 Oct 2026" */
export const formatDay = (s) => (isDate(s) ? toUTC(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : s ?? '');

/**
 * A repeat rule: { freq: 'monthly' | 'quarterly' | 'yearly' | 'custom', every, unit: 'day' | 'week' | 'month' }.
 * Returns the cleaned rule, null for "does not repeat", or throws on nonsense.
 */
export function normalizeRule(rule) {
  if (!rule || rule === 'none' || rule.freq === 'none') return null;
  const r = typeof rule === 'string' ? { freq: rule } : rule;
  if (['monthly', 'quarterly', 'yearly'].includes(r.freq)) return { freq: r.freq };
  if (r.freq === 'custom') {
    const every = Number(r.every);
    if (!Number.isInteger(every) || every < 1 || every > 366) throw new Error('Repeat every must be a whole number from 1 to 366');
    if (!['day', 'week', 'month'].includes(r.unit)) throw new Error('Repeat unit must be days, weeks or months');
    return { freq: 'custom', every, unit: r.unit };
  }
  throw new Error('Repeat must be monthly, quarterly, yearly or custom');
}

const monthsPer = (r) => ({ monthly: 1, quarterly: 3, yearly: 12 })[r.freq] ?? (r.unit === 'month' ? r.every : 0);

/**
 * The due date `steps` repeats after `anchor`. Months keep the anchor's day where the month has it,
 * and use the month's last day where it doesn't: 31 Jan → 28 Feb → 31 Mar.
 */
export function stepDate(anchor, rule, steps) {
  const months = monthsPer(rule);
  if (months) {
    const [y, m, d] = anchor.split('-').map(Number);
    const total = m - 1 + months * steps;
    const year = y + Math.floor(total / 12);
    const month = ((total % 12) + 12) % 12;
    return fromUTC(new Date(Date.UTC(year, month, Math.min(d, daysInMonth(year, month)))));
  }
  return addDays(anchor, steps * rule.every * (rule.unit === 'week' ? 7 : 1));
}

/** Plain-words description: "Monthly", "Every 2 weeks". */
export function describeRule(rule) {
  if (!rule) return 'Does not repeat';
  if (rule.freq !== 'custom') return rule.freq[0].toUpperCase() + rule.freq.slice(1);
  return rule.every === 1 ? `Every ${rule.unit}` : `Every ${rule.every} ${rule.unit}s`;
}

/** Has a task that starts on `startOn` reached its start time? */
export const startReached = (startOn, now = new Date()) => {
  const { date, hour } = dubaiNow(now);
  return !startOn || startOn < date || (startOn === date && hour >= START_HOUR);
};
