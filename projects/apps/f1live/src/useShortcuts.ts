// Keyboard shortcuts shared by both sources: `shortcutFor` is the pure key map, `useShortcuts` the one document listener.
import { useEffect, useEffectEvent } from 'react';

export type Shortcut =
  | 'help' | 'play' | 'back10' | 'fwd10' | 'back1' | 'fwd1' | 'faster' | 'slower'
  | 'restart' | 'labels' | 'drs' | 'events' | 'drivers' | 'teams';

export interface KeyInfo {
  key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean;
  target: { tag: string; inButton: boolean; inField: boolean };
}

const KEYS: Record<string, Shortcut> = {
  h: 'help', ' ': 'play', ArrowLeft: 'back10', ArrowRight: 'fwd10', ',': 'back1', '.': 'fwd1',
  ArrowUp: 'faster', ArrowDown: 'slower', r: 'restart', l: 'labels', d: 'drs', b: 'events', c: 'drivers', a: 'teams',
};

/** Which shortcut a keystroke triggers, otherwise null. H works even with help open; nothing else does. */
export function shortcutFor(e: KeyInfo, helpOpen: boolean): Shortcut | null {
  if (e.target.inField || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.target.inButton && (e.key === ' ' || e.key === 'Enter')) return null; // let the button act
  const s = KEYS[e.key] ?? KEYS[e.key.toLowerCase()] ?? null;
  return s === 'help' || !helpOpen ? s : null;
}

/** One `document` keydown listener, removed on unmount. `run` and `helpOpen` may change every render. */
export function useShortcuts(run: (s: Shortcut) => void, helpOpen: () => boolean): void {
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const t = e.target instanceof Element ? e.target : null;
    const s = shortcutFor(
      {
        key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey,
        target: { tag: t?.tagName ?? '', inButton: !!t?.closest('button'), inField: !!t?.closest('input, select, textarea') },
      },
      helpOpen(),
    );
    if (s) { e.preventDefault(); run(s); }
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey(e);
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);
}
