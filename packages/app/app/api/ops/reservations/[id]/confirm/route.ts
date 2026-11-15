import { NextResponse } from "next/server";
import { getOps, opsError, errorJson } from "@/lib/ops";
import { resolveIdentity, identityStatus } from "@/lib/identity";

/**
 * Record that the external owner (marine coordinator, finance…) confirmed a held booking.
 * The system books nothing. The confirmation is bound to the content the person saw:
 * quantity must match the hold and caseRevision must be the CURRENT case revision (a hold
 * placed at an earlier revision is carried forward only if the plan in force needs exactly
 * this content — evidence stored in reservation_events). The external reference is unique
 * per resource type; the role is checked per resource type; service credentials are refused.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = resolveIdentity(request);
    if (!actor) return errorJson(401, "identity_missing", `Chưa có danh tính phía server. ${identityStatus().detail}`);
    const { id } = await params;
    const b = (await request.json().catch(() => ({}))) as { externalRef?: unknown; quantity?: unknown; caseRevision?: unknown; idempotencyKey?: unknown };
    const quantity = Number(b.quantity);
    const caseRevision = Number(b.caseRevision);
    if (!Number.isFinite(quantity) || !Number.isInteger(caseRevision)) return errorJson(400, "invalid_input", "Cần quantity và caseRevision của giữ chỗ đang xem", { field: "quantity/caseRevision" });
    const idempotencyKey = typeof b.idempotencyKey === "string" ? b.idempotencyKey.slice(0, 120) : undefined;
    const out = getOps().confirmReservation({ id: Number(id), externalRef: String(b.externalRef ?? ""), quantity, caseRevision, actor, idempotencyKey });
    return NextResponse.json({ ok: true, duplicate: out.duplicate });
  } catch (err) {
    return opsError(err);
  }
}
