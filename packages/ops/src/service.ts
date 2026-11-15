import { L, contentLanguage, datasetText } from "./lang";
import fs from "fs";
import path from "path";
import { openDatabase, sha256, nowIso, num, tx, type Database } from "./db";
import { loadOpsConfig, configVersion, type OpsConfig } from "./config";
import { parseCsv, parseXlsx, parseJsonTable, extractDocumentText, isSimulated, type ParsedTable } from "./parsers";
import { importTable, detectDatasetType, DATASET_MAP, DATASETS, type QualityReport } from "./datasets";
import { runDetection } from "./detection";
import { Orchestrator, OpsError, WORKFLOW_STEPS, STEP_MAP, BRANCH_LABEL, rulesMode, type VisualEvent } from "./workflow";
import { latestSnapshot, revisions } from "./caseModel";
import { caseReservations, confirmExternal, cancelExternal, expireHolds } from "./resources";
import { authorize, audit, logDenied, type MutationAction } from "./authz";
import { now, setBusinessTimeZone } from "./clock";
import { resolveTrace, type TraceView } from "./trace";
import { translationView, translateSource, reviewTranslation, TranslationError, type SourceKind, type TargetLang, type TranslationView, type TranslationRow } from "./translation";
import { scanUntrusted } from "./untrusted";
import type { LlmClient } from "./llm";
import { AGENT_DIRECTORY, DATASET_OWNER, AGENT_INFO } from "./agents";
import { WAIT_KIND_LABEL, type AgentId, type AgentOutput, type Identity, type ModeState, type OperatingMode, type TaskRow, type TraceRef, type WaitKind, type WorkflowRow } from "./types";

export interface OpsServiceOptions {
  dbPath: string;
  configPath?: string;
  publish?: (e: VisualEvent) => void;
  /** Requested processing mode; default comes from ops-config runtime.llm.enabled */
  requestedMode?: "rules" | "llm";
  /** LLM client (null/undefined when not configured) */
  llm?: LlmClient | null;
  /** Why the LLM client could not be built (shown to users; agents pause) */
  llmConfigError?: { status: "missing_credentials" | "invalid_config"; message: string };
  /** Where the LLM configuration came from (default: env when requestedMode is given, else config) */
  llmSource?: "ui" | "env" | "config";
  /** Settings revision (ui source) */
  llmRevision?: number;
  /**
   * Principal used for in-process callers that pass no identity (scripts, tests).
   * Subject to the SAME role checks; never set by the web app (HTTP callers pass the session identity).
   */
  systemActor?: Identity;
  /** Reasoning effort shown in the mode (ui source) */
  llmEffort?: string;
  /** "production" rejects demo identities (no enterprise identity provider exists yet) */
  operatingMode?: OperatingMode;
  taskDelayMs?: number;
  tickMs?: number;
}

export interface LlmConfigInput {
  requested: "rules" | "llm";
  llm?: LlmClient | null;
  error?: OpsServiceOptions["llmConfigError"];
  source: "ui" | "env" | "config";
  revision?: number;
  effort?: string;
}

export function buildMode(c: LlmConfigInput): ModeState {
  // Only the legacy env path (OPS_LLM=1 + copilot credentials) is read once at start;
  // saving from /ops always applies immediately (and takes precedence).
  const restart = c.source === "env";
  const fix = restart
    ? "Sửa credentials rồi khởi động lại server, hoặc cấu hình Claude API trên /ops (áp dụng ngay)."
    : "Sửa trong mục Claude API trên /ops — áp dụng ngay cho task tiếp theo.";
  const common = { source: c.source, configRevision: c.revision, effort: c.effort, reloadRequiresRestart: restart };
  if (c.requested === "rules") return { ...rulesMode(), ...common, effort: undefined };
  if (!c.llm) {
    return {
      requested: "llm",
      effective: "blocked",
      configurationStatus: c.error?.status ?? "missing_credentials",
      detail: `Yêu cầu xử lý bằng LLM nhưng chưa dùng được: ${c.error?.message ?? "chưa có client LLM"}. Agent tạm dừng (không tự chuyển sang quy tắc/Demo). ${fix}`,
      ...common,
    };
  }
  return {
    requested: "llm",
    effective: "llm",
    configurationStatus: "configured_unverified",
    provider: c.llm.provider,
    model: c.llm.model,
    detail: `Quy tắc tính trước; LLM (${c.llm.provider}${c.llm.model ? "/" + c.llm.model : ""}) viết diễn giải và nhận định bổ sung — chưa có lần gọi thành công với cấu hình này`,
    ...common,
  };
}

export interface ImportOutcome {
  kind: "table" | "document";
  importId: number;
  duplicate: boolean;
  datasetType: string;
  quality?: QualityReport;
  detection?: Array<{ well: string; platform: string; wellKey: string; anomaly: boolean; suspect: boolean; minDropPct: number | null; explainedByDowntime: boolean; reason?: string }>;
  casesCreated: number[];
  requeued: number;
  flags?: string[];
}

export class OpsService {
  readonly db: Database;
  readonly cfg: OpsConfig;
  readonly orch: Orchestrator;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private opts: OpsServiceOptions) {
    this.db = openDatabase(opts.dbPath);
    this.cfg = loadOpsConfig(opts.configPath);
    setBusinessTimeZone(this.cfg.calendar.timeZone); // one business calendar for "today" / validity dates
    const requested = opts.requestedMode ?? (this.cfg.runtime.llm.enabled ? "llm" : "rules");
    const source = opts.llmSource ?? (opts.requestedMode ? "env" : "config");
    this.orch = new Orchestrator(this.db, this.cfg, {
      publish: opts.publish,
      llm: opts.llm ?? null,
      mode: buildMode({ requested, llm: opts.llm, error: opts.llmConfigError, source, revision: opts.llmRevision, effort: opts.llmEffort }),
      operatingMode: opts.operatingMode ?? "demo",
      taskDelayMs: opts.taskDelayMs,
    });
    // Databases from earlier versions: add the new steps / snapshots without touching history
    this.orch.migrateWorkflows();
  }

  start(): void {
    if (this.timer) return;
    const recovered = this.orch.recover();
    if (recovered) this.orch.emit({ type: "system.recovered", label: `Khởi động lại: khôi phục ${recovered} task đang chạy dở`, source: "system" });
    this.timer = setInterval(() => {
      try {
        this.orch.tick();
      } catch (err) {
        console.error("[ops] tick failed", err);
      }
    }, this.opts.tickMs ?? 700);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Processing mode as three separate facts: requested, effective, configuration status. */
  modeInfo(): ModeState {
    return { ...this.orch.mode };
  }

  /**
   * Apply a new LLM configuration without restarting. Tasks already running
   * keep the configuration they started with; the next task uses this one.
   */
  configureLlm(c: LlmConfigInput): ModeState {
    const mode = buildMode(c);
    this.orch.setLlm(mode, c.llm ?? null);
    this.orch.emit({
      type: "system.config",
      label: `Cấu hình xử lý: ${mode.effective === "llm" ? `Claude API (${mode.model})` : mode.effective === "blocked" ? "LLM được yêu cầu nhưng lỗi cấu hình — agent tạm dừng" : "quy tắc xác định"}${c.revision !== undefined ? ` · rev ${c.revision}` : ""}`,
      source: "system",
    });
    return { ...mode };
  }

  /** Configuration changes + connection checks. Never contains the key. */
  recordLlmEvent(e: {
    kind: "config" | "check" | "message_check";
    actor?: string;
    provider: string;
    model?: string;
    enabled?: boolean;
    keyConfigured?: boolean;
    keyChanged?: boolean;
    revision?: number;
    status: "ok" | "error" | "saved";
    errorCategory?: string;
    httpStatus?: number;
    requestId?: string;
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    detail?: string;
  }): void {
    const b = (v: boolean | undefined) => (v === undefined ? null : v ? 1 : 0);
    this.db
      .prepare(
        `INSERT INTO llm_config_events (kind, created_at, actor, provider, model, enabled, key_configured, key_changed, revision, status, error_category, http_status, request_id, duration_ms, input_tokens, output_tokens, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.kind, nowIso(), e.actor ?? null, e.provider, e.model ?? null, b(e.enabled), b(e.keyConfigured), b(e.keyChanged), e.revision ?? null, e.status, e.errorCategory ?? null, e.httpStatus ?? null, e.requestId ?? null, e.durationMs ?? null, e.inputTokens ?? null, e.outputTokens ?? null, e.detail ?? null);
  }

  /** History for the UI: config events + recent LLM calls (metadata only, no prompts/responses). */
  llmHistory(limit = 30) {
    const events = this.db.prepare("SELECT * FROM llm_config_events ORDER BY id DESC LIMIT ?").all(limit);
    const calls = this.db
      .prepare(
        `SELECT c.id, c.task_run_id, c.provider, c.model, c.served_model, c.created_at, c.finished_at, c.duration_ms, c.status, c.stop_reason, c.request_id,
                c.input_tokens, c.output_tokens, c.cache_read_tokens, c.cache_creation_tokens, c.error_category, c.http_status, c.error, c.config_revision, c.fallback_used,
                t.title AS task_title, w.case_no
           FROM llm_calls c
           LEFT JOIN task_runs r ON r.id = c.task_run_id
           LEFT JOIN tasks t ON t.id = r.task_id
           LEFT JOIN workflows w ON w.id = t.workflow_id
          ORDER BY c.id DESC LIMIT ?`,
      )
      .all(limit);
    const totals = this.db
      .prepare("SELECT COUNT(*) AS calls, SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens FROM llm_calls")
      .get();
    return { events, calls, totals };
  }

  // ── import ──

  /** Authorize a mutation for an identity (or the configured system principal). Refusals write nothing. */
  private allow(action: MutationAction, actor: Identity | undefined, detail?: { datasetType?: string; resourceType?: string }): Identity {
    try {
      return authorize(this.cfg, this.orch.operatingMode, actor ?? this.opts.systemActor, action, detail);
    } catch (err) {
      logDenied(action, err);
      throw err;
    }
  }

  /** Check (without writing) that an identity may change the Claude API configuration. */
  authorizeLlmConfigure(actor: Identity | null | undefined): Identity {
    return this.allow("llm.configure", actor ?? undefined);
  }

  async importFile(input: { filename: string; buffer: Buffer; datasetType?: string; workflowId?: number | null; idempotencyKey?: string; source?: "file" | "api"; actor?: Identity }, preAuthorized?: Identity): Promise<ImportOutcome> {
    if (input.buffer.length > this.cfg.limits.importMaxBytes) {
      throw new OpsError(413, `File ${input.filename} ${input.buffer.length} byte vượt giới hạn ${this.cfg.limits.importMaxBytes} byte (limits.importMaxBytes)`, "limit_exceeded", { limitName: "importMaxBytes", value: input.buffer.length, limit: this.cfg.limits.importMaxBytes });
    }
    if (!preAuthorized && !(input.actor ?? this.opts.systemActor)) this.allow("data.import", undefined); // 401 before parsing anything
    const lower = input.filename.toLowerCase();
    if (/\.(pdf|txt|md)$/.test(lower)) {
      const who = preAuthorized ?? this.allow("data.import", input.actor, { datasetType: "document" });
      const out = await this.importDocument(input);
      if (!out.duplicate) audit(this.db, who, "data.import", `document#${out.importId}`, { filename: input.filename, bytes: input.buffer.length });
      return out;
    }
    let table: ParsedTable;
    try {
      if (lower.endsWith(".csv")) table = parseCsv(input.buffer.toString("utf-8"));
      else if (/\.xlsx?$/.test(lower)) table = await parseXlsx(input.buffer);
      else if (lower.endsWith(".json")) table = parseJsonTable(input.buffer.toString("utf-8"));
      else throw new OpsError(400, "Định dạng không hỗ trợ (CSV, XLSX, JSON, PDF, TXT, MD)", "unsupported_format");
    } catch (err) {
      if (err instanceof OpsError) throw err;
      throw new OpsError(400, `Không đọc được file: ${err instanceof Error ? err.message : String(err)}`, "file_unreadable");
    }
    const type = input.datasetType || detectDatasetType(table.header, input.filename);
    if (!type || !DATASET_MAP.has(type)) throw new OpsError(400, `Không nhận diện được loại dữ liệu. Cột trong file: ${table.header.join(", ")}`, "dataset_unknown", { columns: table.header.join(", ") });
    if (table.rows.length > this.cfg.limits.importMaxRows) throw new OpsError(413, `${table.rows.length} dòng vượt giới hạn ${this.cfg.limits.importMaxRows} (limits.importMaxRows)`, "limit_exceeded", { limitName: "importMaxRows", value: table.rows.length, limit: this.cfg.limits.importMaxRows });
    const who = preAuthorized ?? this.allow("data.import", input.actor, { datasetType: type });
    const out = this.ingestTable(type, table, input.filename, input.source ?? "file", sha256(input.buffer), isSimulated(table.comments, input.filename), input.idempotencyKey, input.workflowId ?? null);
    if (!out.duplicate) audit(this.db, who, "data.import", `${type}#${out.importId}`, { filename: input.filename, rows: table.rows.length });
    return out;
  }

  /** API ingestion: records as JSON objects (e.g. from n8n). The caller's identity decides the permission — never a role in the body. */
  importRecords(input: { datasetType: string; rows: Array<Record<string, unknown>>; source?: string; simulated?: boolean; idempotencyKey?: string; actor?: Identity }): ImportOutcome {
    if (!(input.actor ?? this.opts.systemActor)) this.allow("data.import", undefined);
    if (typeof input.datasetType !== "string" || !DATASET_MAP.has(input.datasetType)) throw new OpsError(400, `datasetType không hợp lệ: ${String(input.datasetType).slice(0, 40)}`, "invalid_input", { field: "datasetType" });
    if (!Array.isArray(input.rows) || !input.rows.length) throw new OpsError(400, "rows[] phải là mảng không rỗng", "invalid_input", { field: "rows" });
    if (input.rows.length > this.cfg.limits.importMaxRows) throw new OpsError(413, `${input.rows.length} dòng vượt giới hạn ${this.cfg.limits.importMaxRows} (limits.importMaxRows)`, "limit_exceeded", { limitName: "importMaxRows", value: input.rows.length, limit: this.cfg.limits.importMaxRows });
    if (input.rows.some((r) => !r || typeof r !== "object" || Array.isArray(r))) throw new OpsError(400, "Mỗi phần tử rows[] phải là object", "invalid_input", { field: "rows[]" });
    const body = JSON.stringify({ t: input.datasetType, r: input.rows });
    if (Buffer.byteLength(body) > this.cfg.limits.importMaxBytes) throw new OpsError(413, `Dữ liệu ${Buffer.byteLength(body)} byte vượt giới hạn ${this.cfg.limits.importMaxBytes} (limits.importMaxBytes)`, "limit_exceeded", { limitName: "importMaxBytes", value: Buffer.byteLength(body), limit: this.cfg.limits.importMaxBytes });
    const who = this.allow("data.import", input.actor, { datasetType: input.datasetType });
    const table = parseJsonTable(JSON.stringify(input.rows));
    const out = this.ingestTable(input.datasetType, table, input.source ?? "api", "api", sha256(body), !!input.simulated, input.idempotencyKey, null);
    if (!out.duplicate) audit(this.db, who, "data.import", `${input.datasetType}#${out.importId}`, { source: input.source ?? "api", rows: input.rows.length });
    return out;
  }

  private ingestTable(type: string, table: ParsedTable, filename: string, source: "file" | "api", hash: string, simulated: boolean, idem: string | undefined, workflowId: number | null): ImportOutcome {
    const res = importTable(this.db, this.cfg, { datasetType: type, table, filename, source, contentSha256: hash, simulated, idempotencyKey: idem, workflowId });
    const owner = DATASET_OWNER[type] ?? "ops_agent";
    const T = L(this.cfg);
    const label = datasetText(this.cfg, type, DATASET_MAP.get(type)?.label ?? type);
    if (res.duplicateOf) {
      this.orch.emit({ type: "data.duplicate", label: T(`Bỏ qua "${filename}": trùng nội dung với import #${res.duplicateOf}`, `Skipped "${filename}": same content as import #${res.duplicateOf}`), source: "import", agentId: owner, room: AGENT_INFO.get(owner)?.room });
      return { kind: "table", importId: res.importId, duplicate: true, datasetType: type, quality: res.quality, casesCreated: [], requeued: 0 };
    }
    const q = res.quality;
    this.orch.emit({
      type: "review.intake",
      label: T(`tiếp nhận ${label} "${filename}": ${q.rowsAccepted}/${q.rowsTotal} dòng hợp lệ, ${q.rowsRejected} loại, ${q.duplicates} trùng, ${q.conflicts.length} xung đột${q.simulated ? " (GIẢ LẬP)" : ""}`, `received ${label} "${filename}": ${q.rowsAccepted}/${q.rowsTotal} rows valid, ${q.rowsRejected} rejected, ${q.duplicates} duplicates, ${q.conflicts.length} conflicts${q.simulated ? " (SIMULATED)" : ""}`),
      source: "import",
      agentId: owner,
      room: AGENT_INFO.get(owner)?.room,
      payload: { importId: res.importId },
      msg: { key: q.simulated ? "ev.intakeSim" : "ev.intake", params: { dataset: type, datasetLabel: label, file: filename, ok: q.rowsAccepted, total: q.rowsTotal, rejected: q.rowsRejected, dup: q.duplicates, conflicts: q.conflicts.length } },
    });
    const outcome: ImportOutcome = { kind: "table", importId: res.importId, duplicate: false, datasetType: type, quality: q, casesCreated: [], requeued: 0 };
    let det: ReturnType<typeof runDetection> | null = null;
    if (type === "dpr") {
      det = runDetection(this.db, this.cfg);
      outcome.detection = det.wells.map((w) => ({ well: w.well, platform: w.platform, wellKey: w.wellKey, anomaly: w.anomaly, suspect: w.suspect, minDropPct: w.minDropPct, explainedByDowntime: w.explainedByDowntime, reason: w.reason }));
      // New cases only for wells without an active case; an active case is re-assessed by impact analysis below
      for (const w of det.wells.filter((x) => x.anomaly || x.suspect)) {
        const c = this.orch.createCase(w, { asOf: w.asOf ?? det.asOf!, thresholdPct: det.thresholdPct, consecutiveDays: det.consecutiveDays, dprImportId: res.importId, simulated: q.simulated });
        if (c.created) outcome.casesCreated.push(c.workflowId);
      }
      for (const w of det.wells.filter((x) => x.explainedByDowntime)) {
        this.orch.emit({ type: "review.intake", label: T(`${w.wellKey}: sản lượng thô giảm nhưng lưu lượng khi vận hành không vượt ngưỡng — do downtime, không lập case`, `${w.wellKey}: raw output dropped but the operating rate stays within threshold — downtime, no case opened`), source: "import", agentId: "ops_agent", room: "zone_ops" });
      }
    }
    outcome.requeued = this.orch.onDataChanged([type], `${type}#${res.importId}`, det);
    return outcome;
  }

  private async importDocument(input: { filename: string; buffer: Buffer; workflowId?: number | null; idempotencyKey?: string }): Promise<ImportOutcome> {
    const hash = sha256(input.buffer);
    const existing = this.db.prepare("SELECT id FROM imports WHERE dataset_type = 'document' AND sha256 = ?").get(hash);
    if (existing) return { kind: "document", importId: num(existing.id), duplicate: true, datasetType: "document", casesCreated: [], requeued: 0 };
    let text: string;
    let mime: string;
    try {
      ({ text, mime } = await extractDocumentText(input.filename, input.buffer));
    } catch (err) {
      throw new OpsError(400, `Không trích xuất được nội dung: ${err instanceof Error ? err.message : String(err)}`, "file_unreadable");
    }
    const flags = scanUntrusted(text);
    const simulated = isSimulated([text.slice(0, 200)], input.filename);
    const now = nowIso();
    const imp = this.db
      .prepare("INSERT INTO imports (dataset_type, source, filename, sha256, idempotency_key, received_at, simulated, rows_total, rows_accepted, quality_json, workflow_id) VALUES ('document', 'file', ?, ?, ?, ?, ?, 0, 0, ?, ?)")
      .run(input.filename, hash, input.idempotencyKey ?? null, now, simulated ? 1 : 0, JSON.stringify({ flags }), input.workflowId ?? null);
    const importId = num(imp.lastInsertRowid);
    this.db
      .prepare("INSERT INTO documents (workflow_id, doc_key, version, title, kind, source, mime, content, sha256, import_id, created_at, flags_json) VALUES (?, ?, 1, ?, 'upload', 'upload', ?, ?, ?, ?, ?, ?)")
      .run(input.workflowId ?? null, `UPLOAD/${hash.slice(0, 16)}`, input.filename, mime, text, hash, importId, now, JSON.stringify(flags));
    this.orch.emit({
      type: "review.intake",
      label: L(this.cfg)(`tiếp nhận tài liệu "${input.filename}"${flags.length ? ` — CẢNH BÁO: có câu dạng mệnh lệnh (${flags.join(", ")}), xử lý như dữ liệu` : ""}`, `received document "${input.filename}"${flags.length ? ` — WARNING: instruction-like sentences (${flags.join(", ")}), treated as data` : ""}`),
      source: "import",
      workflowId: input.workflowId ?? null,
      agentId: "ops_agent",
      room: "zone_ops",
    });
    const requeued = this.orch.onDocumentUploaded(`document#${importId}`);
    return { kind: "document", importId, duplicate: false, datasetType: "document", casesCreated: [], requeued, flags };
  }

  /** Load a sample set from a directory with manifest.json {"base": [...], "supplements": [...]} */
  async loadSample(dir: string, set: "base" | "supplements" = "base", only?: string, actor?: Identity): Promise<Array<{ file: string; outcome?: ImportOutcome; error?: string }>> {
    // Bundled SIMULATED set: one permission for the whole set (never in production)
    const who = this.allow("data.sample", actor);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8")) as Record<string, string[]>;
    const files = (manifest[set] ?? []).filter((f) => !only || f === only);
    const results: Array<{ file: string; outcome?: ImportOutcome; error?: string }> = [];
    for (const f of files) {
      try {
        const outcome = await this.importFile({ filename: path.basename(f), buffer: fs.readFileSync(path.join(dir, f)), actor: who }, who);
        results.push({ file: f, outcome });
      } catch (err) {
        results.push({ file: f, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return results;
  }

  /** Demo/test only: wipe workflow data (audit_log is kept). Never available in production. */
  reset(actor?: Identity): void {
    const who = this.allow("admin.reset", actor);
    if (this.orch.busy) throw new OpsError(409, "Đang có task chạy — thử lại sau vài giây", "busy");
    for (const t of ["llm_calls", "outbox", "decisions", "events", "documents", "task_runs", "tasks", "case_revisions", "handoffs", "reservation_events", "reservations", "translations", "workflows", "calcs", "data_rows", "imports", "settings"]) {
      this.db.exec(`DELETE FROM ${t}`);
    }
    audit(this.db, who, "admin.reset", "all", {});
  }

  // ── commands ──

  decide(input: Parameters<Orchestrator["decide"]>[0]) {
    const r = this.orch.decide(input);
    this.orch.tick();
    return r;
  }

  retry(taskId: number, actor?: Identity): void {
    const who = this.allow("task.retry", actor);
    this.orch.retry(taskId, `${who.name}${who.source === "demo" ? " [DEMO]" : ""}`);
    audit(this.db, who, "task.retry", `task#${taskId}`, {});
    this.orch.tick();
  }

  setFault(agentId: string, count: number, actor?: Identity): void {
    const who = this.allow("admin.fault", actor);
    if (!AGENT_INFO.has(agentId as AgentId)) throw new OpsError(400, `Không có agent ${agentId}`, "invalid_input", { field: "agentId" });
    if (!Number.isInteger(count) || count < 0 || count > 10) throw new OpsError(400, "count phải là số nguyên 0–10", "invalid_input", { field: "count" });
    this.orch.setFault(agentId, count);
    audit(this.db, who, "admin.fault", agentId, { count });
    this.orch.emit({ type: "system.fault", label: `Bật lỗi giả lập cho ${agentId} (${count} lần) — phục vụ kiểm thử`, source: "user" });
  }

  /**
   * Approve sending ONE outbound draft. Requires: server-resolved identity with an
   * allowed role, workflow approved, draft still in "draft", and the exact draft
   * version (docId + sha256) the approver saw. Reports success only if the row
   * was actually updated. Nothing is dispatched — no outbound adapter exists.
   */
  approveOutbox(input: { id: number; docId: number; docSha256: string; actor: Identity }): { status: string; duplicate: boolean } {
    const actor = input.actor;
    if (!actor?.userId) throw new OpsError(401, "Chưa xác định danh tính người duyệt gửi (phía server)", "identity_missing");
    // Approving an outbound item is a person's act — never an integration/service credential
    if (actor.source !== "demo" && actor.source !== "enterprise") throw new OpsError(403, "Duyệt gửi phải do người thực hiện — credential tích hợp (service) không được phép", "person_required");
    if (this.orch.operatingMode === "production" && actor.source !== "enterprise") {
      throw new OpsError(403, "Chế độ vận hành thật yêu cầu danh tính doanh nghiệp đã xác thực; danh tính demo bị từ chối", "demo_identity_refused");
    }
    const row = this.db.prepare("SELECT * FROM outbox WHERE id = ?").get(input.id);
    if (!row) throw new OpsError(404, "Không có mục outbox", "not_found", { what: "outbox", id: input.id });
    const wf = this.orch.workflow(num(row.workflow_id));
    // Action level: RFQ needs the approved scope; PR/booking need the commitment approval
    const requiredGate = (row.required_gate as string | null) ?? "gate.asset";
    const gateTask = this.orch.tasks(wf.id).get(requiredGate);
    if (row.case_revision === null || row.case_revision === undefined) {
      if (wf.status !== "approved") throw new OpsError(409, `Case ${wf.case_no} chưa ở trạng thái đã duyệt (hiện: ${wf.status})`, "case_not_approved", { caseNo: wf.case_no, status: wf.status });
    } else {
      if (wf.status !== "open" && wf.status !== "approved") throw new OpsError(409, `Case ${wf.case_no} đã kết thúc (${wf.status})`, "case_closed", { caseNo: wf.case_no, status: wf.status });
      if (num(row.case_revision) !== wf.version) throw new OpsError(409, `Bản nháp thuộc case rev ${row.case_revision}, case đã sang rev ${wf.version} — không duyệt gửi phiên bản cũ`, "revision_moved", { caseNo: wf.case_no, current: wf.version, sent: num(row.case_revision) });
      if (gateTask?.status !== "done") {
        throw new OpsError(409, `"${row.title}" cần ${requiredGate === "gate.technical" ? "phạm vi đã được duyệt" : "cam kết chi đã được duyệt"} (bước ${gateTask?.title ?? requiredGate} hiện: ${gateTask?.status ?? "—"})`, "prerequisite_gate", { gate: requiredGate, step: requiredGate });
      }
    }
    const doc = this.db.prepare("SELECT id, sha256 FROM documents WHERE id = ?").get(num(row.doc_id));
    const expectedSha = (row.doc_sha256 as string | null) ?? (doc?.sha256 as string | undefined);
    if (!input.docSha256 || num(row.doc_id) !== input.docId || expectedSha !== input.docSha256 || doc?.sha256 !== expectedSha) {
      throw new OpsError(409, "Phiên bản bản nháp không khớp với bản đang chờ duyệt gửi — tải lại để xem bản mới", "draft_version_mismatch");
    }
    const finalRole = gateTask ? ((this.orch.currentOutput(gateTask)?.facts.role as string | undefined) ?? null) : null;
    const allowedNames = Array.from(new Map([...this.cfg.approvals.outboxRoles, ...(finalRole ? [finalRole] : [])].map((r) => [r.trim().toLowerCase(), r.trim()])).values());
    const allowed = new Set(allowedNames.map((r) => r.toLowerCase()));
    const role = actor.roles.find((r) => allowed.has(r.trim().toLowerCase()));
    if (!role) throw new OpsError(403, `Duyệt gửi cần một trong các vai trò: ${allowedNames.join(", ")}; ${actor.name} có: ${actor.roles.join(", ") || "—"}`, "role_required", { roles: allowedNames.join(" / ") });
    if (row.status === "approved_to_send") {
      if (row.approved_by_id === actor.userId) return { status: "approved_to_send", duplicate: true };
      throw new OpsError(409, `Mục này đã được duyệt gửi bởi ${row.approved_by} lúc ${row.approved_at}`, "already_approved", { by: String(row.approved_by), at: String(row.approved_at) });
    }
    if (row.status !== "draft") throw new OpsError(409, `Mục ở trạng thái ${row.status} — không duyệt được`, "invalid_state", { status: String(row.status) });
    const now = nowIso();
    // Commitment-level drafts re-check the holds behind them at the time of approval. The check and
    // the status write run in ONE write transaction (BEGIN IMMEDIATE) — nothing can change in between.
    const commitment = row.kind === "vessel_booking" || row.kind === "purchase_requisition";
    const result = tx(this.db, () => {
      if (commitment) {
        const rv = this.orch.revalidate(wf, "outbox");
        if (rv.reasons.length) return { stale: rv, changes: 0 };
      }
      const r = this.db
        .prepare("UPDATE outbox SET status = 'approved_to_send', approved_by = ?, approved_by_id = ?, approved_role = ?, identity_source = ?, approved_at = ?, dispatch_note = ? WHERE id = ? AND status = 'draft' AND doc_id = ?")
        .run(`${actor.name}${actor.source === "demo" ? " [DEMO]" : ""}`, actor.userId, role, actor.source, now, "Đã duyệt gửi. Chưa có adapter gửi ra ngoài — gửi thủ công qua kênh chính thức.", input.id, input.docId);
      return { stale: null, changes: num(r.changes) };
    });
    if (result.stale) {
      this.orch.invalidate(wf.id, result.stale.restart, result.stale.reasons);
      throw new OpsError(409, `Không duyệt gửi "${row.title}": ${result.stale.reasons.join("; ")}. Kế hoạch được lập lại; bản nháp này sẽ được thay.`, "plan_stale");
    }
    const res = { changes: result.changes };
    if (num(res.changes) !== 1) throw new OpsError(409, "Không cập nhật được mục outbox (trạng thái vừa thay đổi) — không ghi nhận duyệt gửi", "concurrent_update");
    this.orch.emit({ type: "message.approved", label: `${actor.name}${actor.source === "demo" ? " [DEMO]" : ""} (${role}) duyệt gửi "${row.title}" → ${row.recipient}`, source: "user", workflowId: wf.id, agentId: "ops_agent", room: "zone_ops" });
    return { status: "approved_to_send", duplicate: false };
  }

  trace(ref: TraceRef): TraceView {
    try {
      return resolveTrace(this.db, ref);
    } catch (err) {
      throw new OpsError(404, err instanceof Error ? err.message : String(err), "not_found", { what: ref.kind, id: String(ref.id) });
    }
  }

  // ── read models ──

  private taskSummary(t: TaskRow) {
    const out = this.orch.currentOutput(t);
    const step = STEP_MAP.get(t.key);
    const nowTs = now().toISOString();
    const active = !["done", "skipped", "cancelled"].includes(t.status);
    return {
      id: t.id,
      key: t.key,
      title: t.title,
      agentId: t.agent_id,
      status: t.status,
      note: t.status_note,
      attempts: t.attempts,
      deps: step?.deps ?? [],
      gate: !!step?.gate,
      phase: step?.phase ?? "",
      updatedAt: t.updated_at,
      summary: out?.summary ?? null,
      mode: out?.mode ?? null,
      gateFacts: step?.gate && t.status === "awaiting_approval" ? out?.facts ?? null : null,
      blocking: out?.missingData.filter((m) => m.blocking).map((m) => m.description) ?? [],
      waitKind: (t.wait_kind as WaitKind | null) ?? null,
      waitLabel: t.wait_kind ? WAIT_KIND_LABEL[t.wait_kind as WaitKind] : null,
      owner: t.owner ?? step?.owner ?? null,
      dueAt: active ? (t.due_at ?? null) : null,
      overdue: active && !!t.due_at && t.due_at < nowTs,
      caseRevision: t.case_revision ?? null,
      waiting: out?.waiting ?? null,
    };
  }

  /** What each case is waiting for, who holds it, and the next step — for the action list and the 3D panels. */
  /** `key` is a stable code (step key, or closed/rejected/cancelled/none) the interface renders per language. */
  private caseStage(tasks: ReturnType<OpsService["taskSummary"]>[], status: string): { phase: string; holder: string | null; next: string | null; key: string } {
    if (status === "closed") return { phase: "Đã đóng", holder: null, next: null, key: "closed" };
    if (status === "rejected" || status === "cancelled") return { phase: status === "rejected" ? "Bị từ chối" : "Đã hủy", holder: null, next: null, key: status };
    const order = WORKFLOW_STEPS.map((s) => s.key);
    const live = tasks.filter((t) => !["done", "skipped", "cancelled"].includes(t.status)).sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    const cur = live.find((t) => t.status !== "pending") ?? live[0];
    if (!cur) return { phase: "—", holder: null, next: null, key: "none" };
    return { phase: cur.phase, holder: cur.owner, next: cur.title, key: cur.key };
  }

    state() {
    expireHolds(this.db);
    const workflows = (this.db.prepare("SELECT * FROM workflows ORDER BY id DESC").all() as unknown as WorkflowRow[]).map((wf) => {
      const tasks = [...this.orch.tasks(wf.id).values()].map((t) => this.taskSummary(t));
      const stage = this.caseStage(tasks, wf.status);
      const proposal = tasks.find((t) => t.key === "ops.proposal");
      const branch = wf.branch ?? ((proposal && proposal.status === "done" ? (this.orch.currentOutput(this.orch.task(proposal.id))?.facts.branch as string | undefined) : undefined) ?? null);
      return {
        id: wf.id,
        caseNo: wf.case_no,
        title: wf.title,
        well: wf.well,
        platform: wf.platform,
        wellKey: wf.well_key ?? `${wf.platform}/${wf.well}`,
        status: wf.status,
        version: wf.version,
        priority: wf.priority ?? "P3",
        branch,
        branchLabel: branch ? (BRANCH_LABEL[branch] ?? branch) : null,
        stage: stage.phase,
        stageKey: stage.key,
        holder: stage.holder,
        nextStep: stage.next,
        closure: wf.closure_json ? JSON.parse(wf.closure_json) : null,
        createdAt: wf.created_at,
        updatedAt: wf.updated_at,
        simulated: !!wf.simulated,
        progress: { done: tasks.filter((t) => t.status === "done" || t.status === "skipped").length, total: tasks.length },
        tasks,
      };
    });
    const isActiveWf = (st: string) => st === "open" || st === "approved";
    const openTasks = workflows.filter((w) => isActiveWf(w.status)).flatMap((w) => w.tasks.map((t) => ({ ...t, workflowId: w.id, caseNo: w.caseNo, priority: w.priority })));
    const lastRoom = new Map<string, string>();
    for (const e of this.db.prepare("SELECT agent_id, room FROM events WHERE room IS NOT NULL AND agent_id IS NOT NULL ORDER BY ts DESC, rowid DESC LIMIT 2000").all()) {
      if (!lastRoom.has(e.agent_id as string)) lastRoom.set(e.agent_id as string, e.room as string);
    }
    // Attention is a projection of what is still pending in the DATABASE, across all
    // open cases — never cleared by ordinary events/log lines.
    const agents = AGENT_DIRECTORY.map((a) => {
      const mine = openTasks.filter((t) => t.agentId === a.id);
      const items = mine
        .filter((t) => ["missing_data", "error", "awaiting_approval", "waiting"].includes(t.status))
        .map((t) => ({
          workflowId: t.workflowId,
          caseNo: t.caseNo,
          taskId: t.id,
          key: t.key,
          waitKind: t.waitKind,
          status: t.status,
          label:
            t.status === "awaiting_approval"
              ? `Chờ duyệt: ${t.title} (${t.caseNo})`
              : t.status === "error"
                ? `Lỗi ${t.caseNo}: ${t.note ?? ""}`
                : t.status === "waiting"
                  ? `${t.waitLabel ?? "Đang chờ"} ${t.caseNo}: ${t.note ?? ""}`
                  : `Thiếu dữ liệu ${t.caseNo}: ${t.blocking.join(" | ")}`,
        }));
      const handoffs = this.db
        .prepare(
          `SELECT h.*, w.case_no FROM handoffs h JOIN workflows w ON w.id = h.workflow_id WHERE w.status IN ('open','approved') AND h.status IN ('offered','accepted') AND (h.from_agent = ? OR h.to_agent = ?) ORDER BY h.id DESC LIMIT 12`,
        )
        .all(a.id, a.id);
      return {
        ...a,
        location: lastRoom.get(a.id) ?? a.room,
        current: mine.find((t) => t.status === "running") ?? null,
        attention: items.length
          ? { status: items[0].status, label: items.length > 1 ? `${items.length} việc chờ xử lý: ${items.map((i) => i.caseNo).join(", ")}` : items[0].label, items }
          : null,
        queue: mine.filter((t) => !["done", "cancelled", "skipped"].includes(t.status)).length,
        holding: mine.filter((t) => !["done", "cancelled", "skipped", "pending"].includes(t.status)).map((t) => ({ taskId: t.id, key: t.key, caseNo: t.caseNo, workflowId: t.workflowId, title: t.title, status: t.status, waitKind: t.waitKind, waitLabel: t.waitLabel, note: t.note, dueAt: t.dueAt, overdue: t.overdue })),
        handoffs: handoffs.map((h) => ({
          id: num(h.id),
          caseNo: String(h.case_no),
          direction: h.to_agent === a.id ? "in" : "out",
          from: String(h.from_key),
          to: String(h.to_key),
          toAgent: String(h.to_agent),
          request: String(h.request),
          status: String(h.status),
          dueAt: (h.due_at as string) ?? null,
          artifactVersion: h.artifact_version === null ? null : num(h.artifact_version),
        })),
      };
    });
    // Action list: everything a person/unit must act on, priority first, overdue first
    const PRI: Record<string, number> = { P1: 1, P2: 2, P3: 3 };
    const actionList = openTasks
      .filter((t) => ["awaiting_approval", "missing_data", "error", "waiting"].includes(t.status))
      .map((t) => ({
        workflowId: t.workflowId,
        caseNo: t.caseNo,
        priority: t.priority,
        taskId: t.id,
        key: t.key,
        title: t.title,
        status: t.status,
        waitKind: t.waitKind ?? (t.status === "awaiting_approval" ? "approval" : t.status === "missing_data" ? "data" : t.status === "error" ? "system" : null),
        waitLabel: t.waitLabel ?? (t.status === "awaiting_approval" ? "Chờ phê duyệt" : t.status === "missing_data" ? "Thiếu dữ liệu" : t.status === "error" ? "Lỗi hệ thống" : "Đang chờ"),
        owner: t.owner,
        dueAt: t.dueAt,
        overdue: t.overdue,
        note: t.status === "missing_data" ? t.blocking.join(" | ") : t.note,
      }))
      .sort((x, y) => Number(y.overdue) - Number(x.overdue) || (PRI[x.priority] ?? 3) - (PRI[y.priority] ?? 3) || String(x.dueAt ?? "~").localeCompare(String(y.dueAt ?? "~")));
    const imports = this.db.prepare("SELECT * FROM imports ORDER BY id DESC LIMIT 60").all().map((i) => ({
      id: num(i.id),
      datasetType: i.dataset_type as string,
      label: (DATASET_MAP.get(i.dataset_type as string)?.label ?? (i.dataset_type === "document" ? "Tài liệu" : i.dataset_type)) as string,
      filename: i.filename as string,
      source: i.source as string,
      receivedAt: i.received_at as string,
      simulated: !!num(i.simulated),
      rowsTotal: num(i.rows_total),
      rowsAccepted: num(i.rows_accepted),
      quality: JSON.parse(i.quality_json as string),
    }));
    const datasetCounts = Object.fromEntries(
      DATASETS.map((d) => [d.type, num(this.db.prepare("SELECT COUNT(*) c FROM data_rows WHERE dataset_type = ? AND status = 'active'").get(d.type)!.c)]),
    );
    const simRows = num(this.db.prepare("SELECT COUNT(*) c FROM data_rows r JOIN imports i ON i.id = r.import_id WHERE r.status = 'active' AND i.simulated = 1").get()!.c);
    const realRows = num(this.db.prepare("SELECT COUNT(*) c FROM data_rows r JOIN imports i ON i.id = r.import_id WHERE r.status = 'active' AND i.simulated = 0").get()!.c);
    const simulatedActive = simRows > 0;
    const dataSource = { kind: simRows && realRows ? "mixed" : simRows ? "simulated" : realRows ? "real" : "none", simulatedRows: simRows, realRows };
    return {
      mode: this.modeInfo(),
      /** Business time zone (ops-config calendar.timeZone) — the interface shows instants in it, whatever the viewer's language. */
      businessTimeZone: this.cfg.calendar.timeZone,
      /** Language rule-generated content is written in (config content.language) — the client only labels content as "original in Vietnamese" when it is. */
      contentLanguage: contentLanguage(this.cfg),
      operatingMode: this.orch.operatingMode,
      simulatedData: simulatedActive,
      dataSource,
      agents,
      workflows,
      approvals: openTasks.filter((t) => t.status === "awaiting_approval"),
      actionList,
      reservations: this.db
        .prepare("SELECT r.*, w.case_no, w.version AS wf_version FROM reservations r JOIN workflows w ON w.id = r.workflow_id ORDER BY r.status = 'held' DESC, r.id DESC LIMIT 60")
        .all(),
      policy: { version: this.cfg.policy.version, source: this.cfg.policy.source, rules: configVersion(this.cfg) },
      imports,
      datasetCounts,
      outbox: this.db.prepare("SELECT * FROM outbox ORDER BY id DESC").all(),
      events: this.db.prepare("SELECT * FROM events ORDER BY ts DESC, rowid DESC LIMIT 80").all(),
      steps: WORKFLOW_STEPS.map((s) => ({ key: s.key, title: s.title, agent: s.agent, deps: s.deps, gate: !!s.gate, depMode: s.depMode ?? "done", hasCondition: !!s.condition || !!s.applies, owner: s.owner, phase: s.phase, accept: s.accept })),
      serverTime: nowIso(),
    };
  }

  workflowDetail(id: number) {
    const wf = this.orch.workflow(id);
    const tasks = [...this.orch.tasks(id).values()].map((t) => {
      const runs = this.db.prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY id DESC").all(t.id).map((r) => ({
        id: num(r.id),
        attempt: num(r.attempt),
        status: r.status as string,
        startedAt: r.started_at as string,
        finishedAt: (r.finished_at as string) ?? null,
        mode: r.mode as string,
        superseded: !!num(r.superseded),
        error: (r.error as string) ?? null,
        inputs: JSON.parse((r.inputs_json as string) || "[]") as TraceRef[],
        output: r.output_json ? (JSON.parse(r.output_json as string) as AgentOutput) : null,
      }));
      return { ...this.taskSummary(t), feedback: (this.db.prepare("SELECT feedback_json FROM tasks WHERE id = ?").get(t.id)?.feedback_json as string) ?? null, runs };
    });
    return {
      workflow: { ...wf, detection: JSON.parse(wf.detection_json) },
      tasks,
      documents: this.db.prepare("SELECT id, doc_key, version, title, kind, source, sha256, created_at, task_run_id FROM documents WHERE workflow_id = ? ORDER BY doc_key, version").all(id),
      decisions: this.db.prepare("SELECT * FROM decisions WHERE workflow_id = ? ORDER BY id").all(id),
      events: this.db.prepare("SELECT * FROM events WHERE workflow_id = ? ORDER BY ts, rowid").all(id),
      outbox: this.db.prepare("SELECT * FROM outbox WHERE workflow_id = ?").all(id),
      revisions: revisions(this.db, id),
      snapshot: latestSnapshot(this.db, id),
      handoffs: this.db.prepare("SELECT * FROM handoffs WHERE workflow_id = ? ORDER BY id DESC").all(id),
      reservations: caseReservations(this.db, id),
      reservationEvents: this.db.prepare("SELECT id, reservation_id, ts, kind, from_revision, to_revision, content_sha, actor, detail_json FROM reservation_events WHERE workflow_id = ? ORDER BY id").all(id),
    };
  }

  /**
   * A responsible person records the execution of an approved activity (never an agent/LLM).
   * Stored as a work_execution row with the server-side identity as the confirmer.
   */
  recordExecution(input: { workflowId: number; activityType: string; status: "done" | "partial" | "not_done"; completedDate: string; findings?: string; resultRef?: string; actor: Identity }): ImportOutcome {
    const actor = this.allow("execution.record", input.actor ?? (null as unknown as Identity));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.completedDate))) throw new OpsError(400, "completedDate phải có dạng YYYY-MM-DD", "invalid_input", { field: "completedDate" });
    const wf = this.orch.workflow(input.workflowId);
    if (wf.status !== "open" && wf.status !== "approved") throw new OpsError(409, `Case ${wf.case_no} đã kết thúc`, "case_closed", { caseNo: wf.case_no, status: wf.status });
    const tasks = this.orch.tasks(wf.id);
    if (tasks.get("gate.readiness")?.status !== "done") throw new OpsError(409, "Chưa có xác nhận sẵn sàng — chưa thể ghi nhận thực hiện", "readiness_missing");
    const prop = this.orch.currentOutput(tasks.get("ops.proposal")!);
    const acts = (prop?.facts.activities as Array<{ type: string }> | undefined) ?? [];
    if (!acts.some((a) => a.type === input.activityType)) throw new OpsError(400, `Hoạt động ${input.activityType} không thuộc phạm vi đã duyệt`, "activity_out_of_scope", { activity: input.activityType });
    if (!["done", "partial", "not_done"].includes(input.status)) throw new OpsError(400, "status phải là done/partial/not_done", "invalid_input", { field: "status" });
    if (input.status === "done" && !(input.findings?.trim() || input.resultRef?.trim())) throw new OpsError(400, "Ghi nhận hoàn tất cần ghi kết quả/phát hiện hoặc mã tài liệu kết quả", "findings_required");
    audit(this.db, actor, "execution.record", `${wf.case_no}:${input.activityType}`, { status: input.status, completedDate: input.completedDate });
    return this.importRecords({
      actor: { ...actor, roles: [...actor.roles, ...(this.cfg.permissions.importByDataset.work_execution ?? [])] },
      datasetType: "work_execution",
      rows: [
        {
          platform: wf.platform,
          well: wf.well,
          activity_type: input.activityType,
          case_no: wf.case_no,
          status: input.status,
          completed_date: input.completedDate,
          findings: input.findings ?? "",
          result_ref: input.resultRef ?? "",
          confirmed_by: `${actor.name}${actor.source === "demo" ? " [DEMO]" : ""}`,
          confirmed_role: actor.roles.join(", "),
        },
      ],
      source: `manual:${actor.userId}`,
      simulated: !!wf.simulated,
      idempotencyKey: `exec:${wf.id}:${input.activityType}:${input.completedDate}:${input.status}:${actor.userId}`,
    });
  }

  /**
   * A person records that the external owner confirmed EXACTLY the content shown
   * (resource, quantity, case revision) under an external reference. No booking is
   * made by the system. Authorization, case state and content are checked here, in the core.
   */
  confirmReservation(input: { id: number; externalRef: string; quantity: number; caseRevision: number; actor: Identity; idempotencyKey?: string }): { duplicate: boolean } {
    const row = this.db.prepare("SELECT r.*, w.status AS wf_status, w.version AS wf_version, w.case_no FROM reservations r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ?").get(input.id);
    if (!row) throw new OpsError(404, `Không có giữ chỗ #${input.id}`, "not_found", { what: "reservation", id: input.id });
    const who = this.allow("reservation.confirm", input.actor ?? (null as unknown as Identity), { resourceType: String(row.resource_type) });
    if (row.wf_status !== "open" && row.wf_status !== "approved") throw new OpsError(409, `Case ${row.case_no} đã kết thúc (${row.wf_status}) — không xác nhận đặt chỗ mới`, "case_closed", { caseNo: String(row.case_no), status: String(row.wf_status) });
    const ref = String(input.externalRef ?? "").trim();
    if (!/^[\w.:/#-]{2,64}$/.test(ref)) throw new OpsError(400, "Mã xác nhận bên ngoài không hợp lệ (2–64 ký tự chữ/số/.:/#-)", "bad_external_ref");
    if (!Number.isFinite(Number(input.quantity)) || !Number.isInteger(Number(input.caseRevision))) throw new OpsError(400, "Cần quantity và caseRevision đúng nội dung đang xác nhận", "invalid_input", { field: "quantity/caseRevision" });
    const wfId = num(row.workflow_id);
    const idem = input.idempotencyKey?.trim() || undefined;
    const requestHash = sha256(JSON.stringify({ a: "confirm", id: input.id, ref, q: Number(input.quantity), r: Number(input.caseRevision), u: who.userId }));
    // The form must be for the CURRENT case revision (checked again inside the transaction below)
    if (Number(input.caseRevision) !== num(row.wf_version)) {
      if (idem) {
        const prev = this.db.prepare("SELECT request_hash FROM reservation_events WHERE idempotency_key = ?").get(idem);
        if (prev && prev.request_hash === requestHash) return { duplicate: true };
      }
      throw new OpsError(409, `Case ${row.case_no} đã sang rev ${row.wf_version} (form xác nhận gửi rev ${input.caseRevision}) — tải lại, kiểm tra nội dung kế hoạch hiện hành rồi xác nhận`, "revision_moved", { caseNo: String(row.case_no), current: num(row.wf_version), sent: input.caseRevision });
    }
    const out = confirmExternal(this.db, {
      id: input.id,
      externalRef: ref,
      quantity: Number(input.quantity),
      revision: Number(input.caseRevision),
      actor: `${who.name}${who.source === "demo" ? " [DEMO]" : ""}`,
      idempotencyKey: idem,
      requestHash,
      carryForward: (r) => {
        // Inside the transaction: re-read the revision and what the plan in force needs
        const cur = num(this.db.prepare("SELECT version FROM workflows WHERE id = ?").get(wfId)!.version);
        if (cur !== Number(input.caseRevision)) return { ok: false, reason: `case vừa sang rev ${cur}` };
        const need = this.orch.planNeeds(wfId, r);
        if (need.status !== "done") return { ok: false, reason: `kế hoạch (${need.step}) của rev ${cur} đang được lập lại (${need.status})` };
        if (!need.demand) return { ok: false, reason: need.keyNeeded ? `kế hoạch hiện hành cần nội dung khác cho ${r.resource_key}` : `kế hoạch hiện hành không còn cần ${r.resource_key}` };
        return { ok: true, evidence: { step: need.step, planRunId: need.demand.runId, demand: { key: need.demand.key, qty: need.demand.qty, unit: need.demand.unit, date: need.demand.date ?? null } } };
      },
    });
    if (!out.duplicate) {
      audit(this.db, who, "reservation.confirm", `reservation#${input.id}`, { resource: `${row.resource_type}:${row.resource_key}`, quantity: input.quantity, revision: input.caseRevision, externalRef: ref });
      this.orch.emit({ type: "resource.confirmed", label: `Xác nhận đặt chỗ ${row.resource_key} ${input.quantity} ${row.unit} (${ref}, rev ${input.caseRevision})`, source: "user", workflowId: wfId, agentId: "logistics_agent", room: "zone_logistics" , msg: { key: "ev.resource.confirmed", params: { key: String(row.resource_key), quantity: input.quantity, unit: String(row.unit), ref, rev: input.caseRevision } } });
      // Readiness reads the ledger: rebuild its package so the gate shows the confirmation (no new revision)
      const t = this.orch.tasks(wfId);
      // (a run in progress sees the ledger change as drift and re-runs by itself)
      if (row.resource_type !== "budget" && ["done", "missing_data"].includes(t.get("hse.readiness")?.status ?? "")) {
        this.orch.refresh(wfId, ["hse.readiness"], `Đã ghi xác nhận booking ${row.resource_key} (${ref}) — cập nhật hồ sơ sẵn sàng`);
      }
    }
    return out;
  }

  /**
   * A person records that the external owner cancelled a confirmed booking (frees capacity).
   * If the plan in force still needs that booking, the owning step (log.plan / fin.check) and
   * everything downstream (package, gates, Outbox) become stale at once — new revision, reason
   * recorded — instead of waiting for a data import. The system never cancels anything outside.
   */
  // ── translations of business content (on demand, separate from the original) ──

  private static translationTarget(kind: unknown, id: unknown, lang: unknown): { kind: SourceKind; id: number; target: TargetLang } {
    if (kind !== "document" && kind !== "task_run") throw new OpsError(400, "kind phải là document hoặc task_run", "invalid_input", { field: "kind" });
    if (!Number.isInteger(Number(id))) throw new OpsError(400, "id không hợp lệ", "invalid_input", { field: "id" });
    if (lang !== "en" && lang !== "vi") throw new OpsError(400, "Ngôn ngữ đích phải là en hoặc vi", "invalid_input", { field: "targetLang" });
    return { kind, id: Number(id), target: lang };
  }

  private static translationError(err: unknown): never {
    if (err instanceof TranslationError) throw new OpsError(err.status, err.message, err.code);
    throw err;
  }

  /** Read-only: the stored translation (if any) with stale/superseded flags. Never calls the LLM. */
  translation(kind: unknown, id: unknown, lang: unknown): TranslationView {
    const t = OpsService.translationTarget(kind, id, lang);
    try {
      return translationView(this.db, t.kind, t.id, t.target);
    } catch (err) {
      return OpsService.translationError(err);
    }
  }

  /**
   * Explicit request by a person: translate with the configured Claude API (billed), or return the
   * cached translation for the same source hash. Without a usable LLM client → 503
   * translation_unavailable; the original is shown unchanged. No workflow state is touched.
   */
  async requestTranslation(input: { kind: unknown; id: unknown; targetLang: unknown; actor: Identity; force?: boolean }): Promise<{ view: TranslationView; cached: boolean }> {
    const t = OpsService.translationTarget(input.kind, input.id, input.targetLang);
    const who = this.allow("translation.create", input.actor ?? (null as unknown as Identity));
    const client = this.orch.llm;
    if (!client || this.modeInfo().effective !== "llm") {
      throw new OpsError(503, "Chưa có bản dịch: Claude API chưa được bật/cấu hình hoặc đang lỗi — hiển thị bản gốc", "translation_unavailable");
    }
    let out: { row: TranslationRow; cached: boolean };
    try {
      out = await translateSource(this.db, client, { kind: t.kind, id: t.id, target: t.target, actor: who.name, maxTokens: this.cfg.runtime.llm.translationMaxTokens, force: !!input.force });
    } catch (err) {
      return OpsService.translationError(err);
    }
    if (!out.cached) audit(this.db, who, "translation.create", `${t.kind}#${t.id}`, { target: t.target, translationId: out.row.id, sourceSha: out.row.sourceSha, status: out.row.status });
    return { view: translationView(this.db, t.kind, t.id, t.target), cached: out.cached };
  }

  reviewTranslation(input: { id: unknown; verdict: unknown; actor: Identity; note?: string }): TranslationRow {
    const who = this.allow("translation.review", input.actor ?? (null as unknown as Identity));
    if (input.verdict !== "reviewed" && input.verdict !== "rejected") throw new OpsError(400, "verdict phải là reviewed hoặc rejected", "invalid_input", { field: "verdict" });
    try {
      const row = reviewTranslation(this.db, Number(input.id), input.verdict, who.name, input.note);
      audit(this.db, who, "translation.review", `translation#${row.id}`, { verdict: input.verdict, sourceSha: row.sourceSha });
      return row;
    } catch (err) {
      return OpsService.translationError(err);
    }
  }

  recordReservationCancelled(input: { id: number; externalRef: string; actor: Identity; idempotencyKey?: string }): { duplicate: boolean } {
    const row = this.db.prepare("SELECT r.*, w.status AS wf_status, w.case_no FROM reservations r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ?").get(input.id);
    if (!row) throw new OpsError(404, `Không có giữ chỗ #${input.id}`, "not_found", { what: "reservation", id: input.id });
    const who = this.allow("reservation.cancel", input.actor ?? (null as unknown as Identity), { resourceType: String(row.resource_type) });
    const ref = String(input.externalRef ?? "").trim();
    if (!/^[\w.:/#-]{2,64}$/.test(ref)) throw new OpsError(400, "Mã hủy bên ngoài không hợp lệ", "bad_external_ref");
    const idem = input.idempotencyKey?.trim() || undefined;
    const requestHash = sha256(JSON.stringify({ a: "cancel", id: input.id, ref, u: who.userId }));
    const wfId = num(row.workflow_id);
    const needed = this.orch.planNeeds(wfId, row);
    const out = cancelExternal(this.db, { id: input.id, externalRef: ref, actor: `${who.name}${who.source === "demo" ? " [DEMO]" : ""}`, idempotencyKey: idem, requestHash });
    if (out.duplicate) return { duplicate: true };
    audit(this.db, who, "reservation.cancel", `reservation#${input.id}`, { resource: `${row.resource_type}:${row.resource_key}`, cancelRef: ref });
    this.orch.emit({ type: "resource.cancelled", label: `Ghi nhận hủy đặt chỗ ${row.resource_key} (${ref})`, source: "user", workflowId: wfId, agentId: "logistics_agent", room: "zone_logistics" , msg: { key: "ev.resource.cancelled", params: { key: String(row.resource_key), ref } } });
    if ((row.wf_status === "open" || row.wf_status === "approved") && needed.keyNeeded && needed.status === "done") {
      this.orch.invalidate(wfId, [needed.step], [`${row.resource_type} ${row.resource_key}: booking ${row.external_ref ?? ""} đã bị hủy (${ref}) — kế hoạch hiện hành cần nguồn lực này`]);
    }
    return { duplicate: false };
  }
}

export { OpsError };
