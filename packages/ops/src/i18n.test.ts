import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { OpsService } from "./service";
import { setClock } from "./clock";
import { checkTranslation } from "./translation";
import { SYSTEM } from "./llm";
import type { LlmClient, LlmChatResult } from "./llm";
import type { GateCondition, Identity } from "./types";

/**
 * Bilingual support on the server side (docs/reviews/2026-11-14-bilingual-improvement-prompt.md):
 * stable error codes + params, keyed trace/data-quality/event messages, LLM output language
 * snapshotted per run, and translations kept as a separate, traceable representation.
 * Temp databases, pinned clock, a local fake LLM client — no network, no billed call.
 */
const SAMPLE = path.resolve(__dirname, "../../../oilgas/sample-data");
const CONFIG = path.resolve(__dirname, "../../../oilgas/ops-config.json");
const HARNESS: Identity = { userId: "svc.test", name: "Test harness", roles: ["Tích hợp dữ liệu", "Quản trị hệ thống"], source: "service" };
const ENG_LEAD: Identity = { userId: "demo.englead", name: "Eng Lead", roles: ["Trưởng phòng Kỹ thuật khai thác"], source: "demo" };
const ENGINEER: Identity = { userId: "demo.engineer", name: "Engineer", roles: ["Kỹ sư khai thác"], source: "demo" };
const SVC: Identity = { userId: "svc.erp", name: "ERP", roles: ["Trưởng phòng Kỹ thuật khai thác", "Kỹ sư khai thác"], source: "service" };

let dir: string;
let svc: OpsService;
let calls: Array<{ system: string; user: string }>;
let reply: (user: string) => string;
let n = 0;
const key = () => `i${++n}`;

function fakeClient(): LlmClient {
  return {
    provider: "anthropic",
    model: "claude-opus-5-5",
    source: "test",
    async chat(system, user): Promise<LlmChatResult> {
      calls.push({ system, user });
      return { text: reply(user), model: "claude-opus-5-5", stopReason: "end_turn", requestId: `req_${calls.length}` };
    },
  };
}
/** Faithful fake "translation": keeps every number and ID (copies the source body). */
const sourceBody = (user: string) => user.replace(/^<source[^>]*>\n/, "").replace(/\n<\/source>$/, "");

beforeEach(() => {
  setClock(() => new Date("2026-11-12T08:00:00Z"));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-i18n-"));
  calls = [];
  reply = (u) => `EN: ${sourceBody(u)}`;
  svc = new OpsService({ dbPath: path.join(dir, "x.db"), configPath: CONFIG, taskDelayMs: 0, systemActor: HARNESS });
});
afterEach(() => {
  svc?.stop();
  setClock(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const wf = () => svc.state().workflows.find((w) => w.wellKey === "SIM-WHP-A/A-03")!;
const T = () => Object.fromEntries(wf().tasks.map((t) => [t.key, t]));
const gate = (id: number) => svc.orch.currentOutput(svc.orch.task(id))!.facts as { packageSha: string; packageDocId: number; conditions: GateCondition[] };
async function toScopeGate() {
  await svc.loadSample(SAMPLE, "base");
  await svc.loadSample(SAMPLE, "supplements", "supplements/SIM_well_test_A-03_2026-11-11.csv");
  await svc.loadSample(SAMPLE, "supplements", "supplements/SIM_quotes_SupplyB.csv");
  await svc.orch.runUntilIdle();
  expect(T()["gate.technical"].status).toBe("awaiting_approval");
}
function codeOf(fn: () => unknown): { status?: number; code?: string; params?: Record<string, unknown>; message: string } {
  try {
    fn();
  } catch (e) {
    const x = e as { status?: number; code?: string; params?: Record<string, unknown>; message: string };
    return { status: x.status, code: x.code, params: x.params, message: x.message };
  }
  throw new Error("expected a refusal");
}
function enableLlm() {
  svc.configureLlm({ requested: "llm", llm: fakeClient(), source: "ui", revision: 1, effort: "low" });
}

describe("stable error codes (B1/B3)", () => {
  it("refusals carry code + params next to the original Vietnamese message", async () => {
    await toScopeGate();
    const t = T()["gate.technical"];
    const g = gate(t.id);
    const stale = codeOf(() => svc.decide({ taskId: t.id, decision: "approve", actor: ENG_LEAD, comment: "", packageSha: "deadbeef", idempotencyKey: key() }));
    expect(stale).toMatchObject({ status: 409, code: "package_changed" });
    expect(stale.message).toMatch(/Hồ sơ đã thay đổi/);
    const svcRefused = codeOf(() => svc.decide({ taskId: t.id, decision: "approve", actor: SVC, comment: "", packageSha: g.packageSha, idempotencyKey: key() }));
    expect(svcRefused).toMatchObject({ status: 403, code: "person_required" });
    const role = codeOf(() => svc.decide({ taskId: t.id, decision: "approve", actor: ENGINEER, comment: "", packageSha: g.packageSha, idempotencyKey: key() }));
    expect(role).toMatchObject({ status: 403, code: "role_required" });
    expect(String(role.params?.roles)).toContain("Trưởng phòng Kỹ thuật khai thác");
    const noComment = codeOf(() => svc.decide({ taskId: t.id, decision: "reject", actor: ENG_LEAD, comment: "", packageSha: g.packageSha, idempotencyKey: key() }));
    expect(noComment).toMatchObject({ status: 400, code: "comment_required" });
    const missing = codeOf(() => svc.decide({ taskId: 999999, decision: "approve", actor: ENG_LEAD, comment: "", packageSha: "x", idempotencyKey: key() }));
    expect(missing).toMatchObject({ status: 404, code: "not_found" });
  });

  it("a non-waivable unmet condition names its condition CODES so every language keeps the blocking reason", async () => {
    // Readiness with transport only HELD (not confirmed): transport_booked is a non-waivable data check
    await toScopeGate();
    let t = T();
    const ASSET: Identity = { userId: "demo.asset", name: "Asset", roles: ["Asset Manager"], source: "demo" };
    const OIM: Identity = { userId: "demo.oim", name: "OIM", roles: ["OIM"], source: "demo" };
    const conf = (id: number) => gate(id).conditions.filter((c) => c.kind === "confirm").map((c) => c.code);
    svc.decide({ taskId: t["gate.technical"].id, decision: "approve", actor: ENG_LEAD, comment: "ok", packageSha: gate(t["gate.technical"].id).packageSha, idempotencyKey: key(), confirmations: conf(t["gate.technical"].id) });
    await svc.orch.runUntilIdle();
    t = T();
    svc.decide({ taskId: t["gate.asset"].id, decision: "approve", actor: ASSET, comment: "ok", packageSha: gate(t["gate.asset"].id).packageSha, idempotencyKey: key(), confirmations: conf(t["gate.asset"].id) });
    await svc.orch.runUntilIdle();
    await svc.loadSample(SAMPLE, "supplements", "supplements/SIM_hse_simops_update.csv");
    svc.importRecords({ datasetType: "hse_documents", rows: [{ doc_id: "HSE-JSA-1201", title: "JSA", doc_type: "jsa", activity_type: "gl_fcv_inspection", scope: "SIM-WHP-A", status: "Approved", valid_to: "2027-05-31" }], simulated: true });
    await svc.orch.runUntilIdle();
    t = T();
    expect(t["gate.readiness"].status).toBe("awaiting_approval");
    const g = gate(t["gate.readiness"].id);
    const blocking = g.conditions.filter((c) => c.kind === "check" && !c.met && !c.waivable);
    expect(blocking.map((c) => c.code)).toContain("transport_booked");
    const r = codeOf(() => svc.decide({ taskId: t["gate.readiness"].id, decision: "approve", actor: OIM, comment: "x", packageSha: g.packageSha, idempotencyKey: key(), confirmations: conf(t["gate.readiness"].id) }));
    expect(r).toMatchObject({ status: 409, code: "non_waivable_unmet" });
    expect(String(r.params?.conditionCodes).split(",")).toEqual(blocking.map((c) => c.code));
    expect(r.message).toMatch(/không thể miễn trừ/);
  });

  it("authorization refusals for a person without the role are 403 role_required (not 'service')", () => {
    const r = codeOf(() => svc.recordExecution({ workflowId: 1, activityType: "x", status: "done", completedDate: "2026-11-12", findings: "y", actor: { userId: "demo.x", name: "X", roles: ["Không có"], source: "demo" } }));
    expect(r).toMatchObject({ status: 403, code: "role_required" });
  });
});

describe("keyed system text (B3)", () => {
  it("data-quality issues keep code + params; trace views carry message keys and field kinds", async () => {
    const out = svc.importRecords({ datasetType: "dpr", rows: [{ report_date: "2026-11-10", platform: "SIM-WHP-A", well: "A-09", oil_bbl: "abc", uptime_h: 20, downtime_h: 2 }], simulated: true });
    const row = svc.db.prepare("SELECT id, issues_json FROM data_rows WHERE import_id = ? ORDER BY id LIMIT 1").get(out.importId)!;
    const issues = JSON.parse(String(row.issues_json)) as Array<{ code: string; params?: Record<string, unknown>; message: string }>;
    expect(issues.length).toBeGreaterThan(0);
    for (const i of issues) {
      expect(i.code).toMatch(/^[a-z_]+$/);
      expect(i.params).toBeTruthy();
      expect(i.message).toBeTruthy(); // original text kept
    }
    const view = svc.trace({ kind: "data_row", id: Number(row.id) });
    expect(view.titleMsg?.key).toBe("trace.title.data_row");
    expect(view.fields.every((f) => !!f.key)).toBe(true);
    expect(view.fields.find((f) => f.key === "trace.f.receivedAt")?.kind).toBe("datetime");
    expect(view.warningMsgs?.some((m) => m?.key.startsWith("dq."))).toBe(true);
    const imp = svc.trace({ kind: "import", id: out.importId! });
    expect(imp.table?.headerKeys).toEqual(["trace.h.row", "trace.h.key", "trace.h.status", "trace.h.notes"]);
    expect(imp.table?.statusColumn).toBe(2);
  });

  it("workflow summary exposes stage/wait codes and events store a message key", async () => {
    await toScopeGate();
    const w = wf();
    expect(w.stageKey).toBe("gate.technical");
    const attn = svc.state().agents.find((a) => a.attention)!;
    expect(attn.attention!.items[0].key).toBeTruthy();
    const ev = svc.db.prepare("SELECT payload_json FROM events WHERE type = 'attention.requested' ORDER BY rowid DESC LIMIT 1").get()!;
    expect(JSON.parse(String(ev.payload_json)).msg?.key).toMatch(/^ev\./);
    expect(svc.state().businessTimeZone).toBe("Asia/Ho_Chi_Minh");
  });
});

describe("LLM output language (B7)", () => {
  it("is a server setting written into the prompt, not the viewer's language", () => {
    expect(SYSTEM("Ops AI", "en")).toMatch(/tiếng Anh \(English\)/);
    expect(SYSTEM("Ops AI")).toMatch(/\(tiếng Việt\)/);
  });
});

describe("translations of business content (B7)", () => {
  it("no usable Claude API → 503 translation_unavailable; the original and the decision state are untouched", async () => {
    await toScopeGate();
    const g = gate(T()["gate.technical"].id);
    const before = svc.db.prepare("SELECT content, sha256 FROM documents WHERE id = ?").get(g.packageDocId)!;
    await expect(svc.requestTranslation({ kind: "document", id: g.packageDocId, targetLang: "en", actor: ENGINEER })).rejects.toMatchObject({ status: 503, code: "translation_unavailable" });
    const after = svc.db.prepare("SELECT content, sha256 FROM documents WHERE id = ?").get(g.packageDocId)!;
    expect(after).toEqual(before);
    expect(svc.translation("document", g.packageDocId, "en").translation).toBeNull();
    expect(calls.length).toBe(0);
  });

  it("translates on demand, binds to source sha/version, caches, and never changes the package sha or the approval", async () => {
    await toScopeGate();
    const t = T()["gate.technical"];
    const g = gate(t.id);
    enableLlm();
    const r1 = await svc.requestTranslation({ kind: "document", id: g.packageDocId, targetLang: "en", actor: ENGINEER });
    expect(r1.cached).toBe(false);
    expect(calls.length).toBe(1);
    const tr = r1.view.translation!;
    expect(tr.sourceSha).toBe(r1.view.source.sha);
    expect(tr.sourceVersion).toMatch(/^v\d+$/);
    expect(tr.translator).toBe("llm:anthropic/claude-opus-5-5");
    expect(tr.status).toBe("machine_unreviewed");
    expect(tr.content.startsWith("EN: ")).toBe(true);
    // cached per (source hash, target language): no second call
    const r2 = await svc.requestTranslation({ kind: "document", id: g.packageDocId, targetLang: "en", actor: ENGINEER });
    expect(r2.cached).toBe(true);
    expect(calls.length).toBe(1);
    // the package under review is unchanged → the decision on the ORIGINAL still goes through
    expect(gate(t.id).packageSha).toBe(g.packageSha);
    svc.decide({ taskId: t.id, decision: "approve", actor: ENG_LEAD, comment: "ok", packageSha: g.packageSha, idempotencyKey: key(), confirmations: g.conditions.filter((c) => c.kind === "confirm").map((c) => c.code) });
    const d = svc.db.prepare("SELECT package_sha256 FROM decisions ORDER BY id DESC LIMIT 1").get()!;
    expect(d.package_sha256).toBe(g.packageSha);
  });

  it("automatic checks flag changed figures / lost IDs; review marks it, the original stays authoritative", async () => {
    await toScopeGate();
    const g = gate(T()["gate.technical"].id);
    enableLlm();
    reply = (u) => sourceBody(u).replace(/\d/, "9").replace(/CASE-[\w-]+/g, "the case");
    const r = await svc.requestTranslation({ kind: "document", id: g.packageDocId, targetLang: "en", actor: ENGINEER });
    expect(r.view.translation!.status).toBe("check_failed");
    expect(r.view.translation!.checks.numbers.ok).toBe(false);
    expect(r.view.translation!.checks.ids.missing.some((x) => x.startsWith("CASE-"))).toBe(true);
    const reviewed = svc.reviewTranslation({ id: r.view.translation!.id, verdict: "reviewed", actor: ENG_LEAD });
    expect(reviewed.status).toBe("reviewed");
    expect(reviewed.reviewedBy).toBe("Eng Lead");
    expect(codeOf(() => svc.reviewTranslation({ id: r.view.translation!.id, verdict: "reviewed", actor: SVC }))).toMatchObject({ code: "person_required" });
  });

  it("a changed source makes the old translation stale; a newer version is reported as superseding it", async () => {
    await toScopeGate();
    const g = gate(T()["gate.technical"].id);
    enableLlm();
    const r = await svc.requestTranslation({ kind: "document", id: g.packageDocId, targetLang: "en", actor: ENGINEER });
    expect(r.view.stale).toBe(false);
    // simulate a changed original (content hash moves)
    svc.db.prepare("UPDATE documents SET content = content || ' (sửa)' WHERE id = ?").run(g.packageDocId);
    const v = svc.translation("document", g.packageDocId, "en");
    expect(v.stale).toBe(true);
    expect(v.translation!.sourceSha).not.toBe(v.source.sha);
    expect(codeOf(() => svc.reviewTranslation({ id: v.translation!.id, verdict: "reviewed", actor: ENG_LEAD }))).toMatchObject({ code: "translation_stale" });
    // a newer version of the same document
    const doc = svc.db.prepare("SELECT * FROM documents WHERE id = ?").get(g.packageDocId)!;
    svc.db
      .prepare("INSERT INTO documents (workflow_id, task_run_id, doc_key, kind, title, version, content, sha256, created_at, source, mime, flags_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')")
      .run(doc.workflow_id, doc.task_run_id, doc.doc_key, doc.kind, doc.title, Number(doc.version) + 1, "v mới", "x", "2026-11-12T09:00:00Z", doc.source, doc.mime);
    expect(svc.translation("document", g.packageDocId, "en").source.supersededBy?.version).toBe(`v${Number(doc.version) + 1}`);
  });

  it("a failing provider keeps the original and stores nothing; service credentials may not request translations", async () => {
    await toScopeGate();
    const g = gate(T()["gate.technical"].id);
    svc.configureLlm({
      requested: "llm",
      llm: { provider: "anthropic", model: "m", async chat() { throw Object.assign(new Error("overloaded"), { status: 529 }); } },
      source: "ui",
      revision: 1,
    });
    await expect(svc.requestTranslation({ kind: "document", id: g.packageDocId, targetLang: "en", actor: ENGINEER })).rejects.toMatchObject({ code: "translation_failed" });
    expect(Number(svc.db.prepare("SELECT COUNT(*) c FROM translations").get()!.c)).toBe(0);
    await expect(svc.requestTranslation({ kind: "document", id: g.packageDocId, targetLang: "en", actor: SVC })).rejects.toMatchObject({ code: "person_required" });
  });

  it("checkTranslation compares signed figures and reference IDs", () => {
    expect(checkTranslation("Giảm -12.5% tại A-03 (E3), 1,234.56 USD", "Down -12.5% at A-03 (E3), 1,234.56 USD")).toEqual({ numbers: { ok: true, missing: [], extra: [] }, ids: { ok: true, missing: [] } });
    const bad = checkTranslation("Giảm -12.5% tại A-03 (E3)", "Down 12.5% at the well");
    expect(bad.numbers.ok).toBe(false);
    expect(bad.numbers.missing).toContain("-12.5");
    expect(bad.ids.missing).toEqual(expect.arrayContaining(["A-03", "E3"]));
  });
});
