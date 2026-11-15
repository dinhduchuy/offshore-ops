import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { OpsService } from "./service";
import { OpsError } from "./workflow";
import type { AgentOutput, Identity, TraceRef } from "./types";

/** Test harness principal (service source) — the core no longer trusts callers without an identity. */
const TEST_SERVICE: import("./types").Identity = { userId: "svc.test", name: "Test harness", roles: ["Tích hợp dữ liệu", "Quản trị hệ thống"], source: "service" };


const ENG_LEAD: Identity = { userId: "demo.englead", name: "Trần Thị B", roles: ["Trưởng phòng Kỹ thuật khai thác"], source: "demo" };
const ASSET: Identity = { userId: "demo.asset", name: "Lê C", roles: ["Asset Manager"], source: "demo" };
const ENGINEER: Identity = { userId: "demo.engineer", name: "Nguyễn Văn A", roles: ["Kỹ sư khai thác"], source: "demo" };

const SAMPLE = path.resolve(__dirname, "../../../oilgas/sample-data");
let dir: string;
let svc: OpsService;

function mk(dbFile = path.join(dir, "ops.db")): OpsService {
  return new OpsService({ dbPath: dbFile, taskDelayMs: 0, systemActor: TEST_SERVICE });
}
function wfTasks(s: OpsService) {
  const wf = s.state().workflows[0];
  return { wf, t: Object.fromEntries(wf.tasks.map((t) => [t.key, t])) };
}
function output(s: OpsService, taskId: number): AgentOutput {
  return s.orch.currentOutput(s.orch.task(taskId))!;
}
async function loadBase(s: OpsService) {
  const res = await s.loadSample(SAMPLE, "base");
  const errors = res.filter((r) => r.error);
  expect(errors, JSON.stringify(errors)).toEqual([]);
  return res;
}
const approver = (s: OpsService, taskKey: string) => output(s, wfTasks(s).t[taskKey].id).facts as { role: string; packageSha: string; packageVersion: number };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-e2e-"));
  svc = mk();
});
afterEach(() => {
  svc.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("data intake & detection", () => {
  it("validates units, missing values, duplicates, late updates and detects only A-03", async () => {
    const res = await loadBase(svc);
    const dpr = res.find((r) => r.file.startsWith("SIM_dpr"))!.outcome!;
    const q = dpr.quality!;
    expect(q.simulated).toBe(true);
    expect(q.duplicates).toBe(1); // A-04 30/10 repeated
    expect(q.issueCounts.unit_converted).toBeGreaterThanOrEqual(1); // A-02 water m3/d
    expect(q.issueCounts.missing_value).toBe(1); // A-05 gas 28/10
    expect(q.issueCounts.late_update).toBe(1); // A-01 03/11
    expect(dpr.detection!.filter((d) => d.anomaly).map((d) => d.well)).toEqual(["A-03"]);
    expect(dpr.detection!.find((d) => d.well === "A-06")!.explainedByDowntime).toBe(true);
    expect(dpr.casesCreated).toHaveLength(1);
    // Excel + text document imported
    expect(res.find((r) => r.file.endsWith(".xlsx"))!.outcome!.quality!.rowsAccepted).toBe(6);
    expect(res.find((r) => r.file.endsWith(".txt"))!.outcome!.flags!.length).toBeGreaterThan(0);
  });

  it("re-importing the same file is a no-op; revisions resolve by updated_at", async () => {
    await loadBase(svc);
    const before = svc.db.prepare("SELECT COUNT(*) c FROM data_rows").get()!.c;
    const again = await svc.importFile({ filename: "SIM_dpr_2026-10-22_to_2026-11-11.csv", buffer: fs.readFileSync(path.join(SAMPLE, "SIM_dpr_2026-10-22_to_2026-11-11.csv")) });
    expect(again.duplicate).toBe(true);
    expect(svc.db.prepare("SELECT COUNT(*) c FROM data_rows").get()!.c).toBe(before);
    expect(svc.state().workflows).toHaveLength(1); // no duplicate case

    const rev = await svc.loadSample(SAMPLE, "supplements", "supplements/SIM_dpr_revision_2026-11-12.csv");
    const q = rev[0].outcome!.quality!;
    expect(q.conflicts).toHaveLength(2);
    expect(q.conflicts[0].resolution).toMatch(/thay thế/); // A-03 newer → replaces
    expect(q.conflicts[1].resolution).toMatch(/Giữ bản đang dùng/); // A-05 older → kept
  });
});

describe("case workflow", () => {
  it("runs end-to-end: missing data → supplement → technical gate → commercial → return → approval → outbox", async () => {
    await loadBase(svc);
    await svc.orch.runUntilIdle();
    let { wf, t } = wfTasks(svc);
    expect(wf.simulated).toBe(true);
    expect(t["ops.anomaly"].status).toBe("done");
    expect(t["mnt.review"].status).toBe("done");
    expect(t["hse.screening"].status).toBe("done");
    expect(t["eng.assessment"].status).toBe("missing_data"); // stale well test
    expect(t["ops.proposal"].status).toBe("missing_data"); // asks for supplement
    expect(t["gate.technical"].status).toBe("pending");
    expect(t["proc.prep"].status).toBe("pending"); // commercial steps closed

    const eng1 = output(svc, t["eng.assessment"].id);
    expect(eng1.missingData.find((m) => m.blocking)!.datasetType).toBe("well_test");
    expect(eng1.facts.sowDocId).toBeNull(); // no SOW without basis
    const hse = output(svc, t["hse.screening"].id);
    expect(hse.warnings.join(" ")).toMatch(/mệnh lệnh/); // injected quote note treated as data

    // Supplement: new well test → engineering re-runs automatically
    const sup = await svc.loadSample(SAMPLE, "supplements", "supplements/SIM_well_test_A-03_2026-11-11.csv");
    expect(sup[0].outcome!.requeued).toBeGreaterThanOrEqual(1);
    await svc.orch.runUntilIdle();
    ({ t } = wfTasks(svc));
    expect(t["eng.assessment"].status).toBe("done");
    const eng = output(svc, t["eng.assessment"].id);
    const hyp = eng.facts.hypotheses as Array<{ code: string; statusCode: string }>;
    expect(hyp.find((h) => h.code === "H_GL")!.statusCode).toBe("supported");
    expect(hyp.find((h) => h.code === "H_SKIN")!.statusCode).toBe("insufficient"); // never defaulted
    const recTypes = (eng.facts.recommendedActivities as Array<{ type: string }>).map((a) => a.type);
    expect(recTypes).toContain("slickline_fgs");
    expect(recTypes).not.toContain("pbu_survey");
    expect(JSON.stringify(eng)).not.toMatch(/acid|axit/i);
    expect(t["gate.technical"].status).toBe("awaiting_approval");
    expect(t["proc.prep"].status).toBe("pending");

    // Wrong role is refused; the right role approves
    const g1 = approver(svc, "gate.technical");
    expect(() => svc.decide({ taskId: t["gate.technical"].id, decision: "approve", actor: ENGINEER, comment: "", packageSha: g1.packageSha, idempotencyKey: "k0" })).toThrow(OpsError);
    svc.decide({ taskId: t["gate.technical"].id, decision: "approve", actor: ENG_LEAD, comment: "Đồng ý chẩn đoán", packageSha: g1.packageSha, idempotencyKey: "k1" });
    expect(svc.decide({ taskId: t["gate.technical"].id, decision: "approve", actor: ENG_LEAD, comment: "Đồng ý chẩn đoán", packageSha: g1.packageSha, idempotencyKey: "k1" }).duplicate).toBe(true);
    await svc.orch.runUntilIdle();
    ({ t } = wfTasks(svc));
    for (const k of ["proc.prep", "log.plan", "fin.check", "ops.package"]) expect(t[k].status, k).toBe("done");
    expect(t["gate.asset"].status).toBe("awaiting_approval");
    const fin = output(svc, t["fin.check"].id).facts as { total: number; requiredApproverRole: string };
    expect(fin.requiredApproverRole).toBe("Asset Manager");
    const proc1 = output(svc, t["proc.prep"].id).facts as { estimated: number; documented: number; total: number };
    expect(proc1.documented).toBeGreaterThan(0);

    // Asset Manager returns the package to procurement
    const g2 = approver(svc, "gate.asset");
    svc.decide({ taskId: t["gate.asset"].id, decision: "request_changes", returnTo: "proc.prep", actor: ASSET, comment: "Cần đủ 2 chào giá cho vật tư slickline", packageSha: g2.packageSha, idempotencyKey: "k2" });
    expect(() => svc.decide({ taskId: t["gate.asset"].id, decision: "approve", actor: ASSET, comment: "", packageSha: g2.packageSha, idempotencyKey: "k3" })).toThrow(/không ở trạng thái chờ duyệt/);
    await svc.orch.runUntilIdle();
    ({ t, wf } = wfTasks(svc));
    expect(wf.version).toBe(2); // well test filled a data gap (no result invalidated → same rev); the return decision opened rev 2
    expect(t["gate.technical"].status).toBe("done"); // upstream of the return point untouched
    expect(t["proc.prep"].status).toBe("missing_data"); // no new data yet → cannot address feedback
    expect(t["gate.asset"].status).toBe("pending");

    await svc.loadSample(SAMPLE, "supplements", "supplements/SIM_quotes_SupplyB.csv");
    await svc.orch.runUntilIdle();
    ({ t } = wfTasks(svc));
    expect(t["proc.prep"].status).toBe("done");
    expect(t["gate.asset"].status).toBe("awaiting_approval");
    const g3 = approver(svc, "gate.asset");
    expect(g3.packageSha).not.toBe(g2.packageSha); // new package version
    svc.decide({ taskId: t["gate.asset"].id, decision: "approve", actor: ASSET, comment: "Duyệt", packageSha: g3.packageSha, idempotencyKey: "k4" });
    await svc.orch.runUntilIdle();
    ({ t, wf } = wfTasks(svc));
    expect(t["ops.release"].status).toBe("done");
    expect(wf.status).toBe("approved"); // commitment approved — NOT completed
    expect(t["gate.close"].status).not.toBe("done");
    const outbox = svc.state().outbox as Array<{ id: number; status: string; doc_id: number; doc_sha256: string; case_revision: number; kind: string }>;
    const current = outbox.filter((o) => Number(o.case_revision) === wf.version);
    expect(current.length).toBeGreaterThanOrEqual(2);
    expect(current.every((o) => o.status === "draft")).toBe(true); // nothing sent automatically
    expect(outbox.filter((o) => Number(o.case_revision) < wf.version).every((o) => o.status === "superseded")).toBe(true); // old revision drafts unusable
    const pr = current.find((o) => o.kind === "purchase_requisition")!;
    svc.approveOutbox({ id: Number(pr.id), docId: Number(pr.doc_id), docSha256: pr.doc_sha256, actor: ASSET });

    // Traceability: every evidence ref of every run resolves, recursively one level
    const detail = svc.workflowDetail(wf.id);
    let checked = 0;
    for (const task of detail.tasks) {
      for (const run of task.runs) {
        for (const e of run.output?.evidence ?? []) {
          const view = svc.trace(e.ref);
          expect(view.title).toBeTruthy();
          for (const l of view.links) svc.trace(l.ref);
          for (const r of view.table?.refs ?? []) if (r) svc.trace(r as TraceRef);
          checked++;
        }
        for (const c of run.output?.conclusions ?? []) {
          for (const id of c.evidence) expect(run.output!.evidence.some((e) => e.id === id), `${task.key} ${c.id}→${id}`).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    // Every event carries ids and source
    for (const e of detail.events as Array<Record<string, unknown>>) {
      expect(e.event_id).toBeTruthy();
      expect(e.source).toBeTruthy();
      expect(e.ts).toBeTruthy();
    }
  });

  it("agent failure → error state → retry succeeds", async () => {
    svc.setFault("maint_agent", 1);
    await loadBase(svc);
    await svc.orch.runUntilIdle();
    let { t } = wfTasks(svc);
    expect(t["mnt.review"].status).toBe("error");
    expect(t["mnt.review"].note).toMatch(/fault injection/);
    expect(t["ops.proposal"].status).toBe("pending"); // does not proceed on error
    svc.retry(t["mnt.review"].id);
    await svc.orch.runUntilIdle();
    ({ t } = wfTasks(svc));
    expect(t["mnt.review"].status).toBe("done");
    expect(t["mnt.review"].attempts).toBe(2);
  });

  it("restart recovery: a task interrupted while running is re-queued and completes", async () => {
    await loadBase(svc);
    // Simulate a crash mid-run: mark a task running with an open run, then reopen the DB
    const { t } = wfTasks(svc);
    svc.db.prepare("UPDATE tasks SET status = 'running', attempts = 1 WHERE id = ?").run(t["ops.anomaly"].id);
    svc.db.prepare("INSERT INTO task_runs (task_id, attempt, status, started_at) VALUES (?, 1, 'running', '2026-11-12T00:00:00Z')").run(t["ops.anomaly"].id);
    svc.db.close();

    svc = mk();
    expect(svc.orch.recover()).toBe(1);
    await svc.orch.runUntilIdle();
    const after = wfTasks(svc).t;
    expect(after["ops.anomaly"].status).toBe("done");
    const runs = svc.workflowDetail(wfTasks(svc).wf.id).tasks.find((x) => x.key === "ops.anomaly")!.runs;
    expect(runs.some((r) => r.error?.includes("khởi động lại"))).toBe(true);
  });

  it("reject closes the case and cancels remaining tasks", async () => {
    await loadBase(svc);
    await svc.loadSample(SAMPLE, "supplements", "supplements/SIM_well_test_A-03_2026-11-11.csv");
    await svc.orch.runUntilIdle();
    const { t } = wfTasks(svc);
    const g = approver(svc, "gate.technical");
    svc.decide({ taskId: t["gate.technical"].id, decision: "reject", actor: ENG_LEAD, comment: "Ưu tiên giếng khác", packageSha: g.packageSha, idempotencyKey: "r1" });
    const after = wfTasks(svc);
    expect(after.wf.status).toBe("rejected");
    expect(after.t["proc.prep"].status).toBe("cancelled");
    expect(after.t["gate.asset"].status).toBe("cancelled");
  });
});
