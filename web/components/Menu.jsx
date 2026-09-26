// A small accessible menu: a trigger button and a list of actions. Arrow keys move, Escape closes and
// returns focus to the trigger, a click outside closes. Used by conversation rows and the chat header.
import { useEffect, useRef, useState } from 'react';
import { Icon } from './ui.jsx';

/** items: [{ label, icon, onSelect, danger?, hidden? } | 'sep'] */
export default function Menu({ label, items, icon = 'dots', className = '', buttonClass = 'icon-btn', text, align = 'right' }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const trigger = useRef(null);
  const list = () => [...(box.current?.querySelectorAll('[role=menuitem]') ?? [])];
  useEffect(() => {
    if (!open) return;
    list()[0]?.focus();
    const away = (e) => !box.current?.contains(e.target) && setOpen(false);
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const onKey = (e) => {
    if (!open) return;
    const all = list();
    const i = all.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') (e.preventDefault(), all[(i + 1) % all.length]?.focus());
    else if (e.key === 'ArrowUp') (e.preventDefault(), all[(i - 1 + all.length) % all.length]?.focus());
    else if (e.key === 'Home') (e.preventDefault(), all[0]?.focus());
    else if (e.key === 'End') (e.preventDefault(), all.at(-1)?.focus());
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === 'Tab') setOpen(false);
  };
  const shown = items.filter((it) => it && !it.hidden);
  if (!shown.some((it) => it !== 'sep')) return null;
  return (
    <div className={`menu-wrap ${className}`} ref={box} onKeyDown={onKey}>
      <button ref={trigger} type="button" className={buttonClass} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={text ? undefined : label} onClick={(e) => (e.stopPropagation(), setOpen((o) => !o))}>
        <Icon name={icon} size={16} />
        {text && <span>{text}</span>}
      </button>
      {open && (
        <div className={`menu menu-${align}`} role="menu" aria-label={label}>
          {shown.map((it, i) =>
            it === 'sep' ? (
              <div key={`sep-${i}`} className="menu-sep" role="separator" />
            ) : (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                className={it.danger ? 'danger' : ''}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  trigger.current?.focus();
                  it.onSelect();
                }}
              >
                {it.icon && <Icon name={it.icon} size={15} />} {it.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
