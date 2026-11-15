import { NextResponse } from "next/server";
import { demoUsers, identityStatus, resolveIdentity, sessionCookie, OPERATING_MODE } from "@/lib/identity";
import { errorJson } from "@/lib/ops";

export const dynamic = "force-dynamic";

/** Current identity + how identities are provided (demo directory vs none). */
export async function GET(request: Request) {
  return NextResponse.json({
    ...identityStatus(),
    identity: resolveIdentity(request),
    users: OPERATING_MODE === "demo" ? demoUsers() : [],
  });
}

/** Demo only: choose an identity from the server-side directory. */
export async function POST(request: Request) {
  if (OPERATING_MODE !== "demo") {
    return errorJson(503, "http_503", identityStatus().detail);
  }
  const { userId } = (await request.json().catch(() => ({}))) as { userId?: string | null };
  if (userId && !demoUsers().some((u) => u.id === userId)) {
    return errorJson(400, "invalid_input", "Không có người dùng demo này", { field: "userId" });
  }
  const res = NextResponse.json({ ok: true });
  res.headers.set("set-cookie", sessionCookie(userId ?? null));
  return res;
}
