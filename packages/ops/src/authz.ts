import type { Database } from "./db";
import { nowIso } from "./db";
import type { OpsConfig } from "./config";
import type { Identity, OperatingMode } from "./types";
import { scrubSecrets } from "./llmSettings";

/**
 * Server-side authorization for every mutation. Enforced in the core service so
 * callers outside HTTP cannot bypass it. A refused request writes NOTHING to the
 * database (the refusal is only logged to the console, without secrets).
 *
 * No enterprise identity provider is integrated: "enterprise" identities can only
 * come from a future SSO adapter. Production refuses demo identities for people
 * actions, and has no reset/fault path at all.
 */

export type MutationAction =
  | "admin.reset"
  | "admin.fault"
  | "data.import"
  | "data.sample"
  | "llm.configure"
  | "task.retry"
  | "execution.record"
  | "reservation.confirm"
  | "reservation.cancel"
  | "translation.create"
  | "translation.review";

export class AuthzError extends Error {
  readonly isOpsError = true;
  constructor(public status: 401 | 403, message: string, public code?: string, public params?: Record<string, string | number | null | undefined>) {
    super(message);
    this.name = "OpsError";
  }
}

const norm = (r: string) => r.trim().toLowerCase();
const hasRole = (actor: Identity, roles: string[]) => actor.roles.some((r) => roles.some((x) => norm(x) === norm(r)));

/** Actions only a person may perform (never an integration/service credential). */
const PEOPLE_ONLY = new Set<MutationAction>(["llm.configure", "execution.record", "reservation.confirm", "reservation.cancel", "translation.create", "translation.review"]);

export function rolesFor(cfg: OpsConfig, action: MutationAction, detail?: { datasetType?: string; resourceType?: string }): string[] {
  const p = cfg.permissions;
  switch (action) {
    case "admin.reset":
    case "admin.fault":
      return p.admin;
    case "llm.configure":
      return p.llmConfigure;
    case "task.retry":
      return p.retry;
    case "execution.record":
      return p.execution;
    case "data.sample":
      return p.sample;
    case "data.import":
      return (detail?.datasetType && p.importByDataset[detail.datasetType]) || p.importDefault;
    case "translation.create":
      return p.translate;
    case "translation.review":
      return p.translationReview;
    case "reservation.confirm":
    case "reservation.cancel":
      return (detail?.resourceType && p.reservation[detail.resourceType]) || [];
  }
}

export function authorize(
  cfg: OpsConfig,
  operatingMode: OperatingMode,
  actor: Identity | null | undefined,
  action: MutationAction,
  detail?: { datasetType?: string; resourceType?: string },
): Identity {
  if (!actor?.userId) throw new AuthzError(401, `Chưa xác định danh tính phía server — không thực hiện "${action}"`, "identity_missing", { action });
  if ((action === "admin.reset" || action === "admin.fault" || action === "data.sample") && operatingMode === "production") {
    throw new AuthzError(403, `Môi trường vận hành (production) không có thao tác "${action}"`, "production_action_unavailable", { action });
  }
  if (PEOPLE_ONLY.has(action) && actor.source === "service") throw new AuthzError(403, `"${action}" phải do người thực hiện — credential tích hợp (service) không được phép`, "person_required", { action });
  if (operatingMode === "production" && actor.source === "demo") throw new AuthzError(403, "Chế độ vận hành thật không chấp nhận danh tính demo (chưa tích hợp danh tính doanh nghiệp)", "demo_identity_refused");
  const roles = rolesFor(cfg, action, detail);
  if (!hasRole(actor, roles)) {
    const what = detail?.datasetType ? ` dữ liệu "${detail.datasetType}"` : detail?.resourceType ? ` tài nguyên "${detail.resourceType}"` : "";
    throw new AuthzError(403, `Không có quyền "${action}"${what}: cần vai trò ${roles.join(" / ") || "(chưa cấu hình)"}; ${actor.name} có: ${actor.roles.join(", ") || "—"}`, "role_required", { action, roles: roles.join(" / ") });
  }
  return actor;
}

/** Append-only audit of allowed mutations (kept across demo resets, no secrets). */
export function audit(db: Database, actor: Identity, action: string, target: string, detail: Record<string, unknown> = {}): void {
  db.prepare("INSERT INTO audit_log (ts, actor_id, actor_name, identity_source, roles, action, target, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    nowIso(),
    actor.userId,
    actor.name,
    actor.source,
    actor.roles.join(", "),
    action,
    target,
    scrubSecrets(JSON.stringify(detail)).slice(0, 4000),
  );
}

export function logDenied(action: string, err: unknown): void {
  console.warn(`[ops][audit] từ chối ${action}: ${scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
}
