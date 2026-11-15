/**
 * Single time source for the ops core. Production uses the wall clock; tests
 * and scripted demos can pin "now" so date-dependent rules (future-dated data,
 * document validity, due dates, holds) are deterministic.
 *
 * Business dates ("today", the date of a decision) are computed in ONE configured
 * time zone (ops-config `calendar.timeZone`, e.g. Asia/Ho_Chi_Minh) — not in UTC and
 * not in the server's local zone. Instants (expires_at, decided_at) stay ISO-8601 UTC.
 * Expiry rule used everywhere: an instant-based validity ends AT expires_at
 * (`expires_at <= now` → expired). A date-based validity (valid_to of a document)
 * includes the whole valid_to business day.
 */
let source: () => Date = () => new Date();
let zone = "UTC";

export function setClock(fn: (() => Date) | null): void {
  source = fn ?? (() => new Date());
}

/** Set the business time zone (IANA name). Throws on an unknown zone. */
export function setBusinessTimeZone(tz: string): void {
  new Intl.DateTimeFormat("en-CA", { timeZone: tz }); // validates (RangeError on unknown zone)
  zone = tz;
}

export function businessTimeZone(): string {
  return zone;
}

export function now(): Date {
  return source();
}

/** YYYY-MM-DD of an instant in the business time zone. */
export function businessDate(at: Date | string): string {
  const d = typeof at === "string" ? new Date(at) : at;
  if (zone === "UTC") return d.toISOString().slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function todayIso(): string {
  return businessDate(source());
}

export function addHoursIso(hours: number, from: Date = source()): string {
  return new Date(from.getTime() + hours * 3_600_000).toISOString();
}
