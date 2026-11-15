/**
 * Domain types for the offshore operations workflow.
 *
 * Traceability is the core contract: every conclusion an agent produces
 * cites Evidence items, and every Evidence item carries a TraceRef that the
 * UI can resolve back to a data row, a calculation, a document, a task run
 * or a human decision (see trace.ts).
 */

export const TASK_STATUSES = [
  "pending", // chờ
  "running", // đang chạy
  "missing_data", // thiếu dữ liệu
  "awaiting_approval", // chờ duyệt
  "done", // hoàn tất
  "error", // lỗi
  "cancelled", // hủy
  "skipped", // bỏ qua theo điều kiện (có lý do, không phải "đã làm")
  "waiting", // chờ nguồn lực / đơn vị khác / tới ngày thực hiện (xem wait_kind)
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "Chờ",
  running: "Đang chạy",
  missing_data: "Thiếu dữ liệu",
  awaiting_approval: "Chờ duyệt",
  done: "Hoàn tất",
  error: "Lỗi",
  cancelled: "Hủy",
  skipped: "Bỏ qua (có lý do)",
  waiting: "Đang chờ",
};

/** Why a task is not moving — kept distinct so users know who must act. */
export type WaitKind = "data" | "resource" | "other_unit" | "system" | "approval" | "date" | "dependency" | "config";
export const WAIT_KIND_LABEL: Record<WaitKind, string> = {
  data: "Thiếu dữ liệu",
  resource: "Thiếu nguồn lực",
  other_unit: "Chờ đơn vị khác",
  system: "Lỗi hệ thống",
  approval: "Chờ phê duyệt",
  date: "Chờ tới ngày thực hiện",
  dependency: "Chờ bước trước",
  config: "Lỗi cấu hình",
};

/** A condition checked at a gate. Waivable ones need an explicit exception by a role from policy.waiverRoles. */
export interface GateCondition {
  code: string;
  label: string;
  met: boolean;
  /** "confirm" = a person must attest it at the gate (e.g. PTW issued by the authority — never by the system) */
  kind: "check" | "confirm";
  waivable: boolean;
  waiverRoles: string[];
  detail?: string;
  evidence?: string[];
}

/**
 * open      — đang xử lý trước cam kết
 * approved  — đã duyệt cam kết chi; vẫn đang kiểm tra sẵn sàng / thực hiện (KHÔNG có nghĩa đã hoàn thành)
 * closed    — đã có kết quả, đánh giá theo tiêu chí và người có trách nhiệm đóng
 * rejected / cancelled
 */
export type WorkflowStatus = "open" | "approved" | "closed" | "rejected" | "cancelled";

export type AgentId =
  | "ops_agent"
  | "prodeng_agent"
  | "maint_agent"
  | "hse_agent"
  | "contracts_agent"
  | "logistics_agent"
  | "finance_agent"
  | "eng_lead" // human approver (scope gate, case closure)
  | "asset_manager" // human approver (commitment gate, per delegation of authority)
  | "oim"; // offshore focal point (readiness confirmation; PTW stays with the authority)

/** Reference to something the user can open and inspect. */
export type TraceRef =
  | { kind: "data_row"; id: number } // a normalized row from an imported dataset
  | { kind: "import"; id: number } // an import batch (file / API payload)
  | { kind: "calc"; id: string } // a stored calculation with formula + inputs
  | { kind: "document"; id: number } // generated or uploaded document (specific version)
  | { kind: "task_run"; id: number } // an agent execution (inputs, output, errors)
  | { kind: "decision"; id: number } // a human decision
  | { kind: "event"; id: string }; // an audit event

export interface Evidence {
  id: string; // unique within an output, e.g. "E3"
  label: string; // human-readable statement of what this evidence shows
  ref: TraceRef;
}

export type ConclusionBasis =
  | "observed" // dữ kiện quan sát trực tiếp từ dữ liệu
  | "calculated" // kết quả tính toán
  | "hypothesis" // giả thuyết, cần kiểm chứng
  | "check"; // kết quả đối chiếu / kiểm tra

export interface Conclusion {
  id: string;
  text: string;
  basis: ConclusionBasis;
  evidence: string[]; // Evidence ids
}

export interface MissingData {
  id: string;
  description: string;
  /** Dataset type that would resolve it (enables auto re-run on import) */
  datasetType?: string;
  /** Blocking items stop the workflow at this task (status missing_data) */
  blocking: boolean;
  /** Who must provide/confirm it */
  owner?: string;
}

export interface OutputDocument {
  docId: number;
  title: string;
  kind: string;
  version: number;
}

/**
 * Who is acting. Always resolved on the server — never taken from request
 * strings. "demo" identities come from a server-side demo directory and are
 * NOT enterprise authentication; operating mode "production" rejects them.
 */
export interface Identity {
  userId: string;
  name: string;
  roles: string[];
  /** service = integration/automation credential (imports, scripted tests) — never a human approver */
  source: "demo" | "enterprise" | "service";
}

export type OperatingMode = "demo" | "production";

/** Processing mode, reported on three separate fields (requested ≠ effective). */
export interface ModeState {
  requested: "rules" | "llm";
  /** "blocked": LLM requested but not usable — agents are paused, NOT silently run on rules */
  effective: "rules" | "llm" | "blocked";
  configurationStatus:
    | "not_applicable" // rules only
    | "missing_credentials"
    | "invalid_config"
    | "configured_unverified" // client built, no successful call yet
    | "verified" // at least one successful call since start
    | "last_call_failed";
  provider?: string;
  model?: string;
  detail: string;
  /** Reasoning effort sent to the provider (Claude API) */
  effort?: string;
  /** Where the configuration came from: "ui" (/ops settings, hot-reload), "env" (OPS_LLM=1 at start), "config" (ops-config.json) */
  source?: "ui" | "env" | "config";
  /** Settings revision (ui source); every run/call records the revision it started with */
  configRevision?: number;
  lastLlmOkAt?: string;
  lastLlmError?: string;
  lastLlmErrorCategory?: string;
  /** true when changing the configuration needs a server restart (env/config sources) */
  reloadRequiresRestart: boolean;
}

/** LLM contribution, kept apart from rule-computed content. */
export interface LlmContribution {
  provider: string;
  model?: string;
  /** Language the narrative/claims were written in (run snapshot of runtime.llm.outputLanguage) */
  language?: "vi" | "en";
  narrative: string | null;
  /** Sentences removed from the narrative and why */
  narrativeRedactions: Array<{ text: string; reason: string }>;
  /** Claims that passed the automatic checks — still NOT semantically verified */
  claims: Array<{ text: string; basis: ConclusionBasis; evidence: string[]; numbersChecked: number }>;
  rejected: Array<{ text: string; reason: string }>;
  /** Suggestions only; no evidence requirement, not verified */
  nextSteps: string[];
  validationNote: string;
}

/** Structured output every agent produces (stored per task run). */
export interface AgentOutput {
  /** Language the rule-generated text was written in (config content.language at run time) */
  language?: "vi" | "en";
  summary: string; // kết luận chính
  conclusions: Conclusion[];
  evidence: Evidence[];
  assumptions: string[];
  missingData: MissingData[];
  documents: OutputDocument[];
  nextSteps: string[];
  /** "demo-rules" = deterministic rules only, no LLM call; "llm" = narrative from a real model */
  mode: "demo-rules" | "llm";
  narrative?: string;
  /** Present only when an LLM was called; never merged into conclusions */
  llm?: LlmContribution;
  warnings: string[];
  /** Machine-readable facts for downstream agents (not shown as prose) */
  facts: Record<string, unknown>;
  /** Set when the step cannot finish yet for a reason other than missing data */
  waiting?: { kind: "resource" | "other_unit" | "date"; reason: string; until?: string; datasetType?: string; owner?: string };
}

export interface WorkflowRow {
  id: number;
  case_no: string;
  title: string;
  well: string;
  platform: string;
  status: WorkflowStatus;
  version: number;
  created_at: string;
  updated_at: string;
  detection_json: string;
  simulated: number;
  asset?: string | null;
  well_key?: string | null;
  priority?: string | null;
  branch?: string | null;
  closed_at?: string | null;
  closure_json?: string | null;
}

export interface TaskRow {
  id: number;
  workflow_id: number;
  key: string;
  title: string;
  agent_id: AgentId;
  status: TaskStatus;
  attempts: number;
  status_note: string | null;
  current_run_id: number | null;
  updated_at: string;
  feedback_json?: string | null;
  wait_kind?: WaitKind | null;
  owner?: string | null;
  due_at?: string | null;
  case_revision?: number | null;
}

export interface TaskRunRow {
  id: number;
  task_id: number;
  attempt: number;
  status: TaskStatus;
  started_at: string;
  finished_at: string | null;
  inputs_json: string;
  input_fingerprint: string;
  output_json: string | null;
  error: string | null;
  mode: string;
  superseded: number;
}

export interface DecisionRow {
  id: number;
  workflow_id: number;
  task_id: number;
  decision: "approve" | "reject" | "request_changes";
  actor_name: string;
  actor_role: string;
  comment: string;
  return_to: string | null;
  package_doc_id: number;
  package_version: number;
  package_sha256: string;
  workflow_version: number;
  decided_at: string;
  idempotency_key: string;
}
