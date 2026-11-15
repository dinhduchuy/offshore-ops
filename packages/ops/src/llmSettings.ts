import fs from "fs";
import path from "path";

/**
 * Claude API settings for the ops workflow, configured from /ops.
 *
 * Stored server-side ONLY in a separate file (default ~/.diorama/ops-llm.json,
 * mode 0600) so the copilot credentials are never touched. The API key never
 * leaves this module except to build the provider on the server: every
 * browser-facing shape goes through `publicLlmSettings` (masked).
 */

export type LlmEffort = "low" | "medium" | "high";

export interface OpsLlmSettings {
  provider: "anthropic";
  /** true → agent tasks use rules + Claude narration; false → rules only */
  enabled: boolean;
  model: string;
  effort: LlmEffort;
  /** Server-side refusal fallback (`fallbacks: "default"`) on models that support it */
  refusalFallback: boolean;
  apiKey?: string;
  /** Monotonic revision; recorded with every call so a run can be tied to its configuration */
  revision: number;
  updatedAt: string;
  updatedBy?: string;
}

export interface PublicLlmSettings {
  exists: boolean;
  provider: "anthropic";
  enabled: boolean;
  model: string;
  effort: LlmEffort;
  refusalFallback: boolean;
  keyConfigured: boolean;
  keyMasked: string | null;
  revision: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const DEFAULT_LLM_MODEL = "claude-opus-5-5";
const EFFORTS: LlmEffort[] = ["low", "medium", "high"];

export function defaultLlmSettings(): OpsLlmSettings {
  return { provider: "anthropic", enabled: false, model: DEFAULT_LLM_MODEL, effort: "medium", refusalFallback: true, revision: 0, updatedAt: new Date(0).toISOString() };
}

export function loadLlmSettings(file: string): OpsLlmSettings | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const p = JSON.parse(raw) as Partial<OpsLlmSettings>;
  const d = defaultLlmSettings();
  return {
    provider: "anthropic",
    enabled: p.enabled === true,
    model: typeof p.model === "string" && p.model ? p.model : d.model,
    effort: EFFORTS.includes(p.effort as LlmEffort) ? (p.effort as LlmEffort) : d.effort,
    refusalFallback: p.refusalFallback !== false,
    apiKey: typeof p.apiKey === "string" && p.apiKey ? p.apiKey : undefined,
    revision: typeof p.revision === "number" ? p.revision : 0,
    updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : d.updatedAt,
    updatedBy: typeof p.updatedBy === "string" ? p.updatedBy : undefined,
  };
}

/** Atomic write (tmp + rename) with mode 0600. */
export function saveLlmSettings(file: string, s: OpsLlmSettings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // best effort on non-POSIX
  }
  fs.renameSync(tmp, file);
}

export function maskKey(key: string | undefined): string | null {
  if (!key) return null;
  if (key.length < 12) return "••••";
  const prefix = key.startsWith("sk-ant-") ? "sk-ant-" : "";
  return `${prefix}…${key.slice(-4)}`;
}

export function publicLlmSettings(s: OpsLlmSettings | null): PublicLlmSettings {
  const v = s ?? defaultLlmSettings();
  return {
    exists: !!s,
    provider: "anthropic",
    enabled: v.enabled,
    model: v.model,
    effort: v.effort,
    refusalFallback: v.refusalFallback,
    keyConfigured: !!v.apiKey,
    keyMasked: maskKey(v.apiKey),
    revision: v.revision,
    updatedAt: s ? v.updatedAt : null,
    updatedBy: v.updatedBy ?? null,
  };
}

export interface LlmSettingsUpdate {
  enabled?: boolean;
  model?: string;
  effort?: string;
  refusalFallback?: boolean;
  /** New key; omitted/empty → keep the current key */
  apiKey?: string;
  /** true → delete the stored key */
  clearKey?: boolean;
}

/** Validate an update and merge it. Throws Error with a Vietnamese message on invalid input. */
export function applyLlmUpdate(current: OpsLlmSettings | null, u: LlmSettingsUpdate, actor: string): { next: OpsLlmSettings; keyChanged: boolean } {
  const base = current ?? defaultLlmSettings();
  const next: OpsLlmSettings = { ...base };
  if (u.enabled !== undefined) next.enabled = !!u.enabled;
  if (u.model !== undefined) {
    const m = String(u.model).trim();
    if (!/^[a-z0-9][a-z0-9.-]{2,80}$/i.test(m)) throw new Error("Model không hợp lệ (chỉ chữ, số, dấu chấm và gạch ngang, ví dụ claude-opus-5-5)");
    next.model = m;
  }
  if (u.effort !== undefined) {
    if (!EFFORTS.includes(u.effort as LlmEffort)) throw new Error(`Effort phải là một trong: ${EFFORTS.join(", ")}`);
    next.effort = u.effort as LlmEffort;
  }
  if (u.refusalFallback !== undefined) next.refusalFallback = !!u.refusalFallback;
  let keyChanged = false;
  if (u.clearKey) {
    keyChanged = !!next.apiKey;
    next.apiKey = undefined;
  } else if (typeof u.apiKey === "string" && u.apiKey.trim()) {
    const k = u.apiKey.trim();
    if (/\s/.test(k) || k.length < 20 || k.length > 400) throw new Error("API key không hợp lệ (độ dài hoặc có khoảng trắng)");
    keyChanged = k !== next.apiKey;
    next.apiKey = k;
  }
  next.revision = base.revision + 1;
  next.updatedAt = new Date().toISOString();
  next.updatedBy = actor;
  return { next, keyChanged };
}

// ───────────────────────── errors ─────────────────────────

export type LlmErrorCategory =
  | "missing_key"
  | "auth"
  | "permission"
  | "model"
  | "rate_limit"
  | "billing"
  | "overloaded"
  | "connection"
  | "bad_request"
  | "refusal"
  | "truncated"
  | "invalid_output"
  | "unknown";

export interface LlmErrorInfo {
  category: LlmErrorCategory;
  /** Short Vietnamese explanation for the UI */
  label: string;
  message: string;
  status?: number;
  requestId?: string;
  retryAfter?: number;
}

const LABELS: Record<LlmErrorCategory, string> = {
  missing_key: "Chưa có API key",
  auth: "Lỗi xác thực — API key sai, đã thu hồi hoặc hết hạn",
  permission: "Key không có quyền dùng tài nguyên này",
  model: "Model không tồn tại hoặc tổ chức không được dùng model này",
  rate_limit: "Vượt giới hạn sử dụng (rate limit) — thử lại sau",
  billing: "Vấn đề thanh toán/hạn mức tín dụng của tài khoản",
  overloaded: "Dịch vụ Anthropic quá tải hoặc lỗi tạm thời",
  connection: "Không kết nối được tới Anthropic (mạng, DNS, proxy, timeout)",
  bad_request: "Yêu cầu không hợp lệ",
  refusal: "Claude từ chối trả lời (stop_reason = refusal)",
  truncated: "Câu trả lời bị cắt do giới hạn max_tokens",
  invalid_output: "Câu trả lời không đúng định dạng JSON yêu cầu",
  unknown: "Lỗi không xác định",
};

/** Remove anything that looks like an API key from a message (defense in depth). */
export function scrubSecrets(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]{6,}/g, "sk-ant-…[ẩn]").replace(/(x-api-key|authorization)\s*[:=]\s*\S+/gi, "$1: [ẩn]");
}

export function classifyLlmError(err: unknown): LlmErrorInfo {
  const e = (err ?? {}) as { message?: string; status?: number; errorType?: string; requestId?: string; retryAfter?: number; category?: LlmErrorCategory; name?: string; cause?: unknown };
  const message = scrubSecrets(String(e.message ?? err));
  const base = { message, status: e.status, requestId: e.requestId, retryAfter: e.retryAfter };
  const cat = (c: LlmErrorCategory): LlmErrorInfo => ({ category: c, label: LABELS[c], ...base });
  if (e.category && LABELS[e.category]) return cat(e.category);
  const t = e.errorType;
  switch (e.status) {
    case 401:
      return cat("auth");
    case 403:
      return cat("permission");
    case 404:
      return cat("model");
    case 402:
      return cat("billing");
    case 429:
      return cat("rate_limit");
    case 500:
    case 502:
    case 503:
    case 529:
      return cat("overloaded");
    case 400:
      if (/credit balance|billing/i.test(message)) return cat("billing");
      if (/model/i.test(message) && /not|invalid|unknown/i.test(message)) return cat("model");
      return cat("bad_request");
  }
  if (t === "authentication_error") return cat("auth");
  if (t === "rate_limit_error") return cat("rate_limit");
  if (e.status === undefined && (e.name === "TypeError" || /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|timeout|abort/i.test(message))) return cat("connection");
  return cat("unknown");
}

/** Error carrying a category (used for stop_reason checks that are not HTTP errors). */
export class LlmCallError extends Error {
  constructor(public category: LlmErrorCategory, message: string) {
    super(message);
    this.name = "LlmCallError";
  }
}
