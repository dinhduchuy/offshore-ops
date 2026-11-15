import { NextResponse } from "next/server";
import { getOps, opsError } from "@/lib/ops";
import type { TraceRef } from "@diorama/ops";

export const dynamic = "force-dynamic";

/** Resolve a trace reference: /api/ops/trace?kind=data_row&id=12 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const kind = url.searchParams.get("kind") as TraceRef["kind"];
    const raw = url.searchParams.get("id") ?? "";
    const id = kind === "calc" || kind === "event" ? raw : Number(raw);
    return NextResponse.json(getOps().trace({ kind, id } as TraceRef));
  } catch (err) {
    return opsError(err);
  }
}
