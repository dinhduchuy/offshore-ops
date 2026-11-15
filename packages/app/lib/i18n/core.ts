import { CATALOGS, type Message, type MessageKey } from "./messages";
import { intlLocale, type Locale } from "./locale";

export type Params = Record<string, string | number | null | undefined>;

/** Keys looked up at runtime that were missing in a catalog (dev diagnostics + tests). */
export const missingTranslations = new Set<string>();

const pluralRules = new Map<Locale, Intl.PluralRules>();
function pluralCategory(locale: Locale, n: number): "one" | "other" {
  let pr = pluralRules.get(locale);
  if (!pr) {
    pr = new Intl.PluralRules(intlLocale(locale));
    pluralRules.set(locale, pr);
  }
  return pr.select(n) === "one" ? "one" : "other";
}

/** Replace {name} placeholders. Unknown placeholders are left visible (never silently dropped). */
export function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = params[k];
    return v === undefined || v === null ? m : String(v);
  });
}

function pick(msg: Message, locale: Locale, params?: Params): string {
  if (typeof msg === "string") return msg;
  const n = Number(params?.count ?? 0);
  return msg[pluralCategory(locale, n)];
}

/**
 * Translate a key. Fallback order: requested locale → Vietnamese (reference) → the key itself.
 * A miss is recorded in `missingTranslations` (and logged once in development).
 */
export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  const cat = CATALOGS[locale] as Record<string, Message | undefined>;
  let msg = cat[key];
  if (msg === undefined) {
    const id = `${locale}:${key}`;
    if (!missingTranslations.has(id)) {
      missingTranslations.add(id);
      if (process.env.NODE_ENV === "development") console.warn(`[i18n] missing ${id}`);
    }
    msg = (CATALOGS.vi as Record<string, Message | undefined>)[key];
  }
  if (msg === undefined) return key;
  return interpolate(pick(msg, locale, params), params);
}

/** Lookup for keys built at runtime (codes from the server). Returns undefined when unknown. */
export function translateDynamic(locale: Locale, key: string, params?: Params): string | undefined {
  const cat = CATALOGS[locale] as Record<string, Message | undefined>;
  const msg = cat[key] ?? (CATALOGS.vi as Record<string, Message | undefined>)[key];
  if (msg === undefined) return undefined;
  return interpolate(pick(msg, locale, params), params);
}

export const hasMessage = (key: string): key is MessageKey => key in CATALOGS.vi;

/** Placeholder names used by a message (both plural forms). */
export function placeholders(msg: Message): string[] {
  const s = typeof msg === "string" ? msg : `${msg.one} ${msg.other}`;
  return [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}
