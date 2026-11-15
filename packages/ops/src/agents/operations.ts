import { roleText } from "../lang";
import type { AgentContext, AgentDef } from "./kit";
import { mdTable, docFooter, rowRef, addDays } from "./kit";
import { compareWindows, windowDates, type DetectionFacts, type WindowCompare } from "./metrics";
import { fmt, usd } from "../calc";
import { nowIso, num } from "../db";
import { todayIso } from "../clock";
import type { GateCondition } from "../types";
import type { WellDetection } from "../detection";

const NAME = "Operations AI (Điều hành khai thác)";
const NAME_EN = "Operations AI";

interface ProposedActivity {
  type: string;
  name: string;
  workType: string;
  addresses: string[];
  source: string; // which branch proposed it
  hseGaps: string[];
}

export interface Acceptance {
  activity: string;
  activityName: string;
  workType: string;
  criterion: string;
}

const CLASS_LABEL_EN: Record<string, string> = {
  data_gap: "Data supplement (not enough basis to assess)",
  investigate: "Engineering / maintenance / HSE assessment needed",
  no_action: "No action needed (latest assessment below threshold)",
};
const CLASS_LABEL: Record<string, string> = {
  data_gap: "Bổ sung dữ liệu (chưa đủ cơ sở đánh giá)",
  investigate: "Cần đánh giá kỹ thuật/bảo dưỡng/HSE",
  no_action: "Không cần hành động (đánh giá mới nhất không vượt ngưỡng)",
};

// ───────────────────────── 1. Intake, data checks, classification ─────────────────────────

/** English intake dossier (content.language = en): same figures and structure as the Vietnamese one. */
function anomalyDossierEn(
  ctx: AgentContext,
  a: { key: string; w: WellDetection; snap: AgentContext["snapshot"]; det: DetectionFacts; classification: string; metrics: Record<string, WindowCompare>; revised: boolean; initial: { asOf: string; well: WellDetection } },
): string {
  const { key, w, snap, det, classification, metrics, revised, initial } = a;
  return `# Intake dossier ${ctx.workflow.case_no} (rev ${ctx.revision})\n\n**Well:** ${key} · **Evaluation date:** ${w.asOf ?? "—"} · **Classification:** ${CLASS_LABEL_EN[classification]}\n\n## Data checks\n\n- Compared quantity: ${w.rateLabel}\n- Data period: ${snap?.reportPeriod.from ?? "—"} → ${snap?.reportPeriod.to ?? "—"} · data age ${snap?.dataAgeDays ?? "?"} days${snap?.stale ? " (**stale**)" : ""}\n- Data: ${snap?.simulated ? "**SIMULATED**" : "real"} · Rules: ${snap?.rules ?? "—"}\n${w.gaps.length ? `- **Missing:**\n${w.gaps.map((g) => `  - ${g.description}`).join("\n")}` : "- Ready for the threshold check"}\n\n## Threshold check\n\nThreshold **${det.thresholdPct}%** for **${det.consecutiveDays}** consecutive days. Baseline: ${w.baseline ? `**${fmt(w.baseline.value)} bbl/d** (${w.baseline.mode === "rolling" ? `${w.baseline.rowIds.length}-day average ${w.baseline.from} → ${w.baseline.to}` : "configured"})` : "_none_"}.\n\n${mdTable(
    ["Date", "Oil (bbl/d)", "Uptime (h)", "Compared quantity", "Drop %", "Raw drop %"],
    w.days.map((d) => [d.date, fmt(d.oilRaw), d.uptime, fmt(d.oilNorm), fmt(d.dropPct, 1), fmt(d.rawDropPct, 1)]),
  )}\n\n${revised ? `## Initial detection vs latest assessment\n\n- Initial (to ${initial.asOf}): minimum drop ${fmt(initial.well?.minDropPct, 1)}%\n- Latest (rev ${ctx.revision}, to ${w.asOf}): ${w.evaluated ? `minimum drop ${fmt(w.minDropPct, 1)}%` : "cannot be evaluated"}\n\n` : ""}## Supporting indicators (observed, no causal conclusion)\n\n${Object.keys(metrics).length ? mdTable(
    ["Indicator", "Baseline", "Current", "Change"],
    Object.values(metrics).map((c) => [c.name + ` (${c.unit})`, fmt(c.base, 2), fmt(c.now, 2), c.metric === "water_cut" ? `${fmt(c.changeAbs, 1)} pp` : `${fmt(c.changePct, 1)}%`]),
  ) : "_Not compared (not enough data)_"}\n\n## Next steps\n\n${classification === "investigate" ? "Production Engineering, Maintenance & Reliability and HSE run preliminary assessments in parallel." : classification === "data_gap" ? "Supply the data listed above; the case re-assesses itself when it arrives. No intervention opened." : "Submit to the Head of Production Engineering to confirm the no-action conclusion."}${docFooter(ctx, NAME_EN)}`;
}

function anomaly(ctx: AgentContext): void {
  const o = ctx.o;
  const T = ctx.L;
  const EN = T("vi", "en") === "en";
  const CL = EN ? CLASS_LABEL_EN : CLASS_LABEL;
  const det = ctx.detection() as unknown as DetectionFacts & { well: WellDetection };
  const initial = ctx.initialDetection() as unknown as { asOf: string; well: WellDetection };
  const w = det.well;
  const snap = ctx.snapshot;
  const key = `${ctx.scope.platform}/${ctx.scope.well}`;
  const rows = ctx.caseRows("dpr").sort((a, b) => String(a.data.report_date).localeCompare(String(b.data.report_date)));

  const evImport = o.ev(T(`File DPR làm căn cứ (import #${det.dprImportId})`, `DPR file used (import #${det.dprImportId})`), { kind: "import", id: det.dprImportId });

  // ── Data checks (facts about the data, not about causes) ──
  o.conclude(T(`Phạm vi case: ${key}${snap?.asset ? ` (asset ${snap.asset})` : ""}; ${rows.length} dòng DPR đang dùng${snap ? `, kỳ ${snap.reportPeriod.from} → ${snap.reportPeriod.to}` : ""}.`, `Case scope: ${key}${snap?.asset ? ` (asset ${snap.asset})` : ""}; ${rows.length} DPR rows in use${snap ? `, period ${snap.reportPeriod.from} → ${snap.reportPeriod.to}` : ""}.`), "check", [evImport]);
  if (ctx.scope.ambiguousWell) {
    o.warn(T(`Tên giếng ${ctx.scope.well} xuất hiện trên nhiều giàn — chỉ dùng dữ liệu có ghi rõ giàn ${ctx.scope.platform}; dòng không ghi giàn bị loại khỏi case.`, `Well name ${ctx.scope.well} exists on several platforms — only rows that state platform ${ctx.scope.platform} are used; rows without a platform are excluded.`));
  }
  const ruleRef = w.summaryCalcId ? { kind: "calc" as const, id: w.summaryCalcId } : { kind: "import" as const, id: det.dprImportId };
  const evRate = o.ev(T(`Định nghĩa oil_rate: ${w.rateLabel} (rate_basis = ${w.rateBasis})`, `oil_rate definition: ${w.rateLabel} (rate_basis = ${w.rateBasis})`), ruleRef);
  o.conclude(T(`Đại lượng so sánh: ${w.rateLabel}.`, `Compared quantity: ${w.rateLabel}.`), "check", [evRate]);
  if (snap) {
    const ev = o.ev(T(`Mốc đánh giá ${snap.evaluationDate ?? "—"}, tuổi dữ liệu ${snap.dataAgeDays ?? "?"} ngày (snapshot rev ${snap.revision}, quy tắc ${snap.rules})`, `Evaluation date ${snap.evaluationDate ?? "—"}, data age ${snap.dataAgeDays ?? "?"} days (snapshot rev ${snap.revision}, rules ${snap.rules})`), { kind: "import", id: det.dprImportId });
    if (snap.stale) {
      o.warn(T(`Dữ liệu DPR mới nhất (${snap.evaluationDate}) đã cũ ${snap.dataAgeDays} ngày so với hôm nay — kết luận phản ánh thời điểm ${snap.evaluationDate}, không phải hiện tại.`, `Latest DPR data (${snap.evaluationDate}) is ${snap.dataAgeDays} days old — conclusions reflect ${snap.evaluationDate}, not today.`));
      o.need({ description: T(`DPR ${key} chưa cập nhật sau ${snap.evaluationDate} (cũ ${snap.dataAgeDays} ngày)`, `DPR ${key} not updated after ${snap.evaluationDate} (${snap.dataAgeDays} days old)`), datasetType: "dpr", blocking: false, owner: T("Operations (giàn)", "Operations (platform)") });
    }
    o.conclude(T(`Mốc đánh giá ${snap.evaluationDate}; dữ liệu ${snap.simulated ? "GIẢ LẬP" : "thực"}; quy tắc ${snap.rules}.`, `Evaluation date ${snap.evaluationDate}; ${snap.simulated ? "SIMULATED" : "real"} data; rules ${snap.rules}.`), "check", [ev]);
  }
  const rejectedFuture = ctx.db
    .prepare("SELECT COUNT(*) c FROM data_rows WHERE dataset_type = 'dpr' AND status = 'rejected' AND issues_json LIKE '%future_date%' AND row_key LIKE ?")
    .get(`%|${ctx.scope.platform}|${ctx.scope.well}`);
  if (num(rejectedFuture?.c) > 0) o.warn(T(`${num(rejectedFuture?.c)} dòng DPR của ${key} ghi ngày tương lai đã bị loại khi nhập.`, `${num(rejectedFuture?.c)} DPR rows of ${key} dated in the future were rejected at import.`));
  const flagged = rows.filter((r) => r.issues.some((i) => i.severity !== "info" || i.code === "unit_converted"));
  if (flagged.length) {
    const evs = flagged.map((r) => o.ev(`${r.data.report_date}: ${r.issues.map((i) => i.message).join("; ")}`, rowRef(r)));
    o.conclude(T(`${flagged.length} dòng DPR của ${key} có ghi nhận chất lượng dữ liệu (quy đổi đơn vị/thiếu giá trị/xung đột) — đã xử lý theo quy tắc nhập liệu.`, `${flagged.length} DPR rows of ${key} have data-quality notes (unit conversion / missing value / conflict) — handled by the import rules.`), "check", evs);
  }

  // ── Classification ──
  let classification: "data_gap" | "investigate" | "no_action";
  if (!w.evaluated) {
    classification = "data_gap";
    for (const g of w.gaps.length ? w.gaps : [{ description: w.reason ?? T("Chưa đánh giá được", "Cannot be evaluated"), datasetType: "dpr" }]) {
      o.need({ description: g.description, datasetType: g.datasetType === "config" ? undefined : g.datasetType, blocking: true, owner: g.datasetType === "config" ? T("Quản trị cấu hình", "Configuration admin") : T("Operations (giàn) / Kỹ thuật khai thác", "Operations (platform) / Production Engineering") });
    }
    const evs = w.days.map((d) => o.ev(T(`${d.date}: ${fmt(d.oilRaw)} bbl/d thô, uptime ${d.uptime}h${d.rawDropPct !== null ? `, giảm thô ${fmt(d.rawDropPct, 1)}%` : ""}`, `${d.date}: ${fmt(d.oilRaw)} bbl/d raw, uptime ${d.uptime} h${d.rawDropPct !== null ? `, raw drop ${fmt(d.rawDropPct, 1)}%` : ""}`), d.calcId ? { kind: "calc", id: d.calcId } : rowRef({ id: d.rowId })));
    o.conclude(
      w.suspect
        ? T(`Số liệu thô cho thấy suy giảm ≥ ${det.thresholdPct}% nhưng CHƯA đủ cơ sở đánh giá (${w.reason}). Case mở để bổ sung dữ liệu — không mở can thiệp.`, `Raw figures show a drop ≥ ${det.thresholdPct}% but there is NOT enough basis to assess (${w.reason}). Case opened to supplement data — no intervention opened.`)
        : T(`Chưa đánh giá được ngưỡng suy giảm: ${w.reason}.`, `The decline threshold cannot be evaluated: ${w.reason}.`),
      "check",
      evs.length ? evs : [evImport],
    );
  } else if (w.anomaly) {
    classification = "investigate";
  } else {
    classification = "no_action";
    const evs = w.days.map((d) => o.ev(T(`${d.date}: giảm ${fmt(d.dropPct, 1)}%`, `${d.date}: drop ${fmt(d.dropPct, 1)}%`), d.calcId ? { kind: "calc", id: d.calcId } : rowRef({ id: d.rowId })));
    o.conclude(T(`Đánh giá mới nhất (đến ${w.asOf}) không còn vượt ngưỡng ${det.thresholdPct}% trong ${det.consecutiveDays} ngày${w.explainedByDowntime ? " — mức giảm thô do giờ chạy thấp" : ""}.`, `Latest assessment (to ${w.asOf}) no longer exceeds ${det.thresholdPct}% over ${det.consecutiveDays} days${w.explainedByDowntime ? " — the raw drop is due to low running hours" : ""}.`), "calculated", evs);
  }

  const drops = w.days.map((d) => d.dropPct ?? 0);
  const metrics: Record<string, WindowCompare> = {};
  if (w.evaluated && w.baseline) {
    const evBase = o.ev(
      T(`Baseline ${key}: ${fmt(w.baseline.value)} bbl/d (${w.baseline.mode === "rolling" ? `TB ${w.baseline.rowIds.length} ngày ${w.baseline.from}→${w.baseline.to}` : "cấu hình cố định"})`, `Baseline ${key}: ${fmt(w.baseline.value)} bbl/d (${w.baseline.mode === "rolling" ? `${w.baseline.rowIds.length}-day average ${w.baseline.from}→${w.baseline.to}` : "fixed configuration"})`),
      { kind: "calc", id: w.baseline.calcId },
    );
    const dayEvs = w.days.map((d) => o.ev(T(`${d.date}: ${fmt(d.oilRaw)} bbl/d trong ${d.uptime}h → ${fmt(d.oilNorm)} bbl/d so sánh → giảm ${fmt(d.dropPct, 1)}%`, `${d.date}: ${fmt(d.oilRaw)} bbl/d in ${d.uptime} h → ${fmt(d.oilNorm)} bbl/d compared → drop ${fmt(d.dropPct, 1)}%`), d.calcId ? { kind: "calc", id: d.calcId } : rowRef({ id: d.rowId })));
    const evRule = o.ev(T(`Quy tắc ngưỡng: giảm ≥ ${det.thresholdPct}% trong ${det.consecutiveDays} ngày liên tiếp`, `Threshold rule: drop ≥ ${det.thresholdPct}% for ${det.consecutiveDays} consecutive days`), ruleRef);
    if (w.anomaly) {
      o.conclude(
        T(`Sản lượng dầu (${w.rateLabel}) của ${key} thấp hơn baseline ${fmt(Math.min(...drops), 1)}–${fmt(Math.max(...drops), 1)}% trong ${w.days.length} ngày liên tiếp đến ${w.asOf}, vượt ngưỡng ${det.thresholdPct}%. Đây là kết quả so ngưỡng, chưa phải kết luận nguyên nhân.`, `Oil rate (${w.rateLabel}) of ${key} is ${fmt(Math.min(...drops), 1)}–${fmt(Math.max(...drops), 1)}% below baseline for ${w.days.length} consecutive days to ${w.asOf}, above the ${det.thresholdPct}% threshold. This is a threshold result, not a conclusion about the cause.`),
        "calculated",
        [evBase, ...dayEvs, evRule, evImport],
      );
    }
    // Supporting metrics — observed changes, no causal claims at this step
    const { base, evalD } = windowDates(det);
    for (const m of ["water_cut", "gl_inj", "thp", "gas_rate"] as const) {
      const c = compareWindows(ctx, w.well, rows, base, evalD, m);
      if (!c) {
        o.need({ description: T(`Không đủ dữ liệu ${m} trong DPR của ${key} để so sánh baseline/hiện tại`, `Not enough ${m} data in the DPR of ${key} to compare baseline and current`), datasetType: "dpr", blocking: false, owner: "Operations" });
        continue;
      }
      metrics[m] = c;
      o.conclude(`${c.name}: ${fmt(c.base, 2)} → ${fmt(c.now, 2)} ${c.unit} (${m === "water_cut" ? `${c.changeAbs >= 0 ? "+" : ""}${fmt(c.changeAbs, 1)} ${T("điểm %", "pp")}` : `${c.changePct >= 0 ? "+" : ""}${fmt(c.changePct, 1)}%`}).`, "observed", [c.evId]);
    }
  }

  // Initial detection vs latest assessment — both kept, never merged
  const revised = ctx.revision > 1 && initial.asOf !== w.asOf;
  if (revised) {
    o.conclude(T(`Phát hiện ban đầu (đến ${initial.asOf}): giảm tối thiểu ${fmt(initial.well?.minDropPct, 1)}%. Đánh giá mới nhất (rev ${ctx.revision}, đến ${w.asOf}): ${w.evaluated ? `giảm tối thiểu ${fmt(w.minDropPct, 1)}%` : "chưa đánh giá được"}.`, `Initial detection (to ${initial.asOf}): minimum drop ${fmt(initial.well?.minDropPct, 1)}%. Latest assessment (rev ${ctx.revision}, to ${w.asOf}): ${w.evaluated ? `minimum drop ${fmt(w.minDropPct, 1)}%` : "cannot be evaluated"}.`), "check", [evImport]);
  }

  const recent = rows.filter((r) => String(r.data.report_date) >= (w.baseline?.from ?? "") && (r.data.notes || (r.data.downtime_h as number) > 0));
  if (recent.length) {
    const evs = recent.map((r) => o.ev(`${r.data.report_date}: downtime ${r.data.downtime_h ?? "—"}h${r.data.notes ? ` — "${r.data.notes}"` : ""}`, rowRef(r)));
    o.conclude(T(`Ghi chú vận hành/downtime trong giai đoạn quan sát: ${recent.length} ngày (xem bằng chứng).`, `Operating / downtime notes in the observed period: ${recent.length} day(s) (see evidence).`), "observed", evs);
  }

  const master = ctx.caseRows("well_master")[0];
  const liftType = master ? (master.data.lift_type as string) : null;
  if (master) o.ev(T(`Danh mục giếng: ${key} — ${liftType}, phân bổ: ${master.data.allocation_method ?? "?"}`, `Well master: ${key} — ${liftType}, allocation: ${master.data.allocation_method ?? "?"}`), rowRef(master));
  else o.need({ description: T(`Không có ${key} trong danh mục giếng (well_master) — chưa biết phương pháp khai thác`, `${key} is not in the well master — lift method unknown`), datasetType: "well_master", blocking: false, owner: "Operations" });

  const doc = ctx.saveDoc(
    "anomaly-dossier",
    T(`Hồ sơ tiếp nhận ${ctx.workflow.case_no} — ${key}`, `Intake dossier ${ctx.workflow.case_no} — ${key}`),
    "anomaly_dossier",
    EN ? anomalyDossierEn(ctx, { key, w, snap, det, classification, metrics, revised, initial }) : `# Hồ sơ tiếp nhận ${ctx.workflow.case_no} (rev ${ctx.revision})\n\n**Giếng:** ${key} · **Mốc đánh giá:** ${w.asOf ?? "—"} · **Phân loại:** ${CLASS_LABEL[classification]}\n\n## Kiểm tra dữ liệu\n\n- Đại lượng so sánh: ${w.rateLabel}\n- Kỳ dữ liệu: ${snap?.reportPeriod.from ?? "—"} → ${snap?.reportPeriod.to ?? "—"} · tuổi dữ liệu ${snap?.dataAgeDays ?? "?"} ngày${snap?.stale ? " (**cũ**)" : ""}\n- Dữ liệu: ${snap?.simulated ? "**GIẢ LẬP**" : "thực"} · Quy tắc: ${snap?.rules ?? "—"}\n${w.gaps.length ? `- **Còn thiếu:**\n${w.gaps.map((g) => `  - ${g.description}`).join("\n")}` : "- Đủ điều kiện so ngưỡng"}\n\n## Phép so ngưỡng\n\nNgưỡng **${det.thresholdPct}%** trong **${det.consecutiveDays}** ngày liên tiếp. Baseline: ${w.baseline ? `**${fmt(w.baseline.value)} bbl/d** (${w.baseline.mode === "rolling" ? `TB ${w.baseline.rowIds.length} ngày ${w.baseline.from} → ${w.baseline.to}` : "cấu hình"})` : "_chưa có_"}.\n\n${mdTable(
      ["Ngày", "Dầu (bbl/d)", "Uptime (h)", "Đại lượng so sánh", "Giảm %", "Giảm thô %"],
      w.days.map((d) => [d.date, fmt(d.oilRaw), d.uptime, fmt(d.oilNorm), fmt(d.dropPct, 1), fmt(d.rawDropPct, 1)]),
    )}\n\n${revised ? `## Phát hiện ban đầu vs đánh giá mới nhất\n\n- Ban đầu (đến ${initial.asOf}): giảm tối thiểu ${fmt(initial.well?.minDropPct, 1)}%\n- Mới nhất (rev ${ctx.revision}, đến ${w.asOf}): ${w.evaluated ? `giảm tối thiểu ${fmt(w.minDropPct, 1)}%` : "chưa đánh giá được"}\n\n` : ""}## Chỉ số đi kèm (quan sát, chưa kết luận nguyên nhân)\n\n${Object.keys(metrics).length ? mdTable(
      ["Chỉ số", "Baseline", "Hiện tại", "Thay đổi"],
      Object.values(metrics).map((c) => [c.name + ` (${c.unit})`, fmt(c.base, 2), fmt(c.now, 2), c.metric === "water_cut" ? `${fmt(c.changeAbs, 1)} điểm %` : `${fmt(c.changePct, 1)}%`]),
    ) : "_Chưa so sánh (chưa đủ dữ liệu)_"}\n\n## Bước tiếp theo\n\n${classification === "investigate" ? "Kỹ thuật khai thác, Bảo dưỡng & Độ tin cậy, HSE đánh giá sơ bộ song song." : classification === "data_gap" ? "Bổ sung dữ liệu theo danh mục trên; case tự đánh giá lại khi có dữ liệu. Không mở can thiệp." : "Trình Trưởng phòng Kỹ thuật khai thác xác nhận kết luận không cần hành động."}${docFooter(ctx, NAME)}`,
  );

  o.summary =
    classification === "investigate"
      ? T(`Tiếp nhận ${key}: giảm ${fmt(Math.min(...drops), 1)}–${fmt(Math.max(...drops), 1)}% so với baseline ${fmt(w.baseline?.value)} bbl/d; phân loại: cần đánh giá; chuyển 3 nhánh.`, `Intake ${key}: ${fmt(Math.min(...drops), 1)}–${fmt(Math.max(...drops), 1)}% below the baseline of ${fmt(w.baseline?.value)} bbl/d; classification: assessment needed; routed to 3 branches.`)
      : classification === "data_gap"
        ? T(`Tiếp nhận ${key}: chưa đủ cơ sở đánh giá (${w.gaps.length || 1} mục dữ liệu cần bổ sung) — nhánh bổ sung dữ liệu, không mở can thiệp.`, `Intake ${key}: not enough basis to assess (${w.gaps.length || 1} data item(s) to supplement) — data-supplement branch, no intervention opened.`)
        : T(`Tiếp nhận ${key}: đánh giá mới nhất không vượt ngưỡng — đề nghị kết luận không cần hành động.`, `Intake ${key}: latest assessment below threshold — proposes concluding with no action.`);
  if (classification === "investigate") {
    o.next(T("Kỹ thuật khai thác: đánh giá xu hướng, giả thuyết và dữ liệu còn thiếu", "Production Engineering: assess trends, hypotheses and missing data"));
    o.next(T("Bảo dưỡng & Độ tin cậy: đối chiếu WO, tình trạng thiết bị, vật tư", "Maintenance & Reliability: check work orders, equipment condition and spares"));
    o.next(T("HSE: rà soát sơ bộ hồ sơ cho các hoạt động khả dĩ (phục vụ lập kế hoạch)", "HSE: preliminary document screening for the candidate activities (for planning)"));
  } else if (classification === "data_gap") o.next(T("Đầu mối dữ liệu bổ sung các mục còn thiếu; hệ thống tự chạy lại khi nhập", "The data focal point supplies the missing items; the system re-runs on import"));
  o.facts = {
    classification,
    classificationLabel: CL[classification],
    well: w.well,
    platform: w.platform,
    wellKey: key,
    liftType,
    allocation: master?.data.allocation_method ?? null,
    asOf: w.asOf,
    baseline: w.baseline?.value ?? null,
    drops,
    metrics,
    dossierDocId: doc.docId,
    rateBasis: w.rateBasis,
    revision: ctx.revision,
  };
}

// ───────────────────────── 2. Option & branch selection ─────────────────────────

function proposal(ctx: AgentContext): void {
  const o = ctx.o;
  const T = ctx.L;
  const N = T(NAME, NAME_EN);
  const anomalyRun = ctx.up("ops.anomaly")!;
  const cls = anomalyRun.output.facts.classification as string;
  const evAnom = o.ev(T(`Tiếp nhận & phân loại: ${anomalyRun.output.summary}`, `Intake & classification: ${anomalyRun.output.summary}`), { kind: "task_run", id: anomalyRun.runId });
  const closure = ctx.cfg.closure;

  if (cls === "no_action") {
    o.conclude(T("Đánh giá mới nhất không vượt ngưỡng — đề xuất KHÔNG cần hành động; tiếp tục theo dõi DPR định kỳ.", "Latest assessment is below threshold — proposes NO action; keep monitoring the DPR."), "check", [evAnom]);
    const doc = ctx.saveDoc(
      "proposal",
      T(`Đề xuất kết luận — ${ctx.workflow.case_no}`, `Proposed conclusion — ${ctx.workflow.case_no}`),
      "proposal",
      T(
        `# Đề xuất kết luận — ${ctx.workflow.case_no} (rev ${ctx.revision})\n\n**Nhánh:** Không cần hành động\n\n${anomalyRun.output.summary}\n\nKhông phát sinh công việc, mua sắm hay huy động. Case đóng khi Trưởng phòng Kỹ thuật khai thác xác nhận.${docFooter(ctx, NAME)}`,
        `# Proposed conclusion — ${ctx.workflow.case_no} (rev ${ctx.revision})\n\n**Branch:** No action needed\n\n${anomalyRun.output.summary}\n\nNo work, purchase or mobilisation. The case closes when the Head of Production Engineering confirms.${docFooter(ctx, NAME_EN)}`,
      ),
    );
    o.summary = T("Nhánh: không cần hành động — trình xác nhận phạm vi rồi đóng case.", "Branch: no action — submitted for scope confirmation, then the case closes.");
    o.next(T("Trưởng phòng Kỹ thuật khai thác xác nhận kết luận (duyệt / trả lại)", "Head of Production Engineering confirms the conclusion (approve / return)"));
    o.facts = { branch: "no_action", activities: [], needsPurchase: false, needsTransport: false, acceptance: [], proposalDocId: doc.docId, conditions: [] };
    return;
  }

  const branches = ["eng.assessment", "mnt.review", "hse.screening"];
  const blocking: Array<{ branch: string; item: { description: string; datasetType?: string; owner?: string } }> = [];
  for (const key of branches) {
    const u = ctx.up(key);
    if (!u) {
      o.need({ description: T(`Chưa có kết quả nhánh ${key}`, `No result yet from branch ${key}`), blocking: true, owner: T("Hệ thống", "System") });
      continue;
    }
    o.ev(T(`Kết quả ${key} (run #${u.runId}, ${u.status}): ${u.output.summary}`, `Result of ${key} (run #${u.runId}, ${u.status}): ${u.output.summary}`), { kind: "task_run", id: u.runId });
    for (const m of u.output.missingData.filter((x) => x.blocking)) blocking.push({ branch: key, item: m });
  }

  if (blocking.length) {
    for (const b of blocking) o.need({ description: `[${b.branch}] ${b.item.description}`, datasetType: b.item.datasetType, blocking: true, owner: b.item.owner });
    ctx.saveDoc(
      "information-request",
      T(`Yêu cầu bổ sung dữ liệu — ${ctx.workflow.case_no}`, `Information request — ${ctx.workflow.case_no}`),
      "information_request",
      `${T(`# Yêu cầu bổ sung dữ liệu — ${ctx.workflow.case_no}\n\nChưa đủ cơ sở chọn phương án. Cần bổ sung:`, `# Information request — ${ctx.workflow.case_no}\n\nNot enough basis to choose an option. Needed:`)}\n\n${mdTable(
        T("Nhánh|Nội dung cần bổ sung|Loại dữ liệu|Đầu mối", "Branch|What is needed|Data type|Owner").split("|"),
        blocking.map((b) => [b.branch, b.item.description, b.item.datasetType ?? "—", b.item.owner ?? "—"]),
      )}\n\n${T("Khi dữ liệu được nhập (màn hình **Dữ liệu**), nhánh liên quan sẽ tự chạy lại.", "When the data is imported (**Data** screen), the related branch re-runs automatically.")}${docFooter(ctx, N)}`,
    );
    o.summary = T(`Chưa thể chọn phương án: ${blocking.length} mục dữ liệu bắt buộc còn thiếu — đã lập yêu cầu bổ sung.`, `Cannot choose an option yet: ${blocking.length} required data item(s) missing — information request issued.`);
    o.next(T("Nhập dữ liệu được yêu cầu; nhánh liên quan tự chạy lại, sau đó tổng hợp lại", "Import the requested data; the related branch re-runs, then this step consolidates again"));
    return;
  }

  const eng = ctx.up("eng.assessment")!.output.facts as { recommendedActivities?: ProposedActivity[]; optionalActivities?: ProposedActivity[]; hypotheses?: Array<{ code: string; title: string; status: string; statusCode?: string; dataNeeded?: string[] }> };
  const mnt = ctx.up("mnt.review")!.output.facts as { recommendedActivities?: ProposedActivity[]; materials?: Array<{ part_no: string; activity: string; qty: number; needsTransport: boolean; needsPurchase: boolean }> };
  const hse = ctx.up("hse.screening")!.output.facts as { activities?: Record<string, { gaps: string[] }> };

  const acts = new Map<string, ProposedActivity>();
  for (const a of [...(eng.recommendedActivities ?? []), ...(mnt.recommendedActivities ?? [])]) {
    if (!acts.has(a.type)) acts.set(a.type, { ...a, hseGaps: hse.activities?.[a.type]?.gaps ?? [] });
  }
  const hypo = new Map((eng.hypotheses ?? []).map((h) => [h.code, h]));
  const engRun = ctx.up("eng.assessment")!;
  const mntRun = ctx.up("mnt.review")!;
  const hseRun = ctx.up("hse.screening")!;

  for (const a of acts.values()) {
    const src = a.source === "maintenance" ? mntRun : engRun;
    const evSrc = o.ev(T(`Đề xuất từ ${a.source === "maintenance" ? "Bảo dưỡng" : "Kỹ thuật khai thác"}: ${a.name}`, `Proposed by ${a.source === "maintenance" ? "Maintenance" : "Production Engineering"}: ${a.name}`), { kind: "task_run", id: src.runId });
    const evHse = o.ev(T(`Rà soát HSE sơ bộ cho ${a.name}: ${a.hseGaps.length ? a.hseGaps.length + " điểm cần xác nhận (kiểm tra lại ở bước sẵn sàng)" : "không ghi nhận thiếu hồ sơ"}`, `Preliminary HSE screening for ${a.name}: ${a.hseGaps.length ? a.hseGaps.length + " point(s) to confirm (re-checked at readiness)" : "no missing documents noted"}`), { kind: "task_run", id: hseRun.runId });
    const targets = a.addresses.map((c) => hypo.get(c)?.title ?? c).join("; ");
    o.conclude(T(`Đề xuất ${a.name} (${a.workType}) để kiểm chứng: ${targets || "—"}.`, `Proposes ${a.name} (${a.workType}) to test: ${targets || "—"}.`), "check", [evSrc, evHse]);
  }

  // Branch: monitoring when nothing actionable; internal vs procurement from the catalog and stock
  const catalog = ctx.index("activity_catalog", "activity_type");
  const materials = mnt.materials ?? [];
  let needsPurchase = false;
  let needsTransport = false;
  for (const a of acts.values()) {
    const c = catalog.get(a.type);
    if (!c) continue;
    if (c.data.contract_category) needsPurchase = true;
    if (((c.data.crew_size as number | null) ?? 0) > 0 || ((c.data.equipment as string[] | null) ?? []).length) needsTransport = true;
    for (const m of ((c.data.materials as string[] | null) ?? [])) {
      const part = m.split(":")[0].trim();
      const mm = materials.find((x) => x.part_no === part);
      if (!mm || mm.needsPurchase) needsPurchase = true;
      if (!mm || mm.needsTransport || mm.needsPurchase) needsTransport = true;
    }
  }
  const branch = !acts.size ? "monitor" : needsPurchase ? "procurement" : "internal";
  const acceptance: Acceptance[] = [...acts.values()].map((a) => ({
    activity: a.type,
    activityName: a.name,
    workType: a.workType,
    criterion:
      a.workType === "maintenance"
        ? T(`Công việc hoàn tất có người xác nhận; sản lượng (${ctx.snapshot?.units.meaning ?? "đại lượng so sánh"}) phục hồi ≥ ${Math.round(closure.recoveryShareMin * 100)}% phần suy giảm, đo trên ≥ ${closure.observationDays} ngày DPR sau thực hiện`, `Work completed and confirmed by a person; output (${ctx.snapshot?.units.meaning ?? "compared quantity"}) recovers ≥ ${Math.round(closure.recoveryShareMin * 100)}% of the decline, measured over ≥ ${closure.observationDays} DPR days after execution`)
        : T(`Công việc hoàn tất có người xác nhận và có kết quả/dữ liệu chẩn đoán (${a.addresses.join(", ")}) đính kèm`, `Work completed and confirmed by a person, with the diagnostic results/data (${a.addresses.join(", ")}) attached`),
  }));
  const optional = eng.optionalActivities ?? [];
  if (optional.length) o.assume(T(`Chưa đưa vào phạm vi các hoạt động tùy chọn: ${optional.map((x) => x.name).join(", ")} — chỉ xem xét sau khi có kết quả chẩn đoán.`, `Optional activities not in scope yet: ${optional.map((x) => x.name).join(", ")} — considered only after the diagnostic results.`));
  const workTypes = new Set([...acts.values()].map((a) => a.workType));
  if ([...workTypes].every((t) => t === "diagnostic" || t === "maintenance")) {
    o.assume(T("Phạm vi đề xuất giới hạn ở thu thập dữ liệu/chẩn đoán và bảo dưỡng; không đề xuất phương án can thiệp xử lý giếng hay thông số thi công ở bước này.", "The proposed scope is limited to data gathering / diagnostics and maintenance; no well-intervention option or job parameters are proposed at this step."));
  }
  const allGaps = [...acts.values()].flatMap((a) => a.hseGaps.map((g) => `${a.name}: ${g}`));
  for (const g of allGaps) o.need({ description: T(`${g} (kiểm tra lại ở bước sẵn sàng trước huy động)`, `${g} (re-checked at readiness before mobilisation)`), blocking: false, owner: T("Người phụ trách HSE / OIM xác nhận", "HSE lead / OIM to confirm") });
  const nonBlocking = branches.flatMap((k) => ctx.up(k)!.output.missingData.filter((m) => !m.blocking).map((m) => `[${k}] ${m.description}`));
  const monitorData = (eng.hypotheses ?? []).flatMap((h) => ((h.statusCode ? h.statusCode !== "not_supported" : h.status !== "Dữ liệu hiện có không ủng hộ") ? h.dataNeeded ?? [] : []));

  const doc = ctx.saveDoc(
    "proposal",
    T(`Phương án & nhánh xử lý — ${ctx.workflow.case_no}`, `Option & handling branch — ${ctx.workflow.case_no}`),
    "proposal",
    T("vi", "en") === "en" ? proposalDocEn(ctx, { branch, needsTransport, eng, acts, acceptance, monitorData, materials, nonBlocking, assumptions: o.assumptions }) : `# Phương án & nhánh xử lý — ${ctx.workflow.case_no} (rev ${ctx.revision})\n\n**Nhánh đề xuất:** ${branch === "monitor" ? "Tiếp tục theo dõi" : branch === "procurement" ? "Cần khảo giá / mua sắm" : "Công việc nội bộ (không mua sắm)"} · cần vận chuyển: ${needsTransport ? "có" : "không"}\n\n## Giả thuyết (từ Kỹ thuật khai thác — chưa xác nhận)\n\n${mdTable(
      ["Mã", "Giả thuyết", "Trạng thái"],
      (eng.hypotheses ?? []).map((h) => [h.code, h.title, h.status]),
    )}\n\n## Hoạt động & tiêu chí nghiệm thu\n\n${acts.size ? mdTable(
      ["Hoạt động", "Loại", "Kiểm chứng", "Tiêu chí nghiệm thu", "HSE sơ bộ cần xác nhận"],
      [...acts.values()].map((a) => [a.name, a.workType, a.addresses.join(", "), acceptance.find((x) => x.activity === a.type)?.criterion ?? "—", a.hseGaps.length ? a.hseGaps.join("; ") : "—"]),
    ) : `_Không có hoạt động đủ cơ sở — đề xuất **tiếp tục theo dõi**${monitorData.length ? `; dữ liệu cần thu thập khi có dịp: ${[...new Set(monitorData)].join("; ")}` : ""}._`}\n\n## Vật tư (từ Bảo dưỡng)\n\n${materials.length ? mdTable(
      ["Mã vật tư", "Cho hoạt động", "SL", "Cần vận chuyển", "Cần mua"],
      materials.map((m) => [m.part_no, m.activity, m.qty, m.needsTransport ? "Có" : "Không", m.needsPurchase ? "Có" : "Không"]),
    ) : "_Không phát sinh._"}\n\n## Hạng mục còn mở (không chặn)\n\n${nonBlocking.length ? nonBlocking.map((x) => `- ${x}`).join("\n") : "- Không có"}\n\n## Giới hạn\n\n${o.assumptions.map((x) => `- ${x}`).join("\n") || "- Không có"}\n\nCần **phê duyệt phạm vi** trước khi khảo giá, lập kế hoạch hậu cần và ngân sách.${docFooter(ctx, NAME)}`,
  );

  o.summary = acts.size
    ? T(`Nhánh "${branch === "procurement" ? "cần khảo giá/mua sắm" : "công việc nội bộ"}": ${acts.size} hoạt động (${[...acts.values()].map((a) => a.name).join(", ")}); ${allGaps.length} điểm HSE sơ bộ. Trình phê duyệt phạm vi.`, `Branch "${branch === "procurement" ? "quotes / procurement needed" : "internal work"}": ${acts.size} activities (${[...acts.values()].map((a) => a.name).join(", ")}); ${allGaps.length} preliminary HSE point(s). Submitted for scope approval.`)
    : T("Không có hoạt động đủ cơ sở — đề xuất nhánh tiếp tục theo dõi; trình xác nhận.", "No activity has enough basis — proposes the keep-monitoring branch; submitted for confirmation.");
  o.next(T("Trưởng phòng Kỹ thuật khai thác quyết định phạm vi (duyệt / trả lại / từ chối)", "Head of Production Engineering decides the scope (approve / return / reject)"));
  o.facts = { branch, activities: [...acts.values()], optionalActivities: optional, hseGaps: allGaps, proposalDocId: doc.docId, materials, needsPurchase, needsTransport, acceptance, conditions: [] };
}

/** English option & branch document (content.language = en). */
function proposalDocEn(
  ctx: AgentContext,
  a: {
    branch: string;
    needsTransport: boolean;
    eng: { hypotheses?: Array<{ code: string; title: string; status: string }> };
    acts: Map<string, ProposedActivity>;
    acceptance: Acceptance[];
    monitorData: string[];
    materials: Array<{ part_no: string; activity: string; qty: number; needsTransport: boolean; needsPurchase: boolean }>;
    nonBlocking: string[];
    assumptions: string[];
  },
): string {
  const { branch, needsTransport, eng, acts, acceptance, monitorData, materials, nonBlocking, assumptions } = a;
  return `# Option & handling branch — ${ctx.workflow.case_no} (rev ${ctx.revision})\n\n**Proposed branch:** ${branch === "monitor" ? "Keep monitoring" : branch === "procurement" ? "Quotes / procurement needed" : "Internal work (no procurement)"} · transport needed: ${needsTransport ? "yes" : "no"}\n\n## Hypotheses (from Production Engineering — not confirmed)\n\n${mdTable(
    ["Code", "Hypothesis", "Status"],
    (eng.hypotheses ?? []).map((h) => [h.code, h.title, h.status]),
  )}\n\n## Activities & acceptance criteria\n\n${acts.size ? mdTable(
    ["Activity", "Type", "Tests", "Acceptance criterion", "Preliminary HSE to confirm"],
    [...acts.values()].map((x) => [x.name, x.workType, x.addresses.join(", "), acceptance.find((y) => y.activity === x.type)?.criterion ?? "—", x.hseGaps.length ? x.hseGaps.join("; ") : "—"]),
  ) : `_No activity has enough basis — proposes **keep monitoring**${monitorData.length ? `; data to collect when possible: ${[...new Set(monitorData)].join("; ")}` : ""}._`}\n\n## Materials (from Maintenance)\n\n${materials.length ? mdTable(
    ["Part no.", "For activity", "Qty", "Transport needed", "Purchase needed"],
    materials.map((m) => [m.part_no, m.activity, m.qty, m.needsTransport ? "Yes" : "No", m.needsPurchase ? "Yes" : "No"]),
  ) : "_None._"}\n\n## Open items (not blocking)\n\n${nonBlocking.length ? nonBlocking.map((x) => `- ${x}`).join("\n") : "- None"}\n\n## Limits\n\n${assumptions.map((x) => `- ${x}`).join("\n") || "- None"}\n\n**Scope approval** is required before quotes, logistics planning and budget.${docFooter(ctx, NAME_EN)}`;
}

// ───────────────────────── 3. Commitment package & conditions ─────────────────────────

function decisionPackage(ctx: AgentContext): void {
  const o = ctx.o;
  const T = ctx.L;
  const EN = T("vi", "en") === "en";
  const facts = (k: string) => (ctx.up(k)?.output.facts ?? {}) as Record<string, unknown>;
  const pol = ctx.cfg.policy;
  const anomalyRun = ctx.up("ops.anomaly")!;
  const proposalRun = ctx.up("ops.proposal")!;
  const proc = facts("proc.prep") as { lines?: Array<{ activity: string; item: string; qty: number; unit: string; unitPrice: number; amount: number; basis: string }>; documented?: number; estimated?: number; unpriced?: Array<{ activity: string; item: string; reason: string }>; quoteStatus?: Array<{ part: string; quotes: number; min: number; met: boolean }>; ceilingIssues?: string[]; skipped?: boolean };
  const log = facts("log.plan") as { mobilizationDate?: string | null; conditions?: string[]; voyage?: string | null; flight?: string | null; totalCost?: number; feasibility?: string; holdFailed?: string[]; skipped?: boolean };
  const fin = facts("fin.check") as { total?: number; documented?: number; estimated?: number; costComplete?: boolean; unpriced?: string[]; requiredApproverRole?: string | null; overBudget?: boolean; shortfalls?: string[]; afeMissing?: string[]; pscConclusion?: string; perCostCode?: Array<{ costCode: string; available: number; heldByOthers: number; request: number; after: number }> };

  const techTask = ctx.db.prepare("SELECT id, status FROM tasks WHERE workflow_id = ? AND key = 'gate.technical'").get(ctx.workflow.id);
  const techDecision = techTask ? ctx.db.prepare("SELECT * FROM decisions WHERE task_id = ? AND decision = 'approve' ORDER BY id DESC LIMIT 1").get(num(techTask.id)) : undefined;
  const evAnomaly = o.ev(T(`Tiếp nhận: ${anomalyRun.output.summary}`, `Intake: ${anomalyRun.output.summary}`), { kind: "task_run", id: anomalyRun.runId });
  const evProp = o.ev(T(`Phương án: ${proposalRun.output.summary}`, `Proposal: ${proposalRun.output.summary}`), { kind: "task_run", id: proposalRun.runId });
  const evTech = techDecision ? o.ev(T(`Phạm vi đã được duyệt bởi ${techDecision.actor_name} (${techDecision.actor_role}) lúc ${techDecision.decided_at}`, `Scope approved by ${techDecision.actor_name} (${roleText(ctx.cfg, String(techDecision.actor_role))}) at ${techDecision.decided_at}`), { kind: "decision", id: num(techDecision.id) }) : null;
  const evOf = (k: string) => {
    const u = ctx.up(k);
    return u ? o.ev(`${k}: ${u.output.summary}`, { kind: "task_run", id: u.runId }) : null;
  };
  const evProc = evOf("proc.prep");
  const evLog = evOf("log.plan");
  const evFin = evOf("fin.check");
  o.conclude(T(`Hồ sơ cam kết tổng hợp tiếp nhận, phạm vi đã duyệt, khảo giá, hậu cần và ngân sách (case rev ${ctx.revision}).`, `The commitment package combines intake, approved scope, quotes, logistics and budget (case rev ${ctx.revision}).`), "check", [evAnomaly, evProp, ...[evTech, evProc, evLog, evFin].filter((x): x is string => !!x)]);

  const W = (code: string) => (pol.nonWaivable.includes(code) ? [] : pol.waiverRoles[code] ?? []);
  const cond = (code: string, label: string, met: boolean, detail?: string, evidence?: Array<string | null>): GateCondition => ({
    code,
    label,
    met,
    kind: "check",
    waivable: !pol.nonWaivable.includes(code) && W(code).length > 0,
    waiverRoles: W(code),
    detail,
    evidence: (evidence ?? []).filter((x): x is string => !!x),
  });
  const conditions: GateCondition[] = [
    cond("scope_current", "Phạm vi đã được duyệt và còn hiệu lực ở revision hiện tại", techTask?.status === "done", techDecision ? T(`Quyết định #${techDecision.id}`, `Decision #${techDecision.id}`) : T("Chưa có quyết định phạm vi", "No scope decision yet"), [evTech]),
    cond("cost_complete", "Tổng chi phí đầy đủ (không có hạng mục thiếu giá/khối lượng)", fin.costComplete !== false, fin.unpriced?.length ? T(`Thiếu: ${fin.unpriced.join("; ")}`, `Missing: ${fin.unpriced.join("; ")}`) : undefined, [evFin]),
    cond(
      "quotes_min",
      `Đủ số chào giá theo chính sách (tối thiểu ${ctx.cfg.procurement.minQuotes}) cho hạng mục mua mới`,
      (proc.quoteStatus ?? []).every((q) => q.met),
      (proc.quoteStatus ?? []).filter((q) => !q.met).map((q) => `${q.part}: ${q.quotes}/${q.min}`).join("; ") || undefined,
      [evProc],
    ),
    cond("contract_ceiling", "Giá trị nằm trong trần hợp đồng hiện hành", !(proc.ceilingIssues ?? []).length, (proc.ceilingIssues ?? []).join("; ") || undefined, [evProc]),
    cond("over_budget", "Ngân sách khả dụng đủ (đã trừ phần các case khác đang giữ)", !fin.overBudget, (fin.shortfalls ?? []).join("; ") || undefined, [evFin]),
    cond("afe", "Có AFE ở mã chi phí yêu cầu AFE", !(fin.afeMissing ?? []).length, (fin.afeMissing ?? []).join("; ") || undefined, [evFin]),
    cond("logistics_feasible", "Có phương án vận chuyển khả thi (nếu cần vận chuyển)", log.feasibility !== "infeasible", (log.conditions ?? []).join("; ") || undefined, [evLog]),
    cond("resources_no_conflict", "Giữ chỗ tàu/bay không xung đột với case khác", !(log.holdFailed ?? []).length, (log.holdFailed ?? []).join("; ") || undefined, [evLog]),
  ];
  if (EN) for (const c of conditions) c.label = COND_EN[c.code] ?? c.label;
  for (const c of conditions) o.conclude(EN
    ? `Condition "${c.label}": ${c.met ? "met" : c.waivable ? `NOT MET — approvable only with a waiver recorded by ${c.waiverRoles.map((r) => roleText(ctx.cfg, r)).join("/")}` : "NOT MET — cannot be waived"}${c.detail ? ` (${c.detail})` : ""}.`
    : `Điều kiện "${c.label}": ${c.met ? "đạt" : c.waivable ? `CHƯA ĐẠT — chỉ duyệt được khi ${c.waiverRoles.join("/")} ghi ngoại lệ` : "CHƯA ĐẠT — không thể miễn trừ"}${c.detail ? ` (${c.detail})` : ""}.`, "check", c.evidence ?? []);

  const role = fin.requiredApproverRole ?? ctx.cfg.approvals.assetRole;
  const openItems = ["eng.assessment", "mnt.review", "hse.screening", "ops.proposal", "proc.prep", "log.plan", "fin.check"].flatMap((k) =>
    (ctx.up(k)?.output.missingData ?? []).map((m) => `[${k}] ${m.description}${m.owner ? ` — ${m.owner}` : ""}`),
  );
  const doc = ctx.saveDoc(
    "decision-package",
    T(`Hồ sơ trình duyệt cam kết — ${ctx.workflow.case_no}`, `Commitment approval package — ${ctx.workflow.case_no}`),
    "decision_package",
    EN ? decisionPackageEn(ctx, { role, pol, anomalyRun, proposalRun, techDecision, conditions, proc, fin, log, openItems }) : `# Hồ sơ trình duyệt cam kết chi — ${ctx.workflow.case_no} (case rev ${ctx.revision})\n\n**Người có thẩm quyền theo ma trận:** ${role} · **Chính sách:** ${pol.version} — ${pol.source}\n\n## 1. Tiếp nhận\n${anomalyRun.output.summary}\n\n## 2. Phạm vi đã duyệt\n${proposalRun.output.summary}\n\n${techDecision ? `Duyệt bởi **${techDecision.actor_name}** (${techDecision.actor_role}) lúc ${techDecision.decided_at}: "${techDecision.comment}"` : "_Chưa có quyết định phạm vi_"}\n\n## 3. Điều kiện cam kết\n\n${mdTable(
      ["Điều kiện", "Kết quả", "Ngoại lệ", "Chi tiết"],
      conditions.map((c) => [c.label, c.met ? "Đạt" : "**Chưa đạt**", c.met ? "—" : c.waivable ? `${c.waiverRoles.join(" / ")} ghi ngoại lệ` : "Không thể miễn trừ", c.detail ?? "—"]),
    )}\n\n## 4. Chi phí\n${proc.lines?.length ? mdTable(
      ["Hoạt động", "Hạng mục", "SL", "ĐVT", "Đơn giá", "Thành tiền", "Cơ sở giá"],
      proc.lines.map((l) => [l.activity, l.item, l.qty, l.unit, usd(l.unitPrice), usd(l.amount), l.basis]),
    ) : "_Không có mua sắm_"}\n\n- Tổng đã định giá: **${usd(fin.total ?? 0)}** (chứng từ ${usd(fin.documented ?? 0)} · ước tính ${usd(fin.estimated ?? 0)})${fin.costComplete === false ? `\n- **CHƯA ĐẦY ĐỦ** — chưa có giá: ${(fin.unpriced ?? []).join("; ")}` : ""}\n\n## 5. Ngân sách (sau giữ chỗ của case khác)\n${fin.perCostCode?.length ? mdTable(
      ["Mã chi phí", "Khả dụng", "Case khác đang giữ", "Đề xuất", "Sau đề xuất"],
      fin.perCostCode.map((c) => [c.costCode, usd(c.available), usd(c.heldByOthers), usd(c.request), usd(c.after)]),
    ) : "_Không có_"}\n\n${fin.pscConclusion ? `PSC: ${fin.pscConclusion}` : ""}\n\n## 6. Hậu cần\n${log.skipped ? "_Không cần vận chuyển_" : `Ngày huy động dự kiến: ${log.mobilizationDate ?? "chưa xác định"} · Tàu: ${log.voyage ?? "—"} · Chuyến bay: ${log.flight ?? "—"} · Khả thi: ${log.feasibility ?? "—"}\n\n${(log.conditions ?? []).map((c) => `- Điều kiện: ${c}`).join("\n")}`}\n\n## 7. Hạng mục còn mở\n${openItems.length ? openItems.map((x) => `- ${x}`).join("\n") : "- Không có"}\n\n## 8. Sau khi duyệt\nDuyệt cam kết cho phép lập **bản nháp** đề nghị mua sắm (PR), yêu cầu đặt chỗ, work request. Không phát hành PO, không đặt tàu, không cấp phép trong hệ thống. Duyệt giá trị chi **không** có nghĩa ngân sách đã được bổ sung. Trước huy động còn bước **kiểm tra sẵn sàng**.${docFooter(ctx, NAME)}`,
  );
  const unmet = conditions.filter((c) => !c.met);
  o.summary = EN
    ? `Commitment package v${doc.version} — ${usd(fin.total ?? 0)}${fin.costComplete === false ? " (INCOMPLETE)" : ""}; ${unmet.length ? `${unmet.length} condition(s) not met (${unmet.map((c) => c.code).join(", ")})` : "all conditions met"}; submitted to ${roleText(ctx.cfg, role)}.`
    : `Hồ sơ cam kết v${doc.version} — ${usd(fin.total ?? 0)}${fin.costComplete === false ? " (CHƯA ĐẦY ĐỦ)" : ""}; ${unmet.length ? `${unmet.length} điều kiện chưa đạt (${unmet.map((c) => c.code).join(", ")})` : "đủ điều kiện"}; trình ${role}.`;
  o.next(T(`${role} quyết định: duyệt (kèm ngoại lệ đúng thẩm quyền nếu cần) / từ chối / trả lại`, `${roleText(ctx.cfg, role)} decides: approve (with a properly authorised waiver if needed) / reject / return`));
  o.facts = { packageDocId: doc.docId, requiredApproverRole: role, total: fin.total ?? 0, generatedAt: nowIso(), conditions };
}

const COND_EN: Record<string, string> = {
  scope_current: "Scope approved and still valid at the current revision",
  cost_complete: "Total cost complete (no unpriced or unquantified items)",
  quotes_min: "Enough quotes per procurement policy for new purchases",
  contract_ceiling: "Value within the current contract ceiling",
  over_budget: "Enough available budget (after other cases' holds)",
  afe: "AFE present where the cost code requires one",
  logistics_feasible: "A feasible transport option (if transport is needed)",
  resources_no_conflict: "Vessel/flight holds do not conflict with other cases",
};

// English package document — same figures and IDs as the Vietnamese one, generated natively.
function decisionPackageEn(
  ctx: AgentContext,
  a: {
    role: string;
    pol: AgentContext["cfg"]["policy"];
    anomalyRun: { output: { summary: string } };
    proposalRun: { output: { summary: string } };
    techDecision: Record<string, unknown> | undefined;
    conditions: GateCondition[];
    proc: { lines?: Array<{ activity: string; item: string; qty: number; unit: string; unitPrice: number; amount: number; basis: string }> };
    fin: { total?: number; documented?: number; estimated?: number; costComplete?: boolean; unpriced?: string[]; pscConclusion?: string; perCostCode?: Array<{ costCode: string; available: number; heldByOthers: number; request: number; after: number }> };
    log: { mobilizationDate?: string | null; conditions?: string[]; voyage?: string | null; flight?: string | null; feasibility?: string; skipped?: boolean };
    openItems: string[];
  },
): string {
  const R = (r: string) => roleText(ctx.cfg, r);
  const { techDecision: td, fin, log, proc } = a;
  return `# Commitment approval package — ${ctx.workflow.case_no} (case rev ${ctx.revision})\n\n**Authority holder per the matrix:** ${R(a.role)} · **Policy:** ${a.pol.version} — ${a.pol.source}\n\n## 1. Intake\n${a.anomalyRun.output.summary}\n\n## 2. Approved scope\n${a.proposalRun.output.summary}\n\n${td ? `Approved by **${td.actor_name}** (${R(String(td.actor_role))}) at ${td.decided_at}: "${td.comment}"` : "_No scope decision yet_"}\n\n## 3. Commitment conditions\n\n${mdTable(
    ["Condition", "Result", "Waiver", "Detail"],
    a.conditions.map((c) => [c.label, c.met ? "Met" : "**Not met**", c.met ? "—" : c.waivable ? `Waiver by ${c.waiverRoles.map(R).join(" / ")}` : "Cannot be waived", c.detail ?? "—"]),
  )}\n\n## 4. Cost\n${proc.lines?.length ? mdTable(
    ["Activity", "Item", "Qty", "Unit", "Unit price", "Amount", "Price basis"],
    proc.lines.map((l) => [l.activity, l.item, l.qty, l.unit, usd(l.unitPrice), usd(l.amount), l.basis]),
  ) : "_No procurement_"}\n\n- Total priced: **${usd(fin.total ?? 0)}** (documented ${usd(fin.documented ?? 0)} · estimated ${usd(fin.estimated ?? 0)})${fin.costComplete === false ? `\n- **INCOMPLETE** — unpriced: ${(fin.unpriced ?? []).join("; ")}` : ""}\n\n## 5. Budget (after other cases' holds)\n${fin.perCostCode?.length ? mdTable(
    ["Cost code", "Available", "Held by other cases", "Proposed", "After proposal"],
    fin.perCostCode.map((c) => [c.costCode, usd(c.available), usd(c.heldByOthers), usd(c.request), usd(c.after)]),
  ) : "_None_"}\n\n${fin.pscConclusion ? `PSC: ${fin.pscConclusion}` : ""}\n\n## 6. Logistics\n${log.skipped ? "_No transport needed_" : `Planned mobilisation date: ${log.mobilizationDate ?? "not set"} · Vessel: ${log.voyage ?? "—"} · Flight: ${log.flight ?? "—"} · Feasibility: ${log.feasibility ?? "—"}\n\n${(log.conditions ?? []).map((c) => `- Condition: ${c}`).join("\n")}`}\n\n## 7. Open items\n${a.openItems.length ? a.openItems.map((x) => `- ${x}`).join("\n") : "- None"}\n\n## 8. After approval\nApproving the commitment allows **drafts** of the purchase requisition (PR), booking requests and work requests. No PO is issued, no vessel is booked and no permit is granted in the system. Approving the spend does **not** mean budget has been added. A **readiness check** still comes before mobilisation.${docFooter(ctx, NAME_EN)}`;
}

// ───────────────────────── 4. Drafts gated by the approval level ─────────────────────────

function release(ctx: AgentContext): void {
  const o = ctx.o;
  const assetGate = ctx.db.prepare("SELECT status FROM tasks WHERE workflow_id = ? AND key = 'gate.asset'").get(ctx.workflow.id);
  const committed = assetGate?.status === "done";
  const items: Array<{ kind: string; title: string; recipient: string; docId: number; gate: string }> = [];
  const proc = ctx.up("proc.prep")?.output.facts as { prDocId?: number } | undefined;
  const log = ctx.up("log.plan")?.output.facts as { bookingDocId?: number; voyage?: string | null } | undefined;
  const mnt = ctx.up("mnt.review")?.output.facts as { workRequestDocId?: number } | undefined;
  if (proc?.prDocId && committed) items.push({ kind: "purchase_requisition", title: "Đề nghị mua sắm (PR)", recipient: "Phòng Mua sắm — hệ thống ERP", docId: proc.prDocId, gate: "gate.asset" });
  if (log?.bookingDocId && committed) items.push({ kind: "vessel_booking", title: `Yêu cầu đặt chỗ ${log.voyage ?? "tàu"}`, recipient: "Marine coordinator", docId: log.bookingDocId, gate: "gate.asset" });
  if (mnt?.workRequestDocId) items.push({ kind: "work_request", title: "Work request (CMMS)", recipient: "Hệ thống CMMS", docId: mnt.workRequestDocId, gate: committed ? "gate.asset" : "gate.technical" });

  const ins = ctx.db.prepare(
    "INSERT OR IGNORE INTO outbox (workflow_id, kind, title, recipient, doc_id, doc_sha256, status, created_at, case_revision, required_gate) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)",
  );
  for (const it of items) {
    const sha = ctx.db.prepare("SELECT sha256 FROM documents WHERE id = ?").get(it.docId)?.sha256 as string;
    ins.run(ctx.workflow.id, it.kind, `${it.title} · rev ${ctx.revision}`, it.recipient, it.docId, sha, nowIso(), ctx.revision, it.gate);
    const ev = o.ev(`Bản nháp: ${it.title} → ${it.recipient} (cần ${it.gate === "gate.asset" ? "phê duyệt cam kết" : "phê duyệt phạm vi"})`, { kind: "document", id: it.docId });
    o.conclude(`Lập bản nháp "${it.title}" gửi ${it.recipient} — trạng thái: chờ phê duyệt gửi.`, "check", [ev]);
  }
  o.assume("Hệ thống không phát hành PO, không đặt tàu/bay, không cấp giấy phép và không điều khiển thiết bị — chỉ lập bản nháp chờ người có thẩm quyền duyệt gửi.");
  o.summary = `Lập ${items.length} bản nháp (PR/đặt chỗ/work request) theo đúng cấp phê duyệt; RFQ đã lập ở bước khảo giá.`;
  o.next("Người có thẩm quyền duyệt từng bản nháp trong Outbox; HSE kiểm tra sẵn sàng tại ngày thực hiện");
  o.facts = { outboxCount: items.length, committed };
}

// ───────────────────────── 5. Execution record (people, never the LLM) ─────────────────────────

function execution(ctx: AgentContext): void {
  const o = ctx.o;
  const prop = ctx.up("ops.proposal")!.output.facts as { activities?: ProposedActivity[]; acceptance?: Acceptance[] };
  const acts = prop.activities ?? [];
  const readyGate = ctx.db.prepare("SELECT d.id, d.decided_at FROM decisions d JOIN tasks t ON t.id = d.task_id WHERE t.workflow_id = ? AND t.key = 'gate.readiness' AND d.decision = 'approve' ORDER BY d.id DESC LIMIT 1").get(ctx.workflow.id);
  const readyDate = readyGate ? String(readyGate.decided_at).slice(0, 10) : null;
  if (readyGate) o.ev(`Xác nhận sẵn sàng ngày ${readyDate}`, { kind: "decision", id: num(readyGate.id) });
  const logF = ctx.up("log.plan")?.output.facts as { mobilizationDate?: string | null } | undefined;
  const readyF = ctx.up("hse.readiness")?.output.facts as { plannedDate?: string } | undefined;
  const planned = logF?.mobilizationDate ?? readyF?.plannedDate ?? (readyDate ? addDays(readyDate, ctx.cfg.logistics.leadDays) : null);

  const recs = ctx.caseRows("work_execution");
  const results: Array<{ activity: string; name: string; status: string; completed: string | null; findings: string | null; resultRef: string | null; confirmedBy: string | null; rowId: number | null }> = [];
  for (const a of acts) {
    const candidates = recs
      .filter((r) => r.data.activity_type === a.type && (!r.data.case_no || r.data.case_no === ctx.workflow.case_no) && (!readyDate || (r.data.completed_date as string) >= readyDate))
      .sort((x, y) => String(y.data.completed_date).localeCompare(String(x.data.completed_date)));
    const confirmed = candidates.find((r) => String(r.data.confirmed_by ?? "").trim());
    const unconfirmed = candidates.find((r) => !String(r.data.confirmed_by ?? "").trim());
    if (unconfirmed && !confirmed) o.warn(`${a.name}: có bản ghi thực hiện ${unconfirmed.data.completed_date} nhưng KHÔNG có người xác nhận — không được tính.`);
    if (!confirmed) {
      results.push({ activity: a.type, name: a.name, status: "chưa ghi nhận", completed: null, findings: null, resultRef: null, confirmedBy: null, rowId: null });
      continue;
    }
    const ev = o.ev(`${a.name}: ${confirmed.data.status} ngày ${confirmed.data.completed_date} — xác nhận bởi ${confirmed.data.confirmed_by}${confirmed.data.confirmed_role ? ` (${confirmed.data.confirmed_role})` : ""}${confirmed.data.findings ? `; ghi nhận: "${confirmed.data.findings}"` : ""}`, rowRef(confirmed));
    o.conclude(`${a.name}: ${confirmed.data.status === "done" ? "đã hoàn tất" : confirmed.data.status === "partial" ? "hoàn tất một phần" : "không thực hiện"} ngày ${confirmed.data.completed_date} (người phụ trách xác nhận).`, "observed", [ev]);
    results.push({ activity: a.type, name: a.name, status: String(confirmed.data.status), completed: confirmed.data.completed_date as string, findings: (confirmed.data.findings as string) ?? null, resultRef: (confirmed.data.result_ref as string) ?? null, confirmedBy: String(confirmed.data.confirmed_by), rowId: confirmed.id });
  }
  const missing = results.filter((r) => r.status === "chưa ghi nhận");
  o.assume("Kết quả thực hiện chỉ lấy từ bản ghi do người phụ trách nhập/xác nhận; agent và LLM không được báo công việc đã hoàn tất.");
  if (missing.length) {
    const today = todayIso();
    if (planned && planned > today) {
      o.wait({ kind: "date", reason: `Chờ tới ngày thực hiện dự kiến ${planned} (${missing.map((m) => m.name).join(", ")})`, until: planned, datasetType: "work_execution", owner: "Người phụ trách thực hiện" });
    } else {
      o.wait({ kind: "other_unit", reason: `Chờ người phụ trách ghi nhận kết quả thực hiện: ${missing.map((m) => m.name).join(", ")}`, datasetType: "work_execution", owner: "Người phụ trách thực hiện / OIM" });
    }
    o.next("Người phụ trách ghi nhận kết quả (màn hình case → Ghi nhận thực hiện, hoặc nhập dữ liệu work_execution)");
  }
  const doc = ctx.saveDoc(
    "execution-record",
    `Ghi nhận thực hiện — ${ctx.workflow.case_no}`,
    "execution_record",
    `# Ghi nhận thực hiện — ${ctx.workflow.case_no} (rev ${ctx.revision})\n\nNgày dự kiến: ${planned ?? "—"}\n\n${mdTable(
      ["Hoạt động", "Trạng thái", "Ngày", "Ghi nhận", "Kết quả/tài liệu", "Người xác nhận"],
      results.map((r) => [r.name, r.status, r.completed ?? "—", r.findings ?? "—", r.resultRef ?? "—", r.confirmedBy ?? "—"]),
    )}\n\n> Chỉ tính bản ghi có người xác nhận. Hệ thống không tự báo đã thực hiện.${docFooter(ctx, NAME)}`,
  );
  o.summary = missing.length
    ? `Đã ghi nhận ${results.length - missing.length}/${results.length} hoạt động; còn chờ: ${missing.map((m) => m.name).join(", ")}.`
    : `Đã ghi nhận đủ ${results.length} hoạt động (có người xác nhận) — chuyển đánh giá hiệu quả.`;
  o.facts = { results, plannedDate: planned, executionDocId: doc.docId, complete: !missing.length };
}

export const operationsAgent: AgentDef = {
  id: "ops_agent",
  name: NAME,
  room: "zone_ops",
  run(ctx) {
    switch (ctx.task.key) {
      case "ops.anomaly":
        return anomaly(ctx);
      case "ops.proposal":
        return proposal(ctx);
      case "ops.package":
        return decisionPackage(ctx);
      case "ops.release":
        return release(ctx);
      case "ops.execution":
        return execution(ctx);
      default:
        throw new Error(`Operations không xử lý task ${ctx.task.key}`);
    }
  },
};
