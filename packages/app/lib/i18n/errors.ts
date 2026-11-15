import { translate, translateDynamic, type Params } from "./core";
import type { Locale } from "./locale";
import { CONDITION_EN, ROLE_EN, STEP_EN } from "./domain";

/**
 * Errors from the API carry a stable `code` + `params` (set by the server) next to the original
 * message. The interface renders the code from the catalog; the original message and the request
 * ID stay available as support details. When there is no code (older servers, history), the
 * summary comes from the HTTP status class only — the message text is NEVER parsed to guess a
 * meaning (B1: "API service unavailable" must not become a permission refusal).
 */
export type ErrorKind = "network" | "http" | "client";

export class ApiError extends Error {
  readonly isApiError = true;
  constructor(
    public kind: ErrorKind,
    public original: string,
    public status?: number,
    public code?: string,
    public params?: Params,
    public requestId?: string,
  ) {
    super(original);
    this.name = "ApiError";
  }
}

export const isApiError = (e: unknown): e is ApiError => !!e && typeof e === "object" && (e as { isApiError?: boolean }).isApiError === true;

/** Build an ApiError from a non-OK response body. */
export function apiErrorFromBody(status: number, body: unknown): ApiError {
  const b = (body && typeof body === "object" ? body : {}) as { error?: unknown; code?: unknown; params?: unknown; requestId?: unknown };
  const original = typeof b.error === "string" ? b.error : `HTTP ${status}`;
  const code = typeof b.code === "string" && /^[a-z0-9_]{2,60}$/.test(b.code) ? b.code : undefined;
  const params = b.params && typeof b.params === "object" ? (b.params as Params) : undefined;
  const requestId = typeof b.requestId === "string" ? b.requestId : undefined;
  return new ApiError("http", original, status, code, params, requestId);
}

/** Normalize anything thrown by fetch/json/our code. fetch() rejects with TypeError on network failure. */
export function toApiError(e: unknown): ApiError {
  if (isApiError(e)) return e;
  if (e instanceof TypeError) return new ApiError("network", e.message);
  return new ApiError("client", e instanceof Error ? e.message : String(e));
}

export interface ErrorDescription {
  summary: string;
  /** Original server/runtime text (support details). */
  original?: string;
  requestId?: string;
  code?: string;
  status?: number;
  kind?: ErrorKind;
}

function statusSummary(locale: Locale, status: number): string {
  if ([400, 401, 403, 404, 409, 413, 503].includes(status)) return translateDynamic(locale, `err.http.${status}`) ?? translate(locale, "err.unknown");
  if (status >= 500) return translate(locale, "err.http.5xx", { status });
  if (status >= 400) return translate(locale, "err.http.4xx", { status });
  return translate(locale, "err.unknown");
}

/**
 * English rendering of parameters that carry business codes (step keys, condition codes, role
 * names). Values without a known mapping are passed through unchanged.
 */
function localizeParams(params: Params | undefined, locale: Locale): Params | undefined {
  if (!params || locale !== "en") return params;
  const out: Params = { ...params };
  for (const k of ["step", "gate"]) if (typeof out[k] === "string" && STEP_EN[out[k] as string]) out[k] = STEP_EN[out[k] as string];
  if (typeof params.conditionCodes === "string") {
    const codes = params.conditionCodes.split(",").filter(Boolean);
    if (codes.every((c) => CONDITION_EN[c])) out.conditions = codes.map((c) => CONDITION_EN[c]).join("; ");
  }
  if (typeof params.conditionCode === "string" && CONDITION_EN[params.conditionCode]) out.condition = CONDITION_EN[params.conditionCode];
  if (typeof params.roles === "string") out.roles = params.roles.split(" / ").map((r) => ROLE_EN[r] ?? r).join(" / ");
  return out;
}

/**
 * The summary never invents a reason. Vietnamese interface: the server's own text is shown (it is
 * the authoritative Vietnamese wording with the exact reason). Other languages: the catalog entry
 * for the stable code, else the HTTP status class.
 */
export function describeError(e: unknown, locale: Locale): ErrorDescription {
  const err = toApiError(e);
  if (err.kind === "network") return { summary: translate(locale, "err.network"), original: err.original, kind: "network" };
  if (locale === "vi" && err.kind === "http" && err.code && err.original) {
    return { summary: err.original, original: err.original, requestId: err.requestId, code: err.code, status: err.status, kind: err.kind };
  }
  const byCode = err.code ? translateDynamic(locale, `err.${err.code}`, localizeParams(err.params, locale)) : undefined;
  const summary = byCode ?? (err.status ? statusSummary(locale, err.status) : translate(locale, "err.unknown"));
  return { summary, original: err.original, requestId: err.requestId, code: err.code, status: err.status, kind: err.kind };
}
