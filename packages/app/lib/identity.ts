import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { Identity, OperatingMode } from "@diorama/ops";

/**
 * Server-side identity for /ops approvals.
 *
 *  OPS_OPERATING_MODE=demo (default): the user picks an identity from the
 *    server-side demo directory (oilgas/demo-users.json). The choice is kept in
 *    an HMAC-signed, httpOnly cookie; roles always come from the directory, never
 *    from request bodies. This is NOT enterprise authentication and is labelled
 *    as demo everywhere.
 *  OPS_OPERATING_MODE=production: requires an enterprise identity provider,
 *    which does not exist yet → no identity is resolved and every approval is refused.
 */
export const OPERATING_MODE: OperatingMode = process.env.OPS_OPERATING_MODE === "production" ? "production" : "demo";
const COOKIE = "ops_demo_identity";

interface DemoUser {
  id: string;
  name: string;
  roles: string[];
}

function opsHome(): string {
  return process.env.OPS_HOME ?? path.resolve(process.cwd(), "../../oilgas");
}

export function demoUsers(): DemoUser[] {
  const file = path.join(opsHome(), "demo-users.json");
  if (!fs.existsSync(file)) return [];
  return (JSON.parse(fs.readFileSync(file, "utf-8")) as { users: DemoUser[] }).users;
}

// Secret: env, else random per process (demo sessions end on server restart)
const KEY = "__opsSessionSecret__";
function secret(): string {
  const g = globalThis as Record<string, unknown>;
  if (!g[KEY]) g[KEY] = process.env.OPS_SESSION_SECRET ?? crypto.randomBytes(32).toString("hex");
  return g[KEY] as string;
}

function sign(userId: string): string {
  return `${userId}.${crypto.createHmac("sha256", secret()).update(userId).digest("hex")}`;
}

function verify(token: string | undefined): string | null {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const userId = token.slice(0, i);
  const expected = Buffer.from(sign(userId));
  const got = Buffer.from(token);
  return expected.length === got.length && crypto.timingSafeEqual(expected, got) ? userId : null;
}

function readCookie(request: Request, name: string): string | undefined {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** Resolve the acting identity for a request (null = none / not allowed). */
export function resolveIdentity(request: Request): Identity | null {
  if (OPERATING_MODE === "production") return null; // no enterprise provider configured
  const userId = verify(readCookie(request, COOKIE));
  const u = userId ? demoUsers().find((x) => x.id === userId) : undefined;
  return u ? { userId: u.id, name: u.name, roles: u.roles, source: "demo" } : null;
}

export function sessionCookie(userId: string | null): string {
  if (!userId) return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  return `${COOKIE}=${encodeURIComponent(sign(userId))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`;
}

export function identityStatus() {
  return OPERATING_MODE === "production"
    ? {
        operatingMode: OPERATING_MODE,
        identityProvider: "none" as const,
        detail: "Chế độ vận hành thật cần nhà cung cấp danh tính doanh nghiệp (SSO) — CHƯA được tích hợp, nên mọi phê duyệt bị chặn.",
      }
    : {
        operatingMode: OPERATING_MODE,
        identityProvider: "demo" as const,
        detail: "Danh tính chọn từ danh mục nội bộ phía server; chưa kết nối xác thực doanh nghiệp (SSO). Nguồn danh tính được lưu trong lịch sử quyết định.",
      };
}
