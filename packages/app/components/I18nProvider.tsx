"use client";

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { DEFAULT_BUSINESS_TIME_ZONE, type Locale } from "@/lib/i18n/locale";
import { getLocaleSnapshot, getServerLocaleSnapshot, setStoredLocale, subscribeLocale } from "@/lib/i18n/store";
import { translate, type Params } from "@/lib/i18n/core";
import type { MessageKey } from "@/lib/i18n/messages";
import { formatDate, formatDateTime, formatMoney, formatNumber, formatPercent, formatRelative, timeZoneLabel } from "@/lib/i18n/format";
import { describeError } from "@/lib/i18n/errors";

/**
 * App-wide interface language (/, Dashboard, wizard, builder, scene, /ops).
 * - The choice is read through useSyncExternalStore: the server render and hydration use the
 *   default (vi), then the stored choice applies — no hydration mismatch, no global mutated in render.
 * - Switching only re-renders labels: component state (form drafts, selection, trace stack) is kept.
 * - The business time zone is separate from the language and only affects how instants are shown.
 */
export interface I18n {
  locale: Locale;
  setLocale: (l: Locale) => void;
  /** Catalog lookup by key (typed). */
  t: (key: MessageKey, params?: Params) => string;
  /** Inline pair for strings not yet moved to the catalog. */
  tr: (vi: string, en: string) => string;
  timeZone: string;
  setTimeZone: (tz: string) => void;
  fmt: {
    dateTime: (iso: string | null | undefined, o?: { year?: boolean; seconds?: boolean }) => string;
    date: (ymd: string | null | undefined) => string;
    number: (n: number | null | undefined, o?: { maxDigits?: number; minDigits?: number }) => string;
    percent: (ratio: number | null | undefined, digits?: number) => string;
    money: (amount: number | null | undefined, currency: string, digits?: number) => string;
    relative: (ts: number, now: number) => string;
    tz: () => string;
  };
  /** lang attribute for content produced in Vietnamese when the interface is in another language. */
  sourceLang: (src?: Locale) => Locale | undefined;
}

function make(locale: Locale, timeZone: string, setTimeZone: (tz: string) => void): I18n {
  return {
    locale,
    setLocale: setStoredLocale,
    t: (key, params) => translate(locale, key, params),
    tr: (vi, en) => (locale === "en" ? en : vi),
    timeZone,
    setTimeZone,
    fmt: {
      dateTime: (iso, o) => formatDateTime(locale, iso, { timeZone, ...o }),
      date: (ymd) => formatDate(locale, ymd),
      number: (n, o) => formatNumber(locale, n, o),
      percent: (r, d) => formatPercent(locale, r, d),
      money: (a, c, d) => formatMoney(locale, a, c, d),
      relative: (ts, now) => formatRelative(locale, ts, now),
      tz: () => timeZoneLabel(locale, timeZone),
    },
    sourceLang: (src = "vi") => (src !== locale ? src : undefined),
  };
}

const Ctx = createContext<I18n>(make("vi", DEFAULT_BUSINESS_TIME_ZONE, () => {}));

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const locale = useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getServerLocaleSnapshot);
  const [timeZone, setTimeZone] = useState(DEFAULT_BUSINESS_TIME_ZONE);
  useEffect(() => {
    document.documentElement.lang = locale;
    const desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute("content", translate(locale, "app.description"));
  }, [locale]);
  const value = useMemo(() => make(locale, timeZone, setTimeZone), [locale, timeZone]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);

/** Segmented VI | EN switch (keyboard: Tab to focus, Enter/Space to choose). */
export function LanguageSwitch() {
  const { locale, setLocale, t } = useI18n();
  const seg = (l: Locale, label: string) => (
    <button
      key={l}
      type="button"
      onClick={() => setLocale(l)}
      aria-pressed={locale === l}
      lang={l}
      title={l === "vi" ? "Tiếng Việt" : "English"}
      style={{
        padding: "3px 9px",
        fontSize: 11.5,
        fontWeight: 650,
        border: "none",
        cursor: "pointer",
        background: locale === l ? "var(--accent)" : "transparent",
        color: locale === l ? "var(--accent-ink)" : "var(--ink-2)",
      }}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label={t("lang.group")} data-testid="lang-switch" style={{ display: "inline-flex", border: "1px solid var(--border-strong)", borderRadius: 6, overflow: "hidden", flexShrink: 0 }}>
      {seg("vi", "VI")}
      {seg("en", "EN")}
    </div>
  );
}

/** Localized error summary + support details (original server text, request ID, code). */
export function ErrorMessage({ error, style }: { error: unknown; style?: React.CSSProperties }) {
  const { locale, t } = useI18n();
  if (!error) return null;
  const d = describeError(error, locale);
  const showOriginal = d.original && d.original !== d.summary;
  return (
    <div role="alert" style={{ color: "#ef4444", fontSize: 12, ...style }}>
      {d.summary}
      {(showOriginal || d.requestId) && (
        <details style={{ marginTop: 2, color: "var(--ink-3)", fontSize: 11 }}>
          <summary style={{ cursor: "pointer" }}>{t("common.details")}</summary>
          {showOriginal && (
            <div>
              {t("common.original")}: <span lang={d.kind === "http" ? "vi" : undefined}>{d.original}</span>
            </div>
          )}
          {d.code && <div style={{ fontFamily: "var(--font-mono)" }}>code: {d.code}{d.status ? ` · HTTP ${d.status}` : ""}</div>}
          {d.requestId && <div style={{ fontFamily: "var(--font-mono)" }}>{t("common.requestId")}: {d.requestId}</div>}
        </details>
      )}
    </div>
  );
}
