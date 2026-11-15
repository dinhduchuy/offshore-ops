import { translateDynamic, type Params } from "./core";
import type { Locale } from "./locale";
import { AGENT_EN, DATASET_EN, ROLE_EN, STEP_EN } from "./domain";

/** Message key + params attached to an event (server) or built by the 3D view (generic activity). */
export type EventMsg = { key: string; params?: Params };

/**
 * Event text in the interface language. Business codes in params (step keys, agent ids, decision
 * and wait codes, roles) are rendered per language; free text stays as produced. Returns
 * undefined when the key is unknown — the caller then shows the original label (never a guess).
 */
export function eventText(msg: EventMsg | null | undefined, locale: Locale, stepTitles?: Record<string, string>): string | undefined {
  if (!msg?.key) return undefined;
  const p: Params = { ...(msg.params ?? {}) };
  const step = typeof p.step === "string" ? p.step : undefined;
  if (step) p.step = locale === "en" ? (STEP_EN[step] ?? step) : (stepTitles?.[step] ?? step);
  if (typeof p.to === "string") p.to = locale === "en" ? (AGENT_EN[p.to] ?? p.to) : p.to;
  if (typeof p.role === "string" && locale === "en") p.role = ROLE_EN[p.role] ?? p.role;
  // dataset: code → English name; Vietnamese keeps the server's label for it
  if (typeof p.dataset === "string") p.dataset = locale === "en" ? (DATASET_EN[p.dataset] ?? p.dataset) : (typeof p.datasetLabel === "string" ? p.datasetLabel : p.dataset);
  if (typeof p.decision === "string") p.decision = translateDynamic(locale, `decision.${p.decision}`) ?? p.decision;
  if (typeof p.wait === "string") p.wait = translateDynamic(locale, `wait.${p.wait}`) ?? p.wait;
  if (locale === "en" && typeof p.room_en === "string" && p.room_en) p.room = p.room_en;
  if (typeof p.activity === "string") p.activity = translateDynamic(locale, `act.${p.activity}`) ?? p.activity;
  return translateDynamic(locale, msg.key, p);
}
