import { NextResponse } from "next/server";
import { getOps, opsError, errorJson } from "@/lib/ops";
import { resolveIdentity, identityStatus } from "@/lib/identity";

/**
 * Record that the external owner CANCELLED a confirmed booking (cancellation reference
 * required). Until this is recorded, a booking dropped from the plan stays
 * "cancel_requested" and keeps occupying capacity — the system never cancels by itself.
 * If the plan in force needs the cancelled booking, the owning plan step and everything
 * downstream (package, gates, Outbox drafts) become stale immediately (new revision).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = resolveIdentity(request);
    if (!actor) return errorJson(401, "identity_missing", `Chưa có danh tính phía server. ${identityStatus().detail}`);
    const { id } = await params;
    const b = (await request.json().catch(() => ({}))) as { externalRef?: unknown; idempotencyKey?: unknown };
    const idempotencyKey = typeof b.idempotencyKey === "string" ? b.idempotencyKey.slice(0, 120) : undefined;
    const out = getOps().recordReservationCancelled({ id: Number(id), externalRef: String(b.externalRef ?? ""), actor, idempotencyKey });
    return NextResponse.json({ ok: true, duplicate: out.duplicate });
  } catch (err) {
    return opsError(err);
  }
}
