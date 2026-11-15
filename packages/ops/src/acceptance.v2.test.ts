import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { OpsService } from "./service";
import { setClock } from "./clock";
import { hold, releaseCase } from "./resources";
import type { GateCondition, Identity } from "./types";

/** Test harness principal (service source) — the core no longer trusts callers without an identity. */
const TEST_SERVICE: import("./types").Identity = { userId: "svc.test", name: "Test harness", roles: ["Tích hợp dữ liệu", "Quản trị hệ thống"], source: "service" };


/**
 * Acceptance scenarios for workflow v2 (docs/reviews/2026-11-12-agent-workflow-improvement-prompt.md §8).
 * Separate temp databases, pinned clock, SIMULATED sample data — no network, no LLM.
 */
const SAMPLE = path.resolve(__dirname, "../../../oilgas/sample-data");
const ENG_LEAD: Identity = { userId: "demo.englead", name: "Eng Lead", roles: ["Trưởng phòng Kỹ thuật khai thác"], source: "demo" };
const ASSET: Identity = { userId: "demo.asset", name: "Asset", roles: ["Asset Manager"], source: "demo" };
const VP: Identity = { userId: "demo.vp", name: "VP", roles: ["Phó Tổng Giám đốc"], source: "demo" };
const OIM: Identity = { userId: "demo.oim", name: "OIM", roles: ["OIM"], source: "demo" };
const MARINE: Identity = { userId: "demo.marine", name: "Marine", roles: ["Marine coordinator"], source: "demo" };
const TECH: Identity = { userId: "demo.tech", name: "Kỹ thuật viên", roles: ["Giám sát giếng"], source: "demo" };

let dir: string;
let svc: OpsService;
let k = 0;
const key = () => `k${++k}`;

beforeEach(() => {
  setClock(() => new Date("2026-11-12T08:00:00Z"));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-v2-"));
  svc = new OpsService({ dbPath: path.join(dir, "x.db"), taskDelayMs: 0, systemActor: TEST_SERVICE });
});
afterEach(() => {
  svc.stop();
  setClock(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const at = (iso: string) => setClock(() => new Date(iso));
/** The sample case (SIM-WHP-A/A-03) unless another index is asked for */
const wfOf = (caseIdx?: number) => {
  const all = svc.state().workflows.filter((w) => w.tasks.length);
  return caseIdx === undefined ? (all.find((w) => w.wellKey === "SIM-WHP-A/A-03") ?? all[0]) : all[caseIdx];
};
const T = (caseIdx?: number) => Object.fromEntries(wfOf(caseIdx).tasks.map((t) => [t.key, t]));
const facts = (taskId: number) => svc.orch.currentOutput(svc.orch.task(taskId))!.facts as Record<string, unknown>;
const gate = (taskId: number) => facts(taskId) as { packageSha: string; packageVersion: number; conditions: GateCondition[]; role: string };

function dprRow(platform: string, well: string, date: string, oil: number, extra: Record<string, unknown> = {}) {
  return { report_date: date, platform, well, oil_rate: oil, oil_unit: "bbl/d", water_rate: 300, water_unit: "bbl/d", gas_rate: 1.2, gas_unit: "MMscf/d", thp: 30, thp_unit: "bar", uptime_h: 24, downtime_h: 0, rate_basis: "daily_volume", updated_at: `${date}T23:00:00Z`, ...extra };
}
function days(from: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(from + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

async function base(opts: { skip?: string[] } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLE, "manifest.json"), "utf-8")) as { base: string[] };
  for (const f of manifest.base.filter((x) => !(opts.skip ?? []).includes(x))) {
    const r = await svc.loadSample(SAMPLE, "base", f);
    expect(r[0].error, f).toBeUndefined();
  }
}
const sup = (f: string) => svc.loadSample(SAMPLE, "supplements", `supplements/${f}`);

async function toScopeGate() {
  await base();
  await sup("SIM_well_test_A-03_2026-11-11.csv");
  await svc.orch.runUntilIdle();
  expect(T()["gate.technical"].status).toBe("awaiting_approval");
}
async function approveScope() {
  const t = T();
  svc.decide({ taskId: t["gate.technical"].id, decision: "approve", actor: ENG_LEAD, comment: "Đồng ý phạm vi chẩn đoán", packageSha: gate(t["gate.technical"].id).packageSha, idempotencyKey: key() });
  await svc.orch.runUntilIdle();
}

describe("§8.1 DPR decline without a sufficient baseline → data branch, no intervention", () => {
  it("opens a data-gap case, keeps the intervention steps closed, re-assesses when data arrives — other cases untouched", async () => {
    await toScopeGate();
    const aRuns = svc.db.prepare("SELECT COUNT(*) c FROM task_runs").get()!.c;
    const aVersion = wfOf().version;

    // Platform B, well with the SAME NAME as platform A's case well: 2 baseline days only (needs ≥ 4)
    const rows = [...["2026-11-03", "2026-11-04"].map((d) => dprRow("SIM-WHP-B", "A-03", d, 1000)), ...days("2026-11-09", 3).map((d) => dprRow("SIM-WHP-B", "A-03", d, 700))];
    const out = svc.importRecords({ datasetType: "dpr", rows, simulated: true });
    expect(out.detection!.find((d) => d.wellKey === "SIM-WHP-B/A-03")).toMatchObject({ anomaly: false, suspect: true });
    expect(out.casesCreated).toHaveLength(1);
    await svc.orch.runUntilIdle();

    const b = svc.state().workflows.find((w) => w.wellKey === "SIM-WHP-B/A-03")!;
    const bt = Object.fromEntries(b.tasks.map((t) => [t.key, t]));
    expect(facts(bt["ops.anomaly"].id).classification).toBe("data_gap");
    expect(bt["ops.anomaly"].status).toBe("missing_data");
    expect(bt["ops.anomaly"].waitKind).toBe("data");
    expect(bt["ops.anomaly"].blocking.join(" ")).toMatch(/Baseline SIM-WHP-B\/A-03: chỉ có 2\/7/);
    for (const k of ["eng.assessment", "proc.prep", "gate.asset"]) expect(bt[k].status, k).toBe("pending");
    expect(svc.db.prepare("SELECT COUNT(*) c FROM outbox WHERE workflow_id = ?").get(b.id)!.c).toBe(0);

    // Platform A case (same well name, other platform) — separate case
    const a = svc.state().workflows.find((w) => w.wellKey === "SIM-WHP-A/A-03")!;
    expect(a.id).not.toBe(b.id);
    expect(a.version).toBe(aVersion);

    // Baseline days arrive → B re-assessed (new revision), now evaluable
    svc.importRecords({ datasetType: "dpr", rows: days("2026-10-29", 5).map((d) => dprRow("SIM-WHP-B", "A-03", d, 1000)), simulated: true });
    await svc.orch.runUntilIdle();
    const b2 = svc.state().workflows.find((w) => w.id === b.id)!;
    expect(b2.version).toBe(2);
    const anom = Object.fromEntries(b2.tasks.map((t) => [t.key, t]))["ops.anomaly"];
    expect(facts(anom.id).classification).toBe("investigate");
    void aRuns;
  });

  it("data for an unrelated well never re-runs another case", async () => {
    await toScopeGate();
    const runs = svc.db.prepare("SELECT COUNT(*) c FROM task_runs").get()!.c;
    const v = wfOf().version;
    svc.importRecords({ datasetType: "dpr", rows: days("2026-10-22", 21).map((d) => dprRow("SIM-WHP-C", "C-01", d, 800)), simulated: true });
    await svc.orch.runUntilIdle();
    const a = svc.state().workflows.find((w) => w.wellKey === "SIM-WHP-A/A-03")!;
    expect(a.version).toBe(v);
    expect(svc.db.prepare("SELECT COUNT(*) c FROM task_runs").get()!.c).toBe(runs);
  });
});

describe("§8.2 enough data, conclusion monitor/no action → valid closure, nothing left pending", () => {
  it("a recovered well closes through the no-action branch with a recorded conclusion", async () => {
    const well = (d: string, oil: number) => dprRow("SIM-WHP-B", "B-07", d, oil);
    svc.importRecords({ datasetType: "dpr", rows: [...days("2026-10-29", 7).map((d) => well(d, 1000)), ...days("2026-11-09", 3).map((d) => well(d, 700))], simulated: true });
    await svc.orch.runUntilIdle();
    expect(facts(T()["ops.anomaly"].id).classification).toBe("investigate");

    // Later DPR: back to normal
    at("2026-11-15T08:00:00Z");
    svc.importRecords({ datasetType: "dpr", rows: days("2026-11-12", 3).map((d) => well(d, 990)), simulated: true });
    await svc.orch.runUntilIdle();
    let t = T();
    expect(facts(t["ops.anomaly"].id).classification).toBe("no_action");
    for (const k of ["eng.assessment", "mnt.review", "hse.screening"]) expect(t[k].status, k).toBe("skipped");
    expect(facts(t["ops.proposal"].id).branch).toBe("no_action");
    svc.decide({ taskId: t["gate.technical"].id, decision: "approve", actor: ENG_LEAD, comment: "Đồng ý: không cần hành động", packageSha: gate(t["gate.technical"].id).packageSha, idempotencyKey: key() });
    await svc.orch.runUntilIdle();
    t = T();
    for (const k of ["proc.prep", "log.plan", "fin.check", "ops.package", "gate.asset", "ops.release", "hse.readiness", "gate.readiness", "ops.execution", "eng.evaluation"]) expect(t[k].status, k).toBe("skipped");
    expect(t["gate.close"].status).toBe("awaiting_approval");
    expect(() => svc.decide({ taskId: t["gate.close"].id, decision: "approve", actor: ENG_LEAD, comment: "", packageSha: gate(t["gate.close"].id).packageSha, idempotencyKey: key() })).toThrow(/kết luận/);
    svc.decide({ taskId: t["gate.close"].id, decision: "approve", actor: ENG_LEAD, comment: "Sản lượng đã phục hồi; tiếp tục theo dõi DPR. Bài học: xác nhận downtime trước khi lập case.", packageSha: gate(t["gate.close"].id).packageSha, idempotencyKey: key() });
    const wf = wfOf();
    expect(wf.status).toBe("closed");
    expect(wf.tasks.every((x) => ["done", "skipped"].includes(x.status))).toBe(true);
    expect(wf.closure.conclusion).toMatch(/phục hồi/);
    // skipped ≠ done: each skip carries its reason
    expect(T()["proc.prep"].note).toMatch(/Không cần hành động|không có công việc/);
  });
});

describe("§8.3 missing quotes → RFQ draft; no purchase commitment until conditions or a proper exception", () => {
  it("RFQ is sendable after the scope approval; PR only after commitment; commitment refused without waiver by the right role", async () => {
    await toScopeGate();
    await approveScope();
    const t = T();
    const rfq = svc.db.prepare("SELECT * FROM outbox WHERE kind = 'rfq' AND status = 'draft'").all() as Array<{ id: number; doc_id: number; doc_sha256: string; required_gate: string }>;
    expect(rfq.length).toBeGreaterThan(0);
    expect(rfq.every((r) => r.required_gate === "gate.technical")).toBe(true);
    expect(svc.db.prepare("SELECT COUNT(*) c FROM outbox WHERE kind = 'purchase_requisition'").get()!.c).toBe(0);
    // RFQ = request for prices: can be approved for sending while the commitment is still pending
    expect(svc.approveOutbox({ id: rfq[0].id, docId: rfq[0].doc_id, docSha256: rfq[0].doc_sha256, actor: ASSET }).status).toBe("approved_to_send");
    expect(t["gate.asset"].status).toBe("awaiting_approval");
    const g = gate(t["gate.asset"].id);
    const q = g.conditions.find((c) => c.code === "quotes_min")!;
    expect(q).toMatchObject({ met: false, waivable: true, waiverRoles: ["Asset Manager"] });
    expect(() => svc.decide({ taskId: t["gate.asset"].id, decision: "approve", actor: ASSET, comment: "", packageSha: g.packageSha, idempotencyKey: key() })).toThrow(/quotes_min/);
    expect(T()["gate.asset"].status).toBe("awaiting_approval");
  });
});

describe("§8.4 missing price or volume → totals/feasibility shown as incomplete, never 0 or 'met'", () => {
  it("unpriced items keep the total incomplete; unknown cargo keeps logistics incomplete; commitment refused even with waivers", async () => {
    await base({ skip: ["SIM_cost_estimates.csv", "SIM_equipment_catalog.csv"] });
    await sup("SIM_well_test_A-03_2026-11-11.csv");
    await sup("SIM_quotes_SupplyB.csv");
    await svc.orch.runUntilIdle();
    await approveScope();
    const t = T();
    const fin = facts(t["fin.check"].id) as { costComplete: boolean; unpriced: string[]; total: number };
    expect(fin.costComplete).toBe(false);
    expect(fin.unpriced.join(" ")).toMatch(/ghế|boong|Ghế|Phân bổ/);
    const log = facts(t["log.plan"].id) as { feasibility: string; incomplete: string[] };
    expect(log.feasibility).toBe("incomplete");
    expect(log.incomplete.join(" ")).toMatch(/SLICKLINE-UNIT chưa có khối lượng/);
    const g = gate(t["gate.asset"].id);
    expect(g.conditions.find((c) => c.code === "cost_complete")).toMatchObject({ met: false, waivable: false });
    expect(() =>
      svc.decide({ taskId: t["gate.asset"].id, decision: "approve", actor: { ...VP, roles: [g.role, ...VP.roles] }, comment: "thử miễn trừ", waivers: ["cost_complete"], packageSha: g.packageSha, idempotencyKey: key() }),
    ).toThrow(/không thể miễn trừ/);
  });
});

describe("§8.5 two cases compete for budget / deck space", () => {
  it("ledger: one case holds, the other sees the conflict; retry and restart do not duplicate holds; release frees capacity", () => {
    const now = "2026-11-12T08:00:00Z";
    for (const n of ["CASE-X-1", "CASE-X-2"]) {
      svc.db.prepare("INSERT INTO workflows (case_no, title, well, platform, status, version, created_at, updated_at, detection_json) VALUES (?, 't', 'W', 'P', 'open', 1, ?, ?, '{}')").run(n, now, now);
    }
    const [w1, w2] = (svc.db.prepare("SELECT id FROM workflows ORDER BY id").all() as Array<{ id: number }>).map((r) => Number(r.id));
    const p = { revision: 1, type: "vessel_deck" as const, key: "V-9001", unit: "m²", capacity: 30, taskId: null, holdDays: 7 };
    expect(hold(svc.db, { ...p, workflowId: w1, quantity: 20 }).status).toBe("held");
    expect(hold(svc.db, { ...p, workflowId: w1, quantity: 20 }).status).toBe("held"); // retry → same row
    const c = hold(svc.db, { ...p, workflowId: w2, quantity: 15 });
    expect(c).toMatchObject({ status: "conflict", heldByOthers: 20, availableToCase: 10 });
    expect(c.conflicts[0].caseNo).toBe("CASE-X-1");
    // restart: same DB, new service → still exactly one hold
    svc.stop();
    svc.db.close();
    svc = new OpsService({ dbPath: path.join(dir, "x.db"), taskDelayMs: 0, systemActor: TEST_SERVICE });
    expect(hold(svc.db, { ...p, workflowId: w1, quantity: 20 }).status).toBe("held");
    expect(svc.db.prepare("SELECT COUNT(*) c FROM reservations WHERE workflow_id = ?").get(w1)!.c).toBe(1);
    releaseCase(svc.db, w1, "case hủy");
    expect(hold(svc.db, { ...p, workflowId: w2, quantity: 15 }).status).toBe("held");
    // expiry
    at("2026-11-30T00:00:00Z");
    expect(hold(svc.db, { ...p, workflowId: w1, quantity: 20 }).status).toBe("held"); // w2's hold expired → capacity back
  });

  it("finance and logistics of a real case see another case's holds (conflict shown, exception needs the higher role)", async () => {
    await base();
    await sup("SIM_well_test_A-03_2026-11-11.csv");
    await sup("SIM_quotes_SupplyB.csv");
    // Another case already holds most of OPX-WS-DIAG and the deck on every voyage before December
    const now = "2026-11-12T08:00:00Z";
    svc.db.prepare("INSERT INTO workflows (case_no, title, well, platform, status, version, created_at, updated_at, detection_json) VALUES ('CASE-OTHER-001', 't', 'A-02', 'SIM-WHP-A', 'open', 1, ?, ?, '{}')").run(now, now);
    const other = Number(svc.db.prepare("SELECT id FROM workflows WHERE case_no = 'CASE-OTHER-001'").get()!.id);
    expect(hold(svc.db, { workflowId: other, revision: 1, type: "budget", key: "OPX-WS-DIAG/FY2026", quantity: 40000, unit: "USD", capacity: 41200, taskId: null, holdDays: 7 }).status).toBe("held");
    const early = svc.db.prepare("SELECT data_json FROM data_rows WHERE dataset_type = 'vessel_schedule' AND status = 'active'").all().map((r) => JSON.parse(String(r.data_json))).filter((v) => v.depart_date < "2026-12-01");
    for (const v of early) hold(svc.db, { workflowId: other, revision: 1, type: "vessel_deck", key: v.voyage_id, quantity: v.deck_m2_free, unit: "m²", capacity: v.deck_m2_free, taskId: null, holdDays: 30 });
    await svc.orch.runUntilIdle();
    await approveScope();
    const t = T();
    const fin = facts(t["fin.check"].id) as { overBudget: boolean; shortfalls: string[] };
    expect(fin.overBudget).toBe(true);
    expect(fin.shortfalls.join(" ")).toMatch(/CASE-OTHER-001/);
    const log = facts(t["log.plan"].id) as { voyage: string };
    expect(early.map((v) => v.voyage_id)).not.toContain(log.voyage); // a later voyage, the held ones were skipped
    const plan = svc.workflowDetail(wfOf().id).tasks.find((x) => x.key === "log.plan")!.runs[0].output!;
    expect(plan.evidence.map((e) => e.label).join(" ")).toMatch(/CASE-OTHER-001 giữ/);
    const g = gate(t["gate.asset"].id);
    expect(g.conditions.find((c) => c.code === "over_budget")).toMatchObject({ met: false, waivable: true });
    expect(() => svc.decide({ taskId: t["gate.asset"].id, decision: "approve", actor: { ...ASSET, roles: [g.role] }, comment: "x", waivers: ["over_budget"], packageSha: g.packageSha, idempotencyKey: key() })).toThrow(/cần vai trò/);
    const vpRole = { ...VP, roles: [g.role, "Phó Tổng Giám đốc"] };
    svc.decide({ taskId: t["gate.asset"].id, decision: "approve", actor: vpRole, comment: "Ngoại lệ ngân sách có thời hạn, điều chuyển quý I", waivers: ["over_budget"], packageSha: g.packageSha, idempotencyKey: key() });
    expect(T()["gate.asset"].status).toBe("done");
    // only one hold per resource for the case
    const dup = svc.db.prepare("SELECT resource_type, resource_key, COUNT(*) c FROM reservations WHERE workflow_id = ? GROUP BY resource_type, resource_key HAVING c > 1").all(wfOf().id);
    expect(dup).toEqual([]);
  });
});

describe("§8.6 DPR or SOW changes while awaiting approval", () => {
  it("new revision, stale branch re-runs, old package and old-revision outbox refused, decisions kept for audit", async () => {
    await toScopeGate();
    let t = T();
    const old = gate(t["gate.technical"].id);
    const v0 = wfOf().version;
    await sup("SIM_dpr_revision_2026-11-12.csv"); // corrects A-03 on 10/11 (inside the assessed period)
    expect(wfOf().version).toBe(v0 + 1);
    expect(() => svc.decide({ taskId: t["gate.technical"].id, decision: "approve", actor: ENG_LEAD, comment: "", packageSha: old.packageSha, idempotencyKey: key() })).toThrow(/không ở trạng thái chờ duyệt|Hồ sơ đã thay đổi/);
    await svc.orch.runUntilIdle();
    t = T();
    expect(t["gate.technical"].status).toBe("awaiting_approval");
    const fresh = gate(t["gate.technical"].id);
    expect(fresh.packageSha).not.toBe(old.packageSha); // re-issued for the new revision
    await approveScope();
    const rfqOld = svc.db.prepare("SELECT * FROM outbox WHERE kind = 'rfq' AND status = 'draft'").get() as { id: number; doc_id: number; doc_sha256: string; case_revision: number };
    // Quote change while the commitment is pending → rev++, procurement branch stale, old RFQ superseded
    const vBefore = wfOf().version;
    await sup("SIM_quotes_SupplyB.csv");
    expect(wfOf().version).toBe(vBefore + 1);
    expect(svc.db.prepare("SELECT status FROM outbox WHERE id = ?").get(rfqOld.id)!.status).toBe("superseded");
    expect(() => svc.approveOutbox({ id: rfqOld.id, docId: rfqOld.doc_id, docSha256: rfqOld.doc_sha256, actor: ASSET })).toThrow(/superseded|rev \d/);
    t = T();
    expect(t["gate.technical"].status).toBe("done"); // scope unaffected by a quote
    expect(t["proc.prep"].status).toBe("pending");
    expect(svc.db.prepare("SELECT COUNT(*) c FROM decisions").get()!.c).toBeGreaterThanOrEqual(1); // audit kept
    const revs = svc.workflowDetail(wfOf().id).revisions.map((r) => r.reason);
    expect(revs.join(" | ")).toMatch(/dpr/);
    expect(revs.join(" | ")).toMatch(/quotes/);
  });
});

async function toReadiness() {
  await base();
  await sup("SIM_well_test_A-03_2026-11-11.csv");
  await sup("SIM_quotes_SupplyB.csv");
  await svc.orch.runUntilIdle();
  await approveScope();
  const t = T();
  const g = gate(t["gate.asset"].id);
  expect(g.conditions.filter((c) => !c.met).map((c) => c.code)).toEqual([]);
  svc.decide({ taskId: t["gate.asset"].id, decision: "approve", actor: ASSET, comment: "Duyệt cam kết", packageSha: g.packageSha, idempotencyKey: key() });
  await svc.orch.runUntilIdle();
}

/** The Marine coordinator records the external confirmation of every transport hold of the plan in force. */
async function confirmTransport() {
  const w = wfOf();
  for (const r of svc.db.prepare("SELECT * FROM reservations WHERE workflow_id = ? AND resource_type != 'budget' AND status = 'held'").all(w.id)) {
    svc.confirmReservation({ id: Number(r.id), externalRef: `BK-${r.resource_key}`, quantity: Number(r.quantity), caseRevision: wfOf().version, actor: MARINE });
  }
  await svc.orch.runUntilIdle();
}

describe("§8.7 HSE document expires before the execution date", () => {
  it("planning proceeds; readiness blocks and assigns HSE; resolves when documents are renewed; confirmations required", async () => {
    await toReadiness();
    let t = T();
    expect(wfOf().status).toBe("approved");
    expect(t["hse.readiness"].status).toBe("missing_data");
    expect(t["hse.readiness"].blocking.join(" ")).toMatch(/risk_assessment.*hết hiệu lực|simops_plan: không tìm thấy|jsa: trạng thái/);
    expect(t["hse.readiness"].owner).toBe("HSE");
    expect(t["gate.readiness"].status).toBe("pending");
    const action = svc.state().actionList.find((a) => a.key === "hse.readiness")!;
    expect(action).toMatchObject({ waitLabel: "Thiếu dữ liệu" });
    expect(action.dueAt).toBeTruthy();

    await sup("SIM_hse_simops_update.csv");
    svc.importRecords({ datasetType: "hse_documents", rows: [{ doc_id: "HSE-JSA-1201", title: "JSA bảo dưỡng van điều khiển khí", doc_type: "jsa", activity_type: "gl_fcv_inspection", scope: "SIM-WHP-A", status: "Approved", valid_to: "2027-05-31" }], simulated: true });
    await svc.orch.runUntilIdle();
    t = T();
    expect(t["hse.readiness"].status).toBe("done");
    expect(t["gate.readiness"].status).toBe("awaiting_approval");
    // Transport is only held internally: a data check (not a checkbox) blocks readiness until it is confirmed
    const g0 = gate(t["gate.readiness"].id);
    expect(g0.conditions.find((c) => c.code === "transport_booked")).toMatchObject({ kind: "check", met: false });
    expect(() => svc.decide({ taskId: t["gate.readiness"].id, decision: "approve", actor: OIM, comment: "", confirmations: g0.conditions.map((c) => c.code), packageSha: g0.packageSha, idempotencyKey: key() })).toThrow(/xác nhận đặt/);
    await confirmTransport();
    t = T();
    expect(t["gate.readiness"].status).toBe("awaiting_approval");
    const g = gate(t["gate.readiness"].id);
    expect(g.role).toBe("OIM");
    const confirms = g.conditions.filter((c) => c.kind === "confirm").map((c) => c.code);
    expect(confirms).toContain("ptw_by_authority");
    expect(() => svc.decide({ taskId: t["gate.readiness"].id, decision: "approve", actor: OIM, comment: "", packageSha: g.packageSha, idempotencyKey: key() })).toThrow(/phải xác nhận/);
    svc.decide({ taskId: t["gate.readiness"].id, decision: "approve", actor: OIM, comment: "PTW cấp theo quy trình giàn", confirmations: confirms, packageSha: g.packageSha, idempotencyKey: key() });
    expect(T()["gate.readiness"].status).toBe("done");
  });
});

describe("§8.8 work executed but the result does not meet the criteria", () => {
  async function toExecution() {
    await toReadiness();
    await sup("SIM_hse_simops_update.csv");
    svc.importRecords({ datasetType: "hse_documents", rows: [{ doc_id: "HSE-JSA-1201", title: "JSA", doc_type: "jsa", activity_type: "gl_fcv_inspection", scope: "SIM-WHP-A", status: "Approved", valid_to: "2027-05-31" }], simulated: true });
    await svc.orch.runUntilIdle();
    await confirmTransport();
    const t = T();
    const g = gate(t["gate.readiness"].id);
    svc.decide({ taskId: t["gate.readiness"].id, decision: "approve", actor: OIM, comment: "ok", confirmations: g.conditions.filter((c) => c.kind === "confirm").map((c) => c.code), packageSha: g.packageSha, idempotencyKey: key() });
    await svc.orch.runUntilIdle();
  }

  it("execution waits for people (never the LLM); not-met result cannot close and reopens the assessment; met result closes with evidence", async () => {
    await toExecution();
    let t = T();
    expect(t["ops.execution"].status).toBe("waiting");
    expect(["date", "other_unit"]).toContain(t["ops.execution"].waitKind);
    const acts = (facts(t["ops.proposal"].id).activities as Array<{ type: string; workType: string }>).map((a) => a);
    // An unconfirmed import is not counted
    at("2026-12-10T08:00:00Z");
    svc.importRecords({ datasetType: "work_execution", rows: [{ platform: "SIM-WHP-A", well: "A-03", activity_type: acts[0].type, status: "done", completed_date: "2026-12-02", findings: "x" }], simulated: true, actor: TECH });
    await svc.orch.runUntilIdle();
    expect(T()["ops.execution"].status).toBe("waiting");
    expect(() => svc.recordExecution({ workflowId: wfOf().id, activityType: "pbu_survey", status: "done", completedDate: "2026-12-02", findings: "x", actor: TECH })).toThrow(/không thuộc phạm vi/);
    for (const a of acts) svc.recordExecution({ workflowId: wfOf().id, activityType: a.type, status: "done", completedDate: "2026-12-02", findings: a.workType === "maintenance" ? "Hiệu chỉnh FCV về setpoint" : "Đã thu dữ liệu", resultRef: `RPT-${a.type}`, actor: TECH });
    await svc.orch.runUntilIdle();
    t = T();
    expect(t["ops.execution"].status).toBe("done");
    expect(t["eng.evaluation"].status).toBe("waiting"); // needs post-work DPR days
    // Post-work DPR: no recovery (≈ level at detection)
    svc.importRecords({ datasetType: "dpr", rows: days("2026-12-03", 3).map((d) => dprRow("SIM-WHP-A", "A-03", d, 1180, { gl_inj: 1.25, gl_inj_unit: "MMscf/d" })), simulated: true });
    await svc.orch.runUntilIdle();
    t = T();
    expect(t["gate.technical"].status).toBe("done"); // new monitoring days do not restart the case
    expect(t["eng.evaluation"].status).toBe("done");
    expect(facts(t["eng.evaluation"].id).result).toBe("not_met");
    const g = gate(t["gate.close"].id);
    expect(() => svc.decide({ taskId: t["gate.close"].id, decision: "approve", actor: ENG_LEAD, comment: "đóng", confirmations: ["attribution_reviewed"], packageSha: g.packageSha, idempotencyKey: key() })).toThrow(/không thể miễn trừ/);
    const v = wfOf().version;
    svc.decide({ taskId: t["gate.close"].id, decision: "request_changes", returnTo: "eng.assessment", actor: ENG_LEAD, comment: "Chưa phục hồi — mở vòng chẩn đoán mới với dữ liệu FGS", packageSha: g.packageSha, idempotencyKey: key() });
    expect(wfOf().version).toBe(v + 1);
    expect(wfOf().status).not.toBe("closed");
    expect(T()["eng.assessment"].status).toMatch(/pending|running|done|missing_data/);
    expect(svc.workflowDetail(wfOf().id).revisions.at(-1)!.reason).toMatch(/Mở lại đánh giá/);
  });

  it("a met result closes only with the person's confirmation; holds are released", async () => {
    await toExecution();
    at("2026-12-10T08:00:00Z");
    const acts = facts(T()["ops.proposal"].id).activities as Array<{ type: string; workType: string }>;
    for (const a of acts) svc.recordExecution({ workflowId: wfOf().id, activityType: a.type, status: "done", completedDate: "2026-12-02", findings: "ok", resultRef: `RPT-${a.type}`, actor: TECH });
    svc.importRecords({ datasetType: "dpr", rows: days("2026-12-03", 3).map((d) => dprRow("SIM-WHP-A", "A-03", d, 1470)), simulated: true });
    await svc.orch.runUntilIdle();
    const t = T();
    expect(facts(t["eng.evaluation"].id).result).toBe("met");
    const g = gate(t["gate.close"].id);
    expect(() => svc.decide({ taskId: t["gate.close"].id, decision: "approve", actor: ENG_LEAD, comment: "đạt", packageSha: g.packageSha, idempotencyKey: key() })).toThrow(/phải xác nhận/);
    svc.decide({ taskId: t["gate.close"].id, decision: "approve", actor: ENG_LEAD, comment: "Đạt tiêu chí; phần phục hồi quy cho hiệu chỉnh FCV đã xem xét. Bài học: kiểm tra FCV khi WO quá hạn.", confirmations: ["attribution_reviewed"], packageSha: g.packageSha, idempotencyKey: key() });
    expect(wfOf().status).toBe("closed");
    expect(svc.db.prepare("SELECT COUNT(*) c FROM reservations WHERE workflow_id = ? AND status = 'held'").get(wfOf().id)!.c).toBe(0);
  });
});

describe("hand-offs: who holds the work, what was handed over, by when", () => {
  it("records artifact version/hash, acceptance criteria and due date; a return carries the reason", async () => {
    await toScopeGate();
    const ho = svc.workflowDetail(wfOf().id).handoffs as Array<Record<string, unknown>>;
    const toProposal = ho.find((h) => h.from_key === "eng.assessment" && h.to_key === "ops.proposal")!;
    expect(toProposal).toMatchObject({ status: "accepted" });
    expect(toProposal.artifact_sha).toBeTruthy();
    expect(JSON.parse(String(toProposal.acceptance_json)).length).toBeGreaterThan(0);
    expect(toProposal.due_at).toBeTruthy();
    const t = T();
    svc.decide({ taskId: t["gate.technical"].id, decision: "request_changes", returnTo: "mnt.review", actor: ENG_LEAD, comment: "Bổ sung tình trạng K-100", packageSha: gate(t["gate.technical"].id).packageSha, idempotencyKey: key() });
    const after = svc.workflowDetail(wfOf().id).handoffs as Array<Record<string, unknown>>;
    expect(after.find((h) => h.to_key === "gate.technical" && h.status === "returned")!.return_reason).toBe("Bổ sung tình trạng K-100");
    const back = after.find((h) => h.to_key === "mnt.review" && h.from_key === "gate.technical")!;
    expect(["offered", "accepted"]).toContain(back.status); // the receiving step may already have taken it
    expect(back.return_reason).toBe("Bổ sung tình trạng K-100");
    const agent = svc.state().agents.find((a) => a.id === "maint_agent")!;
    expect(agent.handoffs.some((h) => h.direction === "in")).toBe(true);
  });
});

describe("migration of a case created before workflow v2", () => {
  it("adds the new steps, rebuilds a snapshot, infers the branch and continues — history untouched", async () => {
    await toScopeGate();
    await sup("SIM_quotes_SupplyB.csv");
    await approveScope();
    const wfId = wfOf().id;
    // Make it look like an old database: no v2 steps, no snapshot, no branch, no well_key
    svc.db.prepare("DELETE FROM tasks WHERE workflow_id = ? AND key IN ('hse.readiness','gate.readiness','ops.execution','eng.evaluation','gate.close')").run(wfId);
    svc.db.prepare("DELETE FROM case_revisions WHERE workflow_id = ?").run(wfId);
    svc.db.prepare("UPDATE workflows SET well_key = NULL, branch = NULL WHERE id = ?").run(wfId);
    const prop = T()["ops.proposal"];
    const run = svc.db.prepare("SELECT id, output_json FROM task_runs WHERE id = (SELECT current_run_id FROM tasks WHERE id = ?)").get(prop.id)!;
    const out = JSON.parse(String(run.output_json));
    delete out.facts.branch;
    svc.db.prepare("UPDATE task_runs SET output_json = ? WHERE id = ?").run(JSON.stringify(out), run.id);
    const decisionsBefore = svc.db.prepare("SELECT COUNT(*) c FROM decisions").get()!.c;
    svc.stop();
    svc.db.close();

    svc = new OpsService({ dbPath: path.join(dir, "x.db"), taskDelayMs: 0, systemActor: TEST_SERVICE });
    const t = T();
    expect(t["hse.readiness"]).toBeTruthy();
    expect(svc.workflowDetail(wfId).revisions!.length).toBe(1);
    expect(svc.db.prepare("SELECT COUNT(*) c FROM decisions").get()!.c).toBe(decisionsBefore);
    const g = gate(t["gate.asset"].id);
    svc.decide({ taskId: t["gate.asset"].id, decision: "approve", actor: ASSET, comment: "ok", packageSha: g.packageSha, idempotencyKey: key() });
    await svc.orch.runUntilIdle();
    expect(T()["hse.readiness"].status).not.toBe("skipped"); // legacy proposal treated as the procurement branch
  });
});
