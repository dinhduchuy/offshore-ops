import { NextResponse } from "next/server";
import { getOps, opsError, errorJson } from "@/lib/ops";
import { resolveIdentity, identityStatus } from "@/lib/identity";

/**
 * Human decision on an approval gate.
 * Identity/role come from the server session — actorName/actorRole in the body are ignored.
 * packageSha (and optionally packageVersion) are mandatory; idempotencyKey is bound to the payload.
 */
export async function POST(request: Request) {
  try {
    const actor = resolveIdentity(request);
    if (!actor) return errorJson(401, "identity_missing", `Chưa có danh tính phía server. ${identityStatus().detail}`);
    const b = (await request.json()) as {
      taskId: number;
      decision: "approve" | "reject" | "request_changes";
      comment?: string;
      returnTo?: string;
      packageSha?: string;
      packageVersion?: number;
      idempotencyKey?: string;
      waivers?: string[];
      confirmations?: string[];
    };
    if (!b.idempotencyKey) return errorJson(400, "idempotency_missing", "Thiếu idempotencyKey");
    if (!b.packageSha) return errorJson(400, "package_sha_missing", "Thiếu packageSha — phải xác nhận đúng phiên bản hồ sơ đã xem");
    const r = getOps().decide({
      taskId: b.taskId,
      decision: b.decision,
      actor,
      comment: b.comment ?? "",
      returnTo: b.returnTo ?? null,
      packageSha: b.packageSha,
      packageVersion: b.packageVersion,
      idempotencyKey: b.idempotencyKey,
      waivers: Array.isArray(b.waivers) ? b.waivers.map(String) : [],
      confirmations: Array.isArray(b.confirmations) ? b.confirmations.map(String) : [],
    });
    return NextResponse.json({ ok: true, identitySource: actor.source, ...r });
  } catch (err) {
    return opsError(err);
  }
}
