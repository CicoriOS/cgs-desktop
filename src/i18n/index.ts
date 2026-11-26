import { useSyncExternalStore } from "react";
import { en } from "./en";
import { type MessageKey, zh } from "./zh";

export type Locale = "zh" | "en";
export type { MessageKey };

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = { zh, en };
const STORAGE_KEY = "cgs.locale";

function detect(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    /* storage unavailable (private mode, tests) */
  }
  const lang = globalThis.navigator?.language; // absent in tests; the default audience reads Chinese
  return lang && !lang.toLowerCase().startsWith("zh") ? "en" : "zh";
}

let current: Locale = detect();
const listeners = new Set<() => void>();

export const getLocale = (): Locale => current;

export function setLocale(next: Locale): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* not persisted */
  }
  if (typeof document !== "undefined") document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  for (const cb of listeners) cb();
}

/** Translates `key`, filling `{name}` placeholders. Not reactive: components use `useT` so they re-render on a language change. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const text = DICTIONARIES[current][key];
  return params ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m)) : text;
}

const subscribe = (cb: () => void) => (listeners.add(cb), () => listeners.delete(cb));

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale);
}

/** `t` bound to a subscription: the calling component re-renders when the language changes. */
export function useT(): typeof t {
  useLocale();
  return t;
}
