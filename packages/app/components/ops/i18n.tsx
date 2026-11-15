"use client";

/**
 * Offshore Ops bindings over the shared app i18n (components/I18nProvider + lib/i18n).
 * Locale comes ONLY from React context (no module-level state); helpers take the locale
 * explicitly. `t(vi, en)` inline pairs remain for strings not yet moved to the catalog;
 * new or edited areas use catalog keys (`i18n.t(key, params)`).
 */
import { useI18n, LanguageSwitch } from "@/components/I18nProvider";
import type { Locale } from "@/lib/i18n/locale";
import { translateDynamic } from "@/lib/i18n/core";
import { conditionTitle, roleLabel, stepTitle as stepTitleOf, agentName as agentNameOf, datasetName as datasetNameOf, STEP_PHASE } from "@/lib/i18n/domain";
import { translate } from "@/lib/i18n/core";
import type { ModeState } from "./types";

export type Lang = Locale;

export function useLang() {
  const i18n = useI18n();
  return { lang: i18n.locale, setLang: i18n.setLocale, t: i18n.tr, fmt: i18n.fmt, i18n };
}

export const LangSwitch = LanguageSwitch;

export const conditionLabel = (c: { code: string; label: string }, lang: Lang) => conditionTitle(c, lang);
export const roleName = (r: string, lang: Lang) => roleLabel(r, lang);
export const stepTitle = (key: string, title: string, lang: Lang) => stepTitleOf(key, title, lang);
export const agentName = (id: string, name: string, lang: Lang) => agentNameOf(id, name, lang);
export const datasetName = (type: string, label: string, lang: Lang) => datasetNameOf(type, label, lang);

/** Wait label from the server's wait_kind CODE (never from parsing its text). */
export function waitText(kind: string | null | undefined, fallback: string | null | undefined, lang: Lang): string {
  if (kind) {
    const s = translateDynamic(lang, `wait.${kind}`);
    if (s) return s;
  }
  return fallback ?? "";
}

/** Phase name of a workflow step (by step key); falls back to the server text. */
export function phaseName(stepKey: string | null | undefined, fallback: string | null | undefined, lang: Lang): string {
  const k = stepKey ? STEP_PHASE[stepKey] : undefined;
  return k ? translate(lang, k) : (fallback ?? "—");
}

/** Status code → label. */
export function statusText(status: string, lang: Lang): string {
  return translateDynamic(lang, `status.${status}`) ?? status;
}

/**
 * Processing mode described from its CODES (requested/effective/configurationStatus/model);
 * the server's free text (`detail`, provider error) is shown only as the original, marked lang.
 */
export function modeDescription(m: ModeState, t: (vi: string, en: string) => string): string {
  if (m.effective === "rules") return t("Quy tắc xác định trên dữ liệu đầu vào; không gọi LLM.", "Deterministic rules on the input data; no LLM call.");
  if (m.effective === "blocked") {
    const why =
      m.configurationStatus === "missing_credentials"
        ? t("thiếu API key", "missing API key")
        : m.configurationStatus === "invalid_config"
          ? t("cấu hình không hợp lệ", "invalid configuration")
          : t("chưa có client LLM", "no LLM client");
    return t(`Yêu cầu xử lý bằng LLM nhưng chưa dùng được (${why}). Agent tạm dừng — không tự chuyển sang quy tắc.`, `LLM processing requested but unusable (${why}). Agents are paused — no silent switch to rules.`);
  }
  return t(
    `Quy tắc tính trước; Claude API (${m.provider ?? "anthropic"}/${m.model ?? "?"}) viết diễn giải và nhận định bổ sung chưa xác minh.`,
    `Rules compute first; the Claude API (${m.provider ?? "anthropic"}/${m.model ?? "?"}) writes interpretation and additional unverified findings.`,
  );
}

