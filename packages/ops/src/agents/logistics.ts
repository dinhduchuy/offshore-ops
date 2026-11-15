import type { AgentContext, AgentDef } from "./kit";
import { businessDate, todayIso } from "../clock";
import { mdTable, docFooter, rowRef, addDays } from "./kit";
import type { DetectionFacts } from "./metrics";
import { checkMaterials } from "./materials";
import { recordCalc, usd, fmt } from "../calc";
import { num } from "../db";
import type { PricedLine } from "./contracts";
import { heldByOthers, hold, releaseOtherKeys } from "../resources";

const NAME = "Marine & Logistics AI (Hàng hải & hậu cần)";

function run(ctx: AgentContext): void {
  const o = ctx.o;
  const T = ctx.L;
  const SEAT = T("ghế", "seats");
  const DAYS = T("ngày", "days");
  const det = ctx.detection() as unknown as DetectionFacts;
  const platform = det.well.platform;
  if (ctx.feedback) o.warn(T(`Phản hồi của người duyệt (${ctx.feedback.actor}): "${ctx.feedback.comment}" — đã xem xét khi chạy lại.`, `Approver feedback (${ctx.feedback.actor}): "${ctx.feedback.comment}" — considered in this re-run.`));

  const proposalRun = ctx.up("ops.proposal")!;
  o.ev(T(`Phương án đã duyệt kỹ thuật: ${proposalRun.output.summary}`, `Technically approved option: ${proposalRun.output.summary}`), { kind: "task_run", id: proposalRun.runId });
  const activities = (proposalRun.output.facts.activities as Array<{ type: string; name: string }>) ?? [];
  const catalog = ctx.index("activity_catalog", "activity_type");
  const equipCat = ctx.index("equipment_catalog", "item");
  const limits = ctx.index("logistics_limits", "parameter");
  const limit = (p: string): number | null => (limits.get(p)?.data.value as number | undefined) ?? null;
  const incomplete: string[] = [];
  for (const p of ["max_hs_vessel_m", "max_wind_heli_kn", "pob_max", "pob_current"]) {
    if (limit(p) === null) {
      o.need({ description: T(`Thiếu giới hạn vận chuyển "${p}"`, `Transport limit "${p}" missing`), datasetType: "logistics_limits", blocking: false, owner: "Marine" });
      incomplete.push(T(`chưa có giới hạn ${p} — không kiểm tra được tiêu chí này`, `no ${p} limit — this criterion cannot be checked`));
    } else o.ev(T(`Giới hạn ${p} = ${limit(p)} ${limits.get(p)!.data.unit ?? ""}`, `Limit ${p} = ${limit(p)} ${limits.get(p)!.data.unit ?? ""}`), rowRef(limits.get(p)!));
  }

  // Earliest date: technical approval + lead days, later if purchased items have lead time
  const gate = ctx.db.prepare("SELECT d.id, d.decided_at FROM decisions d JOIN tasks t ON t.id = d.task_id WHERE t.workflow_id = ? AND t.key = 'gate.technical' AND d.decision = 'approve' ORDER BY d.id DESC LIMIT 1").get(ctx.workflow.id);
  const approvalDate = gate ? businessDate(String(gate.decided_at)) : todayIso();
  if (gate) o.ev(T(`Phê duyệt kỹ thuật ngày ${approvalDate}`, `Technical approval on ${approvalDate}`), { kind: "decision", id: num(gate.id) });
  const earliest = addDays(approvalDate, ctx.cfg.logistics.leadDays);
  const materials = checkMaterials(ctx, activities.map((a) => a.type));
  const purchaseLead = Math.max(0, ...materials.filter((m) => m.needsPurchase).map((m) => m.leadTimeDays ?? 0));
  const cargoEarliest = addDays(approvalDate, Math.max(ctx.cfg.logistics.leadDays, purchaseLead));
  const evEarliest = o.ev(
    T(`Sớm nhất: người ${earliest} (duyệt ${approvalDate} + ${ctx.cfg.logistics.leadDays} ngày); hàng ${cargoEarliest}${purchaseLead ? ` (lead time mua ${purchaseLead} ngày)` : ""}`, `Earliest: crew ${earliest} (approval ${approvalDate} + ${ctx.cfg.logistics.leadDays} days); cargo ${cargoEarliest}${purchaseLead ? ` (purchase lead time ${purchaseLead} days)` : ""}`),
    { kind: "calc", id: recordCalc(ctx.db, { label: T("Ngày huy động sớm nhất", "Earliest mobilisation date"), formula: T("ngày duyệt kỹ thuật + max(leadDays cấu hình, lead time vật tư mua mới)", "technical approval date + max(configured leadDays, purchase lead time)"), inputs: [{ name: T("ngày duyệt", "approval date"), value: approvalDate }, { name: "leadDays", value: ctx.cfg.logistics.leadDays, unit: DAYS }, { name: T("lead time mua", "purchase lead time"), value: purchaseLead, unit: DAYS }], result: Math.max(ctx.cfg.logistics.leadDays, purchaseLead), unit: DAYS }) },
  );

  // Demand: people + cargo
  let crew = 0;
  const cargo: Array<{ item: string; weight: number | null; deck: number | null; ev: string }> = [];
  for (const a of activities) {
    const c = catalog.get(a.type);
    if (!c) continue;
    crew += (c.data.crew_size as number | null) ?? 0;
    for (const e of (c.data.equipment as string[] | null) ?? []) {
      const ec = equipCat.get(e);
      if (!ec) {
        o.need({ description: T(`Thiết bị "${e}" chưa có khối lượng/diện tích trong equipment_catalog`, `Equipment "${e}" has no weight/area in equipment_catalog`), datasetType: "equipment_catalog", blocking: false, owner: "Marine & Logistics" });
        incomplete.push(T(`thiết bị ${e} chưa có khối lượng/diện tích — sức chứa boong/cẩu chưa kiểm tra đủ`, `equipment ${e} has no weight/area — deck/crane capacity not fully checked`));
        cargo.push({ item: e, weight: null, deck: null, ev: o.ev(T(`${a.name} cần thiết bị ${e}`, `${a.name} needs equipment ${e}`), rowRef(c)) });
      } else cargo.push({ item: e, weight: ec.data.weight_t as number, deck: ec.data.deck_m2 as number, ev: o.ev(`${e}: ${ec.data.weight_t} t, ${ec.data.deck_m2} m²`, rowRef(ec)) });
    }
  }
  for (const m of materials.filter((x) => x.needsTransport || x.needsPurchase)) {
    cargo.push({ item: m.part_no, weight: m.weightT, deck: m.deckM2, ev: m.evId });
    if (m.weightT === null || m.deckM2 === null) incomplete.push(T(`vật tư ${m.part_no} chưa có khối lượng/diện tích`, `material ${m.part_no} has no weight/area`));
  }
  const weight = cargo.reduce((s, c) => s + (c.weight ?? 0), 0);
  const deck = cargo.reduce((s, c) => s + (c.deck ?? 0), 0);
  const heaviest = Math.max(0, ...cargo.map((c) => c.weight ?? 0));
  const evCargo = o.ev(T(`Nhu cầu: ${crew} người; hàng ${fmt(weight, 2)} t, ${fmt(deck, 1)} m², kiện nặng nhất ${fmt(heaviest, 2)} t`, `Need: ${crew} persons; cargo ${fmt(weight, 2)} t, ${fmt(deck, 1)} m², heaviest item ${fmt(heaviest, 2)} t`), {
    kind: "calc",
    id: recordCalc(ctx.db, { label: T("Tổng hợp hàng hóa", "Cargo summary"), formula: T("Σ khối lượng, Σ diện tích boong, max khối lượng kiện", "Σ weight, Σ deck area, max item weight"), inputs: cargo.map((c) => ({ name: c.item, value: `${c.weight ?? "?"} t / ${c.deck ?? "?"} m²` })), result: weight, unit: "t" }),
  });
  o.conclude(T(`Nhu cầu huy động: ${crew} người, ${cargo.length} kiện hàng (${fmt(weight, 2)} t, ${fmt(deck, 1)} m²).`, `Mobilisation need: ${crew} persons, ${cargo.length} cargo item(s) (${fmt(weight, 2)} t, ${fmt(deck, 1)} m²).`), "calculated", [evCargo, ...cargo.map((c) => c.ev)]);

  // Weather lookup
  const weather = ctx.caseRows("weather_forecast");
  const wx = (date: string) => weather.find((w) => w.data.forecast_date === date);
  const hsMax = Math.min(limit("max_hs_vessel_m") ?? Infinity, limit("max_hs_crane_m") ?? Infinity);
  const conditions: string[] = [];

  // Vessel selection
  const voyages = ctx.caseRows("vessel_schedule").sort((a, b) => String(a.data.depart_date).localeCompare(String(b.data.depart_date)));
  const holdFailed: string[] = [];
  const holds: Array<{ type: string; key: string; qty: number; unit: string; status: string; date: string | null }> = [];
  let voyage: (typeof voyages)[number] | null = null;
  const rejected: Array<[string, string]> = [];
  if (cargo.length) {
    for (const v of voyages) {
      const d = v.data.depart_date as string;
      if (d < cargoEarliest) continue;
      const reasons: string[] = [];
      if (String(v.data.status ?? "").toLowerCase() === "cancelled") reasons.push(T("chuyến đã hủy", "voyage cancelled"));
      const others = heldByOthers(ctx.db, "vessel_deck", String(v.data.voyage_id), ctx.workflow.id);
      const freeDeck = (v.data.deck_m2_free as number | null) === null ? null : (v.data.deck_m2_free as number) - others.qty;
      if (freeDeck !== null && freeDeck < deck) {
        reasons.push(
          others.qty > 0
            ? T(`boong còn ${fmt(freeDeck, 1)} m² sau phần ${others.conflicts.map((c) => `${c.caseNo} giữ ${c.quantity} m²`).join(", ")} < ${fmt(deck, 1)} m²`, `deck left ${fmt(freeDeck, 1)} m² after ${others.conflicts.map((c) => `${c.caseNo} holds ${c.quantity} m²`).join(", ")} < ${fmt(deck, 1)} m²`)
            : T(`boong trống ${v.data.deck_m2_free} m² < ${fmt(deck, 1)} m²`, `free deck ${v.data.deck_m2_free} m² < ${fmt(deck, 1)} m²`),
        );
      }
      if ((v.data.max_lift_t as number | null) !== null && (v.data.max_lift_t as number) < heaviest) reasons.push(T(`giới hạn cẩu ${v.data.max_lift_t} t < ${fmt(heaviest, 2)} t`, `crane limit ${v.data.max_lift_t} t < ${fmt(heaviest, 2)} t`));
      const w = wx(d);
      if (w && Number.isFinite(hsMax) && (w.data.hs_m as number) > hsMax) reasons.push(`sóng Hs ${w.data.hs_m} m > ${hsMax} m`);
      const ev = o.ev(T(`${v.data.voyage_id} ${v.data.vessel} ${d}: ${reasons.length ? "loại — " + reasons.join("; ") : "đáp ứng"}${w ? ` (Hs dự báo ${w.data.hs_m} m)` : " (chưa có dự báo)"}`, `${v.data.voyage_id} ${v.data.vessel} ${d}: ${reasons.length ? "rejected — " + reasons.join("; ") : "suitable"}${w ? ` (forecast Hs ${w.data.hs_m} m)` : " (no forecast yet)"}`), rowRef(v));
      if (w) o.ev(T(`Dự báo ${d}: Hs ${w.data.hs_m} m, gió ${w.data.wind_kn} kn`, `Forecast ${d}: Hs ${w.data.hs_m} m, wind ${w.data.wind_kn} kn`), rowRef(w));
      if (reasons.length) {
        rejected.push([`${v.data.voyage_id} (${d})`, reasons.join("; ")]);
        continue;
      }
      const h = hold(ctx.db, { workflowId: ctx.workflow.id, revision: ctx.revision, type: "vessel_deck", key: String(v.data.voyage_id), quantity: Math.ceil(deck * 10) / 10, unit: "m²", capacity: (v.data.deck_m2_free as number | null) ?? null, taskId: ctx.task.id, holdDays: ctx.cfg.policy.holdDays });
      if (h.status === "conflict") {
        rejected.push([`${v.data.voyage_id} (${d})`, T(`vừa bị case khác giữ chỗ (${h.conflicts.map((c) => c.caseNo).join(", ")})`, `just held by another case (${h.conflicts.map((c) => c.caseNo).join(", ")})`)]);
        continue;
      }
      holds.push({ type: "vessel_deck", key: String(v.data.voyage_id), qty: Math.ceil(deck * 10) / 10, unit: "m²", status: "held", date: d });
      voyage = v;
      const checked = [`${T("diện tích boong", "deck area")}${incomplete.some((x) => /khối lượng|weight/.test(x)) ? T(" (chỉ với kiện đã biết kích thước)", " (only items with known size)") : ""}`, (v.data.max_lift_t as number | null) !== null ? T("giới hạn cẩu", "crane limit") : null, w && Number.isFinite(hsMax) ? T("giới hạn sóng", "wave limit") : null].filter(Boolean).join(", ");
      o.conclude(T(`Đề xuất chuyến tàu ${v.data.voyage_id} (${v.data.vessel}) khởi hành ${d} — kiểm tra được: ${checked}; đã GIỮ CHỖ NỘI BỘ ${fmt(deck, 1)} m² (chưa phải đặt chỗ).`, `Proposes voyage ${v.data.voyage_id} (${v.data.vessel}) departing ${d} — checked: ${checked}; INTERNAL HOLD of ${fmt(deck, 1)} m² placed (not a booking).`), "check", [ev, evEarliest, evCargo]);
      if (!w) conditions.push(T(`Cần dự báo thời tiết cho ngày ${d} trước khi xác nhận chuyến tàu`, `A weather forecast for ${d} is needed before the voyage is confirmed`));
      if (!w) incomplete.push(T(`chưa có dự báo thời tiết ngày ${d}`, `no weather forecast for ${d}`));
      break;
    }
    if (!voyage) {
      o.conclude(T(`Không có chuyến tàu nào trong lịch đáp ứng nhu cầu từ ${cargoEarliest}.`, `No scheduled voyage meets the need from ${cargoEarliest}.`), "check", [evEarliest, evCargo]);
      o.need({ description: T(`Không có chuyến tàu khả thi tới ${platform} từ ${cargoEarliest} — cần lịch tàu bổ sung hoặc thuê chuyến riêng`, `No feasible voyage to ${platform} from ${cargoEarliest} — more schedule data or a dedicated charter is needed`), datasetType: "vessel_schedule", blocking: false, owner: "Marine coordinator" });
    }
  }

  // Flight selection (crew travels when equipment is there)
  const crewFrom = voyage ? (voyage.data.depart_date as string) : earliest;
  let flight: ReturnType<typeof ctx.rows>[number] | null = null;
  if (crew > 0) {
    const flights = ctx.caseRows("flight_schedule").sort((a, b) => String(a.data.flight_date).localeCompare(String(b.data.flight_date)));
    for (const f of flights) {
      const d = f.data.flight_date as string;
      if (d < crewFrom) continue;
      const w = wx(d);
      const windOk = !w || limit("max_wind_heli_kn") === null || (w.data.wind_kn as number) <= limit("max_wind_heli_kn")!;
      const seatsHeld = heldByOthers(ctx.db, "flight_seats", String(f.data.flight_id), ctx.workflow.id);
      const seatsFree = (f.data.seats_free as number) - seatsHeld.qty;
      const seatsOk = seatsFree >= crew;
      const ev = o.ev(T(`Chuyến bay ${f.data.flight_id} ${d}: ${f.data.seats_free} chỗ trống${seatsHeld.qty ? `, ${seatsHeld.qty} đã được ${seatsHeld.conflicts.map((c) => c.caseNo).join(", ")} giữ` : ""}${w ? `, gió ${w.data.wind_kn} kn` : ", chưa có dự báo"} — ${seatsOk && windOk ? "đáp ứng" : !seatsOk ? "không đủ chỗ" : "gió vượt giới hạn"}`, `Flight ${f.data.flight_id} ${d}: ${f.data.seats_free} free seats${seatsHeld.qty ? `, ${seatsHeld.qty} held by ${seatsHeld.conflicts.map((c) => c.caseNo).join(", ")}` : ""}${w ? `, wind ${w.data.wind_kn} kn` : ", no forecast yet"} — ${seatsOk && windOk ? "suitable" : !seatsOk ? "not enough seats" : "wind above limit"}`), rowRef(f));
      if (seatsOk && windOk) {
        const h = hold(ctx.db, { workflowId: ctx.workflow.id, revision: ctx.revision, type: "flight_seats", key: String(f.data.flight_id), quantity: crew, unit: SEAT, capacity: f.data.seats_free as number, taskId: ctx.task.id, holdDays: ctx.cfg.policy.holdDays });
        if (h.status === "conflict") continue;
        holds.push({ type: "flight_seats", key: String(f.data.flight_id), qty: crew, unit: SEAT, status: "held", date: d });
        flight = f;
        o.conclude(T(`Đề xuất chuyến bay ${f.data.flight_id} ngày ${d} cho ${crew} người — đã GIỮ CHỖ NỘI BỘ ${crew} ghế (chưa phải đặt chỗ).`, `Proposes flight ${f.data.flight_id} on ${d} for ${crew} persons — INTERNAL HOLD of ${crew} seats placed (not a booking).`), "check", [ev]);
        if (!w) incomplete.push(T(`chưa có dự báo gió ngày bay ${d}`, `no wind forecast for the flight date ${d}`));
        break;
      }
    }
    if (!flight) o.need({ description: T(`Không có chuyến bay đủ ${crew} chỗ tới ${platform} từ ${crewFrom}`, `No flight with ${crew} seats to ${platform} from ${crewFrom}`), datasetType: "flight_schedule", blocking: false, owner: "Logistics" });
    const pobMax = limit("pob_max");
    const pobNow = limit("pob_current");
    if (pobMax !== null && pobNow !== null) {
      const cid = recordCalc(ctx.db, { label: T("Kiểm tra POB", "POB check"), formula: T("POB sau huy động = POB hiện tại + nhân sự huy động ≤ POB tối đa", "POB after mobilisation = current POB + mobilised crew ≤ maximum POB"), inputs: [{ name: T("POB hiện tại", "current POB"), value: pobNow, ref: rowRef(limits.get("pob_current")!) }, { name: T("huy động", "mobilised"), value: crew }, { name: T("POB tối đa", "maximum POB"), value: pobMax, ref: rowRef(limits.get("pob_max")!) }], result: pobNow + crew, unit: T("người", "persons") });
      const ev = o.ev(T(`POB ${pobNow} + ${crew} = ${pobNow + crew} / tối đa ${pobMax}`, `POB ${pobNow} + ${crew} = ${pobNow + crew} / max ${pobMax}`), { kind: "calc", id: cid });
      if (pobNow + crew > pobMax) {
        o.conclude(T(`POB sau huy động (${pobNow + crew}) vượt giới hạn ${pobMax}.`, `POB after mobilisation (${pobNow + crew}) exceeds the limit of ${pobMax}.`), "calculated", [ev]);
        conditions.push(T(`OIM cần sắp xếp giảm POB ${pobNow + crew - pobMax} người trước huy động`, `OIM must reduce POB by ${pobNow + crew - pobMax} person(s) before mobilisation`));
      } else o.conclude(T(`POB sau huy động ${pobNow + crew}/${pobMax} — trong giới hạn.`, `POB after mobilisation ${pobNow + crew}/${pobMax} — within the limit.`), "calculated", [ev]);
    }
  }

  // Cost estimate lines (estimates only — charter is shared)
  const estimates = ctx.index("cost_estimates", "item");
  const costLines: PricedLine[] = [];
  const unpriced: Array<{ activity: string; item: string; qty: number; reason: string }> = [];
  const addCost = (item: string, qty: number, label: string) => {
    const e = estimates.get(item);
    if (!e) {
      unpriced.push({ activity: T("Hậu cần", "Logistics"), item: label, qty, reason: T(`thiếu đơn giá ước tính "${item}"`, `no estimated rate for "${item}"`) });
      o.need({ description: T(`Thiếu đơn giá ước tính "${item}" cho chi phí hậu cần — tổng chi phí CHƯA ĐẦY ĐỦ`, `No estimated rate "${item}" for the logistics cost — total cost INCOMPLETE`), datasetType: "cost_estimates", blocking: false, owner: "Logistics" });
      return;
    }
    o.ev(T(`Ước tính ${item}: ${usd(e.data.estimate_usd as number)}/${e.data.unit} — ${e.data.basis}`, `Estimate ${item}: ${usd(e.data.estimate_usd as number)}/${e.data.unit} — ${e.data.basis}`), rowRef(e));
    costLines.push({ activity: T("Hậu cần", "Logistics"), item: label, qty, unit: (e.data.unit as string) ?? T("đv", "unit"), unitPrice: e.data.estimate_usd as number, amount: qty * (e.data.estimate_usd as number), basis: T(`Ước tính (${e.data.basis})`, `Estimate (${e.data.basis})`), documented: false, costCode: "OPX-LOG-MAR" });
  };
  if (voyage) addCost("vessel_deck_m2", Math.ceil(deck), T(`Phân bổ boong tàu ${voyage.data.voyage_id}`, `Deck allocation ${voyage.data.voyage_id}`));
  if (flight && crew) addCost("helicopter_seat_roundtrip", crew, T(`Ghế trực thăng khứ hồi ${flight.data.flight_id}`, `Round-trip helicopter seats ${flight.data.flight_id}`));
  const totalCost = costLines.reduce((s, l) => s + l.amount, 0);
  releaseOtherKeys(ctx.db, ctx.workflow.id, "vessel_deck", holds.filter((h) => h.type === "vessel_deck").map((h) => h.key), T("Kế hoạch đổi chuyến tàu", "Plan changed voyage"));
  releaseOtherKeys(ctx.db, ctx.workflow.id, "flight_seats", holds.filter((h) => h.type === "flight_seats").map((h) => h.key), T("Kế hoạch đổi chuyến bay", "Plan changed flight"));
  const infeasible = (cargo.length > 0 && !voyage) || (crew > 0 && !flight);
  if (cargo.length && !voyage) holdFailed.push(T("không giữ được chỗ boong trên chuyến tàu khả thi nào", "no deck space could be held on any feasible voyage"));
  if (crew > 0 && !flight) holdFailed.push(T(`không giữ được ${crew} ghế trên chuyến bay khả thi nào`, `${crew} seats could not be held on any feasible flight`));
  const feasibility = infeasible ? "infeasible" : incomplete.length ? "incomplete" : "feasible";
  if (feasibility === "incomplete") o.conclude(T(`Khả thi vận chuyển CHƯA kiểm tra đủ: ${[...new Set(incomplete)].join("; ")}.`, `Transport feasibility NOT fully checked: ${[...new Set(incomplete)].join("; ")}.`), "check", [evCargo]);

  conditions.push(T("Marine coordinator xác nhận đặt chỗ tàu/bay (hệ thống không tự đặt)", "Marine coordinator confirms the vessel/flight booking (the system books nothing)"));
  conditions.push(T("OIM chấp thuận danh sách nhân sự ra giàn", "OIM accepts the offshore crew list"));
  const mobilizationDate = [voyage?.data.depart_date as string | undefined, flight?.data.flight_date as string | undefined].filter(Boolean).sort().pop() ?? null;
  o.assume(T("Kế hoạch dựa trên lịch tàu, lịch bay, dự báo thời tiết tại thời điểm nhập; không phát lệnh điều tàu hay điều động nhân sự.", "The plan uses the vessel/flight schedules and weather forecast as imported; it issues no vessel order and mobilises no one."));

  const plan = ctx.saveDoc(
    "transport-plan",
    T(`Kế hoạch vận chuyển (đề xuất) — ${ctx.workflow.case_no}`, `Transport plan (proposed) — ${ctx.workflow.case_no}`),
    "transport_plan",
    T("vi", "en") === "en" ? `# Transport plan (proposed) — ${platform}\n\n- Crew: **${crew}** · Cargo: **${fmt(weight, 2)} t / ${fmt(deck, 1)} m²**\n- Earliest: crew ${earliest}, cargo ${cargoEarliest}\n- Vessel: ${voyage ? `**${voyage.data.voyage_id}** ${voyage.data.vessel} ${voyage.data.depart_date}` : "_no feasible voyage_"}\n- Flight: ${flight ? `**${flight.data.flight_id}** ${flight.data.flight_date}` : "_none_"}\n- Planned mobilisation date: **${mobilizationDate ?? "not set"}**\n\n## Cargo\n${mdTable(["Item", "Weight (t)", "Deck (m²)"], cargo.map((c) => [c.item, c.weight ?? "?", c.deck ?? "?"]))}\n\n## Internal holds (not bookings)\n${holds.length ? mdTable(["Type", "Trip", "Qty"], holds.map((h) => [h.type === "vessel_deck" ? "Vessel deck" : "Flight seats", h.key, `${h.qty} ${h.unit}`])) : "- None"}\n\n## Rejected voyages\n${rejected.length ? mdTable(["Voyage", "Reason"], rejected) : "- None"}\n\n## Dependencies & conditions to confirm\n${conditions.map((c) => `- ${c}`).join("\n")}\n\n## Logistics cost (estimate)\n${costLines.length ? mdTable(["Item", "Qty", "Unit price", "Amount"], costLines.map((l) => [l.item, l.qty, usd(l.unitPrice), usd(l.amount)])) : "_None_"}${docFooter(ctx, "Marine & Logistics AI")}` : `# Kế hoạch vận chuyển (đề xuất) — ${platform}\n\n- Nhân sự: **${crew}** người · Hàng: **${fmt(weight, 2)} t / ${fmt(deck, 1)} m²**\n- Sớm nhất: người ${earliest}, hàng ${cargoEarliest}\n- Tàu: ${voyage ? `**${voyage.data.voyage_id}** ${voyage.data.vessel} ${voyage.data.depart_date}` : "_chưa có chuyến khả thi_"}\n- Bay: ${flight ? `**${flight.data.flight_id}** ${flight.data.flight_date}` : "_chưa có_"}\n- Ngày huy động dự kiến: **${mobilizationDate ?? "chưa xác định"}**\n\n## Hàng hóa\n${mdTable(["Kiện", "Khối lượng (t)", "Boong (m²)"], cargo.map((c) => [c.item, c.weight ?? "?", c.deck ?? "?"]))}\n\n## Giữ chỗ nội bộ (chưa phải đặt chỗ)\n${holds.length ? mdTable(["Loại", "Chuyến", "SL"], holds.map((h) => [h.type === "vessel_deck" ? "Boong tàu" : "Ghế bay", h.key, `${h.qty} ${h.unit}`])) : "- Không có"}\n\n## Chuyến tàu bị loại\n${rejected.length ? mdTable(["Chuyến", "Lý do"], rejected) : "- Không có"}\n\n## Phụ thuộc & điều kiện cần xác nhận\n${conditions.map((c) => `- ${c}`).join("\n")}\n\n## Chi phí hậu cần (ước tính)\n${costLines.length ? mdTable(["Hạng mục", "SL", "Đơn giá", "Thành tiền"], costLines.map((l) => [l.item, l.qty, usd(l.unitPrice), usd(l.amount)])) : "_Không có_"}${docFooter(ctx, NAME)}`,
  );
  let bookingDocId: number | null = null;
  if (voyage) {
    bookingDocId = ctx.saveDoc(
      "vessel-booking-draft",
      T(`Yêu cầu đặt chỗ tàu (nháp) ${voyage.data.voyage_id}`, `Vessel booking request (draft) ${voyage.data.voyage_id}`),
      "vessel_booking_draft",
      T(
        `# BẢN NHÁP yêu cầu đặt chỗ ${voyage.data.voyage_id}\n\nTàu ${voyage.data.vessel}, khởi hành ${voyage.data.depart_date} tới ${platform}. Hàng: ${fmt(weight, 2)} t, ${fmt(deck, 1)} m²; kiện nặng nhất ${fmt(heaviest, 2)} t.\n\n> Chỉ gửi sau phê duyệt gửi trong Outbox.${docFooter(ctx, NAME)}`,
        `# DRAFT booking request ${voyage.data.voyage_id}\n\nVessel ${voyage.data.vessel}, departing ${voyage.data.depart_date} to ${platform}. Cargo: ${fmt(weight, 2)} t, ${fmt(deck, 1)} m²; heaviest item ${fmt(heaviest, 2)} t.\n\n> Send only after approval to send in the Outbox.${docFooter(ctx, "Marine & Logistics AI")}`,
      ),
    ).docId;
  }
  o.summary = T("vi", "en") === "en"
    ? `Transport plan (${feasibility === "feasible" ? "feasible" : feasibility === "incomplete" ? "NOT fully checked" : "NOT feasible"}): ${voyage ? `vessel ${voyage.data.voyage_id} ${voyage.data.depart_date}` : cargo.length ? "no feasible vessel" : "no vessel needed"}, ${flight ? `flight ${flight.data.flight_id} ${flight.data.flight_date}` : crew ? "no flight yet" : "no flight needed"}; internal holds ${holds.length}; estimated cost ${usd(totalCost)}${unpriced.length ? " (incomplete)" : ""}; ${conditions.length} condition(s) to confirm.`
    : `Kế hoạch vận chuyển (${feasibility === "feasible" ? "khả thi" : feasibility === "incomplete" ? "CHƯA kiểm tra đủ" : "KHÔNG khả thi"}): ${voyage ? `tàu ${voyage.data.voyage_id} ${voyage.data.depart_date}` : cargo.length ? "chưa có tàu khả thi" : "không cần tàu"}, ${flight ? `bay ${flight.data.flight_id} ${flight.data.flight_date}` : crew ? "chưa có chuyến bay" : "không cần bay"}; giữ chỗ nội bộ ${holds.length}; chi phí ước tính ${usd(totalCost)}${unpriced.length ? " (chưa đầy đủ)" : ""}; ${conditions.length} điều kiện cần xác nhận.`;
  o.next(T("Chuyển kế hoạch và chi phí hậu cần sang Tài chính", "Pass the plan and logistics cost to Finance"));
  o.facts = { mobilizationDate, voyage: (voyage?.data.voyage_id as string) ?? null, flight: (flight?.data.flight_id as string) ?? null, crew, cargo: { weight, deck, heaviest }, conditions, costLines, totalCost, planDocId: plan.docId, bookingDocId, feasibility, incomplete: [...new Set(incomplete)], holds, holdFailed, unpriced };
}

export const logisticsAgent: AgentDef = { id: "logistics_agent", name: NAME, room: "zone_logistics", run };
