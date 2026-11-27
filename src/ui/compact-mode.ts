import { useSyncExternalStore } from "react";
import { type CompactMode, parseCompactMode } from "../core/compact";

// The compaction the user picked last is the one the buttons run next time; it is a browser preference, like the language.
const KEY = "cgs.compactMode";
const listeners = new Set<() => void>();

export function getCompactMode(): CompactMode {
  try {
    return parseCompactMode(localStorage.getItem(KEY));
  } catch {
    return parseCompactMode(undefined); // storage unavailable (private mode, tests)
  }
}

export function setCompactMode(mode: CompactMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* the choice then lasts for this call only */
  }
  for (const cb of listeners) cb();
}

const subscribe = (cb: () => void) => (listeners.add(cb), () => listeners.delete(cb));

export const useCompactMode = (): CompactMode => useSyncExternalStore(subscribe, getCompactMode);
