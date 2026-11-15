import type { Ref } from "./ui";

export interface TaskSummary {
  id: number;
  key: string;
  title: string;
  agentId: string;
  status: string;
  note: string | null;
  attempts: number;
  deps: string[];
  gate: boolean;
  updatedAt: string;
  summary: string | null;
  mode: string | null;
  gateFacts: { role: string; packageDocId: number; packageVersion: number; packageSha: string; returnOptions: string[]; workflowVersion: number; conditions?: GateCondition[]; policyVersion?: string } | null;
  blocking: string[];
  phase?: string;
  waitKind?: string | null;
  waitLabel?: string | null;
  owner?: string | null;
  dueAt?: string | null;
  overdue?: boolean;
  caseRevision?: number | null;
  waiting?: { kind: string; reason: string; until?: string } | null;
  workflowId?: number;
  caseNo?: string;
}

export interface GateCondition {
  code: string;
  label: string;
  met: boolean;
  kind: "check" | "confirm";
  waivable: boolean;
  waiverRoles: string[];
  detail?: string;
}

export interface Handoff {
  id: number;
  caseNo: string;
  direction: "in" | "out";
  from: string;
  to: string;
  toAgent: string;
  request: string;
  status: string;
  dueAt: string | null;
  artifactVersion: number | null;
}

export interface ActionItem {
  workflowId: number;
  caseNo: string;
  priority: string;
  taskId: number;
  key: string;
  title: string;
  status: string;
  waitKind?: string | null;
  waitLabel: string;
  owner: string | null;
  dueAt: string | null;
  overdue: boolean;
  note: string | null;
}

export interface Reservation {
  id: number;
  workflow_id: number;
  case_no: string;
  case_revision: number;
  resource_type: string;
  resource_key: string;
  quantity: number;
  unit: string;
  capacity: number | null;
  status: string;
  expires_at: string | null;
  release_reason: string | null;
  external_ref: string | null;
  confirmed_by: string | null;
  /** Content the external confirmation is bound to */
  confirmed_quantity?: number | null;
  confirmed_revision?: number | null;
  /** This row is an amendment of a confirmed booking (needs its own confirmation) */
  amendment_of?: number | null;
  change_note?: string | null;
  cancel_ref?: string | null;
  /** Current revision of the case (a confirmation is always for this revision) */
  wf_version?: number;
}

export interface WorkflowSummary {
  id: number;
  caseNo: string;
  title: string;
  well: string;
  platform: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  simulated: boolean;
  wellKey?: string;
  priority?: string;
  branch?: string | null;
  branchLabel?: string | null;
  stage?: string;
  /** Stable code: current step key, or closed/rejected/cancelled/none. */
  stageKey?: string;
  holder?: string | null;
  nextStep?: string | null;
  closure?: { conclusion: string; closedBy: string; closedAt: string } | null;
  progress: { done: number; total: number };
  tasks: TaskSummary[];
}

export interface AgentState {
  id: string;
  name: string;
  short: string;
  room: string;
  kind: "ai" | "human";
  color: string;
  location: string;
  current: TaskSummary | null;
  attention: { status: string; label: string; items: Array<{ workflowId: number; caseNo: string; taskId: number; key?: string; waitKind?: string | null; status: string; label: string }> } | null;
  queue: number;
  holding?: Array<{ taskId: number; key?: string; caseNo: string; workflowId: number; title: string; status: string; waitKind?: string | null; waitLabel: string | null; note: string | null; dueAt: string | null; overdue: boolean }>;
  handoffs?: Handoff[];
}

export interface ModeState {
  requested: "rules" | "llm";
  effective: "rules" | "llm" | "blocked";
  configurationStatus: "not_applicable" | "missing_credentials" | "invalid_config" | "configured_unverified" | "verified" | "last_call_failed";
  provider?: string;
  model?: string;
  detail: string;
  effort?: string;
  source?: "ui" | "env" | "config";
  configRevision?: number;
  lastLlmOkAt?: string;
  lastLlmError?: string;
  lastLlmErrorCategory?: string;
  reloadRequiresRestart: boolean;
}

export interface PublicLlmSettings {
  exists: boolean;
  provider: "anthropic";
  enabled: boolean;
  model: string;
  effort: "low" | "medium" | "high";
  refusalFallback: boolean;
  keyConfigured: boolean;
  keyMasked: string | null;
  revision: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface LlmTestResult {
  success: boolean;
  /** Stable code rendered from the catalog (llm.result.<code>); label/message are the original text */
  code?: string;
  params?: Record<string, string | number>;
  label: string;
  message: string;
  category?: string;
  status?: number;
  requestId?: string;
  retryAfter?: number;
  durationMs?: number;
}

export interface LlmInfo {
  settings: PublicLlmSettings;
  settingsError: string | null;
  mode: ModeState;
  models: Array<{ id: string; label: string }>;
  operatingMode: "demo" | "production";
  history: {
    events: Array<{ id: number; kind: string; created_at: string; actor: string | null; model: string | null; enabled: number | null; key_configured: number | null; key_changed: number | null; revision: number | null; status: string; error_category: string | null; http_status: number | null; request_id: string | null; duration_ms: number | null; input_tokens: number | null; output_tokens: number | null; detail: string | null }>;
    calls: Array<{ id: number; task_run_id: number; provider: string; model: string | null; served_model: string | null; created_at: string; duration_ms: number | null; status: string | null; stop_reason: string | null; request_id: string | null; input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; error_category: string | null; http_status: number | null; error: string | null; config_revision: number | null; fallback_used: number | null; task_title: string | null; case_no: string | null }>;
    totals: { calls: number; ok: number | null; input_tokens: number; output_tokens: number };
  };
}

export interface SessionInfo {
  operatingMode: "demo" | "production";
  identityProvider: "demo" | "none";
  detail: string;
  identity: { userId: string; name: string; roles: string[]; source: "demo" | "enterprise" } | null;
  users: Array<{ id: string; name: string; roles: string[] }>;
}

export interface OpsState {
  mode: ModeState;
  operatingMode: "demo" | "production";
  simulatedData: boolean;
  businessTimeZone?: string;
  /** config content.language: language of rule-generated content */
  contentLanguage?: "vi" | "en";
  dataSource: { kind: "none" | "simulated" | "real" | "mixed"; simulatedRows: number; realRows: number };
  agents: AgentState[];
  workflows: WorkflowSummary[];
  approvals: TaskSummary[];
  imports: Array<{ id: number; datasetType: string; label: string; filename: string; source: string; receivedAt: string; simulated: boolean; rowsTotal: number; rowsAccepted: number; quality: { warnings?: string[]; conflicts?: unknown[]; duplicates?: number; rowsRejected?: number; flags?: string[] } }>;
  datasetCounts: Record<string, number>;
  outbox: Array<{ id: number; workflow_id: number; kind: string; title: string; recipient: string; doc_id: number; doc_sha256: string | null; identity_source: string | null; status: string; approved_by: string | null; approved_role: string | null; approved_at: string | null; dispatch_note: string | null; case_revision?: number | null; required_gate?: string | null; status_note?: string | null }>;
  actionList?: ActionItem[];
  reservations?: Reservation[];
  policy?: { version: string; source: string; rules: string };
  events: Array<{ event_id: string; workflow_id: number | null; task_id: number | null; agent_id: string | null; ts: string; source: string; type: string; room: string | null; label: string; payload_json?: string }>;
  steps: Array<{ key: string; title: string; agent: string; deps: string[]; gate: boolean; depMode: string; hasCondition: boolean }>;
  serverTime: string;
}

export interface AgentOutput {
  summary: string;
  conclusions: Array<{ id: string; text: string; basis: string; evidence: string[] }>;
  evidence: Array<{ id: string; label: string; ref: Ref }>;
  assumptions: string[];
  missingData: Array<{ id: string; description: string; datasetType?: string; blocking: boolean; owner?: string }>;
  documents: Array<{ docId: number; title: string; kind: string; version: number }>;
  nextSteps: string[];
  mode: string;
  facts: Record<string, unknown>;
  waiting?: { kind: string; reason: string; until?: string };
  llm?: {
    provider: string;
    model?: string;
    narrative: string | null;
    narrativeRedactions: Array<{ text: string; reason: string }>;
    claims: Array<{ text: string; basis: string; evidence: string[]; numbersChecked: number }>;
    rejected: Array<{ text: string; reason: string }>;
    nextSteps: string[];
    validationNote: string;
  };
  warnings: string[];
}

export interface RunDetail {
  id: number;
  attempt: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  mode: string;
  superseded: boolean;
  error: string | null;
  inputs: Ref[];
  output: AgentOutput | null;
}

export interface WorkflowDetail {
  workflow: { id: number; case_no: string; title: string; status: string; version: number };
  tasks: Array<TaskSummary & { feedback: string | null; runs: RunDetail[] }>;
  documents: Array<{ id: number; doc_key: string; version: number; title: string; kind: string; source: string; sha256: string; created_at: string }>;
  decisions: Array<{ id: number; task_id: number; decision: string; actor_name: string; actor_role: string; comment: string; return_to: string | null; package_version: number; package_sha256: string; decided_at: string; identity_source?: string | null; case_revision?: number | null; waivers_json?: string | null; confirmations_json?: string | null }>;
  events: OpsState["events"];
  revisions?: Array<{ revision: number; created_at: string; reason: string; trigger: string | null; snapshot_sha: string }>;
  snapshot?: {
    revision: number;
    wellKey: string;
    reportPeriod: { from: string | null; to: string | null };
    evaluationDate: string | null;
    dataAgeDays: number | null;
    stale: boolean;
    rules: string;
    policy: { version: string; source: string };
    units: { oil: string; basis: string; meaning: string };
    simulated: boolean;
    data: Record<string, { fp: string; rows: number; importIds: number[]; simulated: boolean }>;
    initialDetection: { asOf: string | null; minDropPct: number | null; baseline: number | null };
  } | null;
  handoffs?: Array<{ id: number; case_revision: number; from_key: string; from_agent: string; to_key: string; to_agent: string; artifact_doc_id: number | null; artifact_version: number | null; artifact_sha: string | null; request: string; acceptance_json: string; due_at: string | null; status: string; response: string | null; return_reason: string | null; created_at: string; responded_at: string | null }>;
  reservations?: Reservation[];
  outbox?: OpsState["outbox"];
}

export type View =
  | { kind: "task"; workflowId: number; taskId: number }
  | { kind: "agent"; id: string }
  /** Technical room key only (zone id + layout label); the name is resolved at render in the current language. */
  | { kind: "room"; zone: string; roomLabel: string }
  | { kind: "trace"; ref: Ref }
  | { kind: "llm" };
