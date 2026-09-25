// The robot face for an agent, generated from its name: same name, same face, everywhere
// (the web app, the map, and the PNG avatars Slack shows next to each agent's messages).
// Returns SVG markup for a 100×100 box.

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const pick = (h, shift, n) => (h >>> shift) % n;
const attr = (s) => String(s).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);

export function botFaceMarkup(name = '?', color = '#6366f1', mood = 'idle') {
  const h = hash(name);
  const head = pick(h, 0, 3); // 0 rounded square, 1 circle, 2 wide
  const eyes = pick(h, 3, 4); // 0 dots, 1 visor, 2 big round, 3 sleepy
  const antenna = pick(h, 6, 3); // 0 ball, 1 double, 2 none
  const mouth = pick(h, 9, 3); // 0 smile, 1 grille, 2 flat
  const ears = pick(h, 12, 2);
  const c = attr(color);
  const dark = 'rgba(15,23,42,0.85)';
  const face = '#f8fafc';
  const live = mood === 'working' ? ' class="bot-antenna-live"' : '';
  const out = [];

  if (antenna === 0)
    out.push(`<line x1="50" y1="22" x2="50" y2="10" stroke="${c}" stroke-width="4" stroke-linecap="round"/>`, `<circle cx="50" cy="9" r="6" fill="${c}"${live}/>`);
  if (antenna === 1)
    out.push(
      `<line x1="38" y1="22" x2="32" y2="10" stroke="${c}" stroke-width="4" stroke-linecap="round"/>`,
      `<line x1="62" y1="22" x2="68" y2="10" stroke="${c}" stroke-width="4" stroke-linecap="round"/>`,
      `<circle cx="32" cy="9" r="4.5" fill="${c}"/>`,
      `<circle cx="68" cy="9" r="4.5" fill="${c}"${live}/>`,
    );
  if (ears === 1) out.push(`<rect x="8" y="44" width="10" height="22" rx="4" fill="${c}"/>`, `<rect x="82" y="44" width="10" height="22" rx="4" fill="${c}"/>`);
  if (head === 0) out.push(`<rect x="16" y="20" width="68" height="66" rx="18" fill="${c}"/>`);
  if (head === 1) out.push(`<circle cx="50" cy="54" r="36" fill="${c}"/>`);
  if (head === 2) out.push(`<rect x="12" y="26" width="76" height="56" rx="22" fill="${c}"/>`);
  out.push(`<rect x="24" y="36" width="52" height="38" rx="12" fill="${face}"/>`);

  if (mood === 'paused')
    out.push(
      `<line x1="34" y1="52" x2="44" y2="52" stroke="${dark}" stroke-width="4" stroke-linecap="round"/>`,
      `<line x1="56" y1="52" x2="66" y2="52" stroke="${dark}" stroke-width="4" stroke-linecap="round"/>`,
    );
  else if (eyes === 0) out.push(`<circle cx="39" cy="51" r="4.5" fill="${dark}"/>`, `<circle cx="61" cy="51" r="4.5" fill="${dark}"/>`);
  else if (eyes === 1) out.push(`<rect x="31" y="46" width="38" height="10" rx="5" fill="${dark}"/>`);
  else if (eyes === 2)
    out.push(
      `<circle cx="39" cy="51" r="7" fill="${dark}"/>`,
      `<circle cx="61" cy="51" r="7" fill="${dark}"/>`,
      `<circle cx="41" cy="49" r="2.2" fill="${face}"/>`,
      `<circle cx="63" cy="49" r="2.2" fill="${face}"/>`,
    );
  else
    out.push(
      `<path d="M33 52 q6 -6 12 0" stroke="${dark}" stroke-width="4" fill="none" stroke-linecap="round"/>`,
      `<path d="M55 52 q6 -6 12 0" stroke="${dark}" stroke-width="4" fill="none" stroke-linecap="round"/>`,
    );

  if (mouth === 0) out.push(`<path d="M41 63 q9 7 18 0" stroke="${dark}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`);
  if (mouth === 1)
    out.push(
      `<g stroke="${dark}" stroke-width="2.5"><rect x="39" y="61" width="22" height="7" rx="2" fill="none"/><line x1="46" y1="61" x2="46" y2="68"/><line x1="53" y1="61" x2="53" y2="68"/></g>`,
    );
  if (mouth === 2) out.push(`<line x1="42" y1="65" x2="58" y2="65" stroke="${dark}" stroke-width="3.5" stroke-linecap="round"/>`);
  return out.join('');
}

/** A standalone square avatar (for Slack): the face on a soft tinted tile. */
export function botAvatarSvg(name, color, size = 256) {
  const c = attr(color);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="${c}" fill-opacity="0.16"/><g transform="translate(10 8) scale(0.8)">${botFaceMarkup(name, color)}</g></svg>`;
}
