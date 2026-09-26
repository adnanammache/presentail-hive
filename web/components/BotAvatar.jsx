// A small robot face generated from the agent's name: same name, same face, every time.
// The drawing lives in shared/botface.js so Slack avatars match the app.
import { botFaceMarkup } from '../../shared/botface.js';
import { usePhoto } from '../api.js';

/** Robot face drawn in a 100×100 box; place it with a transform or inside an <svg viewBox="0 0 100 100">. */
export function BotFace({ name = '?', color = '#6366f1', mood = 'idle' }) {
  return <g dangerouslySetInnerHTML={{ __html: botFaceMarkup(name, color, mood) }} />;
}

/** Standalone avatar, e.g. in lists and panels: the agent's photo if it has one, else its face. */
export default function BotAvatar({ name, color, size = 40, mood, id }) {
  const photo = usePhoto({ id, name });
  if (photo) return <img src={photo} alt="" width={size} height={size} className="bot-avatar bot-photo" />;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" className="bot-avatar">
      <BotFace name={name} color={color} mood={mood} />
    </svg>
  );
}
