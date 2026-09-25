// A small robot face generated from the agent's name: same name, same face, every time.
// Pure SVG so it scales from 24px chips to the map, and follows the agent's colour.

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const pick = (h, shift, n) => (h >>> shift) % n;

/** Robot face drawn in a 100×100 box; place it with a transform or inside an <svg viewBox="0 0 100 100">. */
export function BotFace({ name = '?', color = '#6366f1', mood = 'idle' }) {
  const h = hash(name);
  const head = pick(h, 0, 3); // 0 rounded square, 1 circle, 2 wide
  const eyes = pick(h, 3, 4); // 0 dots, 1 visor, 2 big round, 3 sleepy
  const antenna = pick(h, 6, 3); // 0 ball, 1 double, 2 none
  const mouth = pick(h, 9, 3); // 0 smile, 1 grille, 2 flat
  const ears = pick(h, 12, 2);
  const dark = 'rgba(15,23,42,0.85)';
  const face = '#f8fafc';
  const blink = mood === 'paused';

  return (
    <g>
      {antenna === 0 && (
        <>
          <line x1="50" y1="22" x2="50" y2="10" stroke={color} strokeWidth="4" strokeLinecap="round" />
          <circle cx="50" cy="9" r="6" fill={color} className={mood === 'working' ? 'bot-antenna-live' : ''} />
        </>
      )}
      {antenna === 1 && (
        <>
          <line x1="38" y1="22" x2="32" y2="10" stroke={color} strokeWidth="4" strokeLinecap="round" />
          <line x1="62" y1="22" x2="68" y2="10" stroke={color} strokeWidth="4" strokeLinecap="round" />
          <circle cx="32" cy="9" r="4.5" fill={color} />
          <circle cx="68" cy="9" r="4.5" fill={color} className={mood === 'working' ? 'bot-antenna-live' : ''} />
        </>
      )}
      {ears === 1 && (
        <>
          <rect x="8" y="44" width="10" height="22" rx="4" fill={color} />
          <rect x="82" y="44" width="10" height="22" rx="4" fill={color} />
        </>
      )}
      {head === 0 && <rect x="16" y="20" width="68" height="66" rx="18" fill={color} />}
      {head === 1 && <circle cx="50" cy="54" r="36" fill={color} />}
      {head === 2 && <rect x="12" y="26" width="76" height="56" rx="22" fill={color} />}
      <rect x="24" y="36" width="52" height="38" rx="12" fill={face} />
      {blink ? (
        <>
          <line x1="34" y1="52" x2="44" y2="52" stroke={dark} strokeWidth="4" strokeLinecap="round" />
          <line x1="56" y1="52" x2="66" y2="52" stroke={dark} strokeWidth="4" strokeLinecap="round" />
        </>
      ) : eyes === 0 ? (
        <>
          <circle cx="39" cy="51" r="4.5" fill={dark} />
          <circle cx="61" cy="51" r="4.5" fill={dark} />
        </>
      ) : eyes === 1 ? (
        <rect x="31" y="46" width="38" height="10" rx="5" fill={dark} />
      ) : eyes === 2 ? (
        <>
          <circle cx="39" cy="51" r="7" fill={dark} />
          <circle cx="61" cy="51" r="7" fill={dark} />
          <circle cx="41" cy="49" r="2.2" fill={face} />
          <circle cx="63" cy="49" r="2.2" fill={face} />
        </>
      ) : (
        <>
          <path d="M33 52 q6 -6 12 0" stroke={dark} strokeWidth="4" fill="none" strokeLinecap="round" />
          <path d="M55 52 q6 -6 12 0" stroke={dark} strokeWidth="4" fill="none" strokeLinecap="round" />
        </>
      )}
      {mouth === 0 && <path d="M41 63 q9 7 18 0" stroke={dark} strokeWidth="3.5" fill="none" strokeLinecap="round" />}
      {mouth === 1 && (
        <g stroke={dark} strokeWidth="2.5">
          <rect x="39" y="61" width="22" height="7" rx="2" fill="none" />
          <line x1="46" y1="61" x2="46" y2="68" />
          <line x1="53" y1="61" x2="53" y2="68" />
        </g>
      )}
      {mouth === 2 && <line x1="42" y1="65" x2="58" y2="65" stroke={dark} strokeWidth="3.5" strokeLinecap="round" />}
    </g>
  );
}

/** Standalone avatar, e.g. in lists and panels. */
export default function BotAvatar({ name, color, size = 40, mood }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" className="bot-avatar">
      <BotFace name={name} color={color} mood={mood} />
    </svg>
  );
}
