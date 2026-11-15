import { NextResponse } from "next/server";
import { getOps, opsError } from "@/lib/ops";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(getOps().state());
  } catch (err) {
    return opsError(err);
  }
}
