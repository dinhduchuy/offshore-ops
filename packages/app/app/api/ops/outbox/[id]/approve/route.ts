import { NextResponse } from "next/server";
import { getOps, opsError, errorJson } from "@/lib/ops";
import { resolveIdentity, identityStatus } from "@/lib/identity";

/**
 * Approve sending ONE outbound draft (docId + docSha256 of the version seen).
 * Identity from the server session. Nothing is dispatched: no outbound adapter exists.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = resolveIdentity(request);
    if (!actor) return errorJson(401, "identity_missing", `Chưa có danh tính phía server. ${identityStatus().detail}`);
    const { id } = await params;
    const b = (await request.json().catch(() => ({}))) as { docId?: number; docSha256?: string };
    if (!b.docId || !b.docSha256) return errorJson(400, "invalid_input", "Thiếu docId/docSha256 của bản nháp đã xem", { field: "docId/docSha256" });
    return NextResponse.json({ ok: true, identitySource: actor.source, ...getOps().approveOutbox({ id: Number(id), docId: b.docId, docSha256: b.docSha256, actor }) });
  } catch (err) {
    return opsError(err);
  }
}
