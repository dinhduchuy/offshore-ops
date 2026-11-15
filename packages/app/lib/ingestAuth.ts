import crypto from "crypto";
import type { Identity } from "@diorama/ops";
import { resolveIdentity } from "./identity";

/**
 * Who is calling a data-intake endpoint.
 *
 *  - Integration (n8n, ERP export, scripts): `Authorization: Bearer <token>` or
 *    `x-ops-ingest-token: <token>`, compared in constant time with OPS_INGEST_TOKEN.
 *    The principal is a SERVICE identity whose roles come from OPS_INGEST_ROLES
 *    (comma-separated, default "Tích hợp dữ liệu"). Service principals may import the
 *    datasets their roles allow (ops-config permissions.importByDataset) but can never
 *    approve, confirm bookings or record execution.
 *  - Otherwise: the browser session (demo identity in demo mode; none in production).
 *
 * A token that is presented but wrong is refused — it never falls back to the cookie.
 * The token itself is never logged or echoed.
 */
export type IngestPrincipal = { ok: true; actor: Identity | null } | { ok: false; status: number; error: string };

function presentedToken(request: Request): string | null {
  const auth = request.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || request.headers.get("x-ops-ingest-token")?.trim() || null;
}

function sameSecret(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function resolveIngestPrincipal(request: Request): IngestPrincipal {
  const token = presentedToken(request);
  if (token) {
    const expected = process.env.OPS_INGEST_TOKEN;
    if (!expected || expected.length < 16) return { ok: false, status: 401, error: "Máy chủ chưa cấu hình OPS_INGEST_TOKEN (≥16 ký tự) — không nhận token tích hợp" };
    if (!sameSecret(token, expected)) return { ok: false, status: 401, error: "Token tích hợp không hợp lệ" };
    const roles = (process.env.OPS_INGEST_ROLES ?? "Tích hợp dữ liệu").split(",").map((r) => r.trim()).filter(Boolean);
    return { ok: true, actor: { userId: process.env.OPS_INGEST_PRINCIPAL ?? "svc.ingest", name: "Tích hợp dữ liệu (token)", roles, source: "service" } };
  }
  return { ok: true, actor: resolveIdentity(request) };
}
