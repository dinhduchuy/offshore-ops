import type { AgentContext, AgentDef } from "./kit";
import { mdTable, docFooter, rowRef, daysBetween, isGasLift, addDays } from "./kit";
import { todayIso } from "../clock";
import type { GateCondition } from "../types";
import { compareWindows, metricValue, windowDates, type DetectionFacts } from "./metrics";
import { recordCalc, pearson, fmt, r1 } from "../calc";

const NAME = "Production/Subsurface AI (Kỹ thuật khai thác & công nghệ mỏ)";
const NAME_EN = "Production/Subsurface AI";

type HStatus = "supported" | "plausible" | "insufficient" | "not_supported" | "n/a";
const STATUS_VI: Record<HStatus, string> = {
  supported: "Có dấu hiệu ủng hộ",
  plausible: "Có thể — cần kiểm tra",
  insufficient: "Chưa đủ dữ liệu để đánh giá",
  not_supported: "Dữ liệu hiện có không ủng hộ",
  "n/a": "Không áp dụng",
};
const STATUS_EN: Record<HStatus, string> = {
  supported: "Supported by the data",
  plausible: "Possible — to be checked",
  insufficient: "Not enough data to assess",
  not_supported: "Current data does not support",
  "n/a": "Not applicable",
};

interface Hypothesis {
  code: string;
  title: string;
  status: HStatus;
  reason: string;
  evidence: string[];
  dataNeeded: string[];
}

function assessment(ctx: AgentContext): void {
  const o = ctx.o;
  const T = ctx.L;
  const EN = T("vi", "en") === "en";
  const ST = EN ? STATUS_EN : STATUS_VI;
  const cfg = ctx.cfg.engineering;
  const det = ctx.detection() as unknown as DetectionFacts;
  const well = det.well.well;
  const anomalyRun = ctx.up("ops.anomaly")!;
  const evAnomaly = o.ev(T(`Hồ sơ bất thường (Operations): ${anomalyRun.output.summary}`, `Anomaly dossier (Operations): ${anomalyRun.output.summary}`), { kind: "task_run", id: anomalyRun.runId });
  if (ctx.feedback) o.warn(T(`Phản hồi của người duyệt (${ctx.feedback.actor}, ${ctx.feedback.role}): "${ctx.feedback.comment}" — đã xem xét khi chạy lại.`, `Approver feedback (${ctx.feedback.actor}, ${ctx.feedback.role}): "${ctx.feedback.comment}" — considered in this re-run.`));

  const rows = ctx.caseRows("dpr").sort((a, b) => String(a.data.report_date).localeCompare(String(b.data.report_date)));
  const master = ctx.caseRows("well_master")[0];
  const liftType = (master?.data.lift_type as string | undefined) ?? null;
  const allocation = (master?.data.allocation_method as string | undefined) ?? null;
  if (master) o.ev(T(`Danh mục giếng: ${well} — ${liftType}, phân bổ sản lượng: ${allocation ?? "?"}`, `Well master: ${well} — ${liftType}, production allocation: ${allocation ?? "?"}`), rowRef(master));
  else o.need({ description: T(`Thiếu thông tin giếng ${well} trong well_master (phương pháp khai thác, phương pháp phân bổ)`, `Well ${well} missing from the well master (lift method, allocation method)`), datasetType: "well_master", blocking: true, owner: T("Kỹ thuật khai thác", "Production Engineering") });

  // ── Observations (facts from data) ──
  const { base, evalD } = windowDates(det);
  const wc = compareWindows(ctx, well, rows, base, evalD, "water_cut");
  const gl = compareWindows(ctx, well, rows, base, evalD, "gl_inj");
  const thp = compareWindows(ctx, well, rows, base, evalD, "thp");
  const choke = rows.some((r) => r.data.choke_pct !== null && r.data.choke_pct !== undefined)
    ? (() => {
        const b = rows.filter((r) => base.has(r.data.report_date as string) && r.data.choke_pct !== null).map((r) => r.data.choke_pct as number);
        const n = rows.filter((r) => evalD.has(r.data.report_date as string) && r.data.choke_pct !== null).map((r) => r.data.choke_pct as number);
        if (!b.length || !n.length) return null;
        const bm = b.reduce((x, y) => x + y, 0) / b.length;
        const nm = n.reduce((x, y) => x + y, 0) / n.length;
        const id = recordCalc(ctx.db, { label: T(`Độ mở choke ${well}`, `Choke opening ${well}`), formula: T("Δ = TB(hiện tại) − TB(baseline)", "Δ = mean(current) − mean(baseline)"), inputs: [{ name: "baseline", value: r1(bm), unit: "%" }, { name: T("hiện tại", "current"), value: r1(nm), unit: "%" }], result: r1(nm - bm), unit: T("điểm %", "pp") });
        return { delta: r1(nm - bm), ev: o.ev(T(`Độ mở choke ${well}: ${r1(bm)}% → ${r1(nm)}%`, `Choke opening ${well}: ${r1(bm)}% → ${r1(nm)}%`), { kind: "calc", id }) };
      })()
    : null;
  const evDrop = o.ev(T(`Mức giảm dầu chuẩn hóa ${fmt(det.well.minDropPct, 1)}%+ (ngưỡng ${det.thresholdPct}%)`, `Normalized oil drop ${fmt(det.well.minDropPct, 1)}%+ (threshold ${det.thresholdPct}%)`), { kind: "calc", id: det.well.summaryCalcId });
  o.conclude(T(`Quan sát: sản lượng dầu ${well} giảm ≥ ${fmt(det.well.minDropPct, 1)}% so với baseline.`, `Observed: oil output of ${well} is down ≥ ${fmt(det.well.minDropPct, 1)}% versus baseline.`), "observed", [evDrop, evAnomaly]);
  if (wc) o.conclude(T(`Quan sát: water cut ${fmt(wc.base, 1)}% → ${fmt(wc.now, 1)}% (${wc.changeAbs >= 0 ? "+" : ""}${fmt(wc.changeAbs, 1)} điểm %).`, `Observed: water cut ${fmt(wc.base, 1)}% → ${fmt(wc.now, 1)}% (${wc.changeAbs >= 0 ? "+" : ""}${fmt(wc.changeAbs, 1)} pp).`), "observed", [wc.evId]);
  if (gl) o.conclude(T(`Quan sát: khí gas lift ${fmt(gl.base, 2)} → ${fmt(gl.now, 2)} MMscf/d (${fmt(gl.changePct, 1)}%).`, `Observed: gas-lift injection ${fmt(gl.base, 2)} → ${fmt(gl.now, 2)} MMscf/d (${fmt(gl.changePct, 1)}%).`), "observed", [gl.evId]);
  if (thp) o.conclude(T(`Quan sát: THP ${fmt(thp.base, 1)} → ${fmt(thp.now, 1)} bar (${fmt(thp.changePct, 1)}%).`, `Observed: THP ${fmt(thp.base, 1)} → ${fmt(thp.now, 1)} bar (${fmt(thp.changePct, 1)}%).`), "observed", [thp.evId]);

  // Correlation GL injection vs oil (whole record of the well)
  let corr: number | null = null;
  let evCorr: string | null = null;
  const pairs = rows.map((r) => ({ r, g: metricValue(r, "gl_inj"), q: metricValue(r, "oil_norm") })).filter((p) => p.g !== null && p.q !== null);
  if (isGasLift(liftType) && pairs.length >= 5) {
    corr = pearson(pairs.map((p) => p.g!), pairs.map((p) => p.q!));
    const id = recordCalc(ctx.db, {
      label: T(`Tương quan gas lift – dầu ${well}`, `Gas lift – oil correlation ${well}`),
      formula: T("r = Pearson(gl_inj, oil_rate × 24 / uptime_h) trên toàn bộ ngày có đủ 2 giá trị", "r = Pearson(gl_inj, oil_rate × 24 / uptime_h) over all days with both values"),
      inputs: pairs.map((p) => ({ name: `${p.r.data.report_date}`, value: `${r1(p.g!)} | ${r1(p.q!)}`, ref: { kind: "data_row" as const, id: p.r.id } })),
      result: corr === null ? null : Math.round(corr * 100) / 100,
      unit: "r",
    });
    evCorr = o.ev(T(`Hệ số tương quan gas lift ↔ dầu: r = ${corr === null ? "không xác định" : corr.toFixed(2)} (${pairs.length} ngày)`, `Gas lift ↔ oil correlation: r = ${corr === null ? "undefined" : corr.toFixed(2)} (${pairs.length} days)`), { kind: "calc", id });
    o.conclude(T(`Tính toán: tương quan giữa lưu lượng gas lift và dầu r = ${corr === null ? "không xác định" : corr.toFixed(2)} — tương quan không phải bằng chứng nhân quả.`, `Calculated: correlation between gas-lift injection and oil r = ${corr === null ? "undefined" : corr.toFixed(2)} — correlation is not proof of cause.`), "calculated", [evCorr]);
  }

  // ── Well test ──
  const tests = ctx.caseRows("well_test").sort((a, b) => String(a.data.test_date).localeCompare(String(b.data.test_date)));
  if (ctx.scope.ambiguousWell && ctx.rows("well_test").some((r) => r.data.well === well && !r.data.platform)) {
    o.warn(T(`Có thử giếng ${well} không ghi giàn trong khi tên giếng trùng giữa các giàn — không dùng các dòng đó.`, `Some ${well} well tests do not state the platform while the well name exists on several platforms — those rows are not used.`));
  }
  const latest = tests[tests.length - 1];
  let testAge: number | null = null;
  let testDiffPct: number | null = null;
  let evTest: string | null = null;
  if (!latest) {
    o.need({ description: T(`Không có dữ liệu thử giếng ${well}`, `No well test data for ${well}`), datasetType: "well_test", blocking: true, owner: T("Kỹ thuật khai thác / Operations", "Production Engineering / Operations") });
  } else {
    testAge = daysBetween(latest.data.test_date as string, det.asOf);
    const id = recordCalc(ctx.db, {
      label: T(`Tuổi thử giếng ${well}`, `Well test age ${well}`),
      formula: T("tuổi = ngày dữ liệu DPR mới nhất − ngày thử giếng", "age = latest DPR date − well test date"),
      inputs: [
        { name: "test_date", value: latest.data.test_date as string, ref: rowRef(latest) },
        { name: "asOf", value: det.asOf },
      ],
      result: testAge,
      unit: T("ngày", "days"),
    });
    evTest = o.ev(T(`Thử giếng gần nhất ${latest.data.test_date}: dầu ${fmt(latest.data.oil_bbl_d as number)} bbl/d, nước ${fmt(latest.data.water_bbl_d as number)} bbl/d — cách ${testAge} ngày`, `Latest well test ${latest.data.test_date}: oil ${fmt(latest.data.oil_bbl_d as number)} bbl/d, water ${fmt(latest.data.water_bbl_d as number)} bbl/d — ${testAge} days old`), { kind: "calc", id });
    if (testAge > cfg.wellTestMaxAgeDays) {
      o.conclude(T(`Kiểm tra: lần thử giếng gần nhất (${latest.data.test_date}) đã ${testAge} ngày, quá giới hạn ${cfg.wellTestMaxAgeDays} ngày — không đại diện cho giai đoạn suy giảm.`, `Check: the latest well test (${latest.data.test_date}) is ${testAge} days old, beyond the ${cfg.wellTestMaxAgeDays}-day limit — not representative of the decline period.`), "check", [evTest]);
      o.need({
        description: T(`Cần kết quả thử giếng ${well} thực hiện sau thời điểm bắt đầu suy giảm (${det.well.baseline.to ?? det.well.days[0]?.date ?? det.asOf}), không quá ${cfg.wellTestMaxAgeDays} ngày so với ${det.asOf}, để xác nhận lưu lượng dầu/nước đo trên bình tách thử`, `A well test of ${well} taken after the decline started (${det.well.baseline.to ?? det.well.days[0]?.date ?? det.asOf}), no more than ${cfg.wellTestMaxAgeDays} days before ${det.asOf}, is needed to confirm the oil/water rates measured on the test separator`),
        datasetType: "well_test",
        blocking: true,
        owner: T("Operations (bình tách thử) / Kỹ thuật khai thác", "Operations (test separator) / Production Engineering"),
      });
    } else {
      const dpr = rows.find((r) => r.data.report_date === latest.data.test_date) ?? rows[rows.length - 1];
      const dprOil = metricValue(dpr, "oil_norm");
      if (dprOil) {
        testDiffPct = ((dprOil - (latest.data.oil_bbl_d as number)) / (latest.data.oil_bbl_d as number)) * 100;
        const cid = recordCalc(ctx.db, {
          label: T(`Chênh lệch DPR (phân bổ) vs thử giếng ${well}`, `DPR (allocated) vs well test difference ${well}`),
          formula: T("Δ% = (dầu DPR chuẩn hóa − dầu thử giếng) / dầu thử giếng × 100", "Δ% = (normalized DPR oil − well test oil) / well test oil × 100"),
          inputs: [
            { name: "DPR", value: r1(dprOil), unit: "bbl/d", ref: rowRef(dpr) },
            { name: T("thử giếng", "well test"), value: latest.data.oil_bbl_d as number, unit: "bbl/d", ref: rowRef(latest) },
          ],
          result: r1(testDiffPct),
          unit: "%",
        });
        const ev = o.ev(T(`DPR ${dpr.data.report_date} vs thử giếng ${latest.data.test_date}: chênh ${fmt(testDiffPct, 1)}%`, `DPR ${dpr.data.report_date} vs well test ${latest.data.test_date}: difference ${fmt(testDiffPct, 1)}%`), { kind: "calc", id: cid });
        o.conclude(T(`Tính toán: sản lượng DPR chênh ${fmt(testDiffPct, 1)}% so với kết quả thử giếng ${latest.data.test_date}.`, `Calculated: DPR output differs by ${fmt(testDiffPct, 1)}% from the ${latest.data.test_date} well test.`), "calculated", [ev, evTest]);
      }
      if (latest.data.chp_bar !== null && latest.data.chp_bar !== undefined) {
        o.conclude(T(`Quan sát (thử giếng): áp suất vành xuyến CHP ${latest.data.chp_bar} bar, gas lift ${latest.data.gl_inj_mmscfd ?? "—"} MMscf/d.`, `Observed (well test): casing head pressure CHP ${latest.data.chp_bar} bar, gas lift ${latest.data.gl_inj_mmscfd ?? "—"} MMscf/d.`), "observed", [evTest]);
      }
    }
  }

  // ── Hypotheses: facts vs hypotheses vs missing information ──
  const H: Hypothesis[] = [];
  if (isGasLift(liftType)) {
    const drop = gl ? gl.changePct <= -cfg.gasLiftDropPct : false;
    const strong = corr !== null && corr >= cfg.correlationMin;
    H.push({
      code: "H_GL",
      title: T("Suy giảm cấp khí gas lift (nguồn cấp, van điều khiển bề mặt hoặc van gas lift trong giếng)", "Reduced gas-lift supply (supply, surface control valve or downhole gas-lift valve)"),
      status: !gl ? "insufficient" : drop && strong ? "supported" : drop ? "plausible" : "not_supported",
      reason: !gl
        ? T("DPR không có số liệu gas lift", "The DPR has no gas-lift data")
        : T(`Gas lift thay đổi ${fmt(gl.changePct, 1)}% (ngưỡng −${cfg.gasLiftDropPct}%), tương quan r = ${corr === null ? "—" : corr.toFixed(2)} (ngưỡng ${cfg.correlationMin})`, `Gas lift changed ${fmt(gl.changePct, 1)}% (threshold −${cfg.gasLiftDropPct}%), correlation r = ${corr === null ? "—" : corr.toFixed(2)} (threshold ${cfg.correlationMin})`),
      evidence: [gl?.evId, evCorr].filter(Boolean) as string[],
      dataNeeded: [T("Khảo sát gradient dòng chảy (FGS) xác định điểm bơm khí", "Flowing gradient survey (FGS) to locate the injection point"), T("Kiểm tra van điều khiển khí bề mặt", "Check the surface gas control valve")],
    });
  }
  H.push({
    code: "H_WATER",
    title: T("Gia tăng nước xâm nhập (water breakthrough / coning)", "Increasing water influx (water breakthrough / coning)"),
    status: !wc ? "insufficient" : wc.changeAbs >= cfg.waterCutRisePp ? "supported" : "not_supported",
    reason: !wc ? T("Thiếu số liệu nước", "No water data") : T(`Water cut tăng ${fmt(wc.changeAbs, 1)} điểm % (ngưỡng ${cfg.waterCutRisePp}); tăng nước cũng có thể là hệ quả của giảm hiệu quả nâng — chưa tách được nguyên nhân`, `Water cut up ${fmt(wc.changeAbs, 1)} pp (threshold ${cfg.waterCutRisePp}); more water can also follow a loss of lift efficiency — the causes are not separated yet`),
    evidence: [wc?.evId].filter(Boolean) as string[],
    dataNeeded: [T("Mẫu nước (độ mặn) để phân biệt nước vỉa/nước bơm ép", "Water sample (salinity) to tell formation water from injected water"), T("Thử giếng ổn định", "Stable well test")],
  });
  const testStale = testAge === null || testAge > cfg.wellTestMaxAgeDays;
  const allocated = /alloc|phân bổ/i.test(allocation ?? "");
  H.push({
    code: "H_MEAS",
    title: T("Sai số đo đếm / phân bổ sản lượng", "Metering / production allocation error"),
    status: testStale ? (allocated ? "plausible" : "insufficient") : testDiffPct !== null && Math.abs(testDiffPct) > 10 ? "supported" : "not_supported",
    reason: testStale
      ? T(`Sản lượng giếng ${allocated ? "được phân bổ" : "không rõ phương pháp đo"}; thử giếng gần nhất không còn đại diện`, `Well output is ${allocated ? "allocated" : "measured by an unknown method"}; the latest well test is no longer representative`)
      : T(`Chênh lệch DPR vs thử giếng ${fmt(testDiffPct, 1)}% (ngưỡng ±10%)`, `DPR vs well test difference ${fmt(testDiffPct, 1)}% (threshold ±10%)`),
    evidence: [evTest].filter(Boolean) as string[],
    dataNeeded: [T("Thử giếng trên bình tách thử", "Well test on the test separator"), T("Tình trạng hiệu chuẩn đồng hồ đo (Bảo dưỡng)", "Meter calibration status (Maintenance)")],
  });
  if (choke) {
    H.push({
      code: "H_CHOKE",
      title: T("Thay đổi chế độ vận hành (độ mở choke)", "Change in operating conditions (choke opening)"),
      status: Math.abs(choke.delta) >= 5 ? "supported" : "not_supported",
      reason: T(`Độ mở choke thay đổi ${choke.delta} điểm %`, `Choke opening changed ${choke.delta} pp`),
      evidence: [choke.ev],
      dataNeeded: [],
    });
  }
  H.push({
    code: "H_SKIN",
    title: T("Nhiễm bẩn / tổn thương vùng cận đáy giếng", "Near-wellbore damage / skin"),
    status: "insufficient",
    reason: T("Đầu vào không có dữ liệu áp suất đáy giếng / khôi phục áp suất (PTA); không thể đánh giá skin từ DPR", "No bottomhole pressure / pressure transient (PTA) data in the inputs; skin cannot be assessed from the DPR"),
    evidence: [],
    dataNeeded: [T("Khảo sát khôi phục áp suất (PBU) và phân tích PTA", "Pressure build-up (PBU) survey and PTA")],
  });
  for (const h of H) {
    o.conclude(T(`Giả thuyết ${h.code} — ${h.title}: ${ST[h.status]}. ${h.reason}.`, `Hypothesis ${h.code} — ${h.title}: ${ST[h.status]}. ${h.reason}.`), "hypothesis", h.evidence);
  }
  o.assume(T("Các giả thuyết chưa được xác nhận; không kết luận phương án can thiệp hay thông số thi công khi chưa có đánh giá chuyên môn được phê duyệt.", "Hypotheses are not confirmed; no intervention option or job parameters are concluded without an approved specialist assessment."));
  o.assume(T("Sản lượng chuẩn hóa theo giờ chạy giả định lưu lượng không đổi trong giờ vận hành.", "Uptime-normalized output assumes a constant rate during operating hours."));

  // ── Recommendations from the activity catalog (data-driven) ──
  const catalog = ctx.rows("activity_catalog");
  if (!catalog.length) o.need({ description: T("Chưa có danh mục hoạt động kỹ thuật (activity_catalog)", "No technical activity catalog (activity_catalog)"), datasetType: "activity_catalog", blocking: true, owner: T("Kỹ thuật khai thác", "Production Engineering") });
  const supported = H.filter((h) => h.status === "supported").map((h) => h.code);
  const plausible = H.filter((h) => h.status === "plausible").map((h) => h.code);
  const insufficient = H.filter((h) => h.status === "insufficient").map((h) => h.code);
  const primary = new Set(supported.length ? [...supported, ...plausible] : [...plausible, ...insufficient]);
  const recommended: Array<{ type: string; name: string; workType: string; addresses: string[]; source: string }> = [];
  const optional: typeof recommended = [];
  for (const a of catalog) {
    if (a.data.work_type !== "diagnostic") continue;
    const lifts = (a.data.lift_types as string[] | null) ?? [];
    if (lifts.length && !lifts.some((l) => (liftType ?? "").toLowerCase().includes(l.toLowerCase()))) continue;
    const addr = ((a.data.addresses as string[] | null) ?? []).filter((c) => H.some((h) => h.code === c));
    if (!addr.length) continue;
    const item = { type: a.data.activity_type as string, name: a.data.name as string, workType: "diagnostic", addresses: addr, source: "engineering" };
    const ev = o.ev(T(`Danh mục hoạt động: ${item.name} kiểm chứng ${addr.join(", ")}`, `Activity catalog: ${item.name} tests ${addr.join(", ")}`), rowRef(a));
    if (addr.some((c) => primary.has(c))) {
      recommended.push(item);
      o.conclude(T(`Đề xuất thu thập dữ liệu: ${item.name} (kiểm chứng ${addr.join(", ")}).`, `Proposed data gathering: ${item.name} (tests ${addr.join(", ")}).`), "check", [ev]);
    } else if (addr.some((c) => insufficient.includes(c))) optional.push(item);
  }
  for (const a of optional) o.next(T(`Tùy chọn (sau chẩn đoán): ${a.name}`, `Optional (after diagnostics): ${a.name}`));

  const blocking = o.missingData.some((m) => m.blocking);
  const assess = ctx.saveDoc(
    "technical-assessment",
    `Technical assessment — ${ctx.workflow.case_no}`,
    "technical_assessment",
    EN ? assessmentDocEn(ctx, { well, H, ST, recommended, optional }) : `# Technical assessment — ${ctx.workflow.case_no} (${well})\n\n## Dữ kiện quan sát\n${o.conclusions.filter((c) => c.basis !== "hypothesis" && c.basis !== "check").map((c) => `- ${c.text}`).join("\n")}\n\n## Giả thuyết nguyên nhân (chưa xác nhận)\n\n${mdTable(
      ["Mã", "Giả thuyết", "Trạng thái", "Căn cứ", "Dữ liệu cần để kiểm chứng"],
      H.map((h) => [h.code, h.title, STATUS_VI[h.status], h.reason, h.dataNeeded.join("; ") || "—"]),
    )}\n\n## Thông tin còn thiếu\n${o.missingData.length ? o.missingData.map((m) => `- ${m.blocking ? "**[Bắt buộc]** " : ""}${m.description}`).join("\n") : "- Không có"}\n\n## Đề xuất kiểm tra / thu thập dữ liệu\n${recommended.map((a) => `- ${a.name} → ${a.addresses.join(", ")}`).join("\n") || "- Không có"}\n${optional.length ? `\nTùy chọn: ${optional.map((a) => a.name).join(", ")}` : ""}\n\n> Không kết luận nguyên nhân; không đề xuất phương án can thiệp xử lý hay thông số thi công ở bước này.${ctx.feedback ? `\n\n**Phản hồi người duyệt đã nhận:** "${ctx.feedback.comment}" — ${ctx.feedback.actor}` : ""}${docFooter(ctx, NAME)}`,
  );

  let sowDocId: number | null = null;
  if (!blocking && recommended.length) {
    const byType = new Map(catalog.map((a) => [a.data.activity_type as string, a]));
    const sow = ctx.saveDoc(
      "sow-draft",
      T(`Dự thảo Scope of Work (chẩn đoán) — ${ctx.workflow.case_no}`, `Draft Scope of Work (diagnostics) — ${ctx.workflow.case_no}`),
      "sow_draft",
      `${T(`# DỰ THẢO Scope of Work — chẩn đoán giếng ${well}\n\n**Trạng thái:** dự thảo, chờ phê duyệt đánh giá kỹ thuật.`, `# DRAFT Scope of Work — diagnostics, well ${well}\n\n**Status:** draft, awaiting approval of the technical assessment.`)}\n\n${mdTable(
        T("Hạng mục|Mục tiêu (giả thuyết)|Nhân lực|Thời gian (ngày)|Thiết bị|Vật tư", "Item|Target (hypothesis)|Crew|Duration (days)|Equipment|Materials").split("|"),
        recommended.map((a) => {
          const c = byType.get(a.type)!;
          return [a.name, a.addresses.join(", "), c.data.crew_size ?? "—", c.data.duration_days ?? "—", ((c.data.equipment as string[]) ?? []).join(", ") || "—", ((c.data.materials as string[]) ?? []).join(", ") || "—"];
        }),
      )}\n\n${T("Thông số thi công chi tiết do kỹ sư phụ trách xác định sau khi đánh giá được phê duyệt. Phạm vi không bao gồm xử lý/can thiệp giếng.", "Detailed job parameters are set by the responsible engineer after the assessment is approved. The scope excludes well treatment / intervention.")}${docFooter(ctx, T(NAME, NAME_EN))}`,
    );
    sowDocId = sow.docId;
    o.next(T("Chuyển dự thảo SOW cùng technical assessment để tổng hợp phương án", "Pass the draft SOW with the technical assessment for option consolidation"));
  } else if (blocking) {
    o.next(T("Chưa soạn SOW: chờ dữ liệu bắt buộc được bổ sung", "No SOW drafted yet: waiting for the required data"));
  }

  o.summary = blocking
    ? T(`Đánh giá sơ bộ ${well}: ${H.filter((h) => h.status === "supported").length} giả thuyết có dấu hiệu ủng hộ; THIẾU dữ liệu bắt buộc (${o.missingData.filter((m) => m.blocking).length}) nên chưa soạn SOW.`, `Preliminary assessment ${well}: ${H.filter((h) => h.status === "supported").length} hypothesis(es) supported by the data; required data MISSING (${o.missingData.filter((m) => m.blocking).length}), so no SOW yet.`)
    : T(`Đánh giá ${well}: ${H.map((h) => `${h.code} ${STATUS_VI[h.status].toLowerCase()}`).join("; ")}. Đề xuất ${recommended.length} hoạt động chẩn đoán; đã soạn dự thảo SOW.`, `Assessment ${well}: ${H.map((h) => `${h.code} ${STATUS_EN[h.status].toLowerCase()}`).join("; ")}. Proposes ${recommended.length} diagnostic activities; draft SOW prepared.`);
  o.facts = {
    hypotheses: H.map((h) => ({ code: h.code, title: h.title, status: ST[h.status], statusCode: h.status })),
    recommendedActivities: recommended,
    optionalActivities: optional,
    assessmentDocId: assess.docId,
    sowDocId,
    wellTestAgeDays: testAge,
    liftType,
  };
}

/** English technical assessment document (content.language = en). */
function assessmentDocEn(
  ctx: AgentContext,
  a: { well: string; H: Hypothesis[]; ST: Record<HStatus, string>; recommended: Array<{ name: string; addresses: string[] }>; optional: Array<{ name: string }> },
): string {
  const o = ctx.o;
  const { well, H, ST, recommended, optional } = a;
  return `# Technical assessment — ${ctx.workflow.case_no} (${well})\n\n## Observed facts\n${o.conclusions.filter((c) => c.basis !== "hypothesis" && c.basis !== "check").map((c) => `- ${c.text}`).join("\n")}\n\n## Cause hypotheses (not confirmed)\n\n${mdTable(
    ["Code", "Hypothesis", "Status", "Basis", "Data needed to test it"],
    H.map((h) => [h.code, h.title, ST[h.status], h.reason, h.dataNeeded.join("; ") || "—"]),
  )}\n\n## Missing information\n${o.missingData.length ? o.missingData.map((m) => `- ${m.blocking ? "**[Required]** " : ""}${m.description}`).join("\n") : "- None"}\n\n## Proposed checks / data gathering\n${recommended.map((x) => `- ${x.name} → ${x.addresses.join(", ")}`).join("\n") || "- None"}\n${optional.length ? `\nOptional: ${optional.map((x) => x.name).join(", ")}` : ""}\n\n> No cause is concluded; no intervention option or job parameters are proposed at this step.${ctx.feedback ? `\n\n**Approver feedback received:** "${ctx.feedback.comment}" — ${ctx.feedback.actor}` : ""}${docFooter(ctx, NAME_EN)}`;
}

/** Effect evaluation against the acceptance criteria fixed when the scope was chosen. */
function evaluation(ctx: AgentContext): void {
  const o = ctx.o;
  const det = ctx.detection() as unknown as DetectionFacts;
  const key = `${ctx.scope.platform}/${ctx.scope.well}`;
  const prop = ctx.up("ops.proposal")!.output.facts as { acceptance?: Array<{ activity: string; activityName: string; workType: string; criterion: string }> };
  const execRun = ctx.up("ops.execution")!;
  const results = (execRun.output.facts.results as Array<{ activity: string; name: string; status: string; completed: string | null; findings: string | null; resultRef: string | null; confirmedBy: string | null; rowId: number | null }>) ?? [];
  const evExec = o.ev(`Ghi nhận thực hiện: ${execRun.output.summary}`, { kind: "task_run", id: execRun.runId });
  const cfg = ctx.cfg.closure;
  const rows = ctx.caseRows("dpr").sort((a, b) => String(a.data.report_date).localeCompare(String(b.data.report_date)));
  const baseline = det.well.baseline?.value ?? null;
  const preDays = det.well.days.map((d) => d.oilNorm).filter((x): x is number => x !== null);
  const pre = preDays.length ? preDays.reduce((a, b) => a + b, 0) / preDays.length : null;
  const verdicts: Array<{ name: string; criterion: string; result: "met" | "not_met" | "pending"; detail: string }> = [];
  let waitUntil = null as string | null;

  for (const acc of prop.acceptance ?? []) {
    const r = results.find((x) => x.activity === acc.activity);
    const evR = r?.rowId ? o.ev(`${acc.activityName}: ${r.status} ${r.completed ?? ""} — ${r.confirmedBy ?? ""}`, rowRef({ id: r.rowId })) : evExec;
    if (!r || r.status === "chưa ghi nhận") {
      verdicts.push({ name: acc.activityName, criterion: acc.criterion, result: "pending", detail: "chưa có bản ghi thực hiện có xác nhận" });
      continue;
    }
    if (r.status !== "done") {
      verdicts.push({ name: acc.activityName, criterion: acc.criterion, result: "not_met", detail: `công việc ${r.status === "partial" ? "hoàn tất một phần" : "không thực hiện"}` });
      o.conclude(`${acc.activityName}: CHƯA ĐẠT — ${r.status === "partial" ? "hoàn tất một phần" : "không thực hiện"}.`, "check", [evR]);
      continue;
    }
    if (acc.workType !== "maintenance") {
      const ok = !!(r.resultRef || r.findings);
      verdicts.push({ name: acc.activityName, criterion: acc.criterion, result: ok ? "met" : "not_met", detail: ok ? `có kết quả: ${r.resultRef ?? r.findings}` : "đã làm nhưng chưa có kết quả/dữ liệu đính kèm" });
      o.conclude(`${acc.activityName}: ${ok ? "ĐẠT — đã thu được dữ liệu chẩn đoán" : "CHƯA ĐẠT — chưa có kết quả/dữ liệu đính kèm"}. Đạt nghĩa là có dữ liệu để kiểm chứng giả thuyết, không phải sản lượng đã phục hồi.`, "check", [evR]);
      continue;
    }
    // Maintenance: observed recovery over N post-work days
    const post = rows.filter((x) => (x.data.report_date as string) > r.completed!);
    const vals = post.map((x) => metricValue(x, "oil_norm")).filter((x): x is number => x !== null);
    if (vals.length < cfg.observationDays || baseline === null || pre === null) {
      const until = addDays(r.completed!, cfg.observationDays + 1);
      waitUntil = !waitUntil || until > waitUntil ? until : waitUntil;
      verdicts.push({ name: acc.activityName, criterion: acc.criterion, result: "pending", detail: `cần ${cfg.observationDays} ngày DPR sau ${r.completed} (hiện có ${vals.length})` });
      continue;
    }
    const postMean = vals.slice(0, cfg.observationDays).reduce((a, b) => a + b, 0) / cfg.observationDays;
    const share = baseline - pre === 0 ? 0 : (postMean - pre) / (baseline - pre);
    const cid = recordCalc(ctx.db, {
      label: `Phục hồi sau ${acc.activityName} — ${key}`,
      formula: `tỷ lệ phục hồi = (TB ${cfg.observationDays} ngày sau − TB lúc phát hiện) / (baseline − TB lúc phát hiện)`,
      inputs: [
        { name: "baseline", value: r1(baseline), unit: "bbl/d" },
        { name: "lúc phát hiện", value: r1(pre), unit: "bbl/d" },
        ...post.slice(0, cfg.observationDays).map((x) => ({ name: `sau ${x.data.report_date}`, value: r1(metricValue(x, "oil_norm") ?? 0), unit: "bbl/d", ref: { kind: "data_row" as const, id: x.id } })),
      ],
      result: Math.round(share * 1000) / 10,
      unit: "%",
    });
    const ev = o.ev(`Phục hồi quan sát: ${fmt(pre)} → ${fmt(postMean)} bbl/d (baseline ${fmt(baseline)}) = ${fmt(share * 100, 1)}% phần suy giảm`, { kind: "calc", id: cid });
    const ok = share >= cfg.recoveryShareMin;
    verdicts.push({ name: acc.activityName, criterion: acc.criterion, result: ok ? "met" : "not_met", detail: `phục hồi ${fmt(share * 100, 1)}% (ngưỡng ${Math.round(cfg.recoveryShareMin * 100)}%)` });
    o.conclude(`${acc.activityName}: ${ok ? "ĐẠT" : "CHƯA ĐẠT"} tiêu chí — phục hồi quan sát ${fmt(share * 100, 1)}% phần suy giảm. Đây là chỉ số QUAN SÁT; phần quy cho công việc cần kỹ sư xác nhận (yếu tố khác như thay đổi vận hành có thể góp phần).`, "calculated", [ev, evR]);
  }
  const pending = verdicts.filter((v) => v.result === "pending");
  const notMet = verdicts.filter((v) => v.result === "not_met");
  const overall = pending.length ? "pending" : notMet.length ? "not_met" : "met";
  if (overall === "pending") {
    if (waitUntil && waitUntil > todayIso()) o.wait({ kind: "date", reason: `Chờ đủ ${cfg.observationDays} ngày DPR sau thực hiện (tới ${waitUntil})`, until: waitUntil, datasetType: "dpr" });
    else o.wait({ kind: "other_unit", reason: `Chờ dữ liệu để đánh giá: ${pending.map((p) => `${p.name} (${p.detail})`).join("; ")}`, datasetType: "dpr" });
  }
  const conditions: GateCondition[] = [
    { code: "execution_confirmed", label: "Có bản ghi thực hiện được người phụ trách xác nhận cho mọi hoạt động", met: results.every((r) => !!r.confirmedBy), kind: "check", waivable: false, waiverRoles: [] },
    { code: "evaluation_met", label: "Kết quả đạt tiêu chí nghiệm thu đã chốt", met: overall === "met", kind: "check", waivable: false, waiverRoles: [], detail: notMet.map((v) => `${v.name}: ${v.detail}`).join("; ") || undefined },
    { code: "attribution_reviewed", label: "Kỹ sư đã xem xét phần hiệu quả quy cho công việc (khác với chỉ số quan sát)", met: false, kind: "confirm", waivable: false, waiverRoles: [] },
  ];
  const doc = ctx.saveDoc(
    "evaluation",
    `Đánh giá hiệu quả — ${ctx.workflow.case_no}`,
    "evaluation",
    `# Đánh giá hiệu quả — ${ctx.workflow.case_no} (rev ${ctx.revision})\n\n**Kết quả chung:** ${overall === "met" ? "ĐẠT" : overall === "not_met" ? "CHƯA ĐẠT — đề nghị mở lại đánh giá" : "CHỜ DỮ LIỆU"}\n\n${mdTable(["Hoạt động", "Tiêu chí nghiệm thu", "Kết quả", "Chi tiết"], verdicts.map((v) => [v.name, v.criterion, v.result === "met" ? "Đạt" : v.result === "not_met" ? "**Chưa đạt**" : "Chờ", v.detail]))}\n\n> Chỉ số sản lượng là quan sát; hiệu quả quy cho công việc cần kỹ sư xác nhận. ${overall === "not_met" ? "Nếu chưa đạt: người đóng case trả lại bước đánh giá kỹ thuật để mở vòng chẩn đoán mới (cùng case, revision mới)." : ""}${docFooter(ctx, NAME)}`,
  );
  o.summary = overall === "met" ? `Đạt tiêu chí nghiệm thu (${verdicts.length} hoạt động) — trình đóng case.` : overall === "not_met" ? `CHƯA ĐẠT: ${notMet.map((v) => v.name).join(", ")} — đề nghị mở lại đánh giá.` : `Chờ dữ liệu đánh giá: ${pending.map((p) => p.name).join(", ")}.`;
  o.next(overall === "not_met" ? "Trưởng phòng Kỹ thuật: trả lại bước đánh giá kỹ thuật (vòng chẩn đoán mới)" : "Trưởng phòng Kỹ thuật: đóng case kèm kết luận & bài học");
  o.facts = { result: overall, verdicts, conditions, evaluationDocId: doc.docId };
}

export const engineeringAgent: AgentDef = {
  id: "prodeng_agent",
  name: NAME,
  room: "zone_prod_eng",
  run(ctx) {
    return ctx.task.key === "eng.evaluation" ? evaluation(ctx) : assessment(ctx);
  },
};
