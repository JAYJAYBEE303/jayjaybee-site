// Help + standings <dialog> refs with open/close/toggle; native close() restores focus to the opener.
import { useRef } from 'react';

export type DialogKind = 'help' | 'standings';

export function useDialogs() {
  const helpRef = useRef<HTMLDialogElement>(null);
  const standingsRef = useRef<HTMLDialogElement>(null);
  const el = (k: DialogKind) => (k === 'help' ? helpRef : standingsRef).current;
  const isOpen = (k: DialogKind) => !!el(k)?.open;
  const open = (k: DialogKind) => { const d = el(k); if (d && !d.open) d.showModal(); };
  const close = (k: DialogKind) => { el(k)?.close(); };
  const toggle = (k: DialogKind) => (isOpen(k) ? close(k) : open(k));
  return { helpRef, standingsRef, open, close, toggle, isOpen };
}
