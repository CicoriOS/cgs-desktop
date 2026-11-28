import { useSyncExternalStore } from "react";

type Theme = "system" | "light" | "dark";
const STORAGE_KEY = "cgs.theme";
const darkScheme = globalThis.window?.matchMedia?.("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function storedTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

let theme = storedTheme();
function applyTheme(): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme === "system" ? (darkScheme?.matches ? "dark" : "light") : theme;
}

applyTheme();
darkScheme?.addEventListener("change", applyTheme);

export function setTheme(next: Theme): void {
  if (next === theme) return;
  theme = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* not persisted */
  }
  applyTheme();
  for (const cb of listeners) cb();
}

const subscribe = (cb: () => void) => (listeners.add(cb), () => listeners.delete(cb));
const getTheme = () => theme;
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme);
}
