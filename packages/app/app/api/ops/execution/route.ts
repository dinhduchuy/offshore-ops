import { NextResponse } from "next/server";
import { getOps, opsError, errorJson } from "@/lib/ops";
import { resolveIdentity, identityStatus } from "@/lib/identity";

/**
 * Record the execution of an approved activity. The confirmer is the
 * server-side identity — never an agent or the LLM.
 */
export async function POST(request: Request) {
  try {
    const actor = resolveIdentity(request);
    if (!actor) return errorJson(401, "identity_missing", `Chưa có danh tính phía server. ${identityStatus().detail}`);
    const b = (await request.json()) as { workflowId: number; activityType: string; status: "done" | "partial" | "not_done"; completedDate: string; findings?: string; resultRef?: string };
    if (!b.workflowId || !b.activityType || !b.status || !b.completedDate) return errorJson(400, "invalid_input", "Thiếu workflowId/activityType/status/completedDate", { field: "workflowId/activityType/status/completedDate" });
    const out = getOps().recordExecution({ ...b, actor });
    return NextResponse.json({ ok: true, importId: out.importId, duplicate: out.duplicate, requeued: out.requeued });
  } catch (err) {
    return opsError(err);
  }
}
