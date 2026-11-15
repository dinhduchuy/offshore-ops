import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getOps, opsError, OPS_HOME } from "@/lib/ops";
import { resolveIdentity } from "@/lib/identity";

const DIR = path.join(OPS_HOME, "sample-data");

/** GET: manifest of the SIMULATED sample set. POST {set, file?}: load it. */
export async function GET() {
  if (!fs.existsSync(path.join(DIR, "manifest.json"))) return NextResponse.json({ error: "Chưa có dữ liệu mẫu" }, { status: 404 });
  return NextResponse.json(JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf-8")));
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { set?: unknown; file?: unknown };
    const set = body.set === "supplements" ? "supplements" : "base";
    const file = typeof body.file === "string" ? body.file : undefined;
    // Simulated sample data: demo mode + a role from ops-config permissions.sample (checked in the core)
    const results = await getOps().loadSample(DIR, set, file, resolveIdentity(request) ?? undefined);
    return NextResponse.json({ ok: results.every((r) => !r.error), results });
  } catch (err) {
    return opsError(err);
  }
}
