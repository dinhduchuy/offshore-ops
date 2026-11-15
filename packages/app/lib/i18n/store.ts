import { DEFAULT_LOCALE, isLocale, type Locale } from "./locale";

/**
 * Persistent locale preference (display only, no secrets).
 * localStorage when available; in-memory fallback when storage is blocked (private mode,
 * sandboxed iframe) so the choice still holds for the session. Read through
 * useSyncExternalStore in the provider — never mutated during render.
 */
export const LOCALE_STORAGE_KEY = "offshore-ops.lang";

type Listener = () => void;
const listeners = new Set<Listener>();
let memory: Locale | null = null;

function readStorage(): Locale | null {
  try {
    const v = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(v) ? v : null;
  } catch {
    return null;
  }
}

export function getLocaleSnapshot(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  return readStorage() ?? memory ?? DEFAULT_LOCALE;
}

/** Server render and the first client render (hydration) always use the default. */
export const getServerLocaleSnapshot = (): Locale => DEFAULT_LOCALE;

export function setStoredLocale(l: Locale): void {
  memory = l;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, l);
  } catch {
    /* storage blocked: the in-memory value is used */
  }
  for (const f of [...listeners]) f();
}

export function subscribeLocale(f: Listener): () => void {
  listeners.add(f);
  const onStorage = (e: StorageEvent) => {
    if (e.key === LOCALE_STORAGE_KEY) f();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(f);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
