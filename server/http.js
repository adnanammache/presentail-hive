// Small HTTP helpers shared by the API modules.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const bad = (msg) => new HttpError(400, msg);
export const forbidden = (msg) => new HttpError(403, msg);
export const notFound = (what) => new HttpError(404, `${what} not found`);
export const conflict = (msg) => new HttpError(409, msg);
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((data) => data !== undefined && res.json(data), next);

export function check(value, allowed, field) {
  if (value !== undefined && !allowed.includes(value)) throw bad(`${field} must be one of: ${allowed.join(', ')}`);
}

/** A safe file name from an X-Filename header, or null. */
export function cleanFilename(header) {
  let raw;
  try {
    raw = decodeURIComponent(header || '');
  } catch {
    return null;
  }
  const name = raw.split(/[\\/]/).pop().replace(/[^\w.\- ()&+,]/g, '_').trim().slice(0, 180);
  return name && !name.startsWith('.') ? name : null;
}

/** Only http(s) links are stored. */
export function cleanUrl(url) {
  try {
    const u = new URL(String(url ?? '').trim());
    return ['http:', 'https:'].includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}
