/**
 * Interface locale (display language) — independent of the business time zone.
 * Changing it never changes stored values, IDs, permissions or instants.
 */
export type Locale = "vi" | "en";
export const LOCALES: readonly Locale[] = ["vi", "en"] as const;
export const DEFAULT_LOCALE: Locale = "vi";
export const isLocale = (v: unknown): v is Locale => v === "vi" || v === "en";

/** BCP-47 tag used for Intl formatting. */
export const intlLocale = (l: Locale): string => (l === "en" ? "en-GB" : "vi-VN");

/** Business time zone used when the server has not told us otherwise (ops-config calendar.timeZone). */
export const DEFAULT_BUSINESS_TIME_ZONE = "Asia/Ho_Chi_Minh";
