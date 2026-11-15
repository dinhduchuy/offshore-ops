import { L } from "../lang";
import type { Database } from "../db";
import { nowIso, sha256, num } from "../db";
import type { OpsConfig } from "../config";
import { activeRows, type ActiveRow, DATASET_MAP } from "../datasets";
import { caseScope, scopedRows, scopedFingerprint, scopedFingerprintUpTo, fingerprintForKey, latestSnapshot, keyedDepKey, keyedFingerprintOf, keyTokens, normKey, LEDGER_KEY, ledgerFingerprint, type CaseScope, type CaseSnapshot } from "../caseModel";
import type {
  AgentId,
  AgentOutput,
  Conclusion,
  ConclusionBasis,
  Evidence,
  MissingData,
  OutputDocument,
  TaskRow,
  TraceRef,
  WorkflowRow,
} from "../types";

export interface UpstreamResult {
  taskKey: string;
  taskId: number;
  runId: number;
  status: string;
  agentId: string;
  output: AgentOutput;
}

export interface CaseDocument {
  id: number;
  title: string;
  content: string;
  flags: string[];
  version: number;
}

export interface Feedback {
  decisionId: number;
  comment: string;
  actor: string;
  role: string;
}

/** Everything an agent may read; usage is recorded for the audit trail and impact analysis. */
/** Lookup into a shared dataset by code; each requested code is recorded as a dependency. */
export interface KeyedIndex {
  all(value: unknown): ActiveRow[];
  get(value: unknown): ActiveRow | undefined;
  /** Rows in the dataset (to tell "dataset empty" from "code missing") — not a dependency by itself */
  size: number;
}

export class AgentContext {
  readonly usedDatasets = new Set<string>();
  /** Scoped fingerprint of each dataset AT THE TIME it was first read (detects changes during the run) */
  private readonly readFps = new Map<string, string>();
  readonly inputRefs: TraceRef[] = [];
  private readonly out = new OutputBuilder();
  readonly scope: CaseScope;
  readonly snapshot: CaseSnapshot | null;
  private readonly docs: CaseDocument[];

  constructor(
    readonly db: Database,
    readonly cfg: OpsConfig,
    readonly workflow: WorkflowRow,
    readonly task: TaskRow,
    readonly runId: number,
    readonly upstream: Map<string, UpstreamResult>,
    caseDocs: CaseDocument[],
    readonly feedback: Feedback | null,
  ) {
    for (const u of upstream.values()) this.inputRefs.push({ kind: "task_run", id: u.runId });
    this.scope = caseScope(db, workflow, cfg);
    this.snapshot = latestSnapshot(db, workflow.id);
    this.docs = caseDocs;
  }

  /** Pick the sentence for the configured content language: L("tiếng Việt", "English") */
  get L(): (vi: string, en: string) => string {
    return L(this.cfg);
  }

  /** Case revision this run works on */
  get revision(): number {
    return this.workflow.version;
  }

  /** Uploaded documents of the case (reading them is recorded as an input) */
  private mark(type: string): void {
    this.usedDatasets.add(type);
    if (!this.readFps.has(type)) this.readFps.set(type, scopedFingerprint(this.db, type, this.scope));
    // Also fingerprint the assessed period alone, so later monitoring days can be told apart from corrections
    const d = this.snapshot?.evaluationDate;
    if (type === "dpr" && d && !this.readFps.has(`dpr<=${d}`)) this.readFps.set(`dpr<=${d}`, scopedFingerprintUpTo(this.db, this.scope, d));
  }

  get caseDocs(): CaseDocument[] {
    this.mark("document");
    for (const d of this.docs) if (!this.inputRefs.some((r) => r.kind === "document" && r.id === d.id)) this.inputRefs.push({ kind: "document", id: d.id });
    return this.docs;
  }

  /**
   * Look up a SHARED dataset by a code field (part_no, item, cost_code, activity_type, contract_no…).
   * Only the codes actually requested become dependencies of this run ("quotes{part_no=X}"), so a
   * change to another code never re-runs this case, and a change to X invalidates exactly the steps
   * that used X. Matching is exact on normalized codes (list fields match whole tokens).
   */
  index(type: string, field: string): KeyedIndex {
    this.usedDatasets.add(type);
    const rows = activeRows(this.db, type);
    const by = new Map<string, ActiveRow[]>();
    for (const r of rows) for (const t of keyTokens(r.data[field])) by.set(t, [...(by.get(t) ?? []), r]);
    const all = (value: unknown): ActiveRow[] => {
      const k = keyedDepKey(type, field, value);
      const hit = by.get(normKey(value)) ?? [];
      if (!this.readFps.has(k)) this.readFps.set(k, keyedFingerprintOf(k, hit));
      for (const imp of new Set(hit.map((r) => r.importId))) {
        if (!this.inputRefs.some((r) => r.kind === "import" && r.id === imp)) this.inputRefs.push({ kind: "import", id: imp });
      }
      return hit;
    };
    return { all, get: (value: unknown) => all(value)[0], size: rows.length };
  }

  /** Record that this run reads the case's reservation ledger (confirmations / cancellations make it stale). */
  trackLedger(): void {
    if (!this.readFps.has(LEDGER_KEY)) this.readFps.set(LEDGER_KEY, ledgerFingerprint(this.db, this.workflow.id));
  }

  /** Rows of a dataset that belong to this case (platform/well scope; shared datasets unchanged). */
  caseRows(type: string): ActiveRow[] {
    this.mark(type);
    const rows = scopedRows(this.db, type, this.scope);
    for (const imp of new Set(rows.map((r) => r.importId))) {
      if (!this.inputRefs.some((r) => r.kind === "import" && r.id === imp)) this.inputRefs.push({ kind: "import", id: imp });
    }
    return rows;
  }

  get o(): OutputBuilder {
    return this.out;
  }

  /** Active rows of a dataset (records the dependency). */
  rows(type: string): ActiveRow[] {
    this.mark(type);
    const rows = activeRows(this.db, type);
    for (const imp of new Set(rows.map((r) => r.importId))) {
      if (!this.inputRefs.some((r) => r.kind === "import" && r.id === imp)) this.inputRefs.push({ kind: "import", id: imp });
    }
    return rows;
  }

  datasetLabel(type: string): string {
    return DATASET_MAP.get(type)?.label ?? type;
  }

  up(key: string): UpstreamResult | undefined {
    return this.upstream.get(key);
  }

  /**
   * Detection facts of the CURRENT revision (latest assessment). The detection
   * at case creation stays in workflows.detection_json — see initialDetection().
   */
  detection(): Record<string, unknown> {
    const initial = JSON.parse(this.workflow.detection_json) as Record<string, unknown>;
    const a = this.snapshot?.assessment;
    if (!a) return initial;
    return { ...initial, asOf: a.asOf ?? initial.asOf, well: a };
  }

  initialDetection(): Record<string, unknown> {
    return JSON.parse(this.workflow.detection_json);
  }

  /** Save a generated document; new version only when content changed. */
  saveDoc(slug: string, title: string, kind: string, markdown: string): OutputDocument {
    const docKey = `WF${this.workflow.id}/${slug}`;
    const hash = sha256(markdown);
    const latest = this.db
      .prepare("SELECT id, version, sha256 FROM documents WHERE doc_key = ? ORDER BY version DESC LIMIT 1")
      .get(docKey);
    let id: number;
    let version: number;
    if (latest && latest.sha256 === hash) {
      id = num(latest.id);
      version = num(latest.version);
    } else {
      version = latest ? num(latest.version) + 1 : 1;
      const res = this.db
        .prepare(
          `INSERT INTO documents (workflow_id, doc_key, version, title, kind, source, mime, content, sha256, task_run_id, created_at)
           VALUES (?, ?, ?, ?, ?, 'generated', 'text/markdown', ?, ?, ?, ?)`,
        )
        .run(this.workflow.id, docKey, version, title, kind, markdown, hash, this.runId, nowIso());
      id = num(res.lastInsertRowid);
    }
    const doc = { docId: id, title, kind, version };
    this.out.doc(doc);
    return doc;
  }

  /** Per dataset read: fingerprint of the rows in the case scope (impact analysis compares these). */
  scopedFingerprints(): Record<string, string> {
    const out: Record<string, string> = {};
    // Whole-dataset reads, assessed-period DPR and keyed (per-code) reads — exactly what was consumed
    for (const k of [...this.readFps.keys()].sort()) out[k] = this.readFps.get(k)!;
    return out;
  }

  /** Datasets that changed between the read and now (the result would mix old and new data). */
  changedSinceRead(): string[] {
    return [...this.readFps.entries()].filter(([k, fp]) => !k.startsWith("dpr<=") && fingerprintForKey(this.db, k, this.scope) !== fp).map(([k]) => k);
  }

  /** Fingerprint of everything this run consumed (scoped data + upstream runs). */
  fingerprint(): string {
    const ups = [...this.upstream.values()].map((u) => `${u.taskKey}:${u.runId}`).sort();
    const d = Object.fromEntries(Object.entries(this.scopedFingerprints()).filter(([k]) => !k.startsWith("dpr<=")));
    return sha256(JSON.stringify({ d, ups }));
  }

  /** Surface untrusted-document flags as warnings (content is data, never instructions). */
  noteUntrustedDocs(): void {
    for (const d of this.caseDocs) {
      if (d.flags.length) {
        const ev = this.out.ev(this.L(`Tài liệu tải lên "${d.title}" v${d.version}`, `Uploaded document "${d.title}" v${d.version}`), { kind: "document", id: d.id });
        this.out.warn(
          this.L(`Tài liệu "${d.title}" chứa câu dạng mệnh lệnh (${d.flags.join("; ")}) — đã xử lý như dữ liệu, không thay đổi quy trình hay quyền hạn [${ev}]`, `Document "${d.title}" contains instruction-like sentences (${d.flags.join("; ")}) — treated as data; workflow and permissions unchanged [${ev}]`),
        );
      }
    }
  }
}

export class OutputBuilder {
  evidence: Evidence[] = [];
  conclusions: Conclusion[] = [];
  assumptions: string[] = [];
  missingData: MissingData[] = [];
  documents: OutputDocument[] = [];
  nextSteps: string[] = [];
  warnings: string[] = [];
  facts: Record<string, unknown> = {};
  summary = "";
  waiting: AgentOutput["waiting"] = undefined;

  /** Finish in "waiting" (resource / other unit / date) instead of done — distinct from missing data. */
  wait(w: NonNullable<AgentOutput["waiting"]>): void {
    this.waiting = w;
  }

  /** Register evidence; returns its id (deduplicated by ref + label). */
  ev(label: string, ref: TraceRef): string {
    const key = JSON.stringify(ref) + label;
    const found = this.evidence.find((e) => JSON.stringify(e.ref) + e.label === key);
    if (found) return found.id;
    const id = `E${this.evidence.length + 1}`;
    this.evidence.push({ id, label, ref });
    return id;
  }

  conclude(text: string, basis: ConclusionBasis, evidence: string[]): string {
    const id = `K${this.conclusions.length + 1}`;
    this.conclusions.push({ id, text, basis, evidence });
    return id;
  }

  assume(text: string): void {
    if (!this.assumptions.includes(text)) this.assumptions.push(text);
  }

  need(m: Omit<MissingData, "id">): void {
    if (this.missingData.some((x) => x.description === m.description)) return;
    this.missingData.push({ id: `M${this.missingData.length + 1}`, ...m });
  }

  doc(d: OutputDocument): void {
    if (!this.documents.some((x) => x.docId === d.docId)) this.documents.push(d);
  }

  next(text: string): void {
    if (!this.nextSteps.includes(text)) this.nextSteps.push(text);
  }

  warn(text: string): void {
    if (!this.warnings.includes(text)) this.warnings.push(text);
  }

  build(): AgentOutput {
    return {
      summary: this.summary,
      conclusions: this.conclusions,
      evidence: this.evidence,
      assumptions: this.assumptions,
      missingData: this.missingData,
      documents: this.documents,
      nextSteps: this.nextSteps,
      mode: "demo-rules",
      warnings: this.warnings,
      facts: this.facts,
      ...(this.waiting ? { waiting: this.waiting } : {}),
    };
  }
}

export interface AgentDef {
  id: AgentId;
  name: string;
  /** Zone id of the agent's home room (matches room labels in the 3D layout) */
  room: string;
  run(ctx: AgentContext): Promise<void> | void;
}

export function rowRef(row: ActiveRow | { id: number }): TraceRef {
  return { kind: "data_row", id: row.id };
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function mdTable(header: string[], rows: Array<Array<unknown>>): string {
  const esc = (v: unknown) => String(v ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${header.map(esc).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
  ].join("\n");
}

/** Standard document footer — states provenance and mode. */
export function docFooter(ctx: AgentContext, agentName: string): string {
  const T = ctx.L;
  const sim = ctx.workflow.simulated ? T("\n\n> ⚠ Hồ sơ dựng trên **DỮ LIỆU GIẢ LẬP** — không dùng cho quyết định thực tế.", "\n\n> ⚠ Built on **SIMULATED DATA** — not for real decisions.") : "";
  return T(
    `\n\n---\n_Tạo bởi ${agentName} · task \`${ctx.task.key}\` · run #${ctx.runId} · ${nowIso()}. Mọi số liệu dẫn chiếu tới dòng dữ liệu/phép tính trong mục Bằng chứng của task._${sim}`,
    `\n\n---\n_Produced by ${agentName} · task \`${ctx.task.key}\` · run #${ctx.runId} · ${nowIso()}. Every figure refers to a data row / calculation in the task's Evidence section._${sim}`,
  );
}

export function isGasLift(liftType: string | undefined | null): boolean {
  return /gas\s*lift|^gl$/i.test(liftType ?? "");
}
