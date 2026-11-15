import type { AgentContext, AgentDef } from "./kit";
import { mdTable, docFooter, rowRef, daysBetween, isGasLift } from "./kit";
import type { DetectionFacts } from "./metrics";
import { checkMaterials } from "./materials";

const NAME = "Maintenance & Reliability AI (Bảo dưỡng & độ tin cậy)";

/** Equipment system → hypothesis codes it can explain (used to match catalog activities). */
const SYSTEM_HYPOTHESIS: Record<string, string[]> = {
  "gas lift": ["H_GL"],
  metering: ["H_MEAS"],
  esp: ["H_ESP"],
  wellhead: ["H_CHOKE"],
};

function run(ctx: AgentContext): void {
  const o = ctx.o;
  const T = ctx.L;
  const det = ctx.detection() as unknown as DetectionFacts;
  const well = det.well.well;
  const onset = det.well.baseline.to ?? det.well.days[0]?.date ?? det.asOf;
  const anomalyRun = ctx.up("ops.anomaly")!;
  o.ev(T(`Hồ sơ bất thường (Operations): ${anomalyRun.output.summary}`, `Anomaly dossier (Operations): ${anomalyRun.output.summary}`), { kind: "task_run", id: anomalyRun.runId });
  if (ctx.feedback) o.warn(T(`Phản hồi của người duyệt (${ctx.feedback.actor}): "${ctx.feedback.comment}" — đã xem xét khi chạy lại.`, `Approver feedback (${ctx.feedback.actor}): "${ctx.feedback.comment}" — considered in this re-run.`));

  const history = ctx.caseRows("maintenance_history");
  if (!history.length) {
    o.need({ description: T("Chưa có lịch sử bảo dưỡng / work order (maintenance_history)", "No maintenance history / work orders (maintenance_history)"), datasetType: "maintenance_history", blocking: true, owner: T("Bảo dưỡng", "Maintenance") });
  }
  const liftType = (ctx.caseRows("well_master")[0]?.data.lift_type as string | undefined) ?? "";

  // Relevant: equipment of this well, or shared facilities (no well) that affect allocation/lift
  const relevant = history.filter((r) => r.data.well === well || (!r.data.well && ["metering", "gas lift", "gas compression"].includes(String(r.data.system).toLowerCase())));
  const findings: Array<{ wo: string; system: string; state: string; overdueDays: number | null; beforeOnset: boolean | null; evId: string; rowId: number }> = [];
  for (const r of relevant) {
    const status = String(r.data.status).toLowerCase();
    const due = r.data.due_date as string | null;
    const closed = status === "closed" || status === "đóng";
    const overdue = !closed && !!due && due < det.asOf;
    const overdueDays = overdue ? daysBetween(due!, det.asOf) : null;
    const recentCm = String(r.data.wo_type).toUpperCase() === "CM" && r.data.raised_date && daysBetween(r.data.raised_date as string, det.asOf) <= 120;
    if (!overdue && closed && !recentCm) continue;
    const state = overdue ? T(`quá hạn ${overdueDays} ngày`, `${overdueDays} days overdue`) : !closed ? T("đang mở", "open") : T("CM gần đây", "recent CM");
    const beforeOnset = overdue ? due! <= onset : null;
    const evId = o.ev(`${r.data.wo_no} ${r.data.equipment_tag} (${r.data.system}): ${r.data.description} — ${state}${due ? T(`, hạn ${due}`, `, due ${due}`) : ""}`, rowRef(r));
    findings.push({ wo: r.data.wo_no as string, system: String(r.data.system), state, overdueDays, beforeOnset, evId, rowId: r.id });
    o.conclude(
      T(`Đối chiếu: ${r.data.wo_no} (${r.data.equipment_tag}, ${r.data.system}) ${state}${beforeOnset ? ` — quá hạn từ trước thời điểm bắt đầu suy giảm (${onset})` : ""}.`, `Check: ${r.data.wo_no} (${r.data.equipment_tag}, ${r.data.system}) ${state}${beforeOnset ? ` — overdue since before the decline started (${onset})` : ""}.`),
      "check",
      [evId],
    );
  }
  if (history.length && !findings.length) {
    o.conclude(T(`Không có work order mở/quá hạn hoặc sửa chữa gần đây liên quan đến ${well}.`, `No open/overdue work order or recent repair related to ${well}.`), "check", []);
  }

  // Maintenance activities from the catalog that address systems with findings
  const codes = new Set(findings.flatMap((f) => SYSTEM_HYPOTHESIS[f.system.toLowerCase()] ?? []));
  const catalog = ctx.rows("activity_catalog").filter((a) => a.data.work_type === "maintenance");
  const recommended: Array<{ type: string; name: string; workType: string; addresses: string[]; source: string }> = [];
  for (const a of catalog) {
    const addr = ((a.data.addresses as string[] | null) ?? []).filter((c) => codes.has(c));
    const lifts = (a.data.lift_types as string[] | null) ?? [];
    if (!addr.length) continue;
    if (lifts.length && !lifts.some((l) => liftType.toLowerCase().includes(l.toLowerCase()))) continue;
    if (addr.includes("H_GL") && !isGasLift(liftType)) continue;
    const related = findings.filter((f) => (SYSTEM_HYPOTHESIS[f.system.toLowerCase()] ?? []).some((c) => addr.includes(c)));
    const ev = o.ev(T(`Danh mục hoạt động bảo dưỡng: ${a.data.name}`, `Maintenance activity catalog: ${a.data.name}`), rowRef(a));
    recommended.push({ type: a.data.activity_type as string, name: a.data.name as string, workType: "maintenance", addresses: addr, source: "maintenance" });
    o.conclude(T(`Đề xuất ${a.data.name} do ${related.map((f) => `${f.wo} ${f.state}`).join(", ")}.`, `Proposes ${a.data.name} because ${related.map((f) => `${f.wo} is ${f.state}`).join(", ")}.`), "check", [ev, ...related.map((f) => f.evId)]);
  }

  const materials = checkMaterials(ctx, recommended.map((r) => r.type));
  for (const m of materials) {
    o.conclude(
      T(`Vật tư ${m.part_no} cho ${m.activity}: ${m.needsPurchase ? `không đủ tồn kho — cần mua (lead time ${m.leadTimeDays ?? "?"} ngày)` : m.needsTransport ? "có ở kho bờ — cần vận chuyển ra giàn" : "có sẵn ngoài giàn"}.`, `Material ${m.part_no} for ${m.activity}: ${m.needsPurchase ? `not enough stock — purchase needed (lead time ${m.leadTimeDays ?? "?"} days)` : m.needsTransport ? "in onshore stores — to be shipped offshore" : "available offshore"}.`),
      "check",
      [m.evId],
    );
  }
  o.need({ description: T("Chưa có dữ liệu lịch nhân lực bảo dưỡng ngoài giàn — cần trưởng bộ phận xác nhận nguồn lực (tích hợp CMMS chưa có: xác nhận thủ công có trace)", "No offshore maintenance crew schedule — the section head must confirm resources (no CMMS integration yet: manual, traceable confirmation)"), blocking: false, owner: T("Trưởng bộ phận Bảo dưỡng", "Maintenance section head") });

  let workRequestDocId: number | null = null;
  if (recommended.length) {
    const byType = new Map(catalog.map((a) => [a.data.activity_type as string, a]));
    const doc = ctx.saveDoc(
      "work-request-draft",
      T(`Dự thảo work request — ${ctx.workflow.case_no}`, `Draft work request — ${ctx.workflow.case_no}`),
      "work_request_draft",
      `${T("# DỰ THẢO Work request", "# DRAFT work request")} — ${well}\n\n${mdTable(
        T("Hoạt động|Liên quan WO|Nhân lực|Thời gian (ngày)", "Activity|Related WO|Crew|Duration (days)").split("|"),
        recommended.map((r) => {
          const c = byType.get(r.type)!;
          const wos = findings.filter((f) => (SYSTEM_HYPOTHESIS[f.system.toLowerCase()] ?? []).some((x) => r.addresses.includes(x))).map((f) => f.wo);
          return [r.name, wos.join(", ") || "—", c.data.crew_size ?? "—", c.data.duration_days ?? "—"];
        }),
      )}\n\n${T("## Danh sách vật tư", "## Materials list")}\n\n${materials.length ? mdTable(
        T("Mã|Mô tả|SL|Ngoài giàn|Kho bờ|Phương án", "Part|Description|Qty|Offshore|Onshore|Plan").split("|"),
        materials.map((m) => [m.part_no, m.description, m.qty, m.qtyOffshore ?? "—", m.qtyOnshore ?? "—", m.needsPurchase ? T("Mua mới", "Purchase") : m.needsTransport ? T("Vận chuyển từ kho bờ", "Ship from onshore stores") : T("Xuất kho giàn", "Issue from offshore stores")]),
      ) : T("_Không phát sinh_", "_None_")}\n\n${T("## Phương án thực hiện (dự thảo)\n1. Lập lệnh công việc trên CMMS sau khi được duyệt.\n2. Bố trí vật tư theo bảng trên; phối hợp Hậu cần nếu cần vận chuyển.\n3. Thực hiện theo giấy phép công việc do người có thẩm quyền cấp.", "## Execution plan (draft)\n1. Raise the work order in the CMMS after approval.\n2. Arrange materials per the table above; coordinate with Logistics if transport is needed.\n3. Execute under the permit to work issued by the competent authority.")}${docFooter(ctx, T(NAME, "Maintenance & Reliability AI"))}`,
    );
    workRequestDocId = doc.docId;
  }

  o.summary = T(`${findings.length} phát hiện từ lịch sử bảo dưỡng (${findings.filter((f) => f.overdueDays !== null).length} quá hạn); đề xuất ${recommended.length} hoạt động bảo dưỡng, ${materials.length} vật tư.`, `${findings.length} finding(s) from the maintenance history (${findings.filter((f) => f.overdueDays !== null).length} overdue); proposes ${recommended.length} maintenance activity(ies), ${materials.length} material item(s).`);
  o.next(T("Chuyển kết quả đối chiếu và dự thảo work request để tổng hợp phương án", "Pass the check results and the draft work request for option consolidation"));
  o.facts = {
    findings: findings.map(({ evId: _e, ...f }) => f),
    recommendedActivities: recommended,
    materials: materials.map(({ evId: _e, ...m }) => m),
    workRequestDocId,
  };
}

export const maintenanceAgent: AgentDef = { id: "maint_agent", name: NAME, room: "zone_maint", run };
