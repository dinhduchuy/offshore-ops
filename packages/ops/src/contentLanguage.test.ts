import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { OpsService } from "./service";
import { setClock } from "./clock";
import type { Identity, TraceRef } from "./types";

/**
 * content.language = "en": every system-generated text on the demo clip path (intake → coordination →
 * missing data → supplement → scope approval → planning, decision package, outbox, holds, trace views)
 * must be English. Role IDs are stable Vietnamese keys that the client renders via ROLE_EN, so they are
 * skipped; so are fields the client renders from codes/message keys. Data + config: the English
 * kit in oilgas/en (English simulated data set, content.language = en). "vi" stays Vietnamese (unchanged default).
 */
const SAMPLE = path.resolve(__dirname, "../../../oilgas/en/sample-data");
const CONFIG = path.resolve(__dirname, "../../../oilgas/en/ops-config.json");
const ENG: Identity = { userId: "demo.engineer", name: "Eng", roles: ["Kỹ sư khai thác"], source: "demo" };
const LEAD: Identity = { userId: "demo.englead", name: "Lead", roles: ["Trưởng phòng Kỹ thuật khai thác"], source: "demo" };
const VI = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹĐ]/i;
const SKIP = /^(Kỹ sư khai thác|Trưởng phòng Kỹ thuật khai thác|Trưởng bộ phận HSE|Quản trị hệ thống|Tích hợp dữ liệu|Phó Tổng Giám đốc|Tổng Giám đốc)$/;

let dirs: string[] = [];
afterEach(() => {
  setClock(null);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function scan(language: "en" | "vi"): Promise<Map<string, Set<string>>> {
  setClock(() => new Date("2026-11-15T03:00:00Z"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-lang-"));
  dirs.push(dir);
  const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf-8"));
  cfg.content = { language };
  fs.writeFileSync(path.join(dir, "cfg.json"), JSON.stringify(cfg));
  const svc = new OpsService({ dbPath: path.join(dir, "x.db"), configPath: path.join(dir, "cfg.json"), taskDelayMs: 0, systemActor: ENG });
  const sd = SAMPLE;
  const man = JSON.parse(fs.readFileSync(path.join(sd, "manifest.json"), "utf-8"));
  await svc.loadSample(sd, "base", undefined, ENG);
  await svc.orch.runUntilIdle();
  await svc.loadSample(sd, "supplements", man.supplements[0], ENG);
  await svc.orch.runUntilIdle();
  const wf = () => svc.state().workflows[0];
  const T = () => Object.fromEntries(wf().tasks.map((t) => [t.key, t]));
  const g = svc.orch.currentOutput(svc.orch.task(T()["gate.technical"].id))!.facts as any;
  svc.decide({ taskId: T()["gate.technical"].id, decision: "approve", actor: LEAD, comment: "Scope agreed.", packageSha: g.packageSha, idempotencyKey: `k-${language}`, confirmations: [] });
  await svc.orch.runUntilIdle();
  const hits = new Map<string, Set<string>>();
  const walk = (o: unknown, p: string) => {
    if (typeof o === "string") { if (VI.test(o) && !SKIP.test(o)) (hits.get(p) ?? hits.set(p, new Set()).get(p)!).add(o.slice(0, 170)); return; }
    if (Array.isArray(o)) o.forEach((x) => walk(x, p + "[]"));
    else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) walk(v, `${p}.${k}`);
  };
  const st = svc.state() as any;
  // Fields the English interface renders from codes (step key, wait kind, role id, condition code, stage) are skipped
  const wfs = st.workflows.map((w: any) => ({ title: w.title, tasks: w.tasks.map((t: any) => ({ summary: t.summary, note: t.status === "pending" || t.status === "awaiting_approval" ? undefined : t.note, blocking: t.blocking })) }));
  const keep = { workflows: wfs, approvals: st.approvals.map((a: any) => a.summary), outbox: st.outbox.map((o: any) => ({ title: o.title, recipient: o.recipient, note: o.status_note, dispatch: o.dispatch_note })), reservations: st.reservations.map((r: any) => ({ unit: r.unit, change: r.change_note, release: r.release_reason })), handoffs: st.agents.map((a: any) => a.handoffs), events: st.events.filter((e: any) => !JSON.parse(e.payload_json || "{}").msg).map((e: any) => `${e.type}: ${e.label}`) };
  walk(keep, "state");
  const d = svc.workflowDetail(wf().id) as any;
  const shown = (o: any) => o && { summary: o.summary, conclusions: o.conclusions?.map((c: any) => c.text), evidence: o.evidence?.map((e: any) => e.label), assumptions: o.assumptions, missing: o.missingData?.map((m: any) => [m.description, m.owner]), documents: o.documents?.map((x: any) => x.title), next: o.nextSteps, warnings: o.warnings };
  walk({ tasks: d.tasks.map((t: any) => ({ key: t.key, runs: t.runs.filter((r: any) => !r.superseded).map((r: any) => ({ [t.key]: shown(r.output) })) })), handoffs: d.handoffs.map((h: any) => ({ request: h.request, response: h.response })), revisions: d.revisions.map((r: any) => r.reason), snapshot: { meaning: d.snapshot?.units?.meaning } }, "detail");
  const refs: TraceRef[] = [];
  for (const t of d.tasks) for (const r of t.runs) { if (r.superseded) continue; refs.push({ kind: "task_run", id: r.id }); for (const e of r.output?.evidence ?? []) refs.push(e.ref); for (const doc of r.output?.documents ?? []) refs.push({ kind: "document", id: doc.docId }); }
  for (const dec of d.decisions) refs.push({ kind: "decision", id: dec.id });
  const seen = new Set<string>();
  for (const r of refs) { const k = `${r.kind}:${r.id}`; if (seen.has(k)) continue; seen.add(k); try { const v = svc.trace(r) as any; walk({ title: v.titleMsg ? "" : v.title, fields: v.fields.filter((f: any) => !f.valueMsg && !["status", "datetime", "identity"].includes(f.kind)).map((f: any) => f.value), table: v.table?.rows, links: v.links.filter((l: any) => !l.key).map((l: any) => l.label), warnings: v.warningMsgs?.length ? [] : v.warnings, body: r.kind === "document" || r.kind === "task_run" ? v.body : undefined, bodyLang: v.bodyLang === "vi" ? "BODYLANG=vi" : "" }, `trace.${r.kind}`); } catch { /* ref without a trace view */ } }
  svc.stop();
  return hits;
}

const report = (hits: Map<string, Set<string>>) => [...hits].map(([p, s]) => `${p}: ${[...s][0]}`);

describe("content.language = en (demo clip path)", () => {
  it("produces no Vietnamese system text in states, outputs, documents or trace views", async () => {
    const hits = await scan("en");
    expect(report(hits)).toEqual([]);
  }, 60_000);
  it("vi keeps producing Vietnamese content on the same path", async () => {
    const hits = await scan("vi");
    expect(hits.size).toBeGreaterThan(5);
  }, 60_000);
});
