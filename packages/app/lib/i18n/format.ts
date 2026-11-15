import { DEFAULT_BUSINESS_TIME_ZONE, intlLocale, type Locale } from "./locale";
import { translate } from "./core";

/**
 * Central formatters. The locale only changes how a value is DISPLAYED; values, instants and
 * stored ISO strings are never changed. Business times are shown in the business time zone
 * (ops-config calendar.timeZone, default Asia/Ho_Chi_Minh), not the viewer's machine zone.
 * Currency is always explicit (code shown) and never inferred from the locale.
 */

export function formatNumber(locale: Locale, n: number | null | undefined, opts: { maxDigits?: number; minDigits?: number } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  return new Intl.NumberFormat(intlLocale(locale), {
    maximumFractionDigits: opts.maxDigits ?? 2,
    minimumFractionDigits: opts.minDigits ?? 0,
  }).format(Number(n));
}

/** ratio 0.1234 → "12.3%" / "12,3%". */
export function formatPercent(locale: Locale, ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))) return "—";
  return new Intl.NumberFormat(intlLocale(locale), { style: "percent", maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(Number(ratio));
}

/** Money with an explicit ISO currency code (never inferred): "USD 1,234.56" / "1.234,56 USD". */
export function formatMoney(locale: Locale, amount: number | null | undefined, currency: string, digits = 2): string {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return "—";
  const code = String(currency || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return `${formatNumber(locale, amount, { maxDigits: digits, minDigits: digits })} ${currency || "?"}`;
  return new Intl.NumberFormat(intlLocale(locale), { style: "currency", currency: code, currencyDisplay: "code", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(amount));
}

/** Instant (ISO with time) → date-time in the business time zone. */
export function formatDateTime(
  locale: Locale,
  iso: string | null | undefined,
  opts: { timeZone?: string; year?: boolean; seconds?: boolean } = {},
): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: opts.timeZone ?? DEFAULT_BUSINESS_TIME_ZONE,
    hour12: false,
    day: "2-digit",
    month: "2-digit",
    ...(opts.year ? { year: "numeric" as const } : {}),
    hour: "2-digit",
    minute: "2-digit",
    ...(opts.seconds === false ? {} : { second: "2-digit" as const }),
  }).format(d);
}

/**
 * Calendar date "YYYY-MM-DD" (a business date, not an instant) → localized date.
 * Never converted through a time zone, so it cannot shift by a day.
 */
export function formatDate(locale: Locale, ymd: string | null | undefined): string {
  if (!ymd) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) return String(ymd);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat(intlLocale(locale), { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

/** Short offset label of a time zone, e.g. "GMT+7". */
export function timeZoneLabel(locale: Locale, timeZone: string, at = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat(intlLocale(locale), { timeZone, timeZoneName: "shortOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName");
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** Relative time from the catalog (now / N seconds ago / N minutes ago / N hours ago). */
export function formatRelative(locale: Locale, ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 1) return translate(locale, "time.now");
  if (s < 60) return translate(locale, "time.secondsAgo", { count: s });
  const m = Math.floor(s / 60);
  if (m < 60) return translate(locale, "time.minutesAgo", { count: m });
  return translate(locale, "time.hoursAgo", { count: Math.floor(m / 60) });
}

/**
 * Parse a number typed in the given locale. Strict: grouping must be in groups of three and use
 * the locale's group separator; anything ambiguous returns NaN instead of a different value.
 * en: "1,234.56" → 1234.56 · vi: "1.234,56" → 1234.56 · en "1.234,56" → NaN.
 * Plain machine form "1234.56" is accepted in both locales only when it has no group separator
 * and the separator is the locale's decimal mark ("." for en; for vi "1234.56" is NaN).
 */
export function parseNumber(locale: Locale, text: string): number {
  const s = String(text ?? "").trim().replace(/\u00a0|\u202f/g, " ");
  if (!s) return NaN;
  const group = locale === "en" ? "," : ".";
  const dec = locale === "en" ? "." : ",";
  const esc = (c: string) => (c === "." ? "\\." : c);
  const re = new RegExp(`^([-−]?)(\\d{1,3}(?:${esc(group)}\\d{3})+|\\d+)(?:${esc(dec)}(\\d+))?$`);
  const m = re.exec(s);
  if (!m) return NaN;
  const intPart = m[2].split(group).join("");
  const n = Number(`${intPart}${m[3] ? `.${m[3]}` : ""}`);
  return m[1] ? -n : n;
}
