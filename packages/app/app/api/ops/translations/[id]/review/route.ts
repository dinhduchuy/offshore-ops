import { NextResponse } from "next/server";
import { getOps, opsError, errorJson } from "@/lib/ops";
import { resolveIdentity, identityStatus } from "@/lib/identity";

/** A specialist marks a translation reviewed (or rejected). The original and its approvals are untouched. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = resolveIdentity(request);
    if (!actor) return errorJson(401, "identity_missing", `Chưa có danh tính phía server. ${identityStatus().detail}`);
    const { id } = await params;
    const b = (await request.json().catch(() => ({}))) as { verdict?: unknown; note?: unknown };
    const row = getOps().reviewTranslation({ id: Number(id), verdict: b.verdict, actor, note: typeof b.note === "string" ? b.note.slice(0, 500) : undefined });
    return NextResponse.json({ ok: true, translation: row });
  } catch (err) {
    return opsError(err);
  }
}
