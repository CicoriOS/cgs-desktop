import { useSyncExternalStore } from "react";
import { desktop } from "../ui/desktop";
import { en } from "./en";
import { type MessageKey, zh } from "./zh";

export type Locale = "zh" | "en";
export type LocalePreference = Locale | "system";
export type { MessageKey };

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = { zh, en };
const STORAGE_KEY = "cgs.locale";

function storedLocale(): LocalePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    /* storage unavailable (private mode, tests) */
  }
  return "system";
}

let preference = storedLocale();
const resolveLocale = (): Locale => {
  if (preference !== "system") return preference;
  const lang = desktop?.systemLocale || globalThis.navigator?.language;
  return !lang || /^zh(?:[-_]|$)/i.test(lang) ? "zh" : "en";
};
let current = resolveLocale();
const listeners = new Set<() => void>();
const preferenceListeners = new Set<() => void>();

export const getLocale = (): Locale => current;

function updateLocale(): void {
  const next = resolveLocale();
  if (next === current) return;
  current = next;
  if (typeof document !== "undefined") document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  for (const cb of listeners) cb();
}

if (typeof window !== "undefined") window.addEventListener("languagechange", updateLocale);

export function setLocale(next: LocalePreference): void {
  if (next === preference) return;
  preference = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* not persisted */
  }
  updateLocale();
  for (const cb of preferenceListeners) cb();
}

const subscribePreference = (cb: () => void) => (preferenceListeners.add(cb), () => preferenceListeners.delete(cb));
const getPreference = () => preference;
export function useLocalePreference(): LocalePreference {
  return useSyncExternalStore(subscribePreference, getPreference);
}

/** Translates `key`, filling `{name}` placeholders. Not reactive: components use `useT` so they re-render on a language change. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const text = DICTIONARIES[current][key];
  return params ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m)) : text;
}

export const subscribeLocale = (cb: () => void) => (listeners.add(cb), () => listeners.delete(cb));

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale);
}

/** `t` bound to a subscription: the calling component re-renders when the language changes. */
export function useT(): typeof t {
  useLocale();
  return t;
}
