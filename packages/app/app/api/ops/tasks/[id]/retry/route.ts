import { NextResponse } from "next/server";
import { getOps, opsError } from "@/lib/ops";
import { resolveIdentity } from "@/lib/identity";

/** Retry a failed task. The actor is the server-side identity — never a name from the body. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    getOps().retry(Number(id), resolveIdentity(request) ?? undefined);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return opsError(err);
  }
}
