import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { OpsService } from "./service";
import type { Identity } from "./types";

/** Test harness principal (service source) — the core no longer trusts callers without an identity. */
const TEST_SERVICE: import("./types").Identity = { userId: "svc.test", name: "Test harness", roles: ["Tích hợp dữ liệu", "Quản trị hệ thống"], source: "service" };


/**
 * Regression tests for review 2026-11-12-modes (R1 decision versioning,
 * R2 server-side identity & outbox control, R3 requested/effective mode,
 * R5 attention projected from the database across cases).
 */
const SAMPLE = path.resolve(__dirname, "../../../oilgas/sample-data");
const ENG_LEAD: Identity = { userId: "demo.englead", name: "Demo Eng Lead", roles: ["Trưởng phòng Kỹ thuật khai thác"], source: "demo" };
const ASSET: Identity = { userId: "demo.asset", name: "Demo Asset", roles: ["Asset Manager"], source: "demo" };
const OTHER: Identity = { userId: "demo.engineer", name: "Demo Engineer", roles: ["Unrelated role"], source: "demo" };
const ENTERPRISE_ASSET: Identity = { ...ASSET, userId: "ent.asset", source: "enterprise" };

let dir: string;
let svc: OpsService;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-gov-"));
});
afterEach(() => {
  svc?.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

function mk(extra: Partial<ConstructorParameters<typeof OpsService>[0]> = {}) {
  svc = new OpsService({ dbPath: path.join(dir, "x.db"), taskDelayMs: 0, systemActor: TEST_SERVICE, ...extra });
  return svc;
}
async function toTechnicalGate(s: OpsService) {
  await s.loadSample(SAMPLE, "base");
  await s.loadSample(SAMPLE, "supplements", "supplements/SIM_well_test_A-03_2026-11-11.csv");
  await s.orch.runUntilIdle();
}
function tasks(s: OpsService, wfIdx = 0) {
  const wf = s.state().workflows[wfIdx];
  return Object.fromEntries(wf.tasks.map((t) => [t.key, t]));
}
function gateFacts(s: OpsService, taskId: number) {
  return s.orch.currentOutput(s.orch.task(taskId))!.facts as { role: string; packageSha: string; packageVersion: number };
}
function snapshot(s: OpsService) {
  return JSON.stringify({
    t: s.db.prepare("SELECT id, status, current_run_id, feedback_json FROM tasks ORDER BY id").all(),
    w: s.db.prepare("SELECT id, status, version FROM workflows").all(),
    d: s.db.prepare("SELECT COUNT(*) c FROM decisions").get(),
  });
}

describe("R1 — decisions are bound to the exact package version", () => {
  it("rejects a missing packageSha without changing task/workflow", async () => {
    const s = mk();
    await toTechnicalGate(s);
    const g = tasks(s)["gate.technical"];
    const before = snapshot(s);
    expect(() => s.decide({ taskId: g.id, decision: "approve", actor: ENG_LEAD, comment: "", packageSha: "", idempotencyKey: "a" })).toThrow(/Thiếu packageSha/);
    expect(() => s.decide({ taskId: g.id, decision: "approve", actor: ENG_LEAD, comment: "", idempotencyKey: "b" } as never)).toThrow(/Thiếu packageSha/);
    expect(snapshot(s)).toBe(before);
    expect(tasks(s)["gate.technical"].status).toBe("awaiting_approval");
  });

  it("rejects a stale package (approval after the package was re-issued) without state change", async () => {
    const s = mk();
    await toTechnicalGate(s);
    let t = tasks(s);
    const g1 = gateFacts(s, t["gate.technical"].id);
    s.decide({ taskId: t["gate.technical"].id, decision: "approve", actor: ENG_LEAD, comment: "ok", packageSha: g1.packageSha, idempotencyKey: "t1" });
    await s.orch.runUntilIdle();
    t = tasks(s);
    const v1 = gateFacts(s, t["gate.asset"].id);
    s.decide({ taskId: t["gate.asset"].id, decision: "request_changes", returnTo: "proc.prep", actor: ASSET, comment: "cần 2 chào giá", packageSha: v1.packageSha, idempotencyKey: "a1" });
    await s.loadSample(SAMPLE, "supplements", "supplements/SIM_quotes_SupplyB.csv");
    await s.orch.runUntilIdle();
    t = tasks(s);
    const v2 = gateFacts(s, t["gate.asset"].id);
    expect(v2.packageSha).not.toBe(v1.packageSha);
    const before = snapshot(s);
    // Approver still looking at the v1 package → refused
    expect(() => s.decide({ taskId: t["gate.asset"].id, decision: "approve", actor: ASSET, comment: "", packageSha: v1.packageSha, idempotencyKey: "a2" })).toThrow(/Hồ sơ đã thay đổi/);
    expect(() => s.decide({ taskId: t["gate.asset"].id, decision: "approve", actor: ASSET, comment: "", packageSha: v2.packageSha, packageVersion: v2.packageVersion - 1, idempotencyKey: "a3" })).toThrow(/Phiên bản hồ sơ không khớp/);
    expect(snapshot(s)).toBe(before);
    s.decide({ taskId: t["gate.asset"].id, decision: "approve", actor: ASSET, comment: "", packageSha: v2.packageSha, packageVersion: v2.packageVersion, idempotencyKey: "a4" });
    expect(tasks(s)["gate.asset"].status).toBe("done");
  });

  it("idempotency: same key + same payload → duplicate; same key + different payload → 409", async () => {
    const s = mk();
    await toTechnicalGate(s);
    const g = tasks(s)["gate.technical"];
    const f = gateFacts(s, g.id);
    const req = { taskId: g.id, decision: "approve" as const, actor: ENG_LEAD, comment: "ok", packageSha: f.packageSha, idempotencyKey: "same" };
    expect(s.decide(req).duplicate).toBe(false);
    expect(s.decide(req).duplicate).toBe(true);
    expect(() => s.decide({ ...req, decision: "reject", comment: "khác" })).toThrow(/idempotencyKey đã được dùng/);
    expect(() => s.decide({ ...req, comment: "ok nhưng sửa" })).toThrow(/idempotencyKey đã được dùng/);
    expect(s.db.prepare("SELECT COUNT(*) c FROM decisions").get()!.c).toBe(1);
  });
});

describe("R2 — identity and roles come from the server; outbox is controlled", () => {
  it("rejects a role the identity does not hold, and demo identities in production mode", async () => {
    const s = mk();
    await toTechnicalGate(s);
    const g = tasks(s)["gate.technical"];
    const f = gateFacts(s, g.id);
    const before = snapshot(s);
    expect(() => s.decide({ taskId: g.id, decision: "approve", actor: OTHER, comment: "", packageSha: f.packageSha, idempotencyKey: "x1" })).toThrow(/cần vai trò/);
    expect(() => s.decide({ taskId: g.id, decision: "approve", actor: undefined as never, comment: "", packageSha: f.packageSha, idempotencyKey: "x2" })).toThrow(/danh tính/);
    expect(snapshot(s)).toBe(before);
    s.stop();
    s.db.close();

    const prod = mk({ operatingMode: "production" });
    const g2 = tasks(prod)["gate.technical"];
    expect(() => prod.decide({ taskId: g2.id, decision: "approve", actor: ENG_LEAD, comment: "", packageSha: f.packageSha, idempotencyKey: "p1" })).toThrow(/danh tính demo bị từ chối/);
    expect(tasks(prod)["gate.technical"].status).toBe("awaiting_approval");
  });

  it("outbox: role, workflow state, draft version and real update are all enforced", async () => {
    const s = mk();
    await toTechnicalGate(s);
    let t = tasks(s);
    s.decide({ taskId: t["gate.technical"].id, decision: "approve", actor: ENG_LEAD, comment: "", packageSha: gateFacts(s, t["gate.technical"].id).packageSha, idempotencyKey: "o1" });
    await s.orch.runUntilIdle();
    t = tasks(s);
    // 1/2 quotes: refused without an exception, accepted with an explicit waiver by the policy role
    const pkg = gateFacts(s, t["gate.asset"].id).packageSha;
    expect(() => s.decide({ taskId: t["gate.asset"].id, decision: "approve", actor: ASSET, comment: "", packageSha: pkg, idempotencyKey: "o2a" })).toThrow(/quotes_min/);
    s.decide({ taskId: t["gate.asset"].id, decision: "approve", actor: ASSET, comment: "Ngoại lệ: vật tư tiêu hao, nhà cung cấp duy nhất trong thời hạn", packageSha: pkg, waivers: ["quotes_min"], idempotencyKey: "o2" });
    expect(JSON.parse(String(s.db.prepare("SELECT waivers_json FROM decisions WHERE idempotency_key = 'o2'").get()!.waivers_json))).toEqual(["quotes_min"]);
    await s.orch.runUntilIdle();
    const wfv = s.state().workflows[0].version;
    const rows = s.db.prepare("SELECT * FROM outbox WHERE case_revision = ? AND status = 'draft' ORDER BY id").all(wfv) as Array<{ id: number; doc_id: number; doc_sha256: string; status: string }>;
    expect(rows.length).toBeGreaterThan(0);
    const [a, b] = rows;

    expect(() => s.approveOutbox({ id: a.id, docId: a.doc_id, docSha256: a.doc_sha256, actor: OTHER })).toThrow(/vai trò/); // "Unrelated role" refused
    expect(() => s.approveOutbox({ id: a.id, docId: a.doc_id, docSha256: "deadbeef", actor: ASSET })).toThrow(/Phiên bản bản nháp không khớp/);
    expect(() => s.approveOutbox({ id: a.id, docId: a.doc_id + 1000, docSha256: a.doc_sha256, actor: ASSET })).toThrow(/Phiên bản bản nháp không khớp/);
    expect(s.db.prepare("SELECT status FROM outbox WHERE id = ?").get(a.id)!.status).toBe("draft");

    expect(s.approveOutbox({ id: a.id, docId: a.doc_id, docSha256: a.doc_sha256, actor: ASSET })).toEqual({ status: "approved_to_send", duplicate: false });
    expect(s.approveOutbox({ id: a.id, docId: a.doc_id, docSha256: a.doc_sha256, actor: ASSET }).duplicate).toBe(true);
    const row = s.db.prepare("SELECT approved_by_id, identity_source, approved_role FROM outbox WHERE id = ?").get(a.id)!;
    expect(row).toMatchObject({ approved_by_id: "demo.asset", identity_source: "demo", approved_role: "Asset Manager" });

    // A row that changed state concurrently is never reported as approved
    if (b) {
      s.db.prepare("UPDATE outbox SET status = 'cancelled' WHERE id = ?").run(b.id);
      expect(() => s.approveOutbox({ id: b.id, docId: b.doc_id, docSha256: b.doc_sha256, actor: ASSET })).toThrow(/trạng thái cancelled/);
      expect(s.db.prepare("SELECT status FROM outbox WHERE id = ?").get(b.id)!.status).toBe("cancelled");
    }
    // Production mode refuses a demo identity for outbox too (same DB, restarted in production)
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const c = rows[2];
    s.stop();
    s.db.close();
    const prod = mk({ operatingMode: "production" });
    expect((prod.db.prepare("SELECT status FROM outbox WHERE id = ?").get(c.id) as { status: string }).status).toBe("draft");
    expect(() => prod.approveOutbox({ id: c.id, docId: c.doc_id, docSha256: c.doc_sha256, actor: ASSET })).toThrow(/danh tính demo bị từ chối/);
    expect(prod.approveOutbox({ id: c.id, docId: c.doc_id, docSha256: c.doc_sha256, actor: ENTERPRISE_ASSET }).duplicate).toBe(false);
  });

  it("outbox refuses approval while the case is not approved", async () => {
    const s = mk();
    await toTechnicalGate(s);
    const wfId = s.state().workflows[0].id;
    s.db.prepare("INSERT INTO documents (workflow_id, doc_key, version, title, kind, source, mime, content, sha256, created_at) VALUES (?, 'x', 1, 't', 'rfq_draft', 'generated', 'text/markdown', 'c', 'sha-x', 'now')").run(wfId);
    const docId = Number(s.db.prepare("SELECT id FROM documents WHERE doc_key = 'x'").get()!.id);
    s.db.prepare("INSERT INTO outbox (workflow_id, kind, title, recipient, doc_id, doc_sha256, status, created_at) VALUES (?, 'rfq', 'early', 'v', ?, 'sha-x', 'draft', 'now')").run(wfId, docId);
    const id = Number(s.db.prepare("SELECT id FROM outbox WHERE title = 'early'").get()!.id);
    expect(() => s.approveOutbox({ id, docId, docSha256: "sha-x", actor: ENTERPRISE_ASSET })).toThrow(/chưa ở trạng thái đã duyệt/);
  });
});

describe("R3 — requested vs effective processing mode", () => {
  it("LLM requested without credentials → blocked: agents paused, no silent rules run", async () => {
    const s = mk({ requestedMode: "llm", llm: null, llmConfigError: { status: "missing_credentials", message: "chưa có credentials" } });
    const res = await s.loadSample(SAMPLE, "base");
    expect(res.every((r) => !r.error)).toBe(true); // data intake still works
    await s.orch.runUntilIdle();
    const m = s.modeInfo();
    expect(m).toMatchObject({ requested: "llm", effective: "blocked", configurationStatus: "missing_credentials", reloadRequiresRestart: true });
    const t = tasks(s)["ops.anomaly"];
    expect(t.status).toBe("pending");
    expect(t.note).toMatch(/Tạm dừng/);
    expect(s.db.prepare("SELECT COUNT(*) c FROM task_runs").get()!.c).toBe(0);
  });

  it("rules mode is reported as rules (not applicable configuration)", () => {
    const s = mk();
    expect(s.modeInfo()).toMatchObject({ requested: "rules", effective: "rules", configurationStatus: "not_applicable" });
  });
});

describe("R5 — attention reflects pending work in the database across cases", () => {
  it("an approver with two pending cases keeps attention after one is decided", async () => {
    const s = mk();
    await s.loadSample(SAMPLE, "base");
    // Second anomalous well (A-01) via a later DPR revision
    const src = fs.readFileSync(path.join(SAMPLE, "SIM_dpr_2026-10-22_to_2026-11-11.csv"), "utf-8").split("\n");
    const header = src.findIndex((l) => l.startsWith("report_date"));
    const cols = src[header].split(",");
    const rows = src.slice(header + 1).filter((l) => /^2026-11-(09|10|11),SIM-WHP-A,A-01,/.test(l)).map((l) => {
      const c = l.split(",");
      c[cols.indexOf("oil_rate")] = String(Math.round(Number(c[cols.indexOf("oil_rate")]) * 0.7));
      c[cols.indexOf("updated_at")] = "2026-11-13T00:00:00Z";
      return c.join(",");
    });
    const out = await s.importFile({ filename: "SIM_dpr_A01_revision.csv", buffer: Buffer.from(["# GIẢ LẬP / SIMULATED", src[header], ...rows].join("\n")) });
    expect(out.casesCreated).toHaveLength(1);
    await s.loadSample(SAMPLE, "supplements", "supplements/SIM_well_test_A-03_2026-11-11.csv");
    await s.orch.runUntilIdle();

    const wfs = s.state().workflows;
    expect(wfs).toHaveLength(2);
    const gates = wfs.map((w) => w.tasks.find((t) => t.key === "gate.technical")!);
    expect(gates.every((g) => g.status === "awaiting_approval")).toBe(true);
    let lead = s.state().agents.find((a) => a.id === "eng_lead")!;
    expect(lead.attention!.items).toHaveLength(2);

    // Decide one case; an ordinary event from eng_lead must not clear the other
    s.decide({ taskId: gates[0].id, decision: "reject", actor: ENG_LEAD, comment: "không ưu tiên", packageSha: gateFacts(s, gates[0].id).packageSha, idempotencyKey: "r5" });
    s.orch.emit({ type: "task.completed", label: "sự kiện thường", source: "system", agentId: "eng_lead", room: "zone_prod_eng" });
    lead = s.state().agents.find((a) => a.id === "eng_lead")!;
    expect(lead.attention!.items).toHaveLength(1);
    expect(lead.attention!.items[0].caseNo).toBe(wfs[1].caseNo);
  });
});
