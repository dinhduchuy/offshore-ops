import { NextResponse } from "next/server";
import { getOps, opsError, errorJson } from "@/lib/ops";
import { resolveIngestPrincipal } from "@/lib/ingestAuth";

/**
 * Data intake.
 *  - multipart/form-data: file (CSV/XLSX/JSON/PDF/TXT/MD), optional datasetType, workflowId
 *  - application/json:    {datasetType, rows:[{…}], idempotencyKey?, simulated?, source?}  (API / n8n)
 * Caller: browser session, or an integration token (see lib/ingestAuth.ts). Roles are
 * never read from the body; the core checks the role per dataset type, the size and row
 * limits (ops-config limits) and the schema. Idempotent: same content or key → existing import.
 */
export async function POST(request: Request) {
  try {
    const who = resolveIngestPrincipal(request);
    if (!who.ok) return errorJson(who.status, "integration_token_invalid", who.error);
    const actor = who.actor ?? undefined;
    const ops = getOps();
    const maxBytes = ops.cfg.limits.importMaxBytes;
    const len = Number(request.headers.get("content-length") ?? "0");
    if (len > maxBytes + 64 * 1024) return errorJson(413, "limit_exceeded", `Vượt giới hạn kích thước nhập (${Math.round(maxBytes / 1024 / 1024)} MB)`, { limitName: "importMaxBytes", value: len, limit: maxBytes });
    if (!actor) return errorJson(401, "identity_missing", "Chưa xác định danh tính phía server — chọn danh tính hoặc dùng token tích hợp");
    const ct = request.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const body = (await request.json()) as { datasetType?: unknown; rows?: unknown; idempotencyKey?: unknown; simulated?: unknown; source?: unknown };
      if (typeof body.datasetType !== "string" || !Array.isArray(body.rows) || !body.rows.length) {
        return errorJson(400, "invalid_input", "Cần datasetType và rows[] không rỗng", { field: "datasetType/rows" });
      }
      return NextResponse.json({
        ok: true,
        ...ops.importRecords({
          datasetType: body.datasetType,
          rows: body.rows as Array<Record<string, unknown>>,
          idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey.slice(0, 200) : undefined,
          simulated: body.simulated === true,
          source: typeof body.source === "string" ? body.source.slice(0, 60) : undefined,
          actor,
        }),
      });
    }
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return errorJson(400, "invalid_input", "Thiếu file", { field: "file" });
    if (file.size > maxBytes) return errorJson(413, "limit_exceeded", `File vượt giới hạn ${Math.round(maxBytes / 1024 / 1024)} MB`, { limitName: "importMaxBytes", value: file.size, limit: maxBytes });
    const wf = form.get("workflowId");
    const outcome = await ops.importFile({
      filename: file.name,
      buffer: Buffer.from(await file.arrayBuffer()),
      datasetType: (form.get("datasetType") as string) || undefined,
      workflowId: wf ? Number(wf) : null,
      idempotencyKey: (form.get("idempotencyKey") as string) || undefined,
      actor,
    });
    return NextResponse.json({ ok: true, ...outcome });
  } catch (err) {
    return opsError(err);
  }
}
