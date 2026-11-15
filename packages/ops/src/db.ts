import fs from "fs";
import { now } from "./clock";
import path from "path";
import crypto from "crypto";

/**
 * SQLite persistence via Node's built-in `node:sqlite` (Node ≥ 22.13).
 * Loaded through process.getBuiltinModule so bundlers (Next.js/webpack)
 * never try to resolve it.
 */

// Minimal typing of the node:sqlite surface we use
export interface Statement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

function loadSqlite(): { DatabaseSync: new (file: string) => Database } {
  const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  if (!getBuiltin) throw new Error("Cần Node.js ≥ 22.13 (node:sqlite)");
  // Silence the one-time ExperimentalWarning for sqlite only
  const origEmit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const msg = typeof warning === "string" ? warning : warning?.message;
    if (msg && msg.includes("SQLite")) return;
    return (origEmit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return getBuiltin("node:sqlite") as { DatabaseSync: new (file: string) => Database };
  } finally {
    process.emitWarning = origEmit;
  }
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_type TEXT NOT NULL,
  source TEXT NOT NULL,            -- file | api
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  idempotency_key TEXT,
  received_at TEXT NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 0,
  rows_total INTEGER NOT NULL DEFAULT 0,
  rows_accepted INTEGER NOT NULL DEFAULT 0,
  quality_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'accepted',
  workflow_id INTEGER,
  UNIQUE(dataset_type, sha256)
);
CREATE UNIQUE INDEX IF NOT EXISTS imports_idem ON imports(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS data_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES imports(id),
  dataset_type TEXT NOT NULL,
  row_no INTEGER NOT NULL,          -- line number in the source file (1-based, header = 1)
  row_key TEXT NOT NULL,            -- natural key, e.g. "2026-11-01|SIM-WHP-A|A-03"
  data_json TEXT NOT NULL,          -- normalized values
  raw_json TEXT NOT NULL,           -- original cells as received
  status TEXT NOT NULL,             -- active | duplicate | superseded | rejected
  issues_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS data_rows_type_key ON data_rows(dataset_type, row_key, status);

CREATE TABLE IF NOT EXISTS calcs (
  id TEXT PRIMARY KEY,               -- content hash
  label TEXT NOT NULL,
  formula TEXT NOT NULL,
  inputs_json TEXT NOT NULL,         -- [{name, value, unit, ref}]
  result REAL,
  unit TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  well TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  detection_json TEXT NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL REFERENCES workflows(id),
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status_note TEXT,
  current_run_id INTEGER,
  feedback_json TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(workflow_id, key)
);

CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  inputs_json TEXT NOT NULL DEFAULT '[]',
  input_fingerprint TEXT NOT NULL DEFAULT '',
  output_json TEXT,
  error TEXT,
  mode TEXT NOT NULL DEFAULT 'demo-rules',
  superseded INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER,
  doc_key TEXT NOT NULL,             -- stable identity across versions, e.g. "WF1/technical-assessment"
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,              -- generated | upload
  mime TEXT NOT NULL,
  content TEXT NOT NULL,             -- markdown / extracted text (untrusted for uploads)
  sha256 TEXT NOT NULL,
  task_run_id INTEGER,
  import_id INTEGER,
  created_at TEXT NOT NULL,
  flags_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(doc_key, version)
);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  decision TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  comment TEXT NOT NULL,
  return_to TEXT,
  package_doc_id INTEGER NOT NULL,
  package_version INTEGER NOT NULL,
  package_sha256 TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  decided_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  workflow_id INTEGER,
  task_id INTEGER,
  agent_id TEXT,
  ts TEXT NOT NULL,
  source TEXT NOT NULL,              -- orchestrator | agent | user | import | api | system
  type TEXT NOT NULL,
  room TEXT,
  label TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS events_wf ON events(workflow_id, ts);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- rfq | purchase_requisition | vessel_booking | work_request
  title TEXT NOT NULL,
  recipient TEXT NOT NULL,
  doc_id INTEGER NOT NULL,
  status TEXT NOT NULL,              -- draft | approved_to_send | cancelled
  created_at TEXT NOT NULL,
  approved_by TEXT,
  approved_role TEXT,
  approved_at TEXT,
  dispatch_note TEXT,
  UNIQUE(workflow_id, kind, title)
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_run_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  system_prompt TEXT NOT NULL,
  user_prompt TEXT NOT NULL,
  response TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);

-- Claude API configuration changes and connection checks (never the key itself)
CREATE TABLE IF NOT EXISTS llm_config_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,            -- config | check | message_check
  created_at TEXT NOT NULL,
  actor TEXT,
  provider TEXT NOT NULL,
  model TEXT,
  enabled INTEGER,
  key_configured INTEGER,
  key_changed INTEGER,
  revision INTEGER,
  status TEXT NOT NULL,          -- ok | error | saved
  error_category TEXT,
  http_status INTEGER,
  request_id TEXT,
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  detail TEXT
);

-- Input snapshot per case revision: scope, period, data/rule versions, units, latest assessment
CREATE TABLE IF NOT EXISTS case_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  trigger TEXT,                 -- creation | data:<type>#<import> | return:<decision> | reopen:<decision>
  snapshot_json TEXT NOT NULL,
  snapshot_sha TEXT NOT NULL,
  UNIQUE(workflow_id, revision)
);

-- Hand-offs between steps/people: who gives what (artifact version), to whom, by when, and the response
CREATE TABLE IF NOT EXISTS handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  case_revision INTEGER NOT NULL,
  from_task_id INTEGER NOT NULL,
  from_key TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_key TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  artifact_doc_id INTEGER,
  artifact_version INTEGER,
  artifact_sha TEXT,
  from_run_id INTEGER,
  request TEXT NOT NULL,
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  due_at TEXT,
  status TEXT NOT NULL,          -- offered | accepted | returned | superseded
  response TEXT,
  return_reason TEXT,
  created_at TEXT NOT NULL,
  responded_at TEXT,
  business_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS handoffs_wf ON handoffs(workflow_id, status);

-- Soft reservations of shared resources (budget, deck space, seats). "held" is internal only;
-- "confirmed" means an external system/person confirmed the booking (recorded manually).
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  case_revision INTEGER NOT NULL,
  resource_type TEXT NOT NULL,   -- budget | vessel_deck | flight_seats
  resource_key TEXT NOT NULL,    -- e.g. OPX-WS-DIAG/FY2026 | V-1103 | HL-0005
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  capacity REAL,                 -- capacity seen when the hold was placed
  status TEXT NOT NULL,          -- held | confirmed | released | expired
  business_key TEXT NOT NULL UNIQUE,
  source_task_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  released_at TEXT,
  release_reason TEXT,
  external_ref TEXT,
  confirmed_by TEXT
);
CREATE INDEX IF NOT EXISTS reservations_res ON reservations(resource_type, resource_key, status);

-- Lifecycle trail of each reservation: hold, update, carry_forward (with the plan run and content
-- hash that justified it), amend, confirm, cancel_request, cancel, supersede, release, expire.
-- idempotency_key + request_hash make person actions (confirm/cancel) safely retryable.
CREATE TABLE IF NOT EXISTS reservation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL,
  workflow_id INTEGER NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_revision INTEGER,
  to_revision INTEGER,
  content_sha TEXT,
  actor TEXT,
  idempotency_key TEXT,
  request_hash TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS reservation_events_res ON reservation_events(reservation_id);
CREATE UNIQUE INDEX IF NOT EXISTS reservation_events_idem ON reservation_events(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Translations of business content: a separate representation bound to the original's kind/id,
-- sha256 and version. The original is never modified; approvals apply to the original only.
CREATE TABLE IF NOT EXISTS translations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  source_sha TEXT NOT NULL,
  source_version TEXT,
  source_lang TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  content TEXT NOT NULL,
  translator TEXT NOT NULL,
  request_id TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  status TEXT NOT NULL,
  checks_json TEXT NOT NULL DEFAULT '{}',
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT
);
CREATE INDEX IF NOT EXISTS translations_src ON translations(source_kind, source_id, target_lang, source_sha);

-- Append-only audit of allowed mutations (who, what, target). Never cleared by a demo reset; no secrets.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  identity_source TEXT NOT NULL,
  roles TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Additive migrations for databases created by earlier versions (never drops data). */
const MIGRATIONS: Array<[table: string, column: string, ddl: string]> = [
  ["decisions", "actor_id", "TEXT"],
  ["decisions", "identity_source", "TEXT"],
  ["decisions", "request_hash", "TEXT"],
  ["outbox", "doc_sha256", "TEXT"],
  ["outbox", "approved_by_id", "TEXT"],
  ["outbox", "identity_source", "TEXT"],
  // LLM call history: status, timing, token usage (no secrets)
  ["llm_calls", "status", "TEXT"],
  ["llm_calls", "finished_at", "TEXT"],
  ["llm_calls", "duration_ms", "INTEGER"],
  ["llm_calls", "served_model", "TEXT"],
  ["llm_calls", "stop_reason", "TEXT"],
  ["llm_calls", "request_id", "TEXT"],
  ["llm_calls", "input_tokens", "INTEGER"],
  ["llm_calls", "output_tokens", "INTEGER"],
  ["llm_calls", "cache_read_tokens", "INTEGER"],
  ["llm_calls", "cache_creation_tokens", "INTEGER"],
  ["llm_calls", "error_category", "TEXT"],
  ["llm_calls", "http_status", "INTEGER"],
  ["llm_calls", "config_revision", "INTEGER"],
  ["llm_calls", "fallback_used", "INTEGER"],
  // configuration the run started with (provider/model/revision) — tasks keep it even if settings change
  ["task_runs", "llm_config_json", "TEXT"],
  // ── workflow v2: case revisions, branches, ownership, impact analysis ──
  ["workflows", "asset", "TEXT"],
  ["workflows", "well_key", "TEXT"],
  ["workflows", "priority", "TEXT"],
  ["workflows", "branch", "TEXT"],
  ["workflows", "closed_at", "TEXT"],
  ["workflows", "closure_json", "TEXT"],
  ["tasks", "wait_kind", "TEXT"],
  ["tasks", "owner", "TEXT"],
  ["tasks", "due_at", "TEXT"],
  ["tasks", "case_revision", "INTEGER"],
  ["task_runs", "case_revision", "INTEGER"],
  ["task_runs", "datasets_json", "TEXT"],
  ["task_runs", "scoped_fp_json", "TEXT"],
  ["decisions", "case_revision", "INTEGER"],
  ["decisions", "waivers_json", "TEXT"],
  ["decisions", "confirmations_json", "TEXT"],
  ["outbox", "case_revision", "INTEGER"],
  ["outbox", "required_gate", "TEXT"],
  ["outbox", "status_note", "TEXT"],
  // reservation lifecycle v2: confirmation bound to content, amendments, cancellation requests
  ["reservations", "confirmed_quantity", "REAL"],
  ["reservations", "confirmed_revision", "INTEGER"],
  ["reservations", "confirmed_sha", "TEXT"],
  ["reservations", "confirmed_at", "TEXT"],
  ["reservations", "amendment_of", "INTEGER"],
  ["reservations", "change_note", "TEXT"],
  ["reservations", "cancel_ref", "TEXT"],
  ["reservations", "cancelled_by", "TEXT"],
  ["reservations", "cancelled_at", "TEXT"],
];

function migrate(db: Database): void {
  for (const [table, column, ddl] of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export function openDatabase(file: string): Database {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function nowIso(): string {
  return now().toISOString();
}

export function sha256(text: string | Buffer): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** Run fn inside a transaction (BEGIN IMMEDIATE … COMMIT/ROLLBACK). */
export function tx<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : (v as number);
}
