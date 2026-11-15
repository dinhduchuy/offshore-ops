import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { TEMPLATES_DIR } from "@/lib/ops";

/** 3D layout for the ops center (independent of ~/.diorama/config.json). */
export async function GET() {
  const file = path.join(TEMPLATES_DIR, "oil-gas-ops", "diorama.config.json");
  if (!fs.existsSync(file)) return NextResponse.json({ error: "Chưa sinh mặt bằng: python3 oilgas/generate_ops_layout.py" }, { status: 404 });
  return NextResponse.json(JSON.parse(fs.readFileSync(file, "utf-8")));
}
