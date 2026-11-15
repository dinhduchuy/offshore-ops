import type { AgentContext, AgentDef } from "./kit";
import { businessDate, todayIso } from "../clock";
import { mdTable, docFooter, rowRef, addDays } from "./kit";
import { num } from "../db";
import type { GateCondition } from "../types";
import { keyTokens, normKey } from "../caseModel";
import { coverage, demandsFromFacts } from "../resources";
import type { ActiveRow } from "../datasets";

/** Document applies to the activity (exact code) and the case scope (exact platform / platform/well tokens). */
function docApplies(d: ActiveRow, activity: string, platform: string, well: string, ambiguousWell: boolean): boolean {
  const at = normKey(d.data.activity_type);
  if (at && at !== normKey(activity)) return false;
  const tokens = keyTokens(d.data.scope);
  if (!tokens.length) return true; // already admitted by the case scope rule (rowsWithoutPlatform)
  const P = normKey(platform);
  const W = normKey(well);
  return tokens.some((t) => t === P || t === `${P}/${W}` || (t === W && !ambiguousWell));
}

/** A document is valid on a business date: approved, valid_from ≤ date ≤ valid_to (whole valid_to day). */
function validOn(d: ActiveRow, date: string): boolean {
  return String(d.data.status).toLowerCase() === "approved" && (!d.data.valid_from || String(d.data.valid_from) <= date) && (!d.data.valid_to || String(d.data.valid_to) >= date);
}
import type { DetectionFacts } from "./metrics";

const NAME = "HSE AI (An toàn, sức khỏe, môi trường)";

function screening(ctx: AgentContext): void {
  const o = ctx.o;
  const T = ctx.L;
  const det = ctx.detection() as unknown as DetectionFacts;
  const well = det.well.well;
  const platform = det.well.platform;
  const today = todayIso();
  if (ctx.feedback) o.warn(T(`Phản hồi của người duyệt (${ctx.feedback.actor}): "${ctx.feedback.comment}" — đã xem xét khi chạy lại.`, `Approver feedback (${ctx.feedback.actor}): "${ctx.feedback.comment}" — considered in this re-run.`));
  ctx.noteUntrustedDocs();

  const liftType = String(ctx.caseRows("well_master")[0]?.data.lift_type ?? "");
  const catalog = ctx.rows("activity_catalog").filter((a) => {
    const lifts = (a.data.lift_types as string[] | null) ?? [];
    return !lifts.length || lifts.some((l) => liftType.toLowerCase().includes(l.toLowerCase()));
  });
  const matrix = ctx.index("permit_matrix", "activity_type");
  const docs = ctx.caseRows("hse_documents");
  if (!matrix.size) o.need({ description: T("Chưa có ma trận giấy phép công việc (permit_matrix) — không thể rà soát", "No permit-to-work matrix (permit_matrix) — cannot screen"), datasetType: "permit_matrix", blocking: true, owner: "HSE" });
  if (!docs.length) o.need({ description: T("Chưa có sổ đăng ký tài liệu HSE (hse_documents)", "No HSE document register (hse_documents)"), datasetType: "hse_documents", blocking: true, owner: "HSE" });

  const result: Record<string, { name: string; permits: string[]; docs: Array<{ docType: string; status: string; docId: string | null }>; gaps: string[] }> = {};
  for (const act of catalog) {
    const type = act.data.activity_type as string;
    const name = act.data.name as string;
    const reqs = matrix.all(type);
    const entry = { name, permits: reqs.map((r) => r.data.permit_type as string), docs: [] as Array<{ docType: string; status: string; docId: string | null }>, gaps: [] as string[] };
    result[type] = entry;
    if (!reqs.length) {
      entry.gaps.push(T("chưa có quy định giấy phép trong ma trận", "no permit rule in the matrix"));
      o.ev(T(`Không tìm thấy ${type} trong ma trận giấy phép`, `${type} not found in the permit matrix`), rowRef(act));
      continue;
    }
    const evReq = reqs.map((r) => o.ev(T(`${name}: cần ${r.data.permit_type} + ${(r.data.required_documents as string[]).join(", ")}`, `${name}: requires ${r.data.permit_type} + ${(r.data.required_documents as string[]).join(", ")}`), rowRef(r)));
    const needed = Array.from(new Set(reqs.flatMap((r) => r.data.required_documents as string[])));
    const evDocs: string[] = [];
    for (const dt of needed) {
      const candidates = docs.filter((d) => normKey(d.data.doc_type) === normKey(dt) && docApplies(d, type, platform, well, ctx.scope.ambiguousWell));
      const valid = candidates.find((d) => String(d.data.status).toLowerCase() === "approved" && (!d.data.valid_to || (d.data.valid_to as string) >= today));
      const pick = valid ?? candidates[0];
      let status: string;
      if (valid) status = T("Có, còn hiệu lực", "Present, valid");
      else if (!pick) status = T("Không tìm thấy", "Not found");
      else if (String(pick.data.status).toLowerCase() !== "approved") status = T(`Có nhưng trạng thái "${pick.data.status}"`, `Present but status "${pick.data.status}"`);
      else status = T(`Hết hiệu lực từ ${pick.data.valid_to}`, `Expired on ${pick.data.valid_to}`);
      entry.docs.push({ docType: dt, status, docId: (pick?.data.doc_id as string) ?? null });
      if (pick) evDocs.push(o.ev(`${dt}: ${pick.data.doc_id} "${pick.data.title}" — ${status}`, rowRef(pick)));
      if (!valid) entry.gaps.push(`${dt}: ${status.toLowerCase()}`);
    }
    o.conclude(
      entry.gaps.length
        ? T(`${name}: ${entry.gaps.length}/${needed.length} hồ sơ cần người phụ trách xử lý/xác nhận (${entry.gaps.join("; ")}).`, `${name}: ${entry.gaps.length}/${needed.length} document(s) for the owner to resolve/confirm (${entry.gaps.join("; ")}).`)
        : T(`${name}: đủ ${needed.length} hồ sơ yêu cầu theo ma trận (ở mức đăng ký tài liệu).`, `${name}: all ${needed.length} documents required by the matrix are present (register level).`),
      "check",
      [...evReq, ...evDocs],
    );
  }
  o.assume(T("Rà soát SƠ BỘ để lập kế hoạch; hiệu lực hồ sơ được kiểm tra lại trên phạm vi đã chốt và ngày thực hiện ở bước sẵn sàng.", "PRELIMINARY screening for planning; document validity is re-checked on the agreed scope and execution date at readiness."));
  o.assume(T("HSE AI chỉ rà soát tính đầy đủ hồ sơ theo sổ đăng ký và ma trận; không cấp giấy phép, không xác nhận công việc đủ điều kiện triển khai.", "HSE AI only checks document completeness against the register and matrix; it issues no permit and does not confirm the work is fit to proceed."));
  o.assume(T(`Hiệu lực tài liệu so với ngày rà soát ${today}.`, `Document validity checked against ${today}.`));
  o.next(T("Người phụ trách HSE / OIM xác nhận các điểm còn thiếu trước khi cấp giấy phép công việc", "HSE lead / OIM confirms the open points before any permit to work is issued"));

  ctx.saveDoc(
    "hse-review",
    T(`Rà soát hồ sơ HSE — ${ctx.workflow.case_no}`, `HSE document screening — ${ctx.workflow.case_no}`),
    "hse_review",
    `${T(`# Rà soát hồ sơ HSE — ${well} (${platform})\n\nPhạm vi: các hoạt động khả dĩ cho giếng loại "${liftType || "?"}" (rà soát song song, trước khi chốt phương án).`, `# HSE document screening — ${well} (${platform})\n\nScope: candidate activities for a "${liftType || "?"}" well (parallel screening, before the option is chosen).`)}\n\n${Object.entries(result)
      .map(([t, e]) => `## ${e.name} (\`${t}\`)\n${T("Giấy phép", "Permit")}: ${e.permits.join(", ") || "—"}\n\n${e.docs.length ? mdTable(T("Hồ sơ|Tình trạng|Mã tài liệu", "Document|Status|Document no.").split("|"), e.docs.map((d) => [d.docType, d.status, d.docId ?? "—"])) : T("_Không có quy định_", "_No rule_")}`)
      .join("\n\n")}\n\n${T("> HSE AI không cấp phép và không xác nhận đủ điều kiện triển khai. Các điểm trên cần người phụ trách xác nhận.", "> HSE AI issues no permit and does not confirm fitness to proceed. The points above need confirmation by the responsible person.")}${docFooter(ctx, T(NAME, "HSE AI"))}`,
  );
  const totalGaps = Object.values(result).reduce((s, e) => s + e.gaps.length, 0);
  o.summary = T(`Rà soát hồ sơ HSE cho ${Object.keys(result).length} hoạt động khả dĩ: ${totalGaps} điểm cần người phụ trách xác nhận.`, `HSE document screening for ${Object.keys(result).length} candidate activities: ${totalGaps} point(s) for the responsible person to confirm.`);
  o.facts = { activities: result };
}

/** Documents required by the permit matrix for an activity, and which are valid on a given date. */
function docCheck(ctx: AgentContext, type: string, onDate: string) {
  const well = ctx.scope.well;
  const platform = ctx.scope.platform;
  const reqs = ctx.index("permit_matrix", "activity_type").all(type);
  const docs = ctx.caseRows("hse_documents");
  const needed = Array.from(new Set(reqs.flatMap((r) => r.data.required_documents as string[])));
  return {
    reqs,
    items: needed.map((dt) => {
      const candidates = docs.filter((d) => normKey(d.data.doc_type) === normKey(dt) && docApplies(d, type, platform, well, ctx.scope.ambiguousWell));
      const valid = candidates.find((d) => validOn(d, onDate));
      const pick = valid ?? candidates[0];
      const status = valid
        ? `còn hiệu lực tới ${valid.data.valid_to ?? "không thời hạn"}`
        : !pick
          ? "không tìm thấy"
          : String(pick.data.status).toLowerCase() !== "approved"
            ? `trạng thái "${pick.data.status}"`
            : pick.data.valid_from && String(pick.data.valid_from) > onDate
              ? `chỉ hiệu lực từ ${pick.data.valid_from} (sau ngày thực hiện ${onDate})`
              : `hết hiệu lực ${pick.data.valid_to} (trước ngày thực hiện ${onDate})`;
      return { docType: dt, ok: !!valid, status, row: pick ?? null };
    }),
  };
}

/** Readiness at the planned execution date, on the approved scope only. AI never issues a PTW. */
function readiness(ctx: AgentContext): void {
  const o = ctx.o;
  if (ctx.feedback) o.warn(`Phản hồi của người duyệt (${ctx.feedback.actor}): "${ctx.feedback.comment}" — đã xem xét khi chạy lại.`);
  const prop = ctx.up("ops.proposal")!;
  const acts = (prop.output.facts.activities as Array<{ type: string; name: string }>) ?? [];
  o.ev(`Phạm vi đã chốt: ${prop.output.summary}`, { kind: "task_run", id: prop.runId });
  const log = ctx.up("log.plan");
  const scopeGate = ctx.db.prepare("SELECT d.id, d.decided_at FROM decisions d JOIN tasks t ON t.id = d.task_id WHERE t.workflow_id = ? AND t.key = 'gate.technical' AND d.decision = 'approve' ORDER BY d.id DESC LIMIT 1").get(ctx.workflow.id);
  const base = scopeGate ? businessDate(String(scopeGate.decided_at)) : todayIso();
  const planned = ((log?.output.facts.mobilizationDate as string | null) ?? null) || addDays(base > todayIso() ? base : todayIso(), ctx.cfg.logistics.leadDays);
  const evDate = log
    ? o.ev(`Ngày thực hiện dự kiến ${planned} (theo kế hoạch hậu cần)`, { kind: "task_run", id: log.runId })
    : o.ev(`Ngày thực hiện dự kiến ${planned} (ngày duyệt phạm vi/hôm nay + ${ctx.cfg.logistics.leadDays} ngày, không cần vận chuyển)`, scopeGate ? { kind: "decision", id: num(scopeGate.id) } : { kind: "task_run", id: prop.runId });

  const rows: Array<[string, string, string]> = [];
  /** Documents relied on — re-checked against the register at the moment of the readiness decision */
  const usedDocs: Array<{ docId: string; docType: string; activity: string }> = [];
  let allValid = true;
  for (const a of acts) {
    const chk = docCheck(ctx, a.type, planned);
    if (!chk.reqs.length) {
      rows.push([a.name, "—", "chưa có quy định trong ma trận giấy phép"]);
      allValid = false;
      o.need({ description: `${a.name}: ma trận giấy phép chưa có quy định — không xác định được hồ sơ cần`, datasetType: "permit_matrix", blocking: true, owner: "HSE" });
      continue;
    }
    for (const it of chk.items) {
      rows.push([a.name, it.docType, it.status]);
      if (it.ok && it.row) usedDocs.push({ docId: String(it.row.data.doc_id), docType: it.docType, activity: a.type });
      const ev = it.row ? o.ev(`${a.name} · ${it.docType}: ${it.row.data.doc_id} — ${it.status}`, rowRef(it.row)) : o.ev(`${a.name} · ${it.docType}: không tìm thấy`, rowRef(chk.reqs[0]));
      if (!it.ok) {
        allValid = false;
        o.conclude(`${a.name}: ${it.docType} ${it.status} — chưa đủ điều kiện thực hiện ngày ${planned}.`, "check", [ev, evDate]);
        o.need({ description: `${a.name}: ${it.docType} ${it.status} — cần gia hạn/bổ sung trước ngày thực hiện ${planned}`, datasetType: "hse_documents", blocking: true, owner: "HSE (người phụ trách hồ sơ)" });
      }
    }
  }
  if (allValid) o.conclude(`Hồ sơ HSE yêu cầu cho ${acts.length} hoạt động đều còn hiệu lực tại ngày thực hiện ${planned} (mức sổ đăng ký tài liệu).`, "check", [evDate]);

  // Transport, weather and data freshness at the planned date — checked from DATA, against the plan in force
  const logF = (log?.output.facts ?? {}) as { voyage?: string | null; flight?: string | null; conditions?: string[]; holds?: Array<{ type: string; key: string }> };
  ctx.trackLedger(); // conditions below read the reservation ledger
  const transport = log ? demandsFromFacts("log.plan", log.runId, log.output.facts).filter((d) => d.type !== "budget") : [];
  const cov = transport.map((d) => ({ d, c: coverage(ctx.db, ctx.workflow.id, d) }));
  const standing = cov.filter(({ c }) => ["confirmed", "held", "amendment_pending"].includes(c.state));
  const broken = cov.filter((x) => !standing.includes(x));
  const unconfirmed = cov.filter(({ c }) => c.state !== "confirmed");
  const limits = ctx.index("logistics_limits", "parameter");
  const lim = (p: string): number | null => {
    const v = limits.get(p)?.data.value;
    return v === undefined || v === null || v === "" ? null : Number(v);
  };
  const needsVessel = transport.some((d) => d.type === "vessel_deck");
  const needsFlight = transport.some((d) => d.type === "flight_seats");
  const maxHs = needsVessel ? lim("max_hs_vessel_m") : null;
  const maxWind = needsFlight ? lim("max_wind_heli_kn") : null;
  const wx = ctx.caseRows("weather_forecast").find((w) => w.data.forecast_date === planned);
  const hs = wx ? Number(wx.data.hs_m) : null;
  const wind = wx ? Number(wx.data.wind_kn) : null;
  const weatherOk = !!wx && (maxHs === null || hs === null || hs <= maxHs) && (maxWind === null || wind === null || wind <= maxWind);
  const snap = ctx.snapshot;
  const C = (code: string, label: string, met: boolean, kind: "check" | "confirm", detail?: string): GateCondition => {
    const roles = ctx.cfg.policy.nonWaivable.includes(code) ? [] : (ctx.cfg.policy.waiverRoles[code] ?? []);
    return { code, label, met, kind, waivable: kind === "check" && roles.length > 0, waiverRoles: roles, detail };
  };
  const conditions: GateCondition[] = [
    C("hse_valid_at_execution", `Hồ sơ HSE theo ma trận còn hiệu lực tại ngày thực hiện ${planned}`, allValid, "check", allValid ? undefined : "Xem danh sách hồ sơ cần gia hạn/bổ sung"),
    C("ptw_by_authority", "Giấy phép công việc (PTW) do người có thẩm quyền cấp theo quy trình của giàn — hệ thống KHÔNG cấp phép", false, "confirm"),
    C("crew_competence", "Danh sách & chứng chỉ nhân sự thực hiện đã được kiểm tra (hệ thống chưa có dữ liệu chứng chỉ)", false, "confirm"),
  ];
  if (log && transport.length) {
    const desc = (x: (typeof cov)[number]) => `${x.d.key} ${x.d.qty} ${x.d.unit}: ${x.c.state === "confirmed" ? `xác nhận ${x.c.row?.external_ref}` : x.c.state === "amendment_pending" ? "bản điều chỉnh chưa xác nhận" : x.c.state === "held" ? "chỉ giữ nội bộ" : x.c.state}`;
    // Data checks (the ledger), not checkboxes: a person cannot tick these into being
    conditions.push(C("transport_holds_valid", "Nguồn lực tàu/bay của kế hoạch hiện hành còn giữ được (không hủy/hết hạn/thiếu)", !broken.length, "check", broken.length ? broken.map(desc).join("; ") : undefined));
    conditions.push(C("transport_booked", `Chỗ tàu/bay của kế hoạch hiện hành (${transport.map((d) => d.key).join(", ")}) đã được bên vận hành xác nhận đặt`, !unconfirmed.length, "check", cov.map(desc).join("; ")));
    conditions.push(
      C(
        "weather_in_limits",
        `Dự báo thời tiết ngày ${planned} có và trong giới hạn vận chuyển${wx ? ` (Hs ${hs} m${maxHs !== null ? ` ≤ ${maxHs}` : ""}, gió ${wind} kn${maxWind !== null ? ` ≤ ${maxWind}` : ""})` : ""}`,
        weatherOk,
        "check",
        !wx ? "Chưa có dự báo cho ngày thực hiện" : weatherOk ? undefined : "Vượt giới hạn — dời ngày hoặc đổi phương án",
      ),
    );
    // What only a person can attest stays a confirmation
    conditions.push(C("weather_reviewed", "Đầu mối offshore đã xem dự báo mới nhất sát ngày huy động", false, "confirm"));
    for (const c of (logF.conditions ?? []).filter((x) => !/xác nhận đặt chỗ|confirms the vessel\/flight booking/i.test(x))) conditions.push(C(`log:${c.slice(0, 40)}`, c, false, "confirm"));
  }
  if (log && !transport.length && (logF.voyage || logF.flight)) {
    // Plan made before the reservation ledger existed: transport cannot be verified from data
    const keys = [logF.voyage, logF.flight].filter(Boolean).join(", ");
    conditions.push(C("transport_booked", `Chỗ tàu/bay (${keys}) đã được bên vận hành xác nhận đặt`, false, "check", `Kế hoạch hậu cần lập trước khi có sổ giữ chỗ — không có giữ chỗ/booking cho ${keys}. Chọn "Yêu cầu bổ sung → log.plan" để lập lại kế hoạch và giữ chỗ.`));
  }
  conditions.push(C("data_fresh", `Dữ liệu sản xuất đủ mới (mốc ${snap?.evaluationDate ?? "—"}, ${snap?.dataAgeDays ?? "?"} ngày)`, !snap?.stale, "check", snap?.stale ? "Cập nhật DPR trước khi huy động" : undefined));
  for (const c of conditions.filter((x) => x.kind === "check")) o.conclude(`Điều kiện sẵn sàng "${c.label}": ${c.met ? "đạt" : "CHƯA ĐẠT"}.`, "check", [evDate]);
  o.assume("HSE AI không cấp PTW, không thay OIM/người có thẩm quyền; các mục 'xác nhận' phải do người duyệt tự kiểm tra và xác nhận.");

  const doc = ctx.saveDoc(
    "readiness-check",
    `Kiểm tra sẵn sàng — ${ctx.workflow.case_no}`,
    "readiness_check",
    `# Kiểm tra sẵn sàng thực hiện — ${ctx.workflow.case_no} (rev ${ctx.revision})\n\n**Ngày dự kiến:** ${planned}\n\n## Hồ sơ HSE trên phạm vi đã chốt\n\n${rows.length ? mdTable(["Hoạt động", "Hồ sơ", "Tình trạng tại ngày thực hiện"], rows) : "_Không có_"}\n\n## Điều kiện\n\n${mdTable(["Điều kiện", "Loại", "Kết quả"], conditions.map((c) => [c.label, c.kind === "confirm" ? "Người duyệt xác nhận" : "Kiểm tra dữ liệu", c.kind === "confirm" ? "Chờ xác nhận" : c.met ? "Đạt" : "**Chưa đạt**"]))}\n\n> Không cấp giấy phép. Không thay thế OIM/người có thẩm quyền.${docFooter(ctx, NAME)}`,
  );
  o.summary = allValid
    ? `Sẵn sàng tại ${planned}: hồ sơ HSE còn hiệu lực; ${conditions.filter((c) => c.kind === "confirm").length} mục cần đầu mối offshore xác nhận.`
    : `CHƯA sẵn sàng tại ${planned}: hồ sơ HSE cần gia hạn/bổ sung — đã giao HSE.`;
  o.next("OIM / đầu mối offshore xem điều kiện và xác nhận sẵn sàng (PTW theo quy trình của giàn)");
  o.facts = {
    plannedDate: planned,
    conditions,
    readinessDocId: doc.docId,
    activities: acts.map((a) => a.type),
    documents: usedDocs,
    weather: { required: !!log && transport.length > 0, maxHs, maxWind },
  };
}

export const hseAgent: AgentDef = {
  id: "hse_agent",
  name: NAME,
  room: "zone_hse",
  run(ctx) {
    return ctx.task.key === "hse.readiness" ? readiness(ctx) : screening(ctx);
  },
};
