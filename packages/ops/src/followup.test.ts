import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { OpsService } from "./service";
import { setClock, todayIso, businessDate } from "./clock";
import { hold, releaseOtherKeys, resourceUsage } from "./resources";
import type { GateCondition, Identity } from "./types";

/**
 * Regression tests for docs/reviews/2026-11-13-followup-review.md (H1–H4) and the
 * acceptance list of 2026-11-13-project-improvement-prompt.md. Temp databases,
 * pinned clock, simulated data — no network.
 */
const SAMPLE = path.resolve(__dirname, "../../../oilgas/sample-data");
const CONFIG = path.resolve(__dirname, "../../../oilgas/ops-config.json");
const HARNESS: Identity = { userId: "svc.test", name: "Test harness", roles: ["Tích hợp dữ liệu", "Quản trị hệ thống"], source: "service" };
const ENG_LEAD: Identity = { userId: "demo.englead", name: "Eng Lead", roles: ["Trưởng phòng Kỹ thuật khai thác"], source: "demo" };
const ASSET: Identity = { userId: "demo.asset", name: "Asset", roles: ["Asset Manager"], source: "demo" };
const OIM: Identity = { userId: "demo.oim", name: "OIM", roles: ["OIM"], source: "demo" };
const MARINE: Identity = { userId: "demo.marine", name: "Marine", roles: ["Marine coordinator"], source: "demo" };
/** An integration credential that happens to carry approver roles — must never decide */
const SVC_APPROVER: Identity = { userId: "svc.erp", name: "ERP sync", roles: ["Asset Manager", "OIM", "Marine coordinator", "Tích hợp dữ liệu"], source: "service" };

let dir: string;
let svc: OpsService;
let n = 0;
const key = () => `f${++n}`;

function mk(extra: Partial<ConstructorParameters<typeof OpsService>[0]> = {}) {
  svc = new OpsService({ dbPath: path.join(dir, "x.db"), configPath: CONFIG, taskDelayMs: 0, systemActor: HARNESS, ...extra });
  return svc;
}
beforeEach(() => {
  setClock(() => new Date("2026-11-12T08:00:00Z"));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-follow-"));
  mk();
});
afterEach(() => {
  svc?.stop();
  setClock(null);
  fs.rmSync(dir, { recursive: true, force: true });
});
const at = (iso: string) => setClock(() => new Date(iso));
const count = (t: string, where = "1=1") => Number(svc.db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${where}`).get()!.c);
const wf = () => svc.state().workflows.find((w) => w.wellKey === "SIM-WHP-A/A-03")!;
const T = () => Object.fromEntries(wf().tasks.map((t) => [t.key, t]));
const facts = (id: number) => svc.orch.currentOutput(svc.orch.task(id))!.facts as Record<string, unknown>;
const gate = (id: number) => facts(id) as { packageSha: string; conditions: GateCondition[]; role: string };
type Res = { id: number; resource_type: string; resource_key: string; quantity: number; unit: string; status: string; case_revision: number; external_ref: string | null; amendment_of: number | null };
const reservations = (where = "1=1") => svc.db.prepare(`SELECT * FROM reservations WHERE workflow_id = ? AND ${where} ORDER BY id`).all(wf().id) as unknown as Res[];
const active = (type: string) => reservations(`resource_type = '${type}' AND status IN ('held','confirmed')`);

async function toCommitGate() {
  await svc.loadSample(SAMPLE, "base");
  await svc.loadSample(SAMPLE, "supplements", "supplements/SIM_well_test_A-03_2026-11-11.csv");
  await svc.loadSample(SAMPLE, "supplements", "supplements/SIM_quotes_SupplyB.csv");
  await svc.orch.runUntilIdle();
  const t = T();
  svc.decide({ taskId: t["gate.technical"].id, decision: "approve", actor: ENG_LEAD, comment: "ok", packageSha: gate(t["gate.technical"].id).packageSha, idempotencyKey: key() });
  await svc.orch.runUntilIdle();
  expect(T()["gate.asset"].status).toBe("awaiting_approval");
}
async function approveCommit() {
  const t = T();
  svc.decide({ taskId: t["gate.asset"].id, decision: "approve", actor: ASSET, comment: "Duyệt cam kết", packageSha: gate(t["gate.asset"].id).packageSha, idempotencyKey: key() });
  await svc.orch.runUntilIdle();
}
/** Commitment approved and HSE documents complete → the readiness gate is open */
async function toReadinessGate() {
  await toCommitGate();
  await approveCommit();
  await svc.loadSample(SAMPLE, "supplements", "supplements/SIM_hse_simops_update.csv");
  svc.importRecords({ datasetType: "hse_documents", rows: [{ doc_id: "HSE-JSA-1201", title: "JSA", doc_type: "jsa", activity_type: "gl_fcv_inspection", scope: "SIM-WHP-A", status: "Approved", valid_to: "2027-05-31" }], simulated: true });
  await svc.orch.runUntilIdle();
  expect(T()["gate.readiness"].status).toBe("awaiting_approval");
}
const confirm = (r: Res, ref: string, extra: Partial<{ caseRevision: number; quantity: number; idempotencyKey: string; actor: Identity }> = {}) =>
  svc.confirmReservation({ id: r.id, externalRef: ref, quantity: r.quantity, caseRevision: wf().version, actor: MARINE, ...extra });

// ───────────────────────── H1 ─────────────────────────
describe("H1 — resources are checked against the plan in force", () => {
  it("commitment gate open → a required confirmed booking is cancelled → old package refused; the re-plan proceeds", async () => {
    await toCommitGate();
    const g = gate(T()["gate.asset"].id);
    const deck = active("vessel_deck")[0];
    confirm(deck, "BK-DECK-1");
    const decisions = count("decisions");
    svc.recordReservationCancelled({ id: deck.id, externalRef: "CXL-DECK-1", actor: MARINE });
    // The plan is stale immediately — no new import needed
    expect(T()["log.plan"].status).not.toBe("done");
    expect(svc.workflowDetail(wf().id).revisions.map((r) => r.reason).join(" | ")).toMatch(new RegExp(deck.resource_key));
    expect(() => svc.decide({ taskId: T()["gate.asset"].id, decision: "approve", actor: ASSET, comment: "ok", packageSha: g.packageSha, idempotencyKey: key() })).toThrow(new RegExp(`Lý do \\(rev \\d+\\)[\\s\\S]*${deck.resource_key}[\\s\\S]*hủy`));
    expect(count("decisions")).toBe(decisions);
    await svc.orch.runUntilIdle();
    // A valid replacement hold exists and the new package can be approved
    expect(active("vessel_deck").length).toBe(1);
    expect(T()["gate.asset"].status).toBe("awaiting_approval");
    expect(gate(T()["gate.asset"].id).packageSha).not.toBe(g.packageSha);
    await approveCommit();
    expect(T()["gate.asset"].status).toBe("done");
  });

  it("booking draft open → its booking is cancelled → approval refused (409) and the draft is replaced", async () => {
    await toCommitGate();
    await approveCommit();
    const deck = active("vessel_deck")[0];
    confirm(deck, "BK-DECK-2");
    const draft = svc.db.prepare("SELECT * FROM outbox WHERE kind = 'vessel_booking' AND status = 'draft'").get() as { id: number; doc_id: number; doc_sha256: string };
    svc.recordReservationCancelled({ id: deck.id, externalRef: "CXL-DECK-2", actor: MARINE });
    expect(() => svc.approveOutbox({ id: draft.id, docId: draft.doc_id, docSha256: draft.doc_sha256, actor: ASSET })).toThrow(/409|rev|superseded|đã hủy|vessel_deck|V-/);
    expect(svc.db.prepare("SELECT status FROM outbox WHERE id = ?").get(draft.id)!.status).not.toBe("approved_to_send");
  });

  it("direct check: a cancelled or cancel-requested booking the plan needs is a problem even though nothing expired", async () => {
    await toCommitGate();
    const deck = active("vessel_deck")[0];
    confirm(deck, "BK-DECK-3");
    svc.db.prepare("UPDATE reservations SET status = 'cancel_requested' WHERE id = ?").run(deck.id); // e.g. recorded by a sync, without the service hook
    const g = gate(T()["gate.asset"].id);
    expect(() => svc.decide({ taskId: T()["gate.asset"].id, decision: "approve", actor: ASSET, comment: "ok", packageSha: g.packageSha, idempotencyKey: key() })).toThrow(new RegExp(`${deck.resource_key}[\\s\\S]*(hủy|cancel)`));
  });

  it("historical cancelled / released bookings outside the current plan never block the case", async () => {
    await toCommitGate();
    const w = wf();
    // A booking for another voyage, confirmed then cancelled, and a hold the plan dropped
    const old = hold(svc.db, { workflowId: w.id, revision: w.version, type: "vessel_deck", key: "V-OLD", quantity: 3, unit: "m²", capacity: 50, taskId: null, holdDays: 7 });
    svc.confirmReservation({ id: old.id!, externalRef: "BK-OLD", quantity: 3, caseRevision: w.version, actor: MARINE });
    svc.recordReservationCancelled({ id: old.id!, externalRef: "CXL-OLD", actor: MARINE });
    hold(svc.db, { workflowId: w.id, revision: w.version, type: "flight_seats", key: "HL-OLD", quantity: 2, unit: "ghế", capacity: 10, taskId: null, holdDays: 7 });
    releaseOtherKeys(svc.db, w.id, "flight_seats", active("flight_seats").filter((r) => r.resource_key !== "HL-OLD").map((r) => r.resource_key), "Kế hoạch đổi chuyến bay");
    await svc.orch.runUntilIdle();
    expect(T()["gate.asset"].status).toBe("awaiting_approval");
    await approveCommit();
    expect(T()["gate.asset"].status).toBe("done");
  });

  it("readiness needs CONFIRMED bookings (data check, not a checkbox); a pending amendment is not a confirmation", async () => {
    await toReadinessGate();
    let g = gate(T()["gate.readiness"].id);
    const booked = g.conditions.find((c) => c.code === "transport_booked")!;
    expect(booked.kind).toBe("check");
    expect(booked.met).toBe(false);
    const confirms = g.conditions.filter((c) => c.kind === "confirm").map((c) => c.code);
    expect(() => svc.decide({ taskId: T()["gate.readiness"].id, decision: "approve", actor: OIM, comment: "ok", confirmations: [...confirms, "transport_booked"], packageSha: g.packageSha, idempotencyKey: key() })).toThrow(/xác nhận đặt|transport|tàu\/bay/i);
    // Confirm what the plan needs → the readiness package is refreshed without any import
    for (const r of [...active("vessel_deck"), ...active("flight_seats")]) confirm(r, `BK-${r.resource_key}`);
    await svc.orch.runUntilIdle();
    expect(T()["gate.readiness"].status).toBe("awaiting_approval");
    g = gate(T()["gate.readiness"].id);
    expect(g.conditions.find((c) => c.code === "transport_booked")!.met).toBe(true);
    const confirms2 = g.conditions.filter((c) => c.kind === "confirm").map((c) => c.code);
    svc.decide({ taskId: T()["gate.readiness"].id, decision: "approve", actor: OIM, comment: "PTW theo quy trình giàn", confirmations: confirms2, packageSha: g.packageSha, idempotencyKey: key() });
    expect(T()["gate.readiness"].status).toBe("done");
  });
});

describe("H1 — confirmations arriving while readiness is being rebuilt (race seen in the UI walk)", () => {
  it("second confirmation lands during the readiness re-run → the run is discarded as drift; the final package sees both", async () => {
    await toReadinessGate();
    svc.stop();
    mk({ taskDelayMs: 40 }); // asynchronous runner, like the dev server
    const rs = [...active("flight_seats"), ...active("vessel_deck")];
    expect(rs.length).toBe(2);
    confirm(rs[0], `BK-${rs[0].resource_key}`);
    const running = svc.orch.runUntilIdle(); // readiness re-runs …
    await new Promise((r) => setTimeout(r, 10));
    confirm(rs[1], `BK-${rs[1].resource_key}`); // … and the second confirmation arrives mid-run
    await running;
    await svc.orch.runUntilIdle();
    expect(T()["gate.readiness"].status).toBe("awaiting_approval");
    const booked = gate(T()["gate.readiness"].id).conditions.find((c) => c.code === "transport_booked")!;
    expect(booked.met).toBe(true);
  });
});

describe("H1 — plans made before the reservation ledger (existing databases)", () => {
  it("readiness does not pass transport unchecked; the approver returns the case to log.plan and the re-plan holds resources", async () => {
    await toReadinessGate();
    // Simulate a log.plan run from before the ledger: voyage/flight in facts, no holds, no rows
    const lp = svc.orch.task(T()["log.plan"].id);
    const run = svc.db.prepare("SELECT output_json FROM task_runs WHERE id = ?").get(lp.current_run_id)!;
    const out = JSON.parse(String(run.output_json));
    delete out.facts.holds;
    svc.db.prepare("UPDATE task_runs SET output_json = ? WHERE id = ?").run(JSON.stringify(out), lp.current_run_id);
    svc.db.prepare("DELETE FROM reservations WHERE workflow_id = ? AND resource_type != 'budget'").run(wf().id);
    svc.orch.refresh(wf().id, ["hse.readiness"], "test: legacy plan");
    await svc.orch.runUntilIdle();
    const g = gate(T()["gate.readiness"].id);
    const booked = g.conditions.find((c) => c.code === "transport_booked")!;
    expect(booked).toMatchObject({ kind: "check", met: false });
    expect(booked.detail).toMatch(/trước khi có sổ giữ chỗ[\s\S]*log\.plan/);
    svc.decide({ taskId: T()["gate.readiness"].id, decision: "request_changes", returnTo: "log.plan", actor: OIM, comment: "Lập lại kế hoạch hậu cần để giữ chỗ", packageSha: g.packageSha, idempotencyKey: key() });
    await svc.orch.runUntilIdle();
    expect(active("vessel_deck").length + active("flight_seats").length).toBeGreaterThan(0);
  });
});

// ───────────────────────── H2 ─────────────────────────
describe("H2 — a confirmation is bound to the current case revision", () => {
  it("case moved to rev 2: a form for rev 1 is refused; rev 2 is refused until the plan in force covers the hold", () => {
    const now = "2026-11-12T08:00:00Z";
    svc.db.prepare("INSERT INTO workflows (case_no, title, well, platform, status, version, created_at, updated_at, detection_json) VALUES ('CASE-H2', 't', 'W', 'P', 'open', 1, ?, ?, '{}')").run(now, now);
    const w = Number(svc.db.prepare("SELECT id FROM workflows WHERE case_no = 'CASE-H2'").get()!.id);
    const h = hold(svc.db, { workflowId: w, revision: 1, type: "vessel_deck", key: "V-H2", quantity: 10, unit: "m²", capacity: 30, taskId: null, holdDays: 7 });
    svc.db.prepare("UPDATE workflows SET version = 2 WHERE id = ?").run(w);
    expect(() => svc.confirmReservation({ id: h.id!, externalRef: "BK-H2", quantity: 10, caseRevision: 1, actor: MARINE })).toThrow(/rev 2/);
    expect(() => svc.confirmReservation({ id: h.id!, externalRef: "BK-H2", quantity: 10, caseRevision: 2, actor: MARINE })).toThrow(/kế hoạch|rev 1/);
    expect(svc.db.prepare("SELECT status, external_ref FROM reservations WHERE id = ?").get(h.id)).toMatchObject({ status: "held", external_ref: null });
  });

  it("revision bumped by an unrelated branch: the hold is carried forward with evidence; an old-revision form is refused", async () => {
    await toCommitGate();
    const v = wf().version;
    const deck = active("vessel_deck")[0];
    expect(deck.case_revision).toBe(v);
    // User opens the form at rev v … meanwhile a quote changes (procurement branch only) → rev v+1
    svc.importRecords({ datasetType: "quotes", rows: [{ rfq_ref: "RFQ-C", part_no: "SL-CONSUMABLES-KIT", vendor: "SIM Supply Co. C", unit_price_usd: 6100, valid_to: "2026-12-31" }], simulated: true });
    expect(wf().version).toBe(v + 1);
    expect(T()["log.plan"].status).toBe("done");
    expect(() => confirm(deck, "BK-CF", { caseRevision: v })).toThrow(/rev/);
    expect(svc.db.prepare("SELECT external_ref FROM reservations WHERE id = ?").get(deck.id)!.external_ref).toBeNull();
    confirm(deck, "BK-CF", { caseRevision: v + 1 });
    const row = svc.db.prepare("SELECT * FROM reservations WHERE id = ?").get(deck.id)!;
    expect(row).toMatchObject({ status: "confirmed", confirmed_revision: v + 1, case_revision: v + 1 });
    const ev = svc.db.prepare("SELECT * FROM reservation_events WHERE reservation_id = ? AND kind = 'carry_forward'").get(deck.id)!;
    expect(ev).toMatchObject({ from_revision: v, to_revision: v + 1 });
    expect(String(ev.detail_json)).toMatch(/log\.plan/);
    expect(String(ev.content_sha)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a confirmed booking whose content is unchanged by a re-plan is carried forward, not amended or double counted", async () => {
    await toCommitGate();
    const deck = active("vessel_deck")[0];
    confirm(deck, "BK-SAME");
    const v = wf().version;
    // New weather data for the platform → logistics re-plans; same voyage, same deck area
    svc.importRecords({ datasetType: "weather_forecast", rows: [{ forecast_date: "2026-12-30", location: "SIM-WHP-A", hs_m: 1, wind_kn: 10, issued_at: "2026-11-12T06:00:00Z" }], simulated: true });
    await svc.orch.runUntilIdle();
    expect(wf().version).toBeGreaterThan(v);
    const rows = reservations(`resource_type = 'vessel_deck' AND resource_key = '${deck.resource_key}'`);
    expect(rows.map((r) => r.status)).toEqual(["confirmed"]);
    expect(resourceUsage(svc.db, "vessel_deck", deck.resource_key)).toBe(deck.quantity);
    expect(count("reservation_events", `reservation_id = ${deck.id} AND kind = 'carry_forward' AND to_revision = ${wf().version}`)).toBe(1);
  });

  it("retry / restart / idempotency key: no duplicate confirmation, audit or reservation; a reused key with another payload is refused", async () => {
    await toCommitGate();
    const deck = active("vessel_deck")[0];
    expect(confirm(deck, "BK-IDEM", { idempotencyKey: "idem-1" })).toEqual({ duplicate: false });
    expect(confirm(deck, "BK-IDEM", { idempotencyKey: "idem-1" })).toEqual({ duplicate: true });
    expect(() => confirm(deck, "BK-OTHER", { idempotencyKey: "idem-1" })).toThrow(/idempotencyKey|khóa/);
    expect(count("audit_log", "action = 'reservation.confirm'")).toBe(1);
    const digest = [count("reservations"), count("decisions"), count("audit_log"), count("reservation_events")];
    svc.stop();
    mk(); // restart on the same database
    await svc.orch.runUntilIdle();
    expect([count("reservations"), count("decisions"), count("audit_log"), count("reservation_events")]).toEqual(digest);
    expect(confirm(deck, "BK-IDEM", { idempotencyKey: "idem-1" })).toEqual({ duplicate: true });
  });
});

// ───────────────────────── H3 ─────────────────────────
describe("H3 — only people decide gates and approve sending", () => {
  it("a service principal with the right role is refused (403) at the gate and the Outbox; nothing changes; a person still can", async () => {
    await toCommitGate();
    const g = gate(T()["gate.asset"].id);
    const digest = () => [count("decisions"), count("audit_log"), count("outbox", "status = 'approved_to_send'"), count("reservations"), T()["gate.asset"].status].join("|");
    const before = digest();
    expect(() => svc.decide({ taskId: T()["gate.asset"].id, decision: "approve", actor: SVC_APPROVER, comment: "auto", packageSha: g.packageSha, idempotencyKey: key() })).toThrow(/người|service/);
    expect(digest()).toBe(before);
    await approveCommit();
    expect(T()["gate.asset"].status).toBe("done");
    const draft = svc.db.prepare("SELECT * FROM outbox WHERE kind = 'purchase_requisition' AND status = 'draft'").get() as { id: number; doc_id: number; doc_sha256: string };
    const before2 = digest();
    expect(() => svc.approveOutbox({ id: draft.id, docId: draft.doc_id, docSha256: draft.doc_sha256, actor: SVC_APPROVER })).toThrow(/người|service/);
    expect(digest()).toBe(before2);
    expect(svc.approveOutbox({ id: draft.id, docId: draft.doc_id, docSha256: draft.doc_sha256, actor: ASSET }).status).toBe("approved_to_send");
  });

  it("no detour: execution, booking confirm/cancel and LLM configuration refuse service principals", async () => {
    await toCommitGate();
    const deck = active("vessel_deck")[0];
    expect(() => svc.confirmReservation({ id: deck.id, externalRef: "BK-S", quantity: deck.quantity, caseRevision: wf().version, actor: SVC_APPROVER })).toThrow(/người|service/);
    expect(() => svc.recordReservationCancelled({ id: deck.id, externalRef: "CXL-S", actor: SVC_APPROVER })).toThrow(/người|service/);
    expect(() => svc.recordExecution({ workflowId: wf().id, activityType: "x", status: "done", completedDate: "2026-11-12", actor: SVC_APPROVER })).toThrow(/người|service/);
    expect(() => svc.authorizeLlmConfigure({ ...SVC_APPROVER, roles: ["Quản trị hệ thống"] })).toThrow(/người|service/);
  });
});

// ───────────────────────── H4 ─────────────────────────
describe("H4 — readiness re-checked at the moment of the decision", () => {
  async function readyWithBookings() {
    await toReadinessGate();
    for (const r of [...active("vessel_deck"), ...active("flight_seats")]) confirm(r, `BK-${r.resource_key}`);
    await svc.orch.runUntilIdle();
    expect(T()["gate.readiness"].status).toBe("awaiting_approval");
    return gate(T()["gate.readiness"].id);
  }
  const approveReadiness = (g: { packageSha: string; conditions: GateCondition[] }) =>
    svc.decide({ taskId: T()["gate.readiness"].id, decision: "approve", actor: OIM, comment: "PTW theo quy trình giàn", confirmations: g.conditions.filter((c) => c.kind === "confirm").map((c) => c.code), packageSha: g.packageSha, idempotencyKey: key() });
  /** Change an active data row in place (as a direct sync would) — bypasses impact analysis on purpose */
  const patchRow = (type: string, match: (d: Record<string, unknown>) => boolean, patch: Record<string, unknown>) => {
    const rows = svc.db.prepare("SELECT id, data_json FROM data_rows WHERE dataset_type = ? AND status = 'active'").all(type);
    const r = rows.find((x) => match(JSON.parse(String(x.data_json))))!;
    svc.db.prepare("UPDATE data_rows SET data_json = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(String(r.data_json)), ...patch }), r.id);
  };

  it("a required HSE document no longer valid at the click → 409 naming it; readiness rebuilt from current data", async () => {
    const g = await readyWithBookings();
    const docs = (facts(T()["hse.readiness"].id).documents as Array<{ docId: string }>) ?? [];
    expect(docs.length).toBeGreaterThan(0);
    const docId = docs[0].docId;
    patchRow("hse_documents", (d) => d.doc_id === docId, { status: "Withdrawn" });
    const before = count("decisions");
    expect(() => approveReadiness(g)).toThrow(new RegExp(`${docId}[\\s\\S]*Withdrawn`));
    expect(count("decisions")).toBe(before);
    await svc.orch.runUntilIdle();
    expect(T()["hse.readiness"].status).toBe("missing_data");
    expect(T()["hse.readiness"].blocking.join(" ")).toMatch(/Withdrawn/);
  });

  it("weather at the planned date beyond the transport limit → refused at the click; the plan is re-checked", async () => {
    const g = await readyWithBookings();
    const planned = String(facts(T()["hse.readiness"].id).plannedDate);
    patchRow("weather_forecast", (d) => d.forecast_date === planned && d.location === "SIM-WHP-A", { hs_m: 9, wind_kn: 60 });
    expect(() => approveReadiness(g)).toThrow(/Hs 9|gió 60/);
    expect(T()["gate.readiness"].status).not.toBe("done");
  });

  it("readiness open → an HSE document changes through import → stale branch; refresh shows the new package", async () => {
    const g = await readyWithBookings();
    const v = wf().version;
    const docs = (facts(T()["hse.readiness"].id).documents as Array<{ docId: string }>) ?? [];
    const row = svc.db.prepare("SELECT data_json FROM data_rows WHERE dataset_type = 'hse_documents' AND status = 'active'").all().map((r) => JSON.parse(String(r.data_json))).find((d) => d.doc_id === docs[0].docId)!;
    svc.importRecords({ datasetType: "hse_documents", rows: [{ ...row, valid_to: "2026-11-13", updated_at: "2026-11-12T09:00:00Z" }], simulated: true });
    expect(wf().version).toBe(v + 1);
    expect(() => approveReadiness(g)).toThrow();
    await svc.orch.runUntilIdle();
    expect(T()["hse.readiness"].status).toBe("missing_data");
    // bookings were not touched by an HSE change
    expect(count("reservations", "workflow_id = " + wf().id + " AND status = 'confirmed' AND resource_type != 'budget'")).toBeGreaterThan(0);
  });

  it("planned date passes before the click → 409, logistics re-planned (no booking cancelled by the system)", async () => {
    const g = await readyWithBookings();
    const planned = String(facts(T()["hse.readiness"].id).plannedDate);
    at(`${planned}T23:00:00Z`); // next business day in Asia/Ho_Chi_Minh
    expect(todayIso() > planned).toBe(true);
    expect(() => approveReadiness(g)).toThrow(/đã qua/);
    expect(count("reservations", "status = 'cancelled'")).toBe(0);
    expect(T()["log.plan"].status).not.toBe("done");
  });

  it("valid_from after the execution date → the document does not count (a checkbox cannot replace it)", async () => {
    await toCommitGate();
    await approveCommit();
    await svc.loadSample(SAMPLE, "supplements", "supplements/SIM_hse_simops_update.csv");
    svc.importRecords({ datasetType: "hse_documents", rows: [{ doc_id: "HSE-JSA-1201", title: "JSA", doc_type: "jsa", activity_type: "gl_fcv_inspection", scope: "SIM-WHP-A", status: "Approved", valid_from: "2027-01-01", valid_to: "2027-05-31" }], simulated: true });
    await svc.orch.runUntilIdle();
    expect(T()["hse.readiness"].status).toBe("missing_data");
    expect(T()["hse.readiness"].blocking.join(" ")).toMatch(/chỉ hiệu lực từ 2027-01-01/);
  });

  it("expiry boundary: a hold is valid strictly before expires_at and expired at it", () => {
    const now0 = "2026-11-12T08:00:00Z";
    svc.db.prepare("INSERT INTO workflows (case_no, title, well, platform, status, version, created_at, updated_at, detection_json) VALUES ('CASE-EXP', 't', 'W', 'P', 'open', 1, ?, ?, '{}')").run(now0, now0);
    const w = Number(svc.db.prepare("SELECT id FROM workflows WHERE case_no = 'CASE-EXP'").get()!.id);
    const a = hold(svc.db, { workflowId: w, revision: 1, type: "vessel_deck", key: "V-A", quantity: 1, unit: "m²", capacity: 10, taskId: null, holdDays: 1 });
    const b = hold(svc.db, { workflowId: w, revision: 1, type: "vessel_deck", key: "V-B", quantity: 1, unit: "m²", capacity: 10, taskId: null, holdDays: 1 });
    at("2026-11-13T07:59:59.999Z");
    expect(svc.confirmReservation({ id: a.id!, externalRef: "BK-A", quantity: 1, caseRevision: 1, actor: MARINE }).duplicate).toBe(false);
    at("2026-11-13T08:00:00.000Z");
    expect(() => svc.confirmReservation({ id: b.id!, externalRef: "BK-B", quantity: 1, caseRevision: 1, actor: MARINE })).toThrow(/hết hạn/);
    expect(svc.db.prepare("SELECT status FROM reservations WHERE id = ?").get(b.id)!.status).toBe("expired");
  });

  it("business dates come from one configured time zone (ops-config calendar.timeZone)", () => {
    at("2026-11-12T18:30:00Z"); // 01:30 on 13/11 in Asia/Ho_Chi_Minh
    expect(todayIso()).toBe("2026-11-13");
    expect(businessDate("2026-11-12T16:59:59Z")).toBe("2026-11-12");
    expect(businessDate("2026-11-12T17:00:00Z")).toBe("2026-11-13");
  });
});
