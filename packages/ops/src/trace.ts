import type { Database } from "./db";
import { num } from "./db";
import type { TraceRef, AgentOutput } from "./types";
import { DATASET_MAP } from "./datasets";
import { AGENT_INFO } from "./agents";
import type { AgentId } from "./types";

/**
 * Resolve any TraceRef to an inspectable record with links to its own
 * sources — the backbone of "trace every conclusion back to its data".
 */
/** Message key + params next to the original Vietnamese text (the interface renders the key per language). */
export type Msg = { key: string; params?: Record<string, string | number> };
export type FieldKind = "text" | "status" | "datetime" | "code" | "identity" | "decision";

export interface TraceView {
  ref: TraceRef;
  title: string;
  titleMsg?: Msg;
  subtitle?: string;
  subtitleMsgs?: Msg[];
  /** Simulated data source (always shown, in every language) */
  simulated?: boolean;
  /** valueMsg: catalog form of a value the server composes in Vietnamese (other languages render it instead) */
  fields: Array<{ label: string; value: string; key?: string; kind?: FieldKind; valueMsg?: Msg }>;
  table?: { header: string[]; headerKeys?: string[]; rows: Array<Array<string>>; refs?: Array<TraceRef | null>; statusColumn?: number; rowIssues?: Array<IssueMsg[]> };
  body?: string;
  bodyKind?: "markdown" | "text" | "json";
  /** Language the body was produced in (business content is not translated here). */
  bodyLang?: string;
  warnings?: string[];
  warningMsgs?: Array<Msg | null>;
  links: Array<{ label: string; ref: TraceRef; key?: string; params?: Record<string, string | number> }>;
}

/** Data-quality issue: stable code + params (rows imported before params existed have none). */
export type IssueMsg = { code?: string; severity?: string; params?: Record<string, string | number>; message: string };
const issueMsgs = (json: unknown): IssueMsg[] => (JSON.parse(String(json || "[]")) as IssueMsg[]).map((i) => ({ code: i.code, severity: i.severity, params: i.params, message: i.message }));

function runLanguage(db: Database, runId: unknown): string {
  if (runId === null || runId === undefined) return "vi";
  const r = db.prepare("SELECT output_json FROM task_runs WHERE id = ?").get(num(runId));
  try {
    return (r?.output_json ? (JSON.parse(String(r.output_json)) as AgentOutput).language : undefined) ?? "vi";
  } catch {
    return "vi";
  }
}

export function resolveTrace(db: Database, ref: TraceRef): TraceView {
  switch (ref.kind) {
    case "data_row": {
      const r = db.prepare("SELECT * FROM data_rows WHERE id = ?").get(ref.id);
      if (!r) throw new Error("Không tìm thấy dòng dữ liệu");
      const imp = db.prepare("SELECT * FROM imports WHERE id = ?").get(r.import_id)!;
      const data = JSON.parse(r.data_json as string) as Record<string, unknown>;
      const raw = JSON.parse(r.raw_json as string) as Record<string, string>;
      const issues = JSON.parse(r.issues_json as string) as Array<{ severity: string; message: string }>;
      const newer = r.status === "superseded" ? db.prepare("SELECT id FROM data_rows WHERE dataset_type = ? AND row_key = ? AND status = 'active'").get(r.dataset_type, r.row_key) : undefined;
      return {
        ref,
        title: `${DATASET_MAP.get(r.dataset_type as string)?.label ?? r.dataset_type} — dòng ${r.row_no}`,
        titleMsg: { key: "trace.title.data_row", params: { dataset: String(r.dataset_type), rowNo: num(r.row_no) } },
        subtitle: `File "${imp.filename}" · import #${imp.id}${num(imp.simulated) ? " · DỮ LIỆU GIẢ LẬP" : ""}`,
        subtitleMsgs: [{ key: "trace.sub.file", params: { filename: String(imp.filename), id: num(imp.id) } }],
        simulated: !!num(imp.simulated),
        fields: [
          { label: "Trạng thái dòng", value: String(r.status), key: "trace.f.rowStatus", kind: "status" },
          { label: "Khóa", value: String(r.row_key), key: "trace.f.key", kind: "code" },
          { label: "Nhận lúc", value: String(imp.received_at), key: "trace.f.receivedAt", kind: "datetime" },
          { label: "Nguồn", value: `${imp.source} · sha256 ${String(imp.sha256).slice(0, 16)}…`, key: "trace.f.source", kind: "code" },
        ],
        table: {
          header: ["Trường", "Giá trị chuẩn hóa", "Giá trị gốc trong file"],
          headerKeys: ["trace.h.field", "trace.h.normalized", "trace.h.raw"],
          rows: Object.keys(data).map((k) => [k, JSON.stringify(data[k]), raw[k] ?? ""]),
        },
        warnings: issues.map((i) => `[${i.severity}] ${i.message}`),
        warningMsgs: issueMsgs(r.issues_json).map((i) => (i.code && i.params ? { key: `dq.${i.code}`, params: { ...i.params, severity: String(i.severity ?? "") } } : null)),
        links: [
          { label: `Import #${imp.id}: ${imp.filename}`, ref: { kind: "import", id: num(imp.id) }, key: "trace.l.import", params: { id: num(imp.id), filename: String(imp.filename) } },
          ...(newer ? [{ label: "Bản đang dùng thay thế dòng này", ref: { kind: "data_row" as const, id: num(newer.id) }, key: "trace.l.replacement" }] : []),
        ],
      };
    }
    case "import": {
      const imp = db.prepare("SELECT * FROM imports WHERE id = ?").get(ref.id);
      if (!imp) throw new Error("Không tìm thấy import");
      const q = JSON.parse(imp.quality_json as string);
      const rows = db.prepare("SELECT id, row_no, status, row_key, issues_json FROM data_rows WHERE import_id = ? ORDER BY row_no LIMIT 400").all(ref.id);
      return {
        ref,
        title: `Import #${imp.id}: ${imp.filename}`,
        titleMsg: { key: "trace.title.import", params: { id: num(imp.id), filename: String(imp.filename) } },
        subtitle: `${DATASET_MAP.get(imp.dataset_type as string)?.label ?? imp.dataset_type}${num(imp.simulated) ? " · DỮ LIỆU GIẢ LẬP" : ""}`,
        // the "simulated" flag is rendered separately from `simulated`; the dataset name is mapped by the client
        subtitleMsgs: [{ key: "trace.sub.dataset", params: { dataset: String(imp.dataset_type) } }],
        simulated: !!num(imp.simulated),
        fields: [
          { label: "Nguồn", value: String(imp.source), key: "trace.f.source", kind: "code" },
          { label: "sha256", value: String(imp.sha256), key: "trace.f.sha256", kind: "code" },
          { label: "Nhận lúc", value: String(imp.received_at), key: "trace.f.receivedAt", kind: "datetime" },
          { label: "Số dòng", value: `${imp.rows_total} (chấp nhận ${imp.rows_accepted}, loại ${q.rowsRejected ?? 0}, trùng ${q.duplicates ?? 0}, xung đột ${(q.conflicts ?? []).length})`, key: "trace.f.rowCount", valueMsg: { key: "trace.v.rowCount", params: { total: num(imp.rows_total), accepted: num(imp.rows_accepted), rejected: num(q.rowsRejected ?? 0), dup: num(q.duplicates ?? 0), conflicts: (q.conflicts ?? []).length } } },
        ],
        warnings: [...(q.warnings ?? []), ...(q.conflicts ?? []).map((c: { key: string; resolution: string }) => `Xung đột ${c.key}: ${c.resolution}`)],
        warningMsgs: [
          ...(q.warnings ?? []).map((_w: string, i: number) => {
            const item = (q.warningItems ?? [])[i] as { code?: string; params?: Record<string, string | number> } | undefined;
            return item?.code ? { key: `dq.${item.code}`, params: item.params } : null;
          }),
          ...(q.conflicts ?? []).map(() => null),
        ],
        table: {
          header: ["Dòng", "Khóa", "Trạng thái", "Ghi nhận"],
          headerKeys: ["trace.h.row", "trace.h.key", "trace.h.status", "trace.h.notes"],
          rows: rows.map((r) => [String(r.row_no), String(r.row_key), String(r.status), (JSON.parse(r.issues_json as string) as Array<{ message: string }>).map((i) => i.message).join("; ")]),
          refs: rows.map((r) => ({ kind: "data_row" as const, id: num(r.id) })),
          statusColumn: 2,
          rowIssues: rows.map((r) => issueMsgs(r.issues_json)),
        },
        links: [],
      };
    }
    case "calc": {
      const c = db.prepare("SELECT * FROM calcs WHERE id = ?").get(ref.id);
      if (!c) throw new Error("Không tìm thấy phép tính");
      const inputs = JSON.parse(c.inputs_json as string) as Array<{ name: string; value: unknown; unit?: string; ref?: TraceRef }>;
      return {
        ref,
        title: `Phép tính: ${c.label}`,
        titleMsg: { key: "trace.title.calc", params: { label: String(c.label) } },
        fields: [
          { label: "Công thức", value: String(c.formula), key: "trace.f.formula", kind: "code" },
          { label: "Kết quả", value: `${c.result ?? "—"} ${c.unit ?? ""}`, key: "trace.f.result", kind: "code" },
          { label: "Mã phép tính", value: String(c.id), key: "trace.f.calcId", kind: "code" },
        ],
        table: {
          header: ["Đầu vào", "Giá trị", "Đơn vị"],
          headerKeys: ["trace.h.input", "trace.h.value", "trace.h.unit"],
          rows: inputs.map((i) => [i.name, String(i.value ?? "—"), i.unit ?? ""]),
          refs: inputs.map((i) => i.ref ?? null),
        },
        links: [],
      };
    }
    case "document": {
      const d = db.prepare("SELECT * FROM documents WHERE id = ?").get(ref.id);
      if (!d) throw new Error("Không tìm thấy tài liệu");
      const versions = db.prepare("SELECT id, version, created_at FROM documents WHERE doc_key = ? ORDER BY version").all(d.doc_key);
      const flags = JSON.parse(d.flags_json as string) as string[];
      return {
        ref,
        title: `${d.title} (v${d.version})`,
        subtitle: d.source === "upload" ? "Tài liệu tải lên — nội dung là dữ liệu, không phải chỉ dẫn" : "Tài liệu do agent tạo",
        subtitleMsgs: [{ key: d.source === "upload" ? "trace.sub.upload" : "trace.sub.agentDoc" }],
        fields: [
          { label: "Loại", value: String(d.kind), key: "trace.f.kind", kind: "code" },
          { label: "sha256", value: String(d.sha256), key: "trace.f.sha256", kind: "code" },
          { label: "Tạo lúc", value: String(d.created_at), key: "trace.f.createdAt", kind: "datetime" },
          { label: "Các phiên bản", value: versions.map((v) => `v${v.version}`).join(", "), key: "trace.f.versions", kind: "code" },
        ],
        warnings: flags.map((f) => `Phát hiện câu dạng mệnh lệnh: ${f} — đã xử lý như dữ liệu`),
        warningMsgs: flags.map((f) => ({ key: "trace.w.imperative", params: { text: f } })),
        body: String(d.content),
        bodyKind: d.source === "upload" ? "text" : "markdown",
        // Agent documents carry the content language of the run that produced them; uploads keep whatever language the file had
        bodyLang: d.source === "upload" ? undefined : runLanguage(db, d.task_run_id),
        links: [
          ...(d.task_run_id ? [{ label: `Tạo bởi lần chạy #${d.task_run_id}`, ref: { kind: "task_run" as const, id: num(d.task_run_id) }, key: "trace.l.createdBy", params: { id: num(d.task_run_id) } }] : []),
          ...(d.import_id ? [{ label: `Import #${d.import_id}`, ref: { kind: "import" as const, id: num(d.import_id) }, key: "trace.l.importOnly", params: { id: num(d.import_id) } }] : []),
          ...versions.filter((v) => num(v.id) !== ref.id).map((v) => ({ label: `Phiên bản v${v.version}`, ref: { kind: "document" as const, id: num(v.id) }, key: "trace.l.version", params: { version: num(v.version) } })),
        ],
      };
    }
    case "task_run": {
      const r = db.prepare("SELECT r.*, t.key, t.title, t.agent_id, t.workflow_id FROM task_runs r JOIN tasks t ON t.id = r.task_id WHERE r.id = ?").get(ref.id);
      if (!r) throw new Error("Không tìm thấy lần chạy");
      const out = r.output_json ? (JSON.parse(r.output_json as string) as AgentOutput) : null;
      const inputs = JSON.parse((r.inputs_json as string) || "[]") as TraceRef[];
      const llm = db
        .prepare("SELECT id, provider, model, served_model, created_at, error, status, error_category, input_tokens, output_tokens, duration_ms, request_id, config_revision FROM llm_calls WHERE task_run_id = ?")
        .all(ref.id);
      const runCfg = r.llm_config_json ? (JSON.parse(r.llm_config_json as string) as { provider?: string; model?: string; effort?: string; source?: string; revision?: number | null; outputLanguage?: string }) : null;
      return {
        ref,
        title: `${r.title} — lần chạy #${r.id} (lần ${r.attempt})`,
        titleMsg: { key: "trace.title.task_run", params: { step: String(r.key), id: num(r.id), attempt: num(r.attempt) } },
        subtitle: `${AGENT_INFO.get(r.agent_id as AgentId)?.name ?? r.agent_id} · ${r.mode === "llm" ? "LLM" : r.mode === "human" ? "Người duyệt" : "DEMO — quy tắc xác định, không gọi LLM"}`,
        subtitleMsgs: [{ key: "agent", params: { id: String(r.agent_id) } }, { key: r.mode === "llm" ? "trace.sub.modeLlm" : r.mode === "human" ? "trace.sub.modeHuman" : "trace.sub.modeRules" }],
        fields: [
          { label: "Trạng thái", value: `${r.status}${num(r.superseded) ? " (đã bị thay thế)" : ""}`, key: "trace.f.status", kind: num(r.superseded) ? "text" : "status" },
          { label: "Bắt đầu", value: String(r.started_at), key: "trace.f.startedAt", kind: "datetime" },
          { label: "Kết thúc", value: String(r.finished_at ?? "—"), key: "trace.f.finishedAt", kind: "datetime" },
          { label: "Dấu vân tay đầu vào", value: String(r.input_fingerprint || "—").slice(0, 16), key: "trace.f.fingerprint", kind: "code" },
          ...(runCfg ? [{ label: "Cấu hình LLM khi bắt đầu", key: "trace.f.llmConfig", kind: "code" as const, value: `${runCfg.provider}/${runCfg.model ?? "?"}${runCfg.effort ? ` · effort ${runCfg.effort}` : ""} · nguồn ${runCfg.source ?? "?"}${runCfg.revision !== null && runCfg.revision !== undefined ? ` · rev ${runCfg.revision}` : ""}` }] : []),
          ...(runCfg?.outputLanguage ? [{ label: "Ngôn ngữ đầu ra", key: "trace.f.outputLanguage", kind: "code" as const, value: String(runCfg.outputLanguage) }] : []),
          ...(llm.length
            ? [{
                label: "Gọi LLM",
                key: "trace.f.llmCalls",
                kind: "code" as const,
                value: llm
                  .map((l) => {
                    const served = l.served_model && l.served_model !== l.model ? ` → ${l.served_model}` : "";
                    const tokens = l.input_tokens !== null && l.input_tokens !== undefined ? ` · token ${l.input_tokens}/${l.output_tokens}` : "";
                    const status = l.error ? `lỗi${l.error_category ? ` (${l.error_category})` : ""}: ${l.error}` : String(l.status ?? "ok");
                    return `${l.provider}/${l.model ?? "?"}${served} · ${status}${tokens}${l.duration_ms ? ` · ${l.duration_ms} ms` : ""}${l.request_id ? ` · ${l.request_id}` : ""}`;
                  })
                  .join("; "),
              }]
            : []),
        ],
        warnings: [...(r.error ? [`Lỗi: ${r.error}`] : []), ...(out?.warnings ?? [])],
        body: out ? out.summary + (out.llm?.narrative ? `\n\n**Diễn giải LLM — CHƯA XÁC MINH NGỮ NGHĨA:** ${out.llm.narrative}` : "") : undefined,
        bodyKind: "markdown",
        bodyLang: out?.language ?? "vi",
        links: inputs.map((i) => ({
          label: i.kind === "import" ? `Đầu vào: import #${i.id}` : i.kind === "task_run" ? `Đầu vào: kết quả lần chạy #${i.id}` : `Đầu vào: ${i.kind} ${i.id}`,
          ref: i,
          key: i.kind === "import" ? "trace.l.inputImport" : i.kind === "task_run" ? "trace.l.inputRun" : "trace.l.inputOther",
          params: { id: String(i.id), kind: i.kind },
        })),
      };
    }
    case "decision": {
      const d = db.prepare("SELECT d.*, t.title, t.key AS task_key FROM decisions d JOIN tasks t ON t.id = d.task_id WHERE d.id = ?").get(ref.id);
      if (!d) throw new Error("Không tìm thấy quyết định");
      const label = { approve: "Duyệt", reject: "Từ chối", request_changes: "Yêu cầu bổ sung" }[d.decision as string] ?? d.decision;
      return {
        ref,
        title: `Quyết định #${d.id}: ${label} — ${d.title}`,
        titleMsg: { key: "trace.title.decision", params: { id: num(d.id), decision: String(d.decision), step: String(d.task_key ?? "") } },
        fields: [
          { label: "Người quyết định", value: `${d.actor_name} (${d.actor_role})${d.actor_id ? ` · id ${d.actor_id}` : ""}`, key: "trace.f.decider", valueMsg: { key: d.actor_id ? "trace.v.deciderId" : "trace.v.decider", params: { name: String(d.actor_name), role: String(d.actor_role), id: String(d.actor_id ?? "") } } },
          { label: "Nguồn danh tính", value: String(d.identity_source ?? ""), key: "trace.f.identitySource", kind: "identity" },
          { label: "Thời gian", value: String(d.decided_at), key: "trace.f.time", kind: "datetime" },
          { label: "Nội dung", value: String(d.comment || "—"), key: "trace.f.content" },
          { label: "Trả về bước", value: String(d.return_to ?? "—"), key: "trace.f.returnTo", kind: "code" },
          { label: "Hồ sơ được quyết định", value: `v${d.package_version} · sha256 ${d.package_sha256}`, key: "trace.f.package", kind: "code" },
          { label: "Phiên bản workflow", value: `v${d.workflow_version}`, key: "trace.f.workflowVersion", kind: "code" },
          { label: "Khóa chống trùng", value: String(d.idempotency_key), key: "trace.f.idempotency", kind: "code" },
        ],
        links: [{ label: `Hồ sơ v${d.package_version}`, ref: { kind: "document", id: num(d.package_doc_id) }, key: "trace.l.package", params: { version: num(d.package_version) } }],
      };
    }
    case "event": {
      const e = db.prepare("SELECT * FROM events WHERE event_id = ?").get(ref.id);
      if (!e) throw new Error("Không tìm thấy sự kiện");
      return {
        ref,
        title: `Sự kiện ${e.type}`,
        titleMsg: { key: "trace.title.event", params: { type: String(e.type) } },
        fields: [
          { label: "eventId", value: String(e.event_id), kind: "code" },
          { label: "workflowId", value: String(e.workflow_id ?? "—"), kind: "code" },
          { label: "taskId", value: String(e.task_id ?? "—"), kind: "code" },
          { label: "agentId", value: String(e.agent_id ?? "—"), kind: "code" },
          { label: "Thời gian", value: String(e.ts), key: "trace.f.time", kind: "datetime" },
          { label: "Nguồn", value: String(e.source), key: "trace.f.source", kind: "code" },
          { label: "Nội dung", value: String(e.label), key: "trace.f.content" },
        ],
        body: String(e.payload_json),
        bodyKind: "json",
        links: [],
      };
    }
  }
}
