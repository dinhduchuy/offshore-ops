import { NextResponse } from "next/server";
import { getOps, opsError, errorJson } from "@/lib/ops";
import { resolveIdentity } from "@/lib/identity";

/**
 * Test/demo controls: {action:"reset"} | {action:"fault", agentId, count}.
 * The core authorizes: server-side identity with the admin role (ops-config
 * permissions.admin), demo mode only — production has no reset/fault path.
 */
export async function POST(request: Request) {
  try {
    const actor = resolveIdentity(request) ?? undefined;
    const b = (await request.json().catch(() => ({}))) as { action?: string; agentId?: string; count?: number };
    const ops = getOps();
    if (b.action === "reset") ops.reset(actor);
    else if (b.action === "fault") ops.setFault(String(b.agentId ?? ""), Number(b.count ?? 1), actor);
    else return errorJson(400, "invalid_input", "action không hợp lệ", { field: "action" });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return opsError(err);
  }
}
