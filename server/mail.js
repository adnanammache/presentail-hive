// Outgoing email (invitations) through Resend's HTTP API. Nothing is sent, and nothing claims to be
// sent, unless RESEND_API_KEY and MAIL_FROM are set (e.g. MAIL_FROM="Presentail Hive <hive@presentail.com>").
export const mailConfigured = () => Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);

let transport = async (message) => {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Email service answered ${res.status}`);
  return data.id;
};
/** Tests replace delivery with a stand-in (never email real people from tests). */
export const setMailTransport = (fn) => (transport = fn);

/** Returns { sent: true } or { sent: false, error } — callers show exactly that. */
export async function sendMail({ to, subject, text, html }) {
  if (!mailConfigured()) return { sent: false, error: 'Email is not set up (RESEND_API_KEY and MAIL_FROM).' };
  try {
    await transport({ from: process.env.MAIL_FROM, to: [to], subject, text, html });
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}
