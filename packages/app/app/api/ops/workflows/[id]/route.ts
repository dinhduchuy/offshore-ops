import { NextResponse } from "next/server";
import { getOps, opsError } from "@/lib/ops";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json(getOps().workflowDetail(Number(id)));
  } catch (err) {
    return opsError(err);
  }
}
