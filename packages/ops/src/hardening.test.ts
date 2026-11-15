import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { OpsService } from "./service";
import { setClock } from "./clock";
import { hold, releaseCase, resourceUsage } from "./resources";
import type { GateCondition, Identity } from "./types";
import { rowInScope, type CaseScope } from "./caseModel";
import type { ActiveRow } from "./datasets";

/**
 * Regression tests for docs/reviews/2026-11-13-project-review.md (F1–F4) and the
 * mandatory acceptance list of 2026-11-13-project-improvement-prompt.md §5.
 * Temp databases, pinned clock, simulated data — no network.
 */
const SAMPLE = path.resolve(__dirname, "../../../oilgas/sample-data");
const CONFIG = path.resolve(__dirname, "../../../oilgas/ops-config.json");
const HARNESS: Identity = { userId: "svc.test", name: "Test harness", roles: ["Tích hợp dữ liệu", "Quản trị hệ thống"], source: "service" };
const ENG_LEAD: Identity = { userId: "demo.englead", name: "Eng Lead", roles: ["Trưởng phòng Kỹ thuật khai thác"], source: "demo" };
const ASSET: Identity = { userId: "demo.asset", name: "Asset", roles: ["Asset Manager"], source: "demo" };
const ENGINEER: Identity = { userId: "demo.engineer", name: "Kỹ sư", roles: ["Kỹ sư khai thác"], source: "demo" };
const MARINE: Identity = { userId: "demo.marine", name: "Marine", roles: ["Marine coordinator"], source: "demo" };
const ADMIN: Identity = { userId: "demo.admin", name: "Admin", roles: ["Quản trị hệ thống"], source: "demo" };

let dir: string;
let svc: OpsService;
let n = 0;
const key = () => `h${++n}`;

function mk(extra: Partial<ConstructorParameters<typeof OpsService>[0]> = {}) {
  svc = new OpsService({ dbPath: path.join(dir, "x.db"), configPath: CONFIG, taskDelayMs: 0, systemActor: HARNESS, ...extra });
  return svc;
}
beforeEach(() => {
  setClock(() => new Date("2026-11-12T08:00:00Z"));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-hard-"));
  mk();
});
afterEach(() => {
  svc?.stop();
  setClock(null);
  fs.rmSync(dir, { recursive: true, force: true });
});
const at = (iso: string) => setClock(() => new Date(iso));
const fakeCase = (no: string) => {
  const now = "2026-11-12T08:00:00Z";
  svc.db.prepare("INSERT INTO workflows (case_no, title, well, platform, status, version, created_at, updated_at, detection_json) VALUES (?, 't', 'W', 'P', 'open', 1, ?, ?, '{}')").run(no, now, now);
  return Number(svc.db.prepare("SELECT id FROM workflows WHERE case_no = ?").get(no)!.id);
};
const dbDigest = () =>
  JSON.stringify(["workflows", "tasks", "task_runs", "data_rows", "imports", "reservations", "decisions", "events", "settings"].map((t) => svc.db.prepare(`SELECT COUNT(*) c FROM ${t}`).get()!.c));
const wf = () => svc.state().workflows.find((w) => w.wellKey === "SIM-WHP-A/A-03")!;
const T = () => Object.fromEntries(wf().tasks.map((t) => [t.key, t]));
const facts = (id: number) => svc.orch.currentOutput(svc.orch.task(id))!.facts as Record<string, unknown>;
const gate = (id: number) => facts(id) as { packageSha: string; conditions: GateCondition[]; role: string };

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

// ───────────────────────── F1 ─────────────────────────
describe("F1 — confirming an expired hold is refused at the time of the action", () => {
  it("expired but never polled → refused; same result after a poll", () => {
    const w = fakeCase("CASE-F1");
    const h = hold(svc.db, { workflowId: w, revision: 1, type: "vessel_deck", key: "V-1", quantity: 10, unit: "m²", capacity: 30, taskId: null, holdDays: 1 });
    at("2026-11-14T08:00:00Z"); // past expires_at, nothing has called expireHolds
    expect(() => svc.confirmReservation({ id: h.id!, externalRef: "BK-1", quantity: 10, caseRevision: 1, actor: MARINE })).toThrow(/hết hạn/);
    expect(svc.db.prepare("SELECT status, external_ref FROM reservations WHERE id = ?").get(h.id)).toMatchObject({ status: "expired", external_ref: null });

    const h2 = hold(svc.db, { workflowId: fakeCase("CASE-F1b"), revision: 1, type: "vessel_deck", key: "V-2", quantity: 10, unit: "m²", capacity: 30, taskId: null, holdDays: 1 });
    at("2026-11-16T08:00:00Z");
    svc.state(); // poll path
    expect(() => svc.confirmReservation({ id: h2.id!, externalRef: "BK-2", quantity: 10, caseRevision: 1, actor: MARINE })).toThrow(/hết hạn/);
  });
});

// ───────────────────────── F2 ─────────────────────────
describe("F2 — an external confirmation is bound to its content", () => {
  it("10 m² confirmed as BK-10, plan grows to 70 m² at a new revision → confirmation not inherited", () => {
    const w = fakeCase("CASE-F2");
    const h = hold(svc.db, { workflowId: w, revision: 1, type: "vessel_deck", key: "V-9", quantity: 10, unit: "m²", capacity: 100, taskId: null, holdDays: 7 });
    svc.confirmReservation({ id: h.id!, externalRef: "BK-10", quantity: 10, caseRevision: 1, actor: MARINE });
    svc.db.prepare("UPDATE workflows SET version = 2 WHERE id = ?").run(w); // the case moved to rev 2 and its plan needs 70
    const h70 = hold(svc.db, { workflowId: w, revision: 2, type: "vessel_deck", key: "V-9", quantity: 70, unit: "m²", capacity: 100, taskId: null, holdDays: 7 });
    expect(h70.id).not.toBe(h.id);
    const old = svc.db.prepare("SELECT * FROM reservations WHERE id = ?").get(h.id)!;
    expect(old).toMatchObject({ status: "confirmed", quantity: 10, external_ref: "BK-10", confirmed_quantity: 10, confirmed_revision: 1 });
    expect(String(old.change_note)).toMatch(/70/);
    const amend = svc.db.prepare("SELECT * FROM reservations WHERE id = ?").get(h70.id)!;
    expect(amend).toMatchObject({ status: "held", quantity: 70, external_ref: null, amendment_of: h.id });
    // capacity counts the booking chain once (max of old/new), not 10 + 70
    expect(resourceUsage(svc.db, "vessel_deck", "V-9")).toBe(70);
    // retry of the same plan does not add rows
    hold(svc.db, { workflowId: w, revision: 2, type: "vessel_deck", key: "V-9", quantity: 70, unit: "m²", capacity: 100, taskId: null, holdDays: 7 });
    expect(svc.db.prepare("SELECT COUNT(*) c FROM reservations WHERE workflow_id = ?").get(w)!.c).toBe(2);
    // the old reference cannot be reused for the new content (no double counting on re-import)
    expect(() => svc.confirmReservation({ id: h70.id!, externalRef: "BK-10", quantity: 70, caseRevision: 2, actor: MARINE })).toThrow(/BK-10/);
    // confirming with stale content is refused
    expect(() => svc.confirmReservation({ id: h70.id!, externalRef: "BK-70", quantity: 10, caseRevision: 2, actor: MARINE })).toThrow(/nội dung/);
    svc.confirmReservation({ id: h70.id!, externalRef: "BK-70", quantity: 70, caseRevision: 2, actor: MARINE });
    expect(svc.db.prepare("SELECT status FROM reservations WHERE id = ?").get(h.id)!.status).toBe("superseded");
    expect(resourceUsage(svc.db, "vessel_deck", "V-9")).toBe(70);
  });

  it("dropping a confirmed booking from the plan asks for cancellation — capacity is kept until a person records it", () => {
    const w = fakeCase("CASE-F2c");
    const h = hold(svc.db, { workflowId: w, revision: 1, type: "vessel_deck", key: "V-8", quantity: 20, unit: "m²", capacity: 30, taskId: null, holdDays: 7 });
    svc.confirmReservation({ id: h.id!, externalRef: "BK-20", quantity: 20, caseRevision: 1, actor: MARINE });
    releaseCase(svc.db, w, "case đóng");
    expect(svc.db.prepare("SELECT status FROM reservations WHERE id = ?").get(h.id)!.status).toBe("cancel_requested");
    expect(resourceUsage(svc.db, "vessel_deck", "V-8")).toBe(20);
    const other = fakeCase("CASE-F2d");
    expect(hold(svc.db, { workflowId: other, revision: 1, type: "vessel_deck", key: "V-8", quantity: 15, unit: "m²", capacity: 30, taskId: null, holdDays: 7 }).status).toBe("conflict");
    svc.recordReservationCancelled({ id: h.id!, externalRef: "CXL-20", actor: MARINE });
    expect(resourceUsage(svc.db, "vessel_deck", "V-8")).toBe(0);
    expect(hold(svc.db, { workflowId: other, revision: 1, type: "vessel_deck", key: "V-8", quantity: 15, unit: "m²", capacity: 30, taskId: null, holdDays: 7 }).status).toBe("held");
  });

  it("two cases competing while one amends: never above capacity; retry adds nothing", () => {
    const a = fakeCase("CASE-A");
    const b = fakeCase("CASE-B");
    const p = { type: "vessel_deck" as const, key: "V-7", unit: "m²", capacity: 30, taskId: null, holdDays: 7 };
    const ha = hold(svc.db, { ...p, workflowId: a, revision: 1, quantity: 20 });
    svc.confirmReservation({ id: ha.id!, externalRef: "BK-A", quantity: 20, caseRevision: 1, actor: MARINE });
    expect(hold(svc.db, { ...p, workflowId: b, revision: 1, quantity: 15 }).status).toBe("conflict");
    expect(hold(svc.db, { ...p, workflowId: a, revision: 2, quantity: 25 }).status).toBe("held"); // amendment uses its own booking's space
    expect(hold(svc.db, { ...p, workflowId: b, revision: 1, quantity: 6 }).status).toBe("conflict");
    expect(hold(svc.db, { ...p, workflowId: b, revision: 1, quantity: 5 }).status).toBe("held");
    expect(hold(svc.db, { ...p, workflowId: b, revision: 1, quantity: 5 }).status).toBe("held"); // retry
    expect(resourceUsage(svc.db, "vessel_deck", "V-7")).toBe(30);
    expect(svc.db.prepare("SELECT COUNT(*) c FROM reservations WHERE workflow_id = ? AND status = 'held'").get(b)!.c).toBe(1);
  });
});

// ───────────────────────── F3 ─────────────────────────
describe("F3 — time- and resource-dependent conditions are re-checked when deciding", () => {
  it("gate opened with valid holds; holds expire before the click → 409 naming the resources, branch re-planned", async () => {
    await toCommitGate();
    const t = T();
    const g = gate(t["gate.asset"].id);
    expect(g.conditions.every((c) => c.met)).toBe(true);
    at("2026-11-20T09:00:00Z"); // policy.holdDays = 7
    const before = svc.db.prepare("SELECT COUNT(*) c FROM decisions").get()!.c;
    expect(() => svc.decide({ taskId: t["gate.asset"].id, decision: "approve", actor: ASSET, comment: "ok", packageSha: g.packageSha, idempotencyKey: key() })).toThrow(/hết hạn[\s\S]*(V-1|HL-|OPX-)/);
    expect(svc.db.prepare("SELECT COUNT(*) c FROM decisions").get()!.c).toBe(before);
    const after = T();
    expect(after["gate.asset"].status).not.toBe("awaiting_approval"); // old package no longer open
    expect(String(after["log.plan"].note ?? "") + String(after["fin.check"].note ?? "")).toMatch(/hết hạn/);
    await svc.orch.runUntilIdle();
    const again = T();
    expect(again["gate.asset"].status).toBe("awaiting_approval");
    expect(gate(again["gate.asset"].id).packageSha).not.toBe(g.packageSha);
  });

  it("booking draft approval re-checks the hold behind it", async () => {
    await toCommitGate();
    const t = T();
    const g = gate(t["gate.asset"].id);
    svc.decide({ taskId: t["gate.asset"].id, decision: "approve", actor: ASSET, comment: "ok", packageSha: g.packageSha, idempotencyKey: key() });
    await svc.orch.runUntilIdle();
    const booking = svc.db.prepare("SELECT * FROM outbox WHERE kind = 'vessel_booking' AND status = 'draft'").get() as { id: number; doc_id: number; doc_sha256: string };
    at("2026-11-21T09:00:00Z");
    expect(() => svc.approveOutbox({ id: booking.id, docId: booking.doc_id, docSha256: booking.doc_sha256, actor: ASSET })).toThrow(/hết hạn/);
    expect(svc.db.prepare("SELECT status FROM outbox WHERE id = ?").get(booking.id)!.status).not.toBe("approved_to_send");
  });
});

// ───────────────────────── F4 ─────────────────────────
describe("F4 — every mutation checks identity and permission in the core", () => {
  it("reset / fault: no identity → 401, wrong role → 403, production → 403; database unchanged", async () => {
    await svc.loadSample(SAMPLE, "base");
    const before = dbDigest();
    const noHarness = mk({ systemActor: undefined });
    expect(() => noHarness.reset()).toThrow(/danh tính/);
    expect(() => noHarness.reset(ENGINEER)).toThrow(/quyền|vai trò/);
    expect(() => noHarness.setFault("maint_agent", 1, ENGINEER)).toThrow(/quyền|vai trò/);
    expect(dbDigest()).toBe(before);
    noHarness.stop();
    noHarness.db.close();
    const prod = mk({ systemActor: undefined, operatingMode: "production" });
    expect(() => prod.reset({ ...ADMIN, source: "enterprise" })).toThrow(/production|vận hành/);
    expect(dbDigest()).toBe(before);
    prod.stop();
    prod.db.close();
    const demo = mk({ systemActor: undefined });
    demo.reset(ADMIN); // allowed: demo environment + configured admin role
    expect(demo.db.prepare("SELECT COUNT(*) c FROM data_rows").get()!.c).toBe(0);
    expect(demo.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'admin.reset'").get()!.c).toBe(1);
  });

  it("import: no identity → 401; role not allowed for the dataset → 403; service principal limited to its datasets", () => {
    const s = mk({ systemActor: undefined });
    const before = dbDigest();
    const budgetRow = [{ cost_code: "X", description: "x", period: "FY2026", budget_usd: 1, actual_usd: 0, committed_usd: 0, afe_required: "no", afe_no: "" }];
    expect(() => s.importRecords({ datasetType: "budget", rows: budgetRow })).toThrow(/danh tính/);
    expect(() => s.importRecords({ datasetType: "budget", rows: budgetRow, actor: ENGINEER })).toThrow(/budget|quyền/);
    expect(() => s.importRecords({ datasetType: "budget", rows: budgetRow, actor: { ...HARNESS, roles: ["Tích hợp dữ liệu"] } })).toThrow(/budget|quyền/);
    expect(dbDigest()).toBe(before);
    expect(s.importRecords({ datasetType: "budget", rows: budgetRow, actor: ASSET }).duplicate).toBe(false);
    // oversized payload refused before touching the database
    const big = Array.from({ length: 60_000 }, (_, i) => ({ part_no: `P${i}`, description: "x", system: "x", qty_offshore: 0, qty_onshore: 0, lead_time_days: 1, weight_t: 0, deck_m2: 0 }));
    const mid = dbDigest();
    expect(() => s.importRecords({ datasetType: "spare_parts", rows: big, actor: ENGINEER })).toThrow(/giới hạn/);
    expect(dbDigest()).toBe(mid);
  });

  it("confirmReservation: role by resource type, case state, service principals refused", () => {
    const s = mk({ systemActor: undefined });
    const w = (() => {
      const now = "2026-11-12T08:00:00Z";
      s.db.prepare("INSERT INTO workflows (case_no, title, well, platform, status, version, created_at, updated_at, detection_json) VALUES ('CASE-R', 't', 'W', 'P', 'open', 1, ?, ?, '{}')").run(now, now);
      return Number(s.db.prepare("SELECT id FROM workflows WHERE case_no = 'CASE-R'").get()!.id);
    })();
    const deck = hold(s.db, { workflowId: w, revision: 1, type: "vessel_deck", key: "V-5", quantity: 5, unit: "m²", capacity: 30, taskId: null, holdDays: 7 });
    const budget = hold(s.db, { workflowId: w, revision: 1, type: "budget", key: "OPX/FY", quantity: 1000, unit: "USD", capacity: 5000, taskId: null, holdDays: 7 });
    const before = dbDigest();
    expect(() => s.confirmReservation({ id: deck.id!, externalRef: "BK", quantity: 5, caseRevision: 1, actor: ENGINEER })).toThrow(/vai trò|quyền/);
    expect(() => s.confirmReservation({ id: deck.id!, externalRef: "BK", quantity: 5, caseRevision: 1, actor: HARNESS })).toThrow(/người|service/);
    expect(() => s.confirmReservation({ id: budget.id!, externalRef: "ERP-1", quantity: 1000, caseRevision: 1, actor: MARINE })).toThrow(/vai trò|quyền/);
    expect(dbDigest()).toBe(before);
    s.db.prepare("UPDATE workflows SET status = 'rejected' WHERE id = ?").run(w);
    expect(() => s.confirmReservation({ id: deck.id!, externalRef: "BK", quantity: 5, caseRevision: 1, actor: MARINE })).toThrow(/kết thúc|rejected/);
  });

  it("retry and execution need a server identity with an allowed role", async () => {
    const s = mk({ systemActor: undefined });
    s.setFault("maint_agent", 1, ADMIN);
    await s.loadSample(SAMPLE, "base", undefined, ENGINEER);
    await s.orch.runUntilIdle();
    const t = Object.fromEntries(s.state().workflows[0].tasks.map((x) => [x.key, x]));
    expect(t["mnt.review"].status).toBe("error");
    expect(() => s.retry(t["mnt.review"].id)).toThrow(/danh tính/);
    expect(() => s.retry(t["mnt.review"].id, { ...ENGINEER, roles: ["Khách"] })).toThrow(/vai trò|quyền/);
    s.retry(t["mnt.review"].id, ENGINEER);
    expect(s.orch.task(t["mnt.review"].id).status).not.toBe("error"); // re-queued (tick may already have started it)
    expect(s.db.prepare("SELECT actor_id FROM audit_log WHERE action = 'task.retry'").get()!.actor_id).toBe("demo.engineer");
  });
});

// ───────────────────────── F5 ─────────────────────────
describe("F5 — scope keys are exact; shared datasets are tracked per code", () => {
  const row = (data: Record<string, unknown>) => ({ id: 1, importId: 1, data }) as unknown as ActiveRow;
  const scope = (over: Partial<CaseScope> = {}): CaseScope => ({ workflowId: 1, platform: "SIM-WHP-A", well: "A-03", wellKey: "SIM-WHP-A/A-03", ambiguousWell: false, platformlessApplies: true, ...over });

  it("A-03 vs A-030 and SIM-WHP-A vs SIM-WHP-AB never match (no substrings)", () => {
    const s = scope();
    expect(rowInScope("dpr", row({ platform: "SIM-WHP-A", well: "A-030" }), s)).toBe(false);
    expect(rowInScope("dpr", row({ platform: " sim-whp-a ", well: "a-03" }), s)).toBe(true); // normalized, still exact
    expect(rowInScope("hse_documents", row({ scope: "SIM-WHP-AB" }), s)).toBe(false);
    expect(rowInScope("hse_documents", row({ scope: "SIM-WHP-A/A-030" }), s)).toBe(false);
    expect(rowInScope("hse_documents", row({ scope: "SIM-WHP-B; SIM-WHP-A" }), s)).toBe(true);
    expect(rowInScope("hse_documents", row({ scope: "SIM-WHP-A/A-03" }), s)).toBe(true);
    expect(rowInScope("weather_forecast", row({ location: "SIM-WHP-AB" }), s)).toBe(false);
    expect(rowInScope("vessel_schedule", row({ destination: "SIM-WHP-A2" }), s)).toBe(false);
    expect(rowInScope("flight_schedule", row({ destination: "SIM-WHP-A" }), s)).toBe(true);
    expect(rowInScope("maintenance_history", row({ well: "A-030" }), s)).toBe(false);
    expect(rowInScope("work_execution", row({ platform: "SIM-WHP-A", well: "A-030" }), s)).toBe(false);
  });

  it("two platforms with the same well name: platform-less rows are never auto-assigned; declared rule applies", () => {
    const amb = scope({ ambiguousWell: true });
    // well test / maintenance without platform for an ambiguous well name → not attributed
    expect(rowInScope("well_test", row({ well: "A-03" }), amb)).toBe(false);
    expect(rowInScope("maintenance_history", row({ well: "A-03" }), amb)).toBe(false);
    // with an explicit platform, attribution is exact
    expect(rowInScope("maintenance_history", row({ platform: "SIM-WHP-B", well: "A-03" }), amb)).toBe(false);
    expect(rowInScope("maintenance_history", row({ platform: "SIM-WHP-A", well: "A-03" }), amb)).toBe(true);
    expect(rowInScope("hse_documents", row({ scope: "A-03" }), amb)).toBe(false);
    // the rule "exclude" (or an explicit other platform) keeps platform-less rows out
    const excl = scope({ platformlessApplies: false });
    expect(rowInScope("well_test", row({ well: "A-03" }), excl)).toBe(false);
    expect(rowInScope("maintenance_history", row({ well: "", system: "Gas lift" }), excl)).toBe(false);
    expect(rowInScope("hse_documents", row({ scope: "" }), excl)).toBe(false);
  });

  it("caseScope resolves the declared rule (single_platform / exclude / explicit code)", async () => {
    const { caseScope } = await import("./caseModel");
    const w = { id: 1, well: "A-03", platform: "SIM-WHP-A" };
    svc.importRecords({ datasetType: "well_master", rows: [{ well: "A-03", platform: "SIM-WHP-A", lift_type: "Gas lift", status: "Producing" }, { well: "A-03", platform: "SIM-WHP-B", lift_type: "ESP", status: "Producing" }], simulated: true });
    expect(caseScope(svc.db, w, { scope: { rowsWithoutPlatform: "single_platform" } })).toMatchObject({ ambiguousWell: true, platformlessApplies: false });
    expect(caseScope(svc.db, w, { scope: { rowsWithoutPlatform: "exclude" } }).platformlessApplies).toBe(false);
    expect(caseScope(svc.db, w, { scope: { rowsWithoutPlatform: "sim-whp-a" } }).platformlessApplies).toBe(true);
    expect(caseScope(svc.db, { ...w, platform: "SIM-WHP-B" }, { scope: { rowsWithoutPlatform: "SIM-WHP-A" } }).platformlessApplies).toBe(false);
  });

  it("data for another platform (same well name, look-alike codes) leaves the case untouched", async () => {
    await toCommitGate();
    const v = wf().version;
    const before = JSON.stringify(Object.values(T()).map((t) => [t.key, t.status]));
    svc.importRecords({ datasetType: "weather_forecast", rows: [{ forecast_date: "2026-11-20", location: "SIM-WHP-AB", hs_m: 4.2, wind_kn: 40, issued_at: "2026-11-12T06:00:00Z" }], simulated: true });
    svc.importRecords({ datasetType: "vessel_schedule", rows: [{ voyage_id: "V-9001", vessel: "Other", depart_date: "2026-11-18", destination: "SIM-WHP-A2", deck_m2_free: 5, max_lift_t: 2, status: "Scheduled" }], simulated: true });
    svc.importRecords({ datasetType: "maintenance_history", rows: [{ wo_no: "WO-B-1", platform: "SIM-WHP-B", well: "A-03", equipment_tag: "ESP-B-A03", system: "ESP", description: "Đổi ESP", status: "Open" }], simulated: true });
    svc.importRecords({ datasetType: "hse_documents", rows: [{ doc_id: "HSE-B-1", title: "JSA B", doc_type: "jsa", activity_type: "slickline_fgs", scope: "SIM-WHP-B/A-03", status: "Approved", valid_to: "2027-01-01" }], simulated: true });
    await svc.orch.runUntilIdle();
    expect(wf().version).toBe(v);
    expect(JSON.stringify(Object.values(T()).map((t) => [t.key, t.status]))).toBe(before);
  });

  it("shared datasets: an unrelated code changes nothing; the used code re-plans exactly its branch, audit kept", async () => {
    await toCommitGate();
    const v = wf().version;
    const pkgSha = gate(T()["gate.asset"].id).packageSha;
    const decisions = svc.db.prepare("SELECT COUNT(*) c FROM decisions").get()!.c;
    // Unrelated part / item / cost code
    svc.importRecords({ datasetType: "quotes", rows: [{ rfq_ref: "RFQ-X", part_no: "WIDGET-X", vendor: "Other", unit_price_usd: 10 }], simulated: true });
    svc.importRecords({ datasetType: "cost_estimates", rows: [{ item: "UNUSED-ITEM", estimate_usd: 1, basis: "x" }], simulated: true });
    svc.importRecords({ datasetType: "budget", rows: [{ cost_code: "OPX-UNRELATED", period: "FY2026", budget_usd: 1, actual_usd: 0, committed_usd: 0 }], simulated: true, actor: ASSET });
    await svc.orch.runUntilIdle();
    expect(wf().version).toBe(v);
    expect(T()["gate.asset"].status).toBe("awaiting_approval");
    expect(gate(T()["gate.asset"].id).packageSha).toBe(pkgSha);
    // A new quote for the part this case prices → procurement branch stale, scope approval untouched
    svc.importRecords({ datasetType: "quotes", rows: [{ rfq_ref: "RFQ-C", part_no: "sl-consumables-kit ", vendor: "SIM Supply Co. C", unit_price_usd: 6100, valid_to: "2026-12-31" }], simulated: true });
    expect(wf().version).toBe(v + 1);
    const reasons = svc.workflowDetail(wf().id).revisions.map((r) => r.reason).join(" | ");
    expect(reasons).toMatch(/quotes\{part_no=SL-CONSUMABLES-KIT\}/);
    expect(T()["gate.technical"].status).toBe("done");
    expect(["pending", "running"]).toContain(T()["proc.prep"].status);
    expect(T()["gate.asset"].status).not.toBe("awaiting_approval");
    await svc.orch.runUntilIdle();
    expect(gate(T()["gate.asset"].id).packageSha).not.toBe(pkgSha);
    expect(svc.db.prepare("SELECT COUNT(*) c FROM decisions").get()!.c).toBe(decisions);
  });
});
