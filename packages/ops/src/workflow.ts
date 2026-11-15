import { L, contentLanguage, roleText, stepText, STEP_ACCEPT_EN } from "./lang";
import type { Database } from "./db";
import { nowIso, uuid, tx, num, sha256 } from "./db";
import type { OpsConfig } from "./config";
import type { AgentId, AgentOutput, GateCondition, Identity, ModeState, OperatingMode, TaskRow, TaskStatus, WaitKind, WorkflowRow } from "./types";
import { AgentContext, type CaseDocument, type Feedback, type UpstreamResult } from "./agents/kit";
import { AGENT_IMPLS, AGENT_INFO } from "./agents";
import { narrateWithLlm, type LlmClient } from "./llm";
import type { DetectionResult, WellDetection } from "./detection";
import { buildSnapshot, caseScope, datasetOfKey, fingerprintForKey, latestSnapshot, priorityFor, saveSnapshot, scopedFingerprint, scopedRows } from "./caseModel";
import { releaseCase, consumeCase, demandsFromFacts, planProblems, type PlanDemand } from "./resources";
import { addHoursIso, now, todayIso } from "./clock";

// ───────────────────────── Workflow definition ─────────────────────────

export interface GateDef {
  approver: AgentId;
  roleFrom: "technical" | "asset" | "readiness" | "close";
  /** Step whose output carries the package document and the gate conditions */
  packageFrom: string | ((tasks: Map<string, TaskRow>) => string);
  returnOptions: string[];
}

export type SlaKind = "agent" | "approval" | "data" | "execution";

export interface StepDef {
  key: string;
  title: string;
  agent: AgentId;
  deps: string[];
  /** "settled" = deps may also be in missing_data (synthesis must see gaps). Skipped deps always count as settled. */
  depMode?: "done" | "settled";
  gate?: GateDef;
  /** Opening condition that WAITS (returns why); the task stays pending */
  condition?: (o: Orchestrator, wf: WorkflowRow, tasks: Map<string, TaskRow>) => string | null;
  /** Applicability: returns a reason to SKIP the step (recorded, never shown as "done") */
  applies?: (o: Orchestrator, wf: WorkflowRow, tasks: Map<string, TaskRow>) => string | null;
  /** Responsible role/unit (who holds the work) */
  owner: string;
  /** What the step must receive to accept a hand-off */
  accept: string[];
  sla: SlaKind;
  /** Business phase shown to users */
  phase: string;
  /** Event type used for the 3D activity icon */
  visual: string;
}

export const BRANCH_LABEL: Record<string, string> = {
  data_gap: "Bổ sung dữ liệu",
  monitor: "Tiếp tục theo dõi",
  no_action: "Không cần hành động",
  internal: "Công việc nội bộ (không mua sắm)",
  procurement: "Cần khảo giá / mua sắm",
};

const facts = (o: Orchestrator, tasks: Map<string, TaskRow>, key: string): Record<string, unknown> | null => {
  const t = tasks.get(key);
  if (!t || t.status === "skipped") return null;
  return o.currentOutput(t)?.facts ?? null;
};
const classification = (o: Orchestrator, tasks: Map<string, TaskRow>) => facts(o, tasks, "ops.anomaly")?.classification as string | undefined;
const branch = (o: Orchestrator, tasks: Map<string, TaskRow>) => {
  const f = facts(o, tasks, "ops.proposal");
  if (!f) return undefined;
  if (typeof f.branch === "string") return f.branch;
  // Proposal produced before workflow v2 (no branch field): the old flow always went on to procurement
  const acts = f.activities as unknown[] | undefined;
  return Array.isArray(acts) ? (acts.length ? "procurement" : "monitor") : undefined;
};
const isActive = (b?: string) => b === "internal" || b === "procurement";

const decisionRef = (o: Orchestrator, wf: WorkflowRow, gateKey: string): string => {
  const d = o.db
    .prepare("SELECT d.id, d.actor_name, d.actor_role FROM decisions d JOIN tasks t ON t.id = d.task_id WHERE t.workflow_id = ? AND t.key = ? AND d.decision = 'approve' ORDER BY d.id DESC LIMIT 1")
    .get(wf.id, gateKey);
  return d ? ` (quyết định #${num(d.id)} của ${d.actor_name}, ${d.actor_role})` : "";
};

const notInvestigate = (o: Orchestrator, _wf: WorkflowRow, tasks: Map<string, TaskRow>): string | null => {
  const c = classification(o, tasks);
  return c === "investigate" ? null : `Case được phân loại "${BRANCH_LABEL[c ?? ""] ?? c}" ở bước tiếp nhận — không mở đánh giá chi tiết`;
};
const notActive = (o: Orchestrator, wf: WorkflowRow, tasks: Map<string, TaskRow>): string | null => {
  const b = branch(o, tasks);
  return isActive(b) ? null : `Phạm vi đã duyệt thuộc nhánh "${BRANCH_LABEL[b ?? ""] ?? b ?? "—"}"${decisionRef(o, wf, "gate.technical")} — không có công việc cần thực hiện`;
};

export const WORKFLOW_STEPS: StepDef[] = [
  {
    key: "ops.anomaly",
    title: "Tiếp nhận DPR, kiểm tra dữ liệu & phân loại case",
    agent: "ops_agent",
    deps: [],
    owner: "Operations",
    accept: ["DPR của đúng giàn/giếng, có cửa sổ đánh giá và baseline", "Định nghĩa oil_rate (rate_basis) khi có ngày downtime"],
    sla: "agent",
    phase: "Tiếp nhận",
    visual: "intake.anomaly",
  },
  {
    key: "eng.assessment",
    title: "Đánh giá kỹ thuật khai thác (sơ bộ)",
    agent: "prodeng_agent",
    deps: ["ops.anomaly"],
    applies: notInvestigate,
    owner: "Kỹ thuật khai thác",
    accept: ["Hồ sơ bất thường của revision hiện tại", "Phân loại case = cần đánh giá"],
    sla: "agent",
    phase: "Đánh giá sơ bộ",
    visual: "review.assessment",
  },
  {
    key: "mnt.review",
    title: "Đối chiếu bảo dưỡng, thiết bị & vật tư",
    agent: "maint_agent",
    deps: ["ops.anomaly"],
    applies: notInvestigate,
    owner: "Bảo dưỡng & Độ tin cậy",
    accept: ["Hồ sơ bất thường của revision hiện tại"],
    sla: "agent",
    phase: "Đánh giá sơ bộ",
    visual: "review.maintenance",
  },
  {
    key: "hse.screening",
    title: "Rà soát HSE sơ bộ (lập kế hoạch)",
    agent: "hse_agent",
    deps: ["ops.anomaly"],
    applies: notInvestigate,
    owner: "HSE",
    accept: ["Hồ sơ bất thường của revision hiện tại"],
    sla: "agent",
    phase: "Đánh giá sơ bộ",
    visual: "review.hse",
  },
  {
    key: "ops.proposal",
    title: "Chọn phương án & nhánh xử lý",
    agent: "ops_agent",
    deps: ["eng.assessment", "mnt.review", "hse.screening"],
    depMode: "settled",
    owner: "Operations",
    accept: ["Kết quả 3 nhánh đánh giá (hoặc lý do bỏ qua)"],
    sla: "agent",
    phase: "Chọn phương án",
    visual: "synthesis.proposal",
  },
  {
    key: "gate.technical",
    title: "Phê duyệt phạm vi (kỹ thuật)",
    agent: "eng_lead",
    deps: ["ops.proposal"],
    gate: { approver: "eng_lead", roleFrom: "technical", packageFrom: "ops.proposal", returnOptions: ["eng.assessment", "mnt.review", "hse.screening", "ops.proposal"] },
    owner: "Trưởng phòng Kỹ thuật khai thác",
    accept: ["Phương án và nhánh xử lý của revision hiện tại"],
    sla: "approval",
    phase: "Phê duyệt phạm vi",
    visual: "attention.requested",
  },
  {
    key: "proc.prep",
    title: "Khảo giá & dự toán (RFQ nháp — chưa cam kết mua)",
    agent: "contracts_agent",
    deps: ["gate.technical"],
    applies: (o, wf, tasks) => notActive(o, wf, tasks) ?? (branch(o, tasks) === "procurement" ? null : `Phạm vi đã duyệt là công việc nội bộ${decisionRef(o, wf, "gate.technical")} — không cần khảo giá/mua sắm`),
    owner: "Hợp đồng & Mua sắm",
    accept: ["Phạm vi đã duyệt (danh mục hoạt động, vật tư)"],
    sla: "agent",
    phase: "Khảo giá & kế hoạch",
    visual: "review.contracts",
  },
  {
    key: "log.plan",
    title: "Nhu cầu & kế hoạch hậu cần",
    agent: "logistics_agent",
    deps: ["gate.technical"],
    applies: (o, wf, tasks) =>
      notActive(o, wf, tasks) ?? (facts(o, tasks, "ops.proposal")?.needsTransport !== false ? null : `Phạm vi đã duyệt không cần vận chuyển người/hàng ra giàn${decisionRef(o, wf, "gate.technical")}`),
    owner: "Hàng hải & Hậu cần",
    accept: ["Phạm vi đã duyệt (nhân lực, thiết bị, vật tư cần vận chuyển)"],
    sla: "agent",
    phase: "Khảo giá & kế hoạch",
    visual: "scenario.logistics",
  },
  {
    key: "fin.check",
    title: "Kiểm tra ngân sách & nguồn lực",
    agent: "finance_agent",
    deps: ["proc.prep", "log.plan"],
    applies: (o, wf, tasks) => {
      const r = notActive(o, wf, tasks);
      if (r) return r;
      return tasks.get("proc.prep")?.status === "skipped" && tasks.get("log.plan")?.status === "skipped" ? "Không phát sinh chi phí mua sắm hay hậu cần — không có khoản chi cần kiểm tra" : null;
    },
    owner: "Tài chính",
    accept: ["Dự toán mua sắm/dịch vụ (kể cả phần chưa có giá)", "Chi phí hậu cần"],
    sla: "agent",
    phase: "Ngân sách & nguồn lực",
    visual: "review.budget",
  },
  {
    key: "ops.package",
    title: "Lập hồ sơ trình duyệt cam kết",
    agent: "ops_agent",
    deps: ["fin.check"],
    applies: (_o, _wf, tasks) => (tasks.get("fin.check")?.status === "skipped" ? "Không có khoản chi cần cam kết" : null),
    owner: "Operations",
    accept: ["Kết quả kiểm tra ngân sách & giữ chỗ nguồn lực"],
    sla: "agent",
    phase: "Phê duyệt cam kết",
    visual: "document.package",
  },
  {
    key: "gate.asset",
    title: "Phê duyệt cam kết chi (theo ma trận thẩm quyền)",
    agent: "asset_manager",
    deps: ["ops.package"],
    applies: (_o, _wf, tasks) => (tasks.get("ops.package")?.status === "skipped" ? "Không có khoản chi cần cam kết" : null),
    gate: {
      approver: "asset_manager",
      roleFrom: "asset",
      packageFrom: "ops.package",
      returnOptions: ["eng.assessment", "mnt.review", "hse.screening", "ops.proposal", "proc.prep", "log.plan", "fin.check", "ops.package"],
    },
    owner: "Người có thẩm quyền theo ma trận",
    accept: ["Hồ sơ trình duyệt và danh sách điều kiện của revision hiện tại"],
    sla: "approval",
    phase: "Phê duyệt cam kết",
    visual: "attention.requested",
  },
  {
    key: "ops.release",
    title: "Lập bản nháp PR / đặt chỗ / work request",
    agent: "ops_agent",
    deps: ["gate.asset"],
    applies: notActive,
    owner: "Operations",
    accept: ["Quyết định cam kết (hoặc phạm vi nội bộ đã duyệt)"],
    sla: "agent",
    phase: "Chuẩn bị thực hiện",
    visual: "message.outbox",
  },
  {
    key: "hse.readiness",
    title: "Kiểm tra sẵn sàng (HSE, nhân sự, phương tiện, dữ liệu) tại ngày thực hiện",
    agent: "hse_agent",
    deps: ["ops.release"],
    applies: notActive,
    owner: "HSE",
    accept: ["Phạm vi đã chốt", "Ngày dự kiến thực hiện"],
    sla: "agent",
    phase: "Sẵn sàng",
    visual: "review.hse",
  },
  {
    key: "gate.readiness",
    title: "Xác nhận sẵn sàng huy động (đầu mối offshore)",
    agent: "oim",
    deps: ["hse.readiness"],
    applies: notActive,
    gate: { approver: "oim", roleFrom: "readiness", packageFrom: "hse.readiness", returnOptions: ["hse.readiness", "log.plan", "ops.release"] },
    owner: "OIM / đầu mối offshore",
    accept: ["Danh sách điều kiện sẵn sàng của revision hiện tại"],
    sla: "approval",
    phase: "Sẵn sàng",
    visual: "attention.requested",
  },
  {
    key: "ops.execution",
    title: "Ghi nhận kết quả thực hiện (người phụ trách xác nhận)",
    agent: "ops_agent",
    deps: ["gate.readiness"],
    applies: notActive,
    owner: "Người phụ trách thực hiện",
    accept: ["Xác nhận sẵn sàng", "Bản ghi thực hiện có người xác nhận"],
    sla: "execution",
    phase: "Thực hiện",
    visual: "intake.anomaly",
  },
  {
    key: "eng.evaluation",
    title: "Đánh giá hiệu quả theo tiêu chí nghiệm thu",
    agent: "prodeng_agent",
    deps: ["ops.execution"],
    applies: notActive,
    owner: "Kỹ thuật khai thác",
    accept: ["Kết quả thực hiện đã xác nhận", "DPR sau thực hiện"],
    sla: "data",
    phase: "Đánh giá hiệu quả",
    visual: "review.assessment",
  },
  {
    key: "gate.close",
    title: "Đóng case (kết luận & bài học)",
    agent: "eng_lead",
    deps: ["gate.technical", "eng.evaluation"],
    gate: {
      approver: "eng_lead",
      roleFrom: "close",
      packageFrom: (tasks) => (tasks.get("eng.evaluation")?.status === "done" ? "eng.evaluation" : "ops.proposal"),
      returnOptions: ["eng.assessment", "ops.proposal", "ops.execution", "eng.evaluation"],
    },
    owner: "Trưởng phòng Kỹ thuật khai thác",
    accept: ["Đánh giá hiệu quả (hoặc kết luận theo dõi/không hành động đã duyệt)"],
    sla: "approval",
    phase: "Đóng case",
    visual: "attention.requested",
  },
];

export const STEP_MAP = new Map(WORKFLOW_STEPS.map((s) => [s.key, s]));

/** All transitive dependents of a step. */
export function dependentsOf(key: string): string[] {
  const out = new Set<string>();
  const visit = (k: string) => {
    for (const s of WORKFLOW_STEPS) {
      if (s.deps.includes(k) && !out.has(s.key)) {
        out.add(s.key);
        visit(s.key);
      }
    }
  };
  visit(key);
  return [...out];
}

/** All transitive prerequisites of a step (its real inputs). */
export function ancestorsOf(key: string): string[] {
  const out = new Set<string>();
  const visit = (k: string) => {
    for (const d of STEP_MAP.get(k)?.deps ?? []) {
      if (!out.has(d)) {
        out.add(d);
        visit(d);
      }
    }
  };
  visit(key);
  return [...out];
}

// ───────────────────────── Orchestrator ─────────────────────────

export interface VisualEvent {
  eventId: string;
  type: string;
  agent: string;
  room: string | null;
  label: string;
  msg?: { key: string; params?: Record<string, string | number> };
  workflowId: number | null;
  taskId: number | null;
  source: string;
  ts: string;
}

export interface OrchestratorOptions {
  publish?: (e: VisualEvent) => void;
  llm?: LlmClient | null;
  /** Processing mode (requested/effective/configuration). Defaults to rules-only. */
  mode?: ModeState;
  /** "production" rejects demo identities for decisions and outbox approvals */
  operatingMode?: OperatingMode;
  /** Override demo pacing (tests use 0) */
  taskDelayMs?: number;
}

export function rulesMode(): ModeState {
  return {
    requested: "rules",
    effective: "rules",
    configurationStatus: "not_applicable",
    detail: "Quy tắc xác định trên dữ liệu đầu vào; không gọi LLM",
    reloadRequiresRestart: false,
  };
}

export class OpsError extends Error {
  /** Duck-type marker: bundlers may duplicate this class, so `instanceof` is unreliable across chunks */
  readonly isOpsError = true;
  /**
   * `code` + `params` are stable (catalog keys `err.<code>` in the interface); `message` stays the
   * original Vietnamese text for logs/support. Never derive meaning from the message text.
   */
  constructor(public status: number, message: string, public code?: string, public params?: Record<string, string | number | null | undefined>) {
    super(message);
    this.name = "OpsError";
  }
}

export function isOpsError(err: unknown): err is OpsError {
  return !!err && typeof err === "object" && (err as { isOpsError?: boolean }).isOpsError === true && typeof (err as { status?: unknown }).status === "number";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Steps that consume the assessed DPR period (before the scope decision) */
const PRE_SCOPE = new Set(["ops.anomaly", "eng.assessment", "mnt.review", "hse.screening", "ops.proposal"]);
/**
 * After the scope decision, planning inputs (HSE register, permit matrix, stock, uploads) act on the
 * downstream steps that re-check them (readiness, procurement) — they do not reopen the approved scope.
 */
const PLANNING_INPUTS = new Set(["hse_documents", "permit_matrix", "spare_parts", "document"]);
const ACTIVE_WF = "('open','approved')";
const PRIORITY_ORDER: Record<string, number> = { P1: 1, P2: 2, P3: 3 };

export class Orchestrator {
  private inFlight = new Map<number, { p: Promise<void>; agent: string; llm: boolean }>();

  /** Current processing mode — replaced as a whole by setLlm(); runs snapshot it when they start */
  mode: ModeState;
  readonly operatingMode: OperatingMode;
  private llmClient: LlmClient | null;

  constructor(
    readonly db: Database,
    readonly cfg: OpsConfig,
    private opts: OrchestratorOptions = {},
  ) {
    this.mode = opts.mode ?? rulesMode();
    this.operatingMode = opts.operatingMode ?? "demo";
    this.llmClient = opts.llm ?? null;
  }

  get llm(): LlmClient | null {
    return this.llmClient;
  }

  /**
   * Hot-swap the processing configuration. Applies to tasks that START after
   * this call; a task already running keeps the mode + client it started with.
   */
  setLlm(mode: ModeState, llm: LlmClient | null): void {
    this.mode = mode;
    this.llmClient = llm;
  }

  // ── events ──

  emit(e: {
    type: string;
    label: string;
    source: string;
    workflowId?: number | null;
    taskId?: number | null;
    agentId?: string | null;
    room?: string | null;
    payload?: Record<string, unknown>;
    dedupeKey?: string;
    /** Stable message key + params (the interface renders it per language; `label` stays the original text) */
    msg?: { key: string; params?: Record<string, string | number> };
  }): string | null {
    const eventId = uuid();
    const ts = nowIso();
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO events (event_id, workflow_id, task_id, agent_id, ts, source, type, room, label, payload_json, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(eventId, e.workflowId ?? null, e.taskId ?? null, e.agentId ?? null, ts, e.source, e.type, e.room ?? null, e.label, JSON.stringify({ ...(e.payload ?? {}), ...(e.msg ? { msg: e.msg } : {}) }), e.dedupeKey ?? null);
    if (num(res.changes) === 0) return null; // duplicate (dedupe_key)
    if (e.agentId && this.opts.publish) {
      try {
        this.opts.publish({ eventId, type: e.type, agent: e.agentId, room: e.room ?? null, label: e.label, msg: e.msg, workflowId: e.workflowId ?? null, taskId: e.taskId ?? null, source: e.source, ts });
      } catch {
        // visualization must never break the workflow
      }
    }
    return eventId;
  }

  roomOf(agent: AgentId | string): string | null {
    return AGENT_INFO.get(agent as AgentId)?.room ?? null;
  }

  // ── queries ──

  workflow(id: number): WorkflowRow {
    const wf = this.db.prepare("SELECT * FROM workflows WHERE id = ?").get(id);
    if (!wf) throw new OpsError(404, `Không có workflow #${id}`, "not_found", { what: "workflow", id });
    return wf as unknown as WorkflowRow;
  }

  tasks(workflowId: number): Map<string, TaskRow> {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE workflow_id = ? ORDER BY id").all(workflowId) as unknown as TaskRow[];
    return new Map(rows.map((t) => [t.key, t]));
  }

  task(id: number): TaskRow {
    const t = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    if (!t) throw new OpsError(404, `Không có task #${id}`, "not_found", { what: "task", id });
    return t as unknown as TaskRow;
  }

  currentOutput(task: TaskRow): AgentOutput | null {
    if (!task.current_run_id) return null;
    const r = this.db.prepare("SELECT output_json FROM task_runs WHERE id = ?").get(task.current_run_id);
    return r?.output_json ? (JSON.parse(r.output_json as string) as AgentOutput) : null;
  }

  private dueAt(kind: SlaKind, until?: string): string {
    if (until) return `${until}T23:59:59.000Z`;
    const h = { agent: this.cfg.sla.agentHours, approval: this.cfg.sla.approvalHours, data: this.cfg.sla.dataHours, execution: this.cfg.sla.executionHours }[kind];
    return addHoursIso(h);
  }

  private setState(taskId: number, status: TaskStatus, note: string | null, wait: WaitKind | null, due: string | null): void {
    this.db.prepare("UPDATE tasks SET status = ?, status_note = ?, wait_kind = ?, due_at = ?, updated_at = ? WHERE id = ?").run(status, note, wait, due, nowIso(), taskId);
  }

  // ── lifecycle ──

  /** Add tasks for steps that did not exist when a case was created (database from an earlier version). */
  migrateWorkflows(): number {
    let added = 0;
    const wfs = this.db.prepare(`SELECT * FROM workflows`).all() as unknown as WorkflowRow[];
    for (const wf of wfs) {
      const have = this.tasks(wf.id);
      const missing = WORKFLOW_STEPS.filter((s) => !have.has(s.key));
      const active = wf.status === "open" || wf.status === "approved";
      const ins = this.db.prepare("INSERT INTO tasks (workflow_id, key, title, agent_id, status, owner, updated_at, status_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const s of missing) {
        ins.run(wf.id, s.key, s.title, s.agent, active ? "pending" : "cancelled", s.owner, nowIso(), active ? "Bước mới của quy trình v2 — bổ sung cho case tạo trước nâng cấp" : "Case đã kết thúc trước nâng cấp quy trình");
        added++;
      }
      for (const s of WORKFLOW_STEPS) {
        this.db.prepare("UPDATE tasks SET title = ?, owner = COALESCE(owner, ?) WHERE workflow_id = ? AND key = ?").run(s.title, s.owner, wf.id, s.key);
      }
      if (!wf.well_key) this.db.prepare("UPDATE workflows SET well_key = ? WHERE id = ?").run(`${wf.platform}/${wf.well}`, wf.id);
      if (!latestSnapshot(this.db, wf.id)) {
        const det = JSON.parse(wf.detection_json) as { well?: WellDetection };
        saveSnapshot(this.db, wf.id, buildSnapshot(this.db, this.cfg, wf, wf.version, "Snapshot ban đầu (dựng lại khi nâng cấp)", det.well ?? null), "migration");
      }
    }
    return added;
  }

  /** After a crash/restart: interrupted runs are recorded and their tasks re-queued. */
  recover(): number {
    const running = this.db.prepare("SELECT * FROM tasks WHERE status = 'running'").all() as unknown as TaskRow[];
    for (const t of running) {
      tx(this.db, () => {
        this.db.prepare("UPDATE task_runs SET status = 'error', error = 'Bị gián đoạn do hệ thống khởi động lại', finished_at = ?, superseded = 1 WHERE task_id = ? AND status = 'running'").run(nowIso(), t.id);
        this.setState(t.id, "pending", "Khôi phục sau khởi động lại — chạy lại", null, null);
      });
      this.emit({ type: "task.recovered", label: `Khôi phục ${t.key} sau khởi động lại`, source: "system", workflowId: t.workflow_id, taskId: t.id, agentId: t.agent_id, room: this.roomOf(t.agent_id) });
    }
    return running.length;
  }

  /** Active case (open/approved) for a namespaced well, if any. */
  activeCaseFor(platform: string, well: string): WorkflowRow | null {
    const r = this.db.prepare(`SELECT * FROM workflows WHERE status IN ${ACTIVE_WF} AND (well_key = ? OR (well_key IS NULL AND well = ? AND platform = ?)) ORDER BY id DESC LIMIT 1`).get(`${platform}/${well}`, well, platform);
    return (r as unknown as WorkflowRow) ?? null;
  }

  /** Open a case for an anomalous (or suspect, data-gap) well. */
  createCase(det: WellDetection, meta: { asOf: string; thresholdPct: number; consecutiveDays: number; dprImportId: number; simulated: boolean }): { workflowId: number; created: boolean } {
    const open = this.activeCaseFor(det.platform, det.well);
    if (open) return { workflowId: open.id, created: false };
    const now = nowIso();
    const seq = num(this.db.prepare("SELECT COUNT(*) c FROM workflows").get()!.c) + 1;
    const caseNo = `CASE-${(det.asOf ?? meta.asOf).replace(/-/g, "")}-${det.well}-${String(seq).padStart(3, "0")}`;
    const detection = { asOf: det.asOf ?? meta.asOf, thresholdPct: meta.thresholdPct, consecutiveDays: meta.consecutiveDays, well: det, dprImportId: meta.dprImportId };
    const T = L(this.cfg);
    const title = det.anomaly
      ? T(`Giếng ${det.well} (${det.platform}) giảm sản lượng ${det.minDropPct?.toFixed(1)}% so với baseline`, `Well ${det.well} (${det.platform}) output down ${det.minDropPct?.toFixed(1)}% versus baseline`)
      : T(`Giếng ${det.well} (${det.platform}) nghi suy giảm — chưa đủ dữ liệu đánh giá`, `Well ${det.well} (${det.platform}) suspected decline — not enough data to assess`);
    const priority = priorityFor(this.cfg, det);
    const id = tx(this.db, () => {
      const r = this.db
        .prepare("INSERT INTO workflows (case_no, title, well, platform, status, version, created_at, updated_at, detection_json, simulated, well_key, priority) VALUES (?, ?, ?, ?, 'open', 1, ?, ?, ?, ?, ?, ?)")
        .run(caseNo, title, det.well, det.platform, now, now, JSON.stringify(detection), meta.simulated ? 1 : 0, det.wellKey, priority);
      const wfId = num(r.lastInsertRowid);
      const ins = this.db.prepare("INSERT INTO tasks (workflow_id, key, title, agent_id, status, owner, case_revision, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, 1, ?)");
      for (const s of WORKFLOW_STEPS) ins.run(wfId, s.key, s.title, s.agent, s.owner, now);
      const wf = this.workflow(wfId);
      saveSnapshot(this.db, wfId, buildSnapshot(this.db, this.cfg, wf, 1, this.T(`Tạo case từ DPR (import #${meta.dprImportId})`, `Case created from DPR (import #${meta.dprImportId})`), det), `creation:dpr#${meta.dprImportId}`);
      return wfId;
    });
    this.emit({ type: "case.created", label: T(`Tạo ${caseNo} (${priority}): ${title}`, `Created ${caseNo} (${priority}): ${title}`), source: "orchestrator", workflowId: id, agentId: "ops_agent", room: "zone_ops" , msg: { key: "ev.case.created", params: { caseNo, priority } } });
    return { workflowId: id, created: true };
  }

  /** Start a new case revision with a fresh input snapshot. */
  bumpRevision(wf: WorkflowRow, reason: string, trigger: string, assessment?: WellDetection | null): number {
    const rev = wf.version + 1;
    this.db.prepare("UPDATE workflows SET version = ?, updated_at = ? WHERE id = ?").run(rev, nowIso(), wf.id);
    const prev = latestSnapshot(this.db, wf.id);
    const fresh = this.workflow(wf.id);
    saveSnapshot(this.db, wf.id, buildSnapshot(this.db, this.cfg, fresh, rev, reason, assessment === undefined ? (prev?.assessment ?? null) : assessment), trigger);
    // Outbound drafts of earlier revisions can no longer be approved
    this.db
      .prepare("UPDATE outbox SET status = 'superseded', status_note = ? WHERE workflow_id = ? AND status = 'draft' AND (case_revision IS NULL OR case_revision < ?)")
      .run(`Thuộc revision cũ — thay bằng rev ${rev}: ${reason}`, wf.id, rev);
    this.db
      .prepare("UPDATE outbox SET status_note = ? WHERE workflow_id = ? AND status = 'approved_to_send' AND (case_revision IS NULL OR case_revision < ?)")
      .run(`⚠ Đã duyệt gửi ở revision cũ; đầu vào thay đổi ở rev ${rev} — kiểm tra lại với bên nhận`, wf.id, rev);
    this.emit({ type: "case.revised", label: `${wf.case_no} → rev ${rev}: ${reason}`, source: "orchestrator", workflowId: wf.id, agentId: "ops_agent", room: "zone_ops" , msg: { key: "ev.case.revised", params: { caseNo: wf.case_no, rev } } });
    return rev;
  }

  private depsState(step: StepDef, tasks: Map<string, TaskRow>): string | null {
    for (const d of step.deps) {
      const t = tasks.get(d);
      if (!t) return `Thiếu bước ${d}`;
      const ok = t.status === "done" || t.status === "skipped" || (step.depMode === "settled" && t.status === "missing_data");
      if (!ok) return `Chờ "${STEP_MAP.get(d)?.title ?? d}" (${t.status})`;
    }
    return null;
  }

  /** Record a conditional skip: a system run with the reason (traceable), never "done". */
  private skip(wf: WorkflowRow, t: TaskRow, reason: string): void {
    const out: AgentOutput = {
      summary: `Bỏ qua: ${reason}`,
      conclusions: [],
      evidence: [],
      assumptions: [],
      missingData: [],
      documents: [],
      nextSteps: [],
      mode: "demo-rules",
      warnings: [],
      facts: { skipped: true, reason },
    };
    tx(this.db, () => {
      const r = this.db
        .prepare("INSERT INTO task_runs (task_id, attempt, status, started_at, finished_at, output_json, mode, case_revision) VALUES (?, ?, 'skipped', ?, ?, ?, 'system', ?)")
        .run(t.id, t.attempts, nowIso(), nowIso(), JSON.stringify(out), wf.version);
      this.db.prepare("UPDATE tasks SET current_run_id = ?, case_revision = ? WHERE id = ?").run(num(r.lastInsertRowid), wf.version, t.id);
      this.setState(t.id, "skipped", reason, null, null);
      this.db.prepare("UPDATE handoffs SET status = 'superseded', response = ?, responded_at = ? WHERE workflow_id = ? AND to_key = ? AND status = 'offered'").run(`Bước được bỏ qua: ${reason}`, nowIso(), wf.id, t.key);
    });
    this.emit({ type: "task.skipped", label: `bỏ qua "${t.title}": ${reason.slice(0, 120)}`, source: "orchestrator", workflowId: wf.id, taskId: t.id, agentId: t.agent_id, room: this.roomOf(t.agent_id) , msg: { key: "ev.task.skipped", params: { step: t.key } } });
  }

  private agentLoad(agent: string): number {
    let n = 0;
    for (const v of this.inFlight.values()) if (v.agent === agent) n++;
    return n;
  }

  private llmLoad(): number {
    let n = 0;
    for (const v of this.inFlight.values()) if (v.llm) n++;
    return n;
  }

  /** Start every runnable task (priority order, concurrency-limited). Returns the number started/changed. */
  tick(): number {
    let started = 0;
    const today = todayIso();
    const wfs = (this.db.prepare(`SELECT * FROM workflows WHERE status IN ${ACTIVE_WF}`).all() as unknown as WorkflowRow[]).sort(
      (a, b) => (PRIORITY_ORDER[a.priority ?? "P3"] ?? 3) - (PRIORITY_ORDER[b.priority ?? "P3"] ?? 3) || a.id - b.id,
    );
    for (const wf of wfs) {
      const tasks = this.tasks(wf.id);
      for (const t of tasks.values()) {
        // Waiting for a date: wake up when it is reached
        if (t.status === "waiting" && t.wait_kind === "date") {
          const until = (this.currentOutput(t)?.waiting?.until ?? "") as string;
          if (until && until <= today) {
            this.setState(t.id, "pending", `Đã tới ngày ${until} — chạy lại`, null, null);
            t.status = "pending";
          }
        }
        if (t.status !== "pending" || this.inFlight.has(t.id)) continue;
        const step = STEP_MAP.get(t.key);
        if (!step) continue; // unknown step from another version — ignored
        const waiting = this.depsState(step, tasks);
        if (waiting) {
          if (t.status_note !== waiting) this.db.prepare("UPDATE tasks SET status_note = ?, wait_kind = 'dependency' WHERE id = ?").run(waiting, t.id);
          continue;
        }
        const skipReason = step.applies?.(this, wf, tasks) ?? null;
        if (skipReason) {
          this.skip(wf, t, skipReason);
          t.status = "skipped";
          started++;
          continue;
        }
        const cond = step.condition?.(this, wf, tasks) ?? null;
        if (cond) {
          if (t.status_note !== cond) this.db.prepare("UPDATE tasks SET status_note = ?, wait_kind = 'dependency' WHERE id = ?").run(cond, t.id);
          continue;
        }
        if (step.gate) {
          this.openGate(wf, t, step, tasks);
          started++;
          continue;
        }
        if (this.mode.effective === "blocked") {
          // Never fall back to rules when the user asked for LLM processing
          const note = this.T(`Tạm dừng: ${this.mode.detail}`, `Paused: ${this.mode.detail}`);
          if (t.status_note !== note) this.db.prepare("UPDATE tasks SET status_note = ?, wait_kind = 'config' WHERE id = ?").run(note, t.id);
          continue;
        }
        if (this.agentLoad(step.agent) >= this.cfg.runtime.maxConcurrentPerAgent) {
          const note = this.T(`Xếp hàng: ${AGENT_INFO.get(step.agent)?.short ?? step.agent} đang xử lý ${this.agentLoad(step.agent)} việc (giới hạn ${this.cfg.runtime.maxConcurrentPerAgent}); ưu tiên ${wf.priority ?? "P3"}`, `Queued: ${AGENT_INFO.get(step.agent)?.short ?? step.agent} is handling ${this.agentLoad(step.agent)} task(s) (limit ${this.cfg.runtime.maxConcurrentPerAgent}); priority ${wf.priority ?? "P3"}`);
          if (t.status_note !== note) this.db.prepare("UPDATE tasks SET status_note = ?, wait_kind = 'resource' WHERE id = ?").run(note, t.id);
          continue;
        }
        const useLlm = this.mode.effective === "llm";
        if (useLlm && this.llmLoad() >= this.cfg.runtime.llm.maxConcurrent) {
          const note = this.T(`Xếp hàng: đang có ${this.llmLoad()} lời gọi LLM (giới hạn ${this.cfg.runtime.llm.maxConcurrent})`, `Queued: ${this.llmLoad()} LLM call(s) in progress (limit ${this.cfg.runtime.llm.maxConcurrent})`);
          if (t.status_note !== note) this.db.prepare("UPDATE tasks SET status_note = ?, wait_kind = 'resource' WHERE id = ?").run(note, t.id);
          continue;
        }
        const p = this.execute(wf.id, t.id, step).finally(() => this.inFlight.delete(t.id));
        this.inFlight.set(t.id, { p, agent: step.agent, llm: useLlm });
        t.status = "running";
        started++;
      }
    }
    return started;
  }

  /** Test helper: tick until nothing more can start and nothing is running. */
  async runUntilIdle(maxRounds = 200): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      const started = this.tick();
      if (this.inFlight.size) {
        await Promise.allSettled([...this.inFlight.values()].map((v) => v.p));
        continue;
      }
      if (!started) return;
    }
  }

  get busy(): boolean {
    return this.inFlight.size > 0;
  }

  // ── hand-offs ──

  /** A finished step hands its result to each dependent step (artifact version + acceptance criteria + due). */
  private offerHandoffs(wf: WorkflowRow, t: TaskRow, runId: number, out: AgentOutput): void {
    const doc = out.documents[0];
    const meta = doc ? this.db.prepare("SELECT id, version, sha256 FROM documents WHERE id = ?").get(doc.docId) : undefined;
    this.db.prepare("UPDATE handoffs SET status = 'superseded', response = COALESCE(response, ?), responded_at = ? WHERE workflow_id = ? AND from_key = ? AND status = 'offered'").run(this.T("Có kết quả mới hơn", "A newer result exists"), nowIso(), wf.id, t.key);
    for (const s of WORKFLOW_STEPS.filter((x) => x.deps.includes(t.key))) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO handoffs (workflow_id, case_revision, from_task_id, from_key, from_agent, to_key, to_agent, artifact_doc_id, artifact_version, artifact_sha, from_run_id, request, acceptance_json, due_at, status, created_at, business_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offered', ?, ?)`,
        )
        .run(
          wf.id,
          wf.version,
          t.id,
          t.key,
          t.agent_id,
          s.key,
          s.agent,
          meta ? num(meta.id) : null,
          meta ? num(meta.version) : null,
          meta ? String(meta.sha256) : null,
          runId,
          stepText(this.cfg, s.key, s.title),
          JSON.stringify(contentLanguage(this.cfg) === "en" ? (STEP_ACCEPT_EN[s.key] ?? s.accept) : s.accept),
          this.dueAt(s.sla),
          nowIso(),
          `${wf.id}:${wf.version}:${t.key}->${s.key}:${runId}`,
        );
    }
  }

  /** The receiving step takes the hand-offs addressed to it. */
  /** Sentence in the configured content language (config content.language). */
  private get T(): (vi: string, en: string) => string {
    return L(this.cfg);
  }

  private acceptHandoffs(wf: WorkflowRow, key: string, response: string): void {
    this.db.prepare("UPDATE handoffs SET status = 'accepted', response = ?, responded_at = ? WHERE workflow_id = ? AND to_key = ? AND status = 'offered'").run(response, nowIso(), wf.id, key);
  }

  // ── gates ──

  private approverRole(gate: GateDef, tasks: Map<string, TaskRow>, pkgKey: string): string {
    if (gate.roleFrom === "technical") return this.cfg.approvals.technicalRole;
    if (gate.roleFrom === "readiness") return this.cfg.approvals.readinessRole;
    if (gate.roleFrom === "close") return this.cfg.approvals.closeRole;
    const pkg = tasks.get(pkgKey);
    const role = pkg ? (this.currentOutput(pkg)?.facts.requiredApproverRole as string | undefined) : undefined;
    return role ?? this.cfg.approvals.assetRole;
  }

  private openGate(wf: WorkflowRow, t: TaskRow, step: StepDef, tasks: Map<string, TaskRow>): void {
    const gate = step.gate!;
    const pkgKey = typeof gate.packageFrom === "function" ? gate.packageFrom(tasks) : gate.packageFrom;
    const src = tasks.get(pkgKey)!;
    const srcOut = this.currentOutput(src);
    const pkgDoc = srcOut?.documents.find((d) => ["decision_package", "proposal", "readiness_check", "evaluation"].includes(d.kind)) ?? srcOut?.documents[0];
    if (!pkgDoc) {
      this.setState(t.id, "error", `Không có hồ sơ để trình duyệt (bước ${pkgKey})`, "system", this.dueAt("agent"));
      return;
    }
    const doc = this.db.prepare("SELECT id, version, sha256 FROM documents WHERE id = ?").get(pkgDoc.docId)!;
    const role = this.approverRole(gate, tasks, pkgKey);
    const T = this.T;
    const roleShown = roleText(this.cfg, role);
    const conditions = ((srcOut?.facts.conditions as GateCondition[] | undefined) ?? []).map((c) => ({ ...c, waivable: c.waivable && !this.cfg.policy.nonWaivable.includes(c.code) }));
    const now = nowIso();
    const unmet = conditions.filter((c) => !c.met && c.kind === "check");
    const confirms = conditions.filter((c) => c.kind === "confirm");
    const output: AgentOutput = {
      summary: T(
        `Chờ ${role} quyết định hồ sơ "${pkgDoc.title}" v${num(doc.version)} (case rev ${wf.version}). ${unmet.length ? `${unmet.length} điều kiện chưa đạt` : "Các điều kiện kiểm tra đều đạt"}${confirms.length ? `; ${confirms.length} mục cần người duyệt xác nhận` : ""}.`,
        `Awaiting the ${roleShown} decision on package "${pkgDoc.title}" v${num(doc.version)} (case rev ${wf.version}). ${unmet.length ? `${unmet.length} condition(s) not met` : "All checked conditions are met"}${confirms.length ? `; ${confirms.length} item(s) for the approver to confirm` : ""}.`,
      ),
      conclusions: [],
      evidence: [
        { id: "E1", label: T(`Hồ sơ trình duyệt "${pkgDoc.title}" v${num(doc.version)} · sha256 ${String(doc.sha256).slice(0, 12)}…`, `Approval package "${pkgDoc.title}" v${num(doc.version)} · sha256 ${String(doc.sha256).slice(0, 12)}…`), ref: { kind: "document", id: num(doc.id) } },
        { id: "E2", label: T(`Kết quả bước ${pkgKey}`, `Result of step ${pkgKey}`), ref: { kind: "task_run", id: src.current_run_id! } },
      ],
      assumptions: [],
      missingData: [],
      documents: [pkgDoc],
      nextSteps: [T(`${role}: duyệt / từ chối / yêu cầu bổ sung (chọn bước cần sửa)`, `${roleShown}: approve / reject / request changes (choose the step to revise)`)],
      mode: "demo-rules",
      language: contentLanguage(this.cfg),
      warnings: unmet.filter((c) => !c.waivable).map((c) => T(`Điều kiện không thể miễn trừ chưa đạt: ${c.label}${c.detail ? ` — ${c.detail}` : ""}`, `Non-waivable condition not met: ${c.label}${c.detail ? ` — ${c.detail}` : ""}`)),
      facts: { role, packageDocId: num(doc.id), packageVersion: num(doc.version), packageSha: doc.sha256, workflowVersion: wf.version, returnOptions: gate.returnOptions, conditions, policyVersion: this.cfg.policy.version },
    };
    tx(this.db, () => {
      const r = this.db
        .prepare("INSERT INTO task_runs (task_id, attempt, status, started_at, inputs_json, output_json, mode, case_revision) VALUES (?, ?, 'awaiting_approval', ?, ?, ?, 'human', ?)")
        .run(t.id, t.attempts + 1, now, JSON.stringify([{ kind: "task_run", id: src.current_run_id }, { kind: "document", id: num(doc.id) }]), JSON.stringify(output), wf.version);
      this.db.prepare("UPDATE tasks SET attempts = attempts + 1, current_run_id = ?, case_revision = ? WHERE id = ?").run(num(r.lastInsertRowid), wf.version, t.id);
      this.setState(t.id, "awaiting_approval", T(`Chờ ${role}`, `Awaiting ${roleShown}`), "approval", this.dueAt("approval"));
      this.acceptHandoffs(wf, t.key, T(`Đã chuyển tới ${role} để quyết định`, `Passed to ${roleShown} for decision`));
    });
    const producer = src.agent_id;
    this.emit({ type: "handoff.delivered", label: T(`chuyển hồ sơ "${pkgDoc.title}" cho ${role}`, `passed package "${pkgDoc.title}" to ${roleShown}`), source: "orchestrator", workflowId: wf.id, taskId: t.id, agentId: producer, room: this.roomOf(gate.approver), msg: { key: "ev.package", params: { step: t.key, role } } });
    this.emit({ type: "attention.requested", label: T(`Chờ duyệt: ${pkgDoc.title} v${num(doc.version)}`, `Awaiting approval: ${pkgDoc.title} v${num(doc.version)}`), source: "orchestrator", workflowId: wf.id, taskId: t.id, agentId: gate.approver, room: this.roomOf(gate.approver) , msg: { key: "ev.attn.approval", params: { step: t.key, version: num(doc.version) } } });
  }

  /**
   * Re-check, at decision time, conditions that change with time or shared resources
   * (not only the conditions stored when the gate opened): holds still valid, planned
   * date not passed, inputs of the package unchanged. Returns the reasons and the steps
   * that must be redone. Must be called inside the decision transaction.
   */
  revalidate(wf: WorkflowRow, scope: "gate.asset" | "gate.readiness" | "gate.technical" | "gate.close" | "outbox"): { reasons: string[]; restart: string[] } {
    const reasons: string[] = [];
    const restart = new Set<string>();
    const tasks = this.tasks(wf.id);
    const today = todayIso();
    if (scope === "gate.asset" || scope === "gate.readiness" || scope === "outbox") {
      // The plan in force vs. the ledger (not "anything expired"): every resource the current plan
      // needs must stand now — cancelled / cancel-requested / released / missing / expired are problems;
      // history the plan no longer needs is ignored. Readiness needs transport CONFIRMED.
      for (const p of planProblems(this.db, wf.id, this.planDemands(wf.id), scope === "gate.readiness" ? "execution" : "planning", today)) {
        reasons.push(p.message);
        restart.add(p.action === "replan" ? p.demand.step : "hse.readiness");
      }
    }
    if (scope === "gate.readiness") {
      const rd = tasks.get("hse.readiness");
      const rf = rd ? ((this.currentOutput(rd)?.facts ?? {}) as { plannedDate?: string; documents?: Array<{ docId: string; docType: string; activity: string }>; weather?: { required: boolean; maxHs: number | null; maxWind: number | null } }) : {};
      const planned = rf.plannedDate;
      if (planned && planned < today) {
        reasons.push(`Ngày thực hiện dự kiến ${planned} đã qua (hôm nay ${today}) — điều kiện sẵn sàng phải kiểm tra lại cho ngày mới`);
        restart.add(tasks.get("log.plan")?.status === "done" ? "log.plan" : "hse.readiness");
      }
      if (planned) {
        // Each required HSE document, re-read NOW: still approved and valid on the planned date
        const sc = caseScope(this.db, wf, this.cfg);
        const docs = new Map(scopedRows(this.db, "hse_documents", sc).map((r) => [String(r.data.doc_id), r]));
        for (const d of rf.documents ?? []) {
          const r = docs.get(d.docId);
          const why = !r
            ? "không còn trong sổ đăng ký"
            : String(r.data.status).toLowerCase() !== "approved"
              ? `trạng thái "${r.data.status}"`
              : r.data.valid_from && String(r.data.valid_from) > planned
                ? `chỉ hiệu lực từ ${r.data.valid_from}`
                : r.data.valid_to && String(r.data.valid_to) < planned
                  ? `hết hiệu lực ${r.data.valid_to}`
                  : null;
          if (why) {
            reasons.push(`Hồ sơ HSE ${d.docId} (${d.docType}, ${d.activity}) ${why} — không còn hợp lệ cho ngày ${planned}`);
            restart.add("hse.readiness");
          }
        }
        // Weather at the planned date, re-read NOW, within the transport limits
        if (rf.weather?.required) {
          const wx = scopedRows(this.db, "weather_forecast", sc).find((w) => w.data.forecast_date === planned);
          const hs = wx ? Number(wx.data.hs_m) : null;
          const wind = wx ? Number(wx.data.wind_kn) : null;
          const bad = !wx
            ? `chưa có dự báo thời tiết cho ${planned}`
            : rf.weather.maxHs !== null && hs !== null && hs > rf.weather.maxHs
              ? `dự báo Hs ${hs} m > giới hạn ${rf.weather.maxHs} m`
              : rf.weather.maxWind !== null && wind !== null && wind > rf.weather.maxWind
                ? `dự báo gió ${wind} kn > giới hạn ${rf.weather.maxWind} kn`
                : null;
          if (bad) {
            reasons.push(`Thời tiết ngày ${planned}: ${bad}`);
            restart.add("hse.readiness");
          }
        }
      }
    }
    // Inputs the package was built from must still be current (defence in depth beside impact analysis)
    if (scope !== "outbox") {
      const gateStep = STEP_MAP.get(scope)!;
      const pkgKey = typeof gateStep.gate!.packageFrom === "function" ? gateStep.gate!.packageFrom(tasks) : gateStep.gate!.packageFrom;
      const pkg = tasks.get(pkgKey);
      if (pkg?.current_run_id) {
        const run = this.db.prepare("SELECT scoped_fp_json FROM task_runs WHERE id = ?").get(pkg.current_run_id);
        const fps = JSON.parse((run?.scoped_fp_json as string) || "{}") as Record<string, string>;
        const sc = caseScope(this.db, wf, this.cfg);
        const drift = Object.entries(fps).filter(([k, v]) => !k.startsWith("dpr<=") && fingerprintForKey(this.db, k, sc) !== v).map(([k]) => k);
        if (drift.length) {
          reasons.push(`Dữ liệu đầu vào của hồ sơ đã thay đổi (${drift.join(", ")})`);
          restart.add(pkgKey);
        }
      }
    }
    return { reasons, restart: [...restart].filter((k) => tasks.has(k)) };
  }

  /** Resources the plan in force needs: current outputs of log.plan / fin.check that are done. */
  planDemands(workflowId: number): PlanDemand[] {
    const tasks = this.tasks(workflowId);
    const out: PlanDemand[] = [];
    for (const step of ["log.plan", "fin.check"] as const) {
      const t = tasks.get(step);
      if (!t || t.status !== "done" || !t.current_run_id) continue;
      out.push(...demandsFromFacts(step, t.current_run_id, this.currentOutput(t)?.facts));
    }
    return out;
  }

  /**
   * The plan step that owns a resource type, and whether the plan in force needs exactly
   * this content (type, key, quantity, unit). Used for carry-forward of a hold placed at
   * an earlier revision, and to decide what a confirmation/cancellation makes stale.
   */
  planNeeds(workflowId: number, r: Record<string, unknown>): { step: "log.plan" | "fin.check"; status: string; demand: PlanDemand | null; keyNeeded: boolean } {
    const step = r.resource_type === "budget" ? "fin.check" : "log.plan";
    const t = this.tasks(workflowId).get(step);
    const ds = this.planDemands(workflowId).filter((d) => d.step === step && d.type === r.resource_type && d.key === r.resource_key);
    const demand = ds.find((d) => Math.abs(d.qty - Number(r.quantity)) < 1e-9 && d.unit === String(r.unit)) ?? null;
    return { step, status: t?.status ?? "missing", demand, keyNeeded: ds.length > 0 };
  }

  /**
   * Re-build steps whose package reads the ledger (readiness) after a person recorded a
   * confirmation — progress, not a change of plan, so no new revision. The gate re-opens
   * with a fresh package; a decision on the old package is refused (package sha).
   */
  refresh(workflowId: number, keys: string[], note: string): string[] {
    const all = new Set<string>();
    for (const k of keys) {
      all.add(k);
      for (const d of dependentsOf(k)) all.add(d);
    }
    const reset = tx(this.db, () => this.resetTasks(workflowId, [...all], note));
    if (reset.length) this.emit({ type: "case.revised", label: `${this.workflow(workflowId).case_no}: ${note.slice(0, 160)}`, source: "orchestrator", workflowId, agentId: "ops_agent", room: "zone_ops" });
    return reset;
  }

  /** Mark the given steps (and everything downstream) stale with a reason; new case revision. */
  invalidate(workflowId: number, keys: string[], reasons: string[]): void {
    const wf = this.workflow(workflowId);
    const all = new Set<string>();
    for (const k of keys) {
      all.add(k);
      for (const d of dependentsOf(k)) all.add(d);
    }
    const rev = this.bumpRevision(wf, `Hồ sơ không còn đúng tại thời điểm quyết định: ${reasons.join("; ")}`, "revalidation");
    const note = `Lập lại (rev ${rev}): ${reasons.join("; ")}`.slice(0, 600);
    tx(this.db, () => {
      this.resetTasks(workflowId, [...all], note);
      const fresh = this.workflow(workflowId);
      if (fresh.status === "approved" && all.has("gate.asset")) this.db.prepare("UPDATE workflows SET status = 'open', updated_at = ? WHERE id = ?").run(nowIso(), workflowId);
    });
    this.emit({ type: "attention.requested", label: `${wf.case_no}: ${note.slice(0, 160)}`, source: "orchestrator", workflowId, agentId: "ops_agent", room: "zone_ops" });
  }

  /**
   * Record a human decision on a gate. Every check runs BEFORE any write, so a
   * refused request leaves task and workflow untouched.
   *  - actor comes from a server-resolved Identity (never a request string)
   *  - packageSha is mandatory and must match the package currently awaiting decision
   *  - idempotencyKey is bound to the request content
   *  - approve: every non-waivable condition must be met; a waivable unmet condition needs an
   *    explicit waiver by a role listed in policy.waiverRoles; "confirm" items must be attested
   */
  decide(input: {
    taskId: number;
    decision: "approve" | "reject" | "request_changes";
    actor: Identity;
    comment: string;
    returnTo?: string | null;
    packageSha: string;
    packageVersion?: number;
    idempotencyKey: string;
    waivers?: string[];
    confirmations?: string[];
  }): { decisionId: number; duplicate: boolean } {
    if (!input.idempotencyKey?.trim()) throw new OpsError(400, "Thiếu idempotencyKey", "idempotency_missing");
    const actor = input.actor;
    if (!actor?.userId) throw new OpsError(401, "Chưa xác định danh tính người quyết định (phía server)", "identity_missing");
    // Decisions at a gate are made by people — never by an integration/service credential, whatever its roles or mode
    if (actor.source !== "demo" && actor.source !== "enterprise") throw new OpsError(403, "Quyết định ở cổng duyệt phải do người thực hiện — credential tích hợp (service) không được phép", "person_required");
    const waivers = [...new Set(input.waivers ?? [])].sort();
    const confirmations = [...new Set(input.confirmations ?? [])].sort();
    const requestHash = sha256(
      JSON.stringify({ t: input.taskId, d: input.decision, c: (input.comment ?? "").trim(), r: input.returnTo ?? null, p: input.packageSha ?? null, v: input.packageVersion ?? null, u: actor.userId, w: waivers, k: confirmations }),
    );
    const dup = this.db.prepare("SELECT id, request_hash FROM decisions WHERE idempotency_key = ?").get(input.idempotencyKey);
    if (dup) {
      if (dup.request_hash === requestHash) return { decisionId: num(dup.id), duplicate: true };
      throw new OpsError(409, "idempotencyKey đã được dùng cho một yêu cầu khác — không ghi quyết định", "idempotency_conflict");
    }
    if (this.operatingMode === "production" && actor.source !== "enterprise") {
      throw new OpsError(403, "Chế độ vận hành thật yêu cầu danh tính doanh nghiệp đã xác thực; danh tính demo bị từ chối", "demo_identity_refused");
    }
    if (!input.packageSha?.trim()) throw new OpsError(400, "Thiếu packageSha — phải xác nhận đúng phiên bản hồ sơ đã xem", "package_sha_missing");
    const t = this.task(input.taskId);
    const step = STEP_MAP.get(t.key);
    if (!step?.gate) throw new OpsError(400, `${t.key} không phải bước phê duyệt`, "not_a_gate", { step: t.key });
    if (t.status !== "awaiting_approval") {
      // Prefer the reason of the revision that superseded the package the person was looking at
      const rv = this.db.prepare("SELECT revision, reason FROM case_revisions WHERE workflow_id = ? AND revision > ? ORDER BY revision DESC LIMIT 1").get(t.workflow_id, t.case_revision ?? 0);
      const why = rv ? ` Lý do (rev ${rv.revision}): ${String(rv.reason).slice(0, 300)}` : t.status_note ? ` Lý do: ${String(t.status_note).slice(0, 300)}` : "";
      throw new OpsError(409, `Bước "${t.title}" không ở trạng thái chờ duyệt (hiện: ${t.status}) — có thể đã có quyết định khác hoặc hồ sơ đang được lập lại.${why}`, "not_awaiting", { step: t.key, status: t.status });
    }
    const wf = this.workflow(t.workflow_id);
    const run = this.db.prepare("SELECT * FROM task_runs WHERE id = ?").get(t.current_run_id)!;
    const out = JSON.parse(run.output_json as string) as AgentOutput;
    const f = out.facts as { role: string; packageDocId: number; packageVersion: number; packageSha: string; returnOptions: string[]; workflowVersion?: number; conditions?: GateCondition[] };
    const role = actor.roles.find((r) => r.trim().toLowerCase() === f.role.trim().toLowerCase());
    if (!role) throw new OpsError(403, `Bước này cần vai trò "${f.role}"; ${actor.name} có vai trò: ${actor.roles.join(", ") || "—"}`, "role_required", { roles: f.role });
    if (input.packageSha !== f.packageSha) throw new OpsError(409, `Hồ sơ đã thay đổi (đang chờ duyệt: v${f.packageVersion}) — tải lại để xem phiên bản mới`, "package_changed", { version: f.packageVersion });
    if (input.packageVersion !== undefined && input.packageVersion !== f.packageVersion) throw new OpsError(409, `Phiên bản hồ sơ không khớp (gửi v${input.packageVersion}, hiện tại v${f.packageVersion})`, "package_version_mismatch", { sent: input.packageVersion, current: f.packageVersion });
    if (f.workflowVersion !== undefined && f.workflowVersion !== wf.version) throw new OpsError(409, `Hồ sơ thuộc case rev ${f.workflowVersion}, case đã sang rev ${wf.version} — không dùng quyết định cho phiên bản cũ`, "revision_moved", { caseNo: wf.case_no, current: wf.version, sent: f.workflowVersion });
    if (input.decision !== "approve" && !(input.comment ?? "").trim()) throw new OpsError(400, "Cần ghi lý do khi từ chối hoặc yêu cầu bổ sung", "comment_required");
    if (t.key === "gate.close" && input.decision === "approve" && !(input.comment ?? "").trim()) throw new OpsError(400, "Ghi kết luận và bài học khi đóng case", "closing_note_required");
    if (input.decision === "request_changes" && (!input.returnTo || !f.returnOptions.includes(input.returnTo))) {
      throw new OpsError(400, `Chọn bước cần sửa trong: ${f.returnOptions.join(", ")}`, "return_step_required", { options: f.returnOptions.join(", ") });
    }
    const conditions = f.conditions ?? [];
    if (input.decision === "approve") {
      const blocking = conditions.filter((c) => c.kind === "check" && !c.met && !c.waivable);
      if (blocking.length) throw new OpsError(409, `Không thể duyệt: điều kiện không thể miễn trừ chưa đạt — ${blocking.map((c) => c.label).join("; ")}`, "non_waivable_unmet", { conditions: blocking.map((c) => c.label).join("; "), conditionCodes: blocking.map((c) => c.code).join(",") });
      for (const c of conditions.filter((x) => x.kind === "check" && !x.met && x.waivable)) {
        if (!waivers.includes(c.code)) throw new OpsError(409, `Điều kiện "${c.label}" chưa đạt — cần ghi ngoại lệ (waiver "${c.code}") hoặc trả lại để bổ sung`, "waiver_required", { condition: c.label, conditionCode: c.code });
        const ok = actor.roles.some((r) => c.waiverRoles.some((w) => w.trim().toLowerCase() === r.trim().toLowerCase()));
        if (!ok) throw new OpsError(403, `Ngoại lệ "${c.label}" cần vai trò: ${c.waiverRoles.join(" / ") || "(chưa cấu hình)"} — ${actor.name} không có thẩm quyền này`, "waiver_role_required", { condition: c.label, conditionCode: c.code, roles: c.waiverRoles.join(" / ") });
      }
      for (const c of conditions.filter((x) => x.kind === "confirm")) {
        if (!confirmations.includes(c.code)) throw new OpsError(409, `Người duyệt phải xác nhận: ${c.label}`, "confirmation_required", { condition: c.label, conditionCode: c.code });
      }
      if (waivers.length && !(input.comment ?? "").trim()) throw new OpsError(400, "Ghi lý do khi duyệt kèm ngoại lệ", "waiver_comment_required");
    }
    const actorLabel = `${actor.name}${actor.source === "demo" ? " [DEMO]" : ""}`;
    input = { ...input, comment: (input.comment ?? "").trim() };

    const now = nowIso();
    let stale: { reasons: string[]; restart: string[] } | null = null;
    const decisionId = tx(this.db, () => {
      // Time/resource-dependent conditions are re-checked under the write lock (no race with holds)
      if (input.decision === "approve") {
        const rv = this.revalidate(wf, t.key as "gate.asset");
        if (rv.reasons.length) {
          stale = rv;
          return -1;
        }
      }
      const r = this.db
        .prepare(
          `INSERT INTO decisions (workflow_id, task_id, decision, actor_id, actor_name, actor_role, identity_source, comment, return_to, package_doc_id, package_version, package_sha256, workflow_version, decided_at, idempotency_key, request_hash, case_revision, waivers_json, confirmations_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          wf.id, t.id, input.decision, actor.userId, actor.name, role, actor.source, input.comment, input.returnTo ?? null, f.packageDocId, f.packageVersion, f.packageSha, wf.version, now,
          input.idempotencyKey, requestHash, wf.version, JSON.stringify(input.decision === "approve" ? waivers : []), JSON.stringify(input.decision === "approve" ? confirmations : []),
        );
      const id = num(r.lastInsertRowid);
      const T = this.T;
      const label = { approve: T("Duyệt", "Approved"), reject: T("Từ chối", "Rejected"), request_changes: T(`Yêu cầu bổ sung → ${input.returnTo}`, `Changes requested → ${input.returnTo}`) }[input.decision];
      const waiverText = waivers.length ? T(` · ngoại lệ: `, ` · waivers: `) + waivers.map((w) => conditions.find((c) => c.code === w)?.label ?? w).join("; ") : "";
      const decided: AgentOutput = {
        ...out,
        summary: T(`${label} bởi ${actorLabel} (${role}) lúc ${now}${input.comment ? `: "${input.comment}"` : ""}${waiverText}`, `${label} by ${actorLabel} (${roleText(this.cfg, role)}) at ${now}${input.comment ? `: "${input.comment}"` : ""}${waiverText}`),
        evidence: [...out.evidence, { id: `E${out.evidence.length + 1}`, label: T(`Quyết định #${id}`, `Decision #${id}`), ref: { kind: "decision", id } }],
        conclusions: [{ id: "K1", text: T(`${label} hồ sơ v${f.packageVersion} (sha256 ${f.packageSha.slice(0, 12)}…, case rev ${wf.version})${waiverText}`, `${label} package v${f.packageVersion} (sha256 ${f.packageSha.slice(0, 12)}…, case rev ${wf.version})${waiverText}`), basis: "check", evidence: [`E${out.evidence.length + 1}`] }],
      };
      this.db.prepare("UPDATE task_runs SET status = 'done', finished_at = ?, output_json = ? WHERE id = ?").run(now, JSON.stringify(decided), t.current_run_id);

      if (input.decision === "approve") {
        this.setState(t.id, "done", T(`Đã duyệt bởi ${actorLabel}`, `Approved by ${actorLabel}`), null, null);
        this.db.prepare("UPDATE handoffs SET response = ? WHERE workflow_id = ? AND to_key = ? AND status = 'accepted' AND case_revision = ?").run(T(`Duyệt bởi ${actorLabel}`, `Approved by ${actorLabel}`), wf.id, t.key, wf.version);
        if (t.key === "gate.asset") this.db.prepare("UPDATE workflows SET status = 'approved', updated_at = ? WHERE id = ?").run(now, wf.id);
        if (t.key === "gate.technical") {
          const b = (this.currentOutput(this.tasks(wf.id).get("ops.proposal")!)?.facts.branch as string | undefined) ?? null;
          this.db.prepare("UPDATE workflows SET branch = ? WHERE id = ?").run(b, wf.id);
        }
        if (t.key === "gate.close") {
          const closure = { decisionId: id, closedBy: actorLabel, role, conclusion: input.comment, packageDocId: f.packageDocId, revision: wf.version, closedAt: now };
          this.db.prepare("UPDATE workflows SET status = 'closed', closed_at = ?, closure_json = ?, updated_at = ? WHERE id = ?").run(now, JSON.stringify(closure), now, wf.id);
          releaseCase(this.db, wf.id, `Case đóng (quyết định #${id})`);
        }
      } else if (input.decision === "reject") {
        this.setState(t.id, "done", `Từ chối bởi ${actorLabel}`, null, null);
        this.db.prepare("UPDATE tasks SET status = 'cancelled', status_note = 'Hủy do hồ sơ bị từ chối', wait_kind = NULL, updated_at = ? WHERE workflow_id = ? AND status NOT IN ('done', 'cancelled', 'skipped')").run(now, wf.id);
        this.db.prepare("UPDATE workflows SET status = 'rejected', updated_at = ? WHERE id = ?").run(now, wf.id);
        this.db.prepare("UPDATE outbox SET status = 'cancelled', status_note = ? WHERE workflow_id = ? AND status = 'draft'").run(`Hủy: hồ sơ bị từ chối (quyết định #${id})`, wf.id);
        releaseCase(this.db, wf.id, `Case bị từ chối (quyết định #${id})`);
      } else {
        const target = this.tasks(wf.id).get(input.returnTo!)!;
        const prevFp = target.current_run_id
          ? (this.db.prepare("SELECT input_fingerprint FROM task_runs WHERE id = ?").get(target.current_run_id)?.input_fingerprint as string)
          : "";
        const feedback = { decisionId: id, comment: input.comment, actor: actorLabel, role, prevFingerprint: prevFp };
        this.db.prepare("UPDATE handoffs SET status = 'returned', return_reason = ?, responded_at = ? WHERE workflow_id = ? AND to_key = ? AND status IN ('accepted','offered')").run(input.comment, now, wf.id, t.key);
        this.resetTasks(wf.id, [input.returnTo!, ...dependentsOf(input.returnTo!)], `Trả lại bởi ${actorLabel}: ${input.comment}`);
        this.db.prepare("UPDATE tasks SET feedback_json = ? WHERE id = ?").run(JSON.stringify(feedback), target.id);
        this.db
          .prepare(
            `INSERT OR IGNORE INTO handoffs (workflow_id, case_revision, from_task_id, from_key, from_agent, to_key, to_agent, request, acceptance_json, due_at, status, return_reason, created_at, business_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offered', ?, ?, ?)`,
          )
          .run(wf.id, wf.version + 1, t.id, t.key, step.gate!.approver, target.key, target.agent_id, `Sửa theo yêu cầu: ${input.comment}`, JSON.stringify(["Có dữ liệu/tài liệu mới hoặc đã xử lý phản hồi"]), this.dueAt(STEP_MAP.get(target.key)!.sla), input.comment, now, `return:${id}`);
        if (wf.status === "approved" && dependentsOf(input.returnTo!).includes("gate.asset")) this.db.prepare("UPDATE workflows SET status = 'open' WHERE id = ?").run(wf.id);
      }
      this.db.prepare("UPDATE workflows SET updated_at = ? WHERE id = ?").run(now, wf.id);
      return id;
    });
    if (stale) {
      const st = stale as { reasons: string[]; restart: string[] };
      this.invalidate(wf.id, st.restart.length ? st.restart : [STEP_MAP.get(t.key)!.deps[0]], st.reasons);
      throw new OpsError(409, `Không ghi quyết định — hồ sơ đang trình không còn đúng: ${st.reasons.join("; ")}. Các bước ${st.restart.join(", ") || "liên quan"} được lập lại; mở hồ sơ mới khi sẵn sàng.`, "package_stale", { steps: st.restart.join(", ") });
    }
    if (input.decision === "request_changes") {
      const fresh = this.workflow(wf.id);
      this.bumpRevision(fresh, `${t.key === "gate.close" ? "Mở lại đánh giá" : "Trả lại"} bởi ${actorLabel} → ${input.returnTo}: ${input.comment}`, `${t.key === "gate.close" ? "reopen" : "return"}:decision#${decisionId}`);
    }

    const gate = step.gate;
    const verb = { approve: "duyệt", reject: "từ chối", request_changes: `trả lại bước ${input.returnTo}` }[input.decision];
    this.emit({ type: `decision.${input.decision}`, label: this.T(`${actorLabel} (${role}) ${verb} hồ sơ v${f.packageVersion}${waivers.length ? " (có ngoại lệ)" : ""}`, `${actorLabel} (${roleText(this.cfg, role)}): ${input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : `returned to ${input.returnTo}`} package v${f.packageVersion}${waivers.length ? " (with waivers)" : ""}`), source: "user", workflowId: wf.id, taskId: t.id, agentId: gate.approver, room: this.roomOf(gate.approver), payload: { decisionId } , msg: { key: "ev.decision", params: { actor: actorLabel, role, decision: input.decision, version: f.packageVersion, step: t.key } } });
    if (input.decision === "request_changes") {
      const target = STEP_MAP.get(input.returnTo!)!;
      this.emit({ type: "attention.requested", label: `Hồ sơ bị trả lại: ${input.comment}`, source: "user", workflowId: wf.id, agentId: target.agent, room: this.roomOf(target.agent) , msg: { key: "ev.attn.returned", params: { step: input.returnTo ?? "" } } });
    }
    if (input.decision === "approve" && t.key === "gate.close") {
      this.emit({ type: "task.completed", label: `${wf.case_no} đã đóng: ${input.comment.slice(0, 120)}`, source: "user", workflowId: wf.id, agentId: "eng_lead", room: this.roomOf("eng_lead") });
    }
    return { decisionId, duplicate: false };
  }

  /** Reset tasks to pending and supersede their current runs (results kept for audit). */
  private resetTasks(workflowId: number, keys: string[], note: string): string[] {
    const tasks = this.tasks(workflowId);
    const now = nowIso();
    const reset: string[] = [];
    for (const k of keys) {
      const t = tasks.get(k);
      if (!t || t.status === "cancelled" || t.status === "pending") continue;
      if (t.current_run_id) this.db.prepare("UPDATE task_runs SET superseded = 1 WHERE id = ?").run(t.current_run_id);
      this.db.prepare("UPDATE tasks SET status = 'pending', status_note = ?, wait_kind = NULL, due_at = NULL, updated_at = ? WHERE id = ?").run(note, now, t.id);
      this.db.prepare("UPDATE handoffs SET status = 'superseded', response = COALESCE(response, ?), responded_at = ? WHERE workflow_id = ? AND (from_key = ? OR to_key = ?) AND status IN ('offered','accepted')").run(note, now, workflowId, k, k);
      reset.push(k);
    }
    return reset;
  }

  retry(taskId: number, actor = "người dùng"): void {
    const t = this.task(taskId);
    if (!["error", "missing_data", "waiting"].includes(t.status)) throw new OpsError(409, `Chỉ chạy lại task ở trạng thái lỗi/thiếu dữ liệu/đang chờ (hiện: ${t.status})`, "retry_invalid_state", { status: t.status });
    const st = this.workflow(t.workflow_id).status;
    if (st !== "open" && st !== "approved") throw new OpsError(409, "Workflow đã kết thúc", "workflow_ended");
    this.setState(t.id, "pending", `Chạy lại theo yêu cầu của ${actor}`, null, null);
    this.emit({ type: "task.retry", label: `${actor} yêu cầu chạy lại ${t.key}`, source: "user", workflowId: t.workflow_id, taskId: t.id, agentId: t.agent_id, room: this.roomOf(t.agent_id) });
  }

  /**
   * Impact analysis after new data / documents. For every active case:
   *  - recompute the scoped fingerprint of each dataset a step's CURRENT run read;
   *  - steps whose inputs changed, and everything downstream, become stale: new case
   *    revision (fresh input snapshot), runs superseded, re-run on the right branch;
   *    pending gates and outbound drafts of the old revision can no longer be used;
   *  - cases whose data did not change are left alone.
   * Returns the number of tasks re-queued.
   */
  onDataChanged(types: string[], trigger: string, det?: DetectionResult | null): number {
    let total = 0;
    const wfs = this.db.prepare(`SELECT * FROM workflows WHERE status IN ${ACTIVE_WF}`).all() as unknown as WorkflowRow[];
    for (const wf of wfs) {
      const scope = caseScope(this.db, wf, this.cfg);
      const tasks = this.tasks(wf.id);
      const changed = new Map<string, string[]>();
      const fpCache = new Map<string, string>();
      const fpNow = (t: string) => {
        if (!fpCache.has(t)) fpCache.set(t, scopedFingerprint(this.db, t, scope));
        return fpCache.get(t)!;
      };
      // Once the scope is approved, new DPR days are monitoring data for evaluation; only corrections
      // inside the assessed period invalidate the intake/assessment branch.
      const scopeFrozen = tasks.get("gate.technical")?.status === "done";
      for (const t of tasks.values()) {
        if (!t.current_run_id || ["pending", "running", "cancelled"].includes(t.status)) continue;
        const run = this.db.prepare("SELECT datasets_json, scoped_fp_json FROM task_runs WHERE id = ?").get(t.current_run_id);
        const used = JSON.parse((run?.datasets_json as string) || "[]") as string[];
        const fps = JSON.parse((run?.scoped_fp_json as string) || "{}") as Record<string, string>;
        const hits = types.flatMap((ty): string[] => {
          // whole-dataset read ("quotes") and/or per-code reads ("quotes{part_no=X}")
          const keys = Object.keys(fps).filter((k) => k === ty || k.startsWith(`${ty}{`));
          if (!used.includes(ty) || !keys.length) return [];
          if (scopeFrozen && PRE_SCOPE.has(t.key) && PLANNING_INPUTS.has(ty)) return [];
          if (ty === "dpr" && scopeFrozen && PRE_SCOPE.has(t.key)) {
            const k = Object.keys(fps).find((x) => x.startsWith("dpr<="));
            return k && fps[k] !== fingerprintForKey(this.db, k, scope) ? [ty] : [];
          }
          const changedKeys = keys.filter((k) => fps[k] !== (k === ty ? fpNow(ty) : fingerprintForKey(this.db, k, scope)));
          return changedKeys.map((k) => (k === ty ? ty : decodeURIComponent(k)));
        });
        const legacyMissing = !run?.datasets_json && t.status === "missing_data" && (this.currentOutput(t)?.missingData ?? []).some((m) => m.blocking && m.datasetType && types.includes(m.datasetType));
        const hasFeedback = t.status === "missing_data" && !!t.feedback_json;
        if (hits.length || legacyMissing || hasFeedback) changed.set(t.key, hits.length ? hits : types);
      }
      // This well's DPR changed → the latest assessment must be refreshed even if no step has consumed it yet
      const snap = latestSnapshot(this.db, wf.id);
      const dprChanged = !scopeFrozen && !!det && types.includes("dpr") && !!snap && snap.data.dpr?.fp !== fpNow("dpr");
      if (!changed.size && !dprChanged) continue;
      // Gates/drafts are invalidated only when a result that fed them changes, not for a re-check of a blocked step
      const consequential = [...changed.keys()].some((k) => {
        const s = tasks.get(k)!.status;
        return s === "done" || s === "awaiting_approval" || s === "skipped";
      });
      const label = [...new Set([...[...changed.values()].flat(), ...(dprChanged ? ["dpr"] : [])])].join(", ");
      let note = this.T(`Có dữ liệu mới (${label}) — chạy lại`, `New data (${label}) — re-running`);
      if (consequential || dprChanged) {
        const assessment = det ? (det.wells.find((w) => w.wellKey === scope.wellKey) ?? null) : undefined;
        const rev = this.bumpRevision(wf, this.T(`Đầu vào thay đổi: ${label} (${trigger})`, `Inputs changed: ${label} (${trigger})`), `data:${trigger}`, assessment);
        note = this.T(`Đầu vào thay đổi (${label}) — rev ${rev}, chạy lại`, `Inputs changed (${label}) — rev ${rev}, re-running`);
      }
      const keys = new Set<string>();
      for (const k of changed.keys()) {
        keys.add(k);
        for (const d of dependentsOf(k)) keys.add(d);
      }
      const reset = this.resetTasks(wf.id, [...keys], note);
      const fresh = this.workflow(wf.id);
      if (fresh.status === "approved" && reset.includes("gate.asset")) this.db.prepare("UPDATE workflows SET status = 'open', updated_at = ? WHERE id = ?").run(nowIso(), wf.id);
      if (reset.length) {
        total += reset.length;
        this.emit({ type: "task.requeued", label: `${wf.case_no}: ${note} → ${reset.join(", ")}`, source: "import", workflowId: wf.id, agentId: "ops_agent", room: "zone_ops", dedupeKey: `impact:${wf.id}:${trigger}` });
      }
    }
    return total;
  }

  /** Back-compat entry point (dataset types only). */
  onDataImported(types: string[]): number {
    return this.onDataChanged(types, `import:${types.join("+")}`);
  }

  /** A document was uploaded (case-specific or global). */
  onDocumentUploaded(trigger = "document"): number {
    return this.onDataChanged(["document"], trigger);
  }

  setFault(agentId: string, count: number): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`fault:${agentId}`, String(count));
  }

  private takeFault(agentId: string): boolean {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(`fault:${agentId}`);
    const n = r ? Number(r.value) : 0;
    if (n <= 0) return false;
    this.db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(String(n - 1), `fault:${agentId}`);
    return true;
  }

  // ── execution ──

  /** Results of the step's prerequisites only — parallel siblings are not inputs. */
  private upstreamFor(wfId: number, selfKey: string): Map<string, UpstreamResult> {
    const out = new Map<string, UpstreamResult>();
    const ancestors = new Set(ancestorsOf(selfKey));
    for (const t of this.tasks(wfId).values()) {
      if (!ancestors.has(t.key) || !t.current_run_id || !["done", "missing_data"].includes(t.status)) continue;
      const r = this.db.prepare("SELECT id, status, output_json FROM task_runs WHERE id = ?").get(t.current_run_id);
      if (!r?.output_json) continue;
      out.set(t.key, { taskKey: t.key, taskId: t.id, runId: num(r.id), status: t.status, agentId: t.agent_id, output: JSON.parse(r.output_json as string) });
    }
    return out;
  }

  caseDocuments(wfId: number): CaseDocument[] {
    return (this.db
      .prepare("SELECT id, title, content, flags_json, version FROM documents WHERE source = 'upload' AND (workflow_id = ? OR workflow_id IS NULL) ORDER BY id")
      .all(wfId))
      .map((d) => ({ id: num(d.id), title: d.title as string, content: d.content as string, flags: JSON.parse(d.flags_json as string), version: num(d.version) }));
  }

  private async execute(wfId: number, taskId: number, step: StepDef): Promise<void> {
    const startedAt = nowIso();
    const claimed = this.db.prepare("UPDATE tasks SET status = 'running', attempts = attempts + 1, status_note = NULL, wait_kind = NULL, due_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(this.dueAt(step.sla === "approval" ? "agent" : step.sla), startedAt, taskId);
    if (num(claimed.changes) === 0) return; // someone else took it
    const task = this.task(taskId);
    const wf = this.workflow(wfId);
    // Snapshot the configuration: this run keeps it even if settings change while it runs
    const mode = this.mode;
    const llm = this.llmClient;
    const outputLanguage = this.cfg.runtime.llm.outputLanguage;
    const llmConfig = mode.effective === "llm" ? JSON.stringify({ provider: llm?.provider ?? mode.provider, model: llm?.model ?? mode.model, effort: mode.effort, source: mode.source, revision: mode.configRevision ?? null, outputLanguage }) : null;
    const runRes = this.db
      .prepare("INSERT INTO task_runs (task_id, attempt, status, started_at, mode, llm_config_json, case_revision) VALUES (?, ?, 'running', ?, ?, ?, ?)")
      .run(taskId, task.attempts, startedAt, mode.effective === "llm" ? "llm" : "demo-rules", llmConfig, wf.version);
    const runId = num(runRes.lastInsertRowid);
    this.db.prepare("UPDATE tasks SET current_run_id = ?, case_revision = ? WHERE id = ?").run(runId, wf.version, taskId);
    this.acceptHandoffs(wf, step.key, this.T(`Tiếp nhận bởi ${AGENT_INFO.get(step.agent)?.short ?? step.agent} (run #${runId}, rev ${wf.version})`, `Taken by ${AGENT_INFO.get(step.agent)?.short ?? step.agent} (run #${runId}, rev ${wf.version})`));
    const agentName = AGENT_INFO.get(step.agent)?.short ?? step.agent;
    this.emit({ type: step.visual, label: this.T(`bắt đầu "${step.title}" (lần ${task.attempts}, rev ${wf.version})`, `started "${stepText(this.cfg, step.key, step.title)}" (attempt ${task.attempts}, rev ${wf.version})`), source: "orchestrator", workflowId: wfId, taskId, agentId: step.agent, room: this.roomOf(step.agent) , msg: { key: "ev.task.started", params: { step: step.key, attempt: task.attempts, rev: wf.version } } });

    try {
      const impl = AGENT_IMPLS[step.agent];
      if (!impl) throw new Error(`Chưa có agent cho ${step.agent}`);
      if (this.takeFault(step.agent)) throw new Error(`Lỗi giả lập (fault injection) tại ${agentName} — dùng để kiểm thử xử lý lỗi`);
      const fbRow = this.db.prepare("SELECT feedback_json FROM tasks WHERE id = ?").get(taskId);
      const feedback = fbRow?.feedback_json ? (JSON.parse(fbRow.feedback_json as string) as Feedback & { prevFingerprint: string }) : null;
      const ctx = new AgentContext(this.db, this.cfg, wf, task, runId, this.upstreamFor(wfId, step.key), this.caseDocuments(wfId), feedback);
      await impl.run(ctx);
      const delay = this.opts.taskDelayMs ?? this.cfg.runtime.demoTaskDelayMs;
      if (delay) await sleep(delay);
      let output: AgentOutput = { ...ctx.o.build(), language: contentLanguage(this.cfg) };
      const fingerprint = ctx.fingerprint();
      const scopedFps = ctx.scopedFingerprints();
      if (feedback && feedback.prevFingerprint && feedback.prevFingerprint === fingerprint) {
        output.missingData.push({
          id: `M${output.missingData.length + 1}`,
          description: `Hồ sơ bị trả lại (${feedback.actor}): "${feedback.comment}". Chưa có dữ liệu/tài liệu mới so với lần trình trước — cần bổ sung để xử lý`,
          blocking: true,
          datasetType: undefined,
          owner: impl.name,
        });
      }
      if (mode.effective === "llm") {
        if (!llm) throw new Error("Chế độ LLM không có client — kiểm tra cấu hình");
        try {
          output = await narrateWithLlm(this.db, llm, this.cfg.runtime.llm.maxTokens, runId, impl.name, step.title, output, ctx.caseDocs, outputLanguage);
          mode.configurationStatus = "verified";
          mode.lastLlmOkAt = nowIso();
          mode.lastLlmError = undefined;
          mode.lastLlmErrorCategory = undefined;
        } catch (err) {
          mode.configurationStatus = "last_call_failed";
          mode.lastLlmError = err instanceof Error ? err.message : String(err);
          mode.lastLlmErrorCategory = (this.db.prepare("SELECT error_category FROM llm_calls WHERE task_run_id = ? ORDER BY id DESC LIMIT 1").get(runId)?.error_category as string | undefined) ?? undefined;
          throw err;
        }
      }
      const blocking = output.missingData.filter((m) => m.blocking);
      const status: TaskStatus = blocking.length ? "missing_data" : output.waiting ? "waiting" : "done";

      const stillOurs = this.db.prepare("SELECT status, current_run_id FROM tasks WHERE id = ?").get(taskId)!;
      // Inputs changed while this run was working → never commit a result computed on old data
      const drift = stillOurs.status === "running" && num(stillOurs.current_run_id) === runId ? ctx.changedSinceRead() : [];
      if (drift.length) {
        tx(this.db, () => {
          this.db.prepare("UPDATE task_runs SET status = ?, finished_at = ?, output_json = ?, superseded = 1, error = ? WHERE id = ?").run(status, nowIso(), JSON.stringify(output), `Đầu vào (${drift.join(", ")}) thay đổi trong lúc chạy — kết quả bị loại, chạy lại`, runId);
          this.setState(taskId, "pending", this.T(`Dữ liệu ${drift.join(", ")} thay đổi trong lúc chạy — chạy lại trên dữ liệu mới`, `Data ${drift.join(", ")} changed during the run — re-running on the new data`), null, null);
        });
        this.emit({ type: "task.requeued", label: this.T(`${step.key}: dữ liệu ${drift.join(", ")} thay đổi trong lúc chạy — chạy lại`, `${step.key}: data ${drift.join(", ")} changed during the run — re-running`), source: "orchestrator", workflowId: wfId, taskId, agentId: step.agent, room: this.roomOf(step.agent) });
        return;
      }
      if (stillOurs.status !== "running" || num(stillOurs.current_run_id) !== runId) {
        this.db.prepare("UPDATE task_runs SET status = ?, finished_at = ?, output_json = ?, superseded = 1 WHERE id = ?").run(status, nowIso(), JSON.stringify(output), runId);
        return; // reset/cancelled while running — result discarded but kept for audit
      }
      tx(this.db, () => {
        this.db
          .prepare("UPDATE task_runs SET status = ?, finished_at = ?, inputs_json = ?, input_fingerprint = ?, output_json = ?, mode = ?, datasets_json = ?, scoped_fp_json = ? WHERE id = ?")
          .run(status, nowIso(), JSON.stringify(ctx.inputRefs), fingerprint, JSON.stringify(output), output.mode, JSON.stringify([...new Set(Object.keys(scopedFps).map(datasetOfKey))].sort()), JSON.stringify(scopedFps), runId);
        if (status === "missing_data") {
          this.setState(taskId, status, this.T(`Thiếu: ${blocking.map((m) => m.description).join(" | ")}`, `Missing: ${blocking.map((m) => m.description).join(" | ")}`), "data", this.dueAt("data"));
        } else if (status === "waiting") {
          const w = output.waiting!;
          this.setState(taskId, status, w.reason, w.kind, this.dueAt(w.kind === "date" ? "execution" : "data", w.until));
        } else {
          this.setState(taskId, "done", null, null, null);
          this.db.prepare("UPDATE tasks SET feedback_json = NULL WHERE id = ?").run(taskId);
          this.offerHandoffs(wf, task, runId, output);
          if (step.key === "ops.execution") consumeCase(this.db, wfId); // confirmed bookings were used
        }
      });

      if (status === "missing_data") {
        this.emit({ type: "attention.requested", label: this.T(`Thiếu dữ liệu: ${blocking.map((m) => m.description).join(" | ").slice(0, 160)}`, `Missing data: ${blocking.map((m) => m.description).join(" | ").slice(0, 160)}`), source: "agent", workflowId: wfId, taskId, agentId: step.agent, room: this.roomOf(step.agent) , msg: { key: "ev.attn.missing", params: { step: step.key, count: blocking.length } } });
        return;
      }
      if (status === "waiting") {
        this.emit({ type: "attention.requested", label: this.T(`Đang chờ: ${output.waiting!.reason.slice(0, 160)}`, `Waiting: ${output.waiting!.reason.slice(0, 160)}`), source: "agent", workflowId: wfId, taskId, agentId: step.agent, room: this.roomOf(step.agent) , msg: { key: "ev.attn.waiting", params: { step: step.key, wait: output.waiting!.kind } } });
        return;
      }
      this.emit({ type: "task.completed", label: this.T(`hoàn tất "${step.title}": ${output.summary.slice(0, 140)}`, `completed "${stepText(this.cfg, step.key, step.title)}": ${output.summary.slice(0, 140)}`), source: "agent", workflowId: wfId, taskId, agentId: step.agent, room: this.roomOf(step.agent) , msg: { key: "ev.task.completed", params: { step: step.key } } });
      // Handoff: walk the result to the next owner (or the war room when fanning out)
      const next = WORKFLOW_STEPS.filter((s) => s.deps.includes(step.key));
      const recipients = Array.from(new Set(next.map((s) => s.agent).filter((a) => a !== step.agent)));
      if (recipients.length === 1 && !next.some((s) => s.gate)) {
        this.emit({ type: "handoff.delivered", label: this.T(`bàn giao kết quả "${step.title}" cho ${AGENT_INFO.get(recipients[0])?.short}`, `handed the results of "${stepText(this.cfg, step.key, step.title)}" to ${AGENT_INFO.get(recipients[0])?.short}`), source: "orchestrator", workflowId: wfId, taskId, agentId: step.agent, room: this.roomOf(recipients[0]) , msg: { key: "ev.handoff", params: { step: step.key, to: recipients[0] } } });
      } else if (recipients.length > 1) {
        this.emit({ type: "session.handoff", label: this.T(`phân công song song: ${recipients.map((r) => AGENT_INFO.get(r)?.short).join(", ")}`, `parallel assignment: ${recipients.map((r) => AGENT_INFO.get(r)?.short).join(", ")}`), source: "orchestrator", workflowId: wfId, taskId, agentId: step.agent, room: "zone_war_room", msg: { key: "ev.parallel", params: { agents: recipients.map((r) => AGENT_INFO.get(r)?.short).join(", ") } } });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tx(this.db, () => {
        this.db.prepare("UPDATE task_runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?").run(nowIso(), msg, runId);
        this.db.prepare("UPDATE tasks SET status = 'error', status_note = ?, wait_kind = 'system', due_at = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(msg, this.dueAt("agent"), nowIso(), taskId);
      });
      this.emit({ type: "attention.requested", label: `Lỗi: ${msg.slice(0, 140)}`, source: "agent", workflowId: wfId, taskId, agentId: step.agent, room: this.roomOf(step.agent) , msg: { key: "ev.attn.error", params: { step: step.key } } });
    }
  }

  /** Tasks blocked on a date before now (used by the UI for overdue reminders). */
  overdue(): number {
    return num(this.db.prepare(`SELECT COUNT(*) c FROM tasks t JOIN workflows w ON w.id = t.workflow_id WHERE w.status IN ${ACTIVE_WF} AND t.due_at IS NOT NULL AND t.due_at < ? AND t.status NOT IN ('done','skipped','cancelled')`).get(now().toISOString())!.c);
  }
}
