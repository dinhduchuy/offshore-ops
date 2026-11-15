import { NextResponse } from "next/server";
import { getOps, opsError, errorJson } from "@/lib/ops";
import { resolveIdentity, identityStatus } from "@/lib/identity";

export const dynamic = "force-dynamic";

/**
 * Translations of business content (documents, run summaries).
 * GET  ?kind=document|task_run&id=N&lang=en  → stored translation + stale/superseded flags (never calls the LLM)
 * POST { kind, id, targetLang, force? }      → explicit, billed translation by the configured Claude API
 *                                              (cached per source hash + target language). A person only.
 * Switching the interface language never calls this.
 */
export async function GET(request: Request) {
  try {
    const u = new URL(request.url);
    return NextResponse.json({ ok: true, ...getOps().translation(u.searchParams.get("kind"), u.searchParams.get("id"), u.searchParams.get("lang") ?? "en") });
  } catch (err) {
    return opsError(err);
  }
}

export async function POST(request: Request) {
  try {
    const actor = resolveIdentity(request);
    if (!actor) return errorJson(401, "identity_missing", `Chưa có danh tính phía server. ${identityStatus().detail}`);
    const b = (await request.json().catch(() => ({}))) as { kind?: unknown; id?: unknown; targetLang?: unknown; force?: unknown };
    const out = await getOps().requestTranslation({ kind: b.kind, id: b.id, targetLang: b.targetLang ?? "en", actor, force: b.force === true });
    return NextResponse.json({ ok: true, cached: out.cached, ...out.view });
  } catch (err) {
    return opsError(err);
  }
}
