import type { Database } from "./db";
import { now } from "./clock";
import { nowIso, sha256, tx, num } from "./db";
import type { OpsConfig } from "./config";
import type { ParsedTable } from "./parsers";

/**
 * Dataset specifications + the import pipeline:
 *   parse → normalize units → validate → dedupe/resolve conflicts → store
 * Every stored row keeps its source line number and raw cells, so any value
 * an agent cites can be traced back to the exact place in the input file.
 */

type FieldType = "string" | "number" | "date" | "datetime" | "bool" | "list";

interface FieldSpec {
  name: string;
  type: FieldType;
  required?: boolean;
  /** Column holding the unit of this value (e.g. oil_unit) */
  unitField?: string;
  /** Canonical unit after normalization */
  unit?: string;
  /** Multipliers to the canonical unit, keyed by lower-cased unit label */
  conversions?: Record<string, number>;
  min?: number;
  max?: number;
  label?: string;
  /** Warn (not reject) when this optional value is blank */
  warnIfMissing?: boolean;
}

export interface DatasetSpec {
  type: string;
  label: string;
  fields: FieldSpec[];
  key: string[];
  /** Field holding the record's last-updated timestamp (for conflict resolution) */
  updatedField?: string;
}

const BBL_PER_M3 = 6.28981;
const LIQUID = { "bbl/d": 1, bopd: 1, bwpd: 1, "bbl/day": 1, "m3/d": BBL_PER_M3, "m3/day": BBL_PER_M3 };
const GAS = { "mmscf/d": 1, mmscfd: 1, "mscf/d": 0.001, "km3/d": 0.0353147, "sm3/d": 0.0000353147 };
const PRESSURE = { bar: 1, barg: 1, psi: 0.0689476, psig: 0.0689476, kpa: 0.01 };

export const DATASETS: DatasetSpec[] = [
  {
    type: "dpr",
    label: "Daily Production Report",
    key: ["report_date", "platform", "well"],
    updatedField: "updated_at",
    fields: [
      { name: "report_date", type: "date", required: true },
      { name: "platform", type: "string", required: true },
      { name: "well", type: "string", required: true },
      { name: "oil_rate", type: "number", required: true, unitField: "oil_unit", unit: "bbl/d", conversions: LIQUID, min: 0, label: "Dầu" },
      { name: "gas_rate", type: "number", unitField: "gas_unit", unit: "MMscf/d", conversions: GAS, min: 0, label: "Khí", warnIfMissing: true },
      { name: "water_rate", type: "number", unitField: "water_unit", unit: "bbl/d", conversions: LIQUID, min: 0, label: "Nước", warnIfMissing: true },
      { name: "uptime_h", type: "number", required: true, min: 0, max: 24, unit: "h" },
      { name: "downtime_h", type: "number", min: 0, max: 24, unit: "h" },
      { name: "thp", type: "number", unitField: "thp_unit", unit: "bar", conversions: PRESSURE, min: 0, label: "THP", warnIfMissing: true },
      { name: "gl_inj", type: "number", unitField: "gl_inj_unit", unit: "MMscf/d", conversions: GAS, min: 0, label: "Gas lift" },
      { name: "choke_pct", type: "number", min: 0, max: 100, unit: "%" },
      { name: "notes", type: "string" },
      /** Meaning of oil_rate: daily_volume (calendar-day volume) | operating_rate (rate while flowing) */
      { name: "rate_basis", type: "string" },
      { name: "updated_at", type: "datetime", required: true },
    ],
  },
  {
    type: "well_master",
    label: "Danh mục giếng",
    key: ["well"],
    fields: [
      { name: "well", type: "string", required: true },
      { name: "platform", type: "string", required: true },
      { name: "lift_type", type: "string", required: true },
      { name: "status", type: "string" },
      { name: "reservoir", type: "string" },
      { name: "completion_date", type: "date" },
      { name: "allocation_method", type: "string" },
    ],
  },
  {
    type: "well_test",
    label: "Thử giếng",
    key: ["well", "test_date"],
    fields: [
      { name: "well", type: "string", required: true },
      /** Optional; required to tell apart wells with the same name on different platforms */
      { name: "platform", type: "string" },
      { name: "test_date", type: "date", required: true },
      { name: "duration_h", type: "number", min: 0 },
      { name: "oil_bbl_d", type: "number", required: true, min: 0, unit: "bbl/d" },
      { name: "water_bbl_d", type: "number", min: 0, unit: "bbl/d" },
      { name: "gas_mmscfd", type: "number", min: 0, unit: "MMscf/d" },
      { name: "thp_bar", type: "number", min: 0, unit: "bar" },
      { name: "chp_bar", type: "number", min: 0, unit: "bar" },
      { name: "gl_inj_mmscfd", type: "number", min: 0, unit: "MMscf/d" },
      { name: "choke_pct", type: "number", min: 0, max: 100, unit: "%" },
      { name: "separator", type: "string" },
      { name: "remarks", type: "string" },
    ],
  },
  {
    type: "maintenance_history",
    label: "Lịch sử bảo dưỡng / work order",
    key: ["wo_no"],
    fields: [
      { name: "wo_no", type: "string", required: true },
      /** Optional; without it the row applies only through config scope.rowsWithoutPlatform */
      { name: "platform", type: "string" },
      { name: "well", type: "string" },
      { name: "equipment_tag", type: "string", required: true },
      { name: "system", type: "string", required: true },
      { name: "wo_type", type: "string" },
      { name: "description", type: "string", required: true },
      { name: "status", type: "string", required: true },
      { name: "raised_date", type: "date" },
      { name: "due_date", type: "date" },
      { name: "closed_date", type: "date" },
    ],
  },
  {
    type: "spare_parts",
    label: "Tồn kho phụ tùng / vật tư",
    key: ["part_no"],
    fields: [
      { name: "part_no", type: "string", required: true },
      { name: "description", type: "string", required: true },
      { name: "system", type: "string" },
      { name: "qty_offshore", type: "number", min: 0 },
      { name: "qty_onshore", type: "number", min: 0 },
      { name: "lead_time_days", type: "number", min: 0 },
      { name: "weight_t", type: "number", min: 0, unit: "t" },
      { name: "deck_m2", type: "number", min: 0, unit: "m²" },
    ],
  },
  {
    type: "activity_catalog",
    label: "Danh mục hoạt động kỹ thuật",
    key: ["activity_type"],
    fields: [
      { name: "activity_type", type: "string", required: true },
      { name: "name", type: "string", required: true },
      { name: "work_type", type: "string", required: true },
      { name: "lift_types", type: "list" },
      { name: "addresses", type: "list" },
      { name: "discipline", type: "string" },
      { name: "crew_size", type: "number", min: 0 },
      { name: "duration_days", type: "number", min: 0 },
      { name: "equipment", type: "list" },
      { name: "materials", type: "list" },
      { name: "contract_category", type: "string" },
      { name: "cost_code", type: "string" },
    ],
  },
  {
    type: "hse_documents",
    label: "Sổ đăng ký tài liệu HSE",
    key: ["doc_id"],
    fields: [
      { name: "doc_id", type: "string", required: true },
      { name: "title", type: "string", required: true },
      { name: "doc_type", type: "string", required: true },
      { name: "activity_type", type: "string" },
      { name: "scope", type: "string" },
      { name: "status", type: "string", required: true },
      /** Optional: first business day the document is valid */
      { name: "valid_from", type: "date" },
      { name: "valid_to", type: "date" },
    ],
  },
  {
    type: "permit_matrix",
    label: "Ma trận giấy phép công việc",
    key: ["activity_type", "permit_type"],
    fields: [
      { name: "activity_type", type: "string", required: true },
      { name: "permit_type", type: "string", required: true },
      { name: "required_documents", type: "list", required: true },
    ],
  },
  {
    type: "contracts",
    label: "Danh mục hợp đồng",
    key: ["contract_no"],
    fields: [
      { name: "contract_no", type: "string", required: true },
      { name: "vendor", type: "string", required: true },
      { name: "scope_categories", type: "list", required: true },
      { name: "valid_from", type: "date" },
      { name: "valid_to", type: "date" },
      { name: "ceiling_usd", type: "number", min: 0, unit: "USD" },
      { name: "committed_usd", type: "number", min: 0, unit: "USD" },
    ],
  },
  {
    type: "rate_sheet",
    label: "Bảng đơn giá hợp đồng",
    key: ["contract_no", "item_code"],
    fields: [
      { name: "contract_no", type: "string", required: true },
      { name: "item_code", type: "string", required: true },
      { name: "description", type: "string", required: true },
      { name: "unit", type: "string", required: true },
      { name: "rate_usd", type: "number", required: true, min: 0, unit: "USD" },
      { name: "applies_to", type: "string" },
    ],
  },
  {
    type: "quotes",
    label: "Chào giá nhận được",
    key: ["rfq_ref", "vendor"],
    fields: [
      { name: "rfq_ref", type: "string", required: true },
      { name: "part_no", type: "string", required: true },
      { name: "vendor", type: "string", required: true },
      { name: "unit_price_usd", type: "number", required: true, min: 0, unit: "USD" },
      { name: "qty", type: "number", min: 0 },
      { name: "lead_time_days", type: "number", min: 0 },
      { name: "valid_to", type: "date" },
      { name: "document_ref", type: "string" },
    ],
  },
  {
    type: "cost_estimates",
    label: "Đơn giá ước tính (không có chứng từ)",
    key: ["item"],
    fields: [
      { name: "item", type: "string", required: true },
      { name: "unit", type: "string" },
      { name: "estimate_usd", type: "number", required: true, min: 0, unit: "USD" },
      { name: "basis", type: "string", required: true },
    ],
  },
  {
    type: "equipment_catalog",
    label: "Thiết bị thi công (khối lượng, diện tích)",
    key: ["item"],
    fields: [
      { name: "item", type: "string", required: true },
      { name: "description", type: "string" },
      { name: "weight_t", type: "number", min: 0, unit: "t" },
      { name: "deck_m2", type: "number", min: 0, unit: "m²" },
    ],
  },
  {
    type: "vessel_schedule",
    label: "Lịch tàu",
    key: ["voyage_id"],
    fields: [
      { name: "voyage_id", type: "string", required: true },
      { name: "vessel", type: "string", required: true },
      { name: "depart_date", type: "date", required: true },
      { name: "destination", type: "string", required: true },
      { name: "deck_m2_free", type: "number", min: 0, unit: "m²" },
      { name: "max_lift_t", type: "number", min: 0, unit: "t" },
      { name: "status", type: "string" },
    ],
  },
  {
    type: "flight_schedule",
    label: "Lịch bay",
    key: ["flight_id"],
    fields: [
      { name: "flight_id", type: "string", required: true },
      { name: "flight_date", type: "date", required: true },
      { name: "destination", type: "string", required: true },
      { name: "seats_free", type: "number", min: 0 },
    ],
  },
  {
    type: "weather_forecast",
    label: "Dự báo thời tiết",
    key: ["forecast_date", "location"],
    fields: [
      { name: "forecast_date", type: "date", required: true },
      { name: "location", type: "string", required: true },
      { name: "hs_m", type: "number", min: 0, unit: "m" },
      { name: "wind_kn", type: "number", min: 0, unit: "kn" },
      { name: "issued_at", type: "datetime" },
    ],
  },
  {
    type: "logistics_limits",
    label: "Giới hạn vận chuyển",
    key: ["parameter"],
    fields: [
      { name: "parameter", type: "string", required: true },
      { name: "value", type: "number", required: true },
      { name: "unit", type: "string" },
      { name: "note", type: "string" },
    ],
  },
  {
    type: "budget",
    label: "Ngân sách / chi phí / cam kết",
    key: ["cost_code", "period"],
    fields: [
      { name: "cost_code", type: "string", required: true },
      { name: "description", type: "string" },
      { name: "period", type: "string", required: true },
      { name: "budget_usd", type: "number", required: true, unit: "USD" },
      { name: "actual_usd", type: "number", required: true, unit: "USD" },
      { name: "committed_usd", type: "number", required: true, unit: "USD" },
      { name: "afe_required", type: "bool" },
      { name: "afe_no", type: "string" },
    ],
  },
  {
    type: "authority_matrix",
    label: "Ma trận thẩm quyền phê duyệt",
    key: ["role"],
    fields: [
      { name: "role", type: "string", required: true },
      { name: "max_usd", type: "number", required: true, min: 0, unit: "USD" },
      { name: "scope", type: "string" },
    ],
  },
  {
    type: "psc_terms",
    label: "Điều khoản PSC (thu hồi chi phí)",
    key: ["clause"],
    fields: [
      { name: "clause", type: "string", required: true },
      { name: "cost_category", type: "string", required: true },
      { name: "recoverable", type: "bool", required: true },
      { name: "text", type: "string" },
      { name: "confirmed_by", type: "string" },
    ],
  },
  {
    // Field execution record — entered/imported by the responsible person (never produced by an agent or LLM)
    type: "work_execution",
    label: "Ghi nhận thực hiện công việc",
    key: ["platform", "well", "activity_type", "completed_date"],
    fields: [
      { name: "platform", type: "string", required: true },
      { name: "well", type: "string", required: true },
      { name: "activity_type", type: "string", required: true },
      { name: "case_no", type: "string" },
      /** done | partial | not_done */
      { name: "status", type: "string", required: true },
      { name: "completed_date", type: "date", required: true },
      { name: "findings", type: "string" },
      { name: "result_ref", type: "string" },
      { name: "confirmed_by", type: "string" },
      { name: "confirmed_role", type: "string" },
    ],
  },
];

/** Date fields that describe something that already happened — a future value is impossible. */
const PAST_DATE_FIELDS: Record<string, string> = { dpr: "report_date", well_test: "test_date", work_execution: "completed_date" };

export const DATASET_MAP = new Map(DATASETS.map((d) => [d.type, d]));

/** Guess the dataset type from the header: best coverage of required columns. */
export function detectDatasetType(header: string[], filename = ""): string | null {
  const lower = filename.toLowerCase();
  for (const spec of DATASETS) {
    if (lower.includes(spec.type)) return spec.type;
  }
  const cols = new Set(header.map((h) => h.trim()));
  let best: { type: string; score: number } | null = null;
  for (const spec of DATASETS) {
    const req = spec.fields.filter((f) => f.required).map((f) => f.name);
    if (!req.every((r) => cols.has(r))) continue;
    const score = spec.fields.filter((f) => cols.has(f.name)).length / spec.fields.length;
    if (!best || score > best.score) best = { type: spec.type, score };
  }
  return best?.type ?? null;
}

export interface RowIssue {
  severity: "error" | "warning" | "info";
  field?: string;
  /** Stable code; with `params` the interface renders it per language (dq.<code>). */
  code: string;
  params?: Record<string, string | number>;
  /** Original Vietnamese text (kept for history and support). */
  message: string;
}

export interface NormalizedRow {
  rowNo: number;
  key: string;
  data: Record<string, unknown>;
  raw: Record<string, string>;
  issues: RowIssue[];
  rejected: boolean;
  updatedAt: string | null;
}

function parseDate(v: string): string | null {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/) ?? null;
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // dd/mm/yyyy (VN convention)
  if (d) return `${d[3]}-${d[2].padStart(2, "0")}-${d[1].padStart(2, "0")}`;
  return null;
}

function parseDateTime(v: string): string | null {
  const t = Date.parse(v.includes("T") || v.includes("Z") ? v : v.replace(" ", "T"));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function parseNumber(v: string): number | null {
  const cleaned = v.replace(/[\s,]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

export function normalizeRow(spec: DatasetSpec, rowNo: number, cells: Record<string, string>): NormalizedRow {
  const data: Record<string, unknown> = {};
  const issues: RowIssue[] = [];
  let rejected = false;

  for (const f of spec.fields) {
    const rawVal = (cells[f.name] ?? "").trim();
    if (rawVal === "") {
      data[f.name] = null;
      if (f.required) {
        issues.push({ severity: "error", field: f.name, code: "missing_required", params: { field: f.name }, message: `Thiếu giá trị bắt buộc "${f.name}"` });
        rejected = true;
      } else if (f.warnIfMissing) {
        issues.push({ severity: "warning", field: f.name, code: "missing_value", params: { field: f.name }, message: `Thiếu giá trị "${f.name}" — để trống, không suy diễn` });
      }
      continue;
    }
    switch (f.type) {
      case "string":
        data[f.name] = rawVal;
        break;
      case "list":
        data[f.name] = rawVal.split(/[;|]/).map((s) => s.trim()).filter(Boolean);
        break;
      case "bool":
        data[f.name] = /^(1|true|yes|y|có|x)$/i.test(rawVal);
        break;
      case "date": {
        const d = parseDate(rawVal);
        if (!d) {
          issues.push({ severity: "error", field: f.name, code: "bad_date", params: { field: f.name, raw: String(rawVal) }, message: `Ngày không hợp lệ "${rawVal}"` });
          if (f.required) rejected = true;
          data[f.name] = null;
        } else data[f.name] = d;
        break;
      }
      case "datetime": {
        const d = parseDateTime(rawVal);
        if (!d) {
          issues.push({ severity: "error", field: f.name, code: "bad_datetime", params: { field: f.name, raw: String(rawVal) }, message: `Thời gian không hợp lệ "${rawVal}"` });
          if (f.required) rejected = true;
          data[f.name] = null;
        } else data[f.name] = d;
        break;
      }
      case "number": {
        let n = parseNumber(rawVal);
        if (n === null || Number.isNaN(n)) {
          issues.push({ severity: "error", field: f.name, code: "bad_number", params: { field: f.name, raw: String(rawVal) }, message: `Không phải số: "${rawVal}"` });
          if (f.required) rejected = true;
          data[f.name] = null;
          break;
        }
        if (f.unitField) {
          const unitRaw = (cells[f.unitField] ?? "").trim();
          const unitKey = (unitRaw || f.unit || "").toLowerCase();
          const factor = f.conversions?.[unitKey];
          if (!unitRaw) {
            issues.push({ severity: "warning", field: f.name, code: "unit_assumed", params: { field: f.name, unit: String(f.unit) }, message: `Không ghi đơn vị — giả định ${f.unit}` });
          } else if (factor === undefined) {
            issues.push({ severity: "error", field: f.name, code: "unknown_unit", params: { field: f.name, raw: String(unitRaw) }, message: `Đơn vị không nhận diện "${unitRaw}" cho ${f.name}` });
            data[f.name] = null;
            if (f.required) rejected = true;
            break;
          } else if (factor !== 1) {
            const converted = round(n * factor);
            issues.push({
              severity: "info",
              field: f.name,
              code: "unit_converted",
              params: { field: f.name, value: n, raw: String(unitRaw), factor, converted, unit: String(f.unit) },
              message: `Quy đổi ${n} ${unitRaw} × ${factor} = ${converted} ${f.unit}`,
            });
            n = converted;
          }
        }
        if (f.min !== undefined && n < f.min) {
          issues.push({ severity: "error", field: f.name, code: "out_of_range", params: { field: f.name, value: n, min: f.min }, message: `${f.name}=${n} nhỏ hơn ${f.min}` });
          data[f.name] = null;
          if (f.required) rejected = true;
          break;
        }
        if (f.max !== undefined && n > f.max) {
          issues.push({ severity: "error", field: f.name, code: "out_of_range", params: { field: f.name, value: n, max: f.max }, message: `${f.name}=${n} lớn hơn ${f.max}` });
          data[f.name] = null;
          if (f.required) rejected = true;
          break;
        }
        data[f.name] = n;
        break;
      }
    }
  }

  // Observations cannot be dated in the future (tolerance: 1 day for time zones)
  const pastField = PAST_DATE_FIELDS[spec.type];
  const pastVal = pastField ? (data[pastField] as string | null) : null;
  if (pastVal) {
    const tomorrow = new Date(now().getTime() + 86_400_000).toISOString().slice(0, 10);
    if (pastVal > tomorrow) {
      issues.push({ severity: "error", field: pastField, code: "future_date", params: { field: pastField, value: String(pastVal) }, message: `${pastField}=${pastVal} ở tương lai — loại, không dùng để đánh giá` });
      rejected = true;
    }
  }
  if (spec.type === "dpr" && data.rate_basis !== null && data.rate_basis !== undefined) {
    const rb = String(data.rate_basis).trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (rb !== "daily_volume" && rb !== "operating_rate") {
      issues.push({ severity: "warning", field: "rate_basis", code: "unknown_rate_basis", params: { value: String(data.rate_basis) }, message: `rate_basis "${data.rate_basis}" không thuộc daily_volume/operating_rate — coi như chưa rõ` });
      data.rate_basis = null;
    } else data.rate_basis = rb;
  }
  if (spec.type === "work_execution") {
    const st = String(data.status ?? "").trim().toLowerCase();
    if (!["done", "partial", "not_done"].includes(st)) {
      issues.push({ severity: "error", field: "status", code: "bad_status", params: { value: String(data.status) }, message: `status phải là done/partial/not_done (nhận "${data.status}")` });
      rejected = true;
    } else data.status = st;
  }

  // Dataset-specific consistency checks
  if (spec.type === "dpr") {
    const up = data.uptime_h as number | null;
    const down = data.downtime_h as number | null;
    if (up !== null && down !== null && Math.abs(up + down - 24) > 0.5) {
      issues.push({ severity: "warning", code: "hours_mismatch", params: { up, down }, message: `uptime ${up}h + downtime ${down}h ≠ 24h` });
    }
  }

  const key = spec.key.map((k) => String(data[k] ?? "")).join("|");
  const updatedAt = spec.updatedField ? ((data[spec.updatedField] as string | null) ?? null) : null;
  return { rowNo, key, data, raw: cells, issues, rejected, updatedAt };
}

export interface QualityReport {
  datasetType: string;
  rowsTotal: number;
  rowsAccepted: number;
  rowsRejected: number;
  duplicates: number;
  conflicts: Array<{ key: string; resolution: string; rowNos: number[] }>;
  warnings: string[];
  /** Same order as `warnings`: stable code + params for each (imports made before this field have none). */
  warningItems: Array<{ code: string; params: Record<string, string | number> }>;
  issueCounts: Record<string, number>;
  simulated: boolean;
  missingColumns: string[];
  unknownColumns: string[];
  coverage?: { from: string; to: string; wells: string[]; gaps: Array<{ well: string; date: string }> };
}

export interface ImportResult {
  importId: number;
  duplicateOf?: number;
  datasetType: string;
  quality: QualityReport;
}

function sameData(a: Record<string, unknown>, b: Record<string, unknown>, ignore: string[]): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => !ignore.includes(k)));
  for (const k of keys) {
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) return false;
  }
  return true;
}

function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Import a parsed table. Idempotent: the same file content (sha256) or the
 * same idempotency key returns the existing import without new rows.
 */
export function importTable(
  db: Database,
  cfg: OpsConfig,
  opts: {
    datasetType: string;
    table: ParsedTable;
    filename: string;
    source: "file" | "api";
    contentSha256: string;
    simulated: boolean;
    idempotencyKey?: string;
    workflowId?: number | null;
    receivedAt?: string;
  },
): ImportResult {
  const spec = DATASET_MAP.get(opts.datasetType);
  if (!spec) throw new Error(`Loại dữ liệu không hỗ trợ: ${opts.datasetType}`);

  const existing = (opts.idempotencyKey
    ? db.prepare("SELECT id, quality_json FROM imports WHERE idempotency_key = ?").get(opts.idempotencyKey)
    : undefined) ??
    db.prepare("SELECT id, quality_json FROM imports WHERE dataset_type = ? AND sha256 = ?").get(spec.type, opts.contentSha256);
  if (existing) {
    return {
      importId: num(existing.id),
      duplicateOf: num(existing.id),
      datasetType: spec.type,
      quality: JSON.parse(existing.quality_json as string),
    };
  }

  const receivedAt = opts.receivedAt ?? nowIso();
  const header = opts.table.header;
  const known = new Set(spec.fields.flatMap((f) => [f.name, ...(f.unitField ? [f.unitField] : [])]));
  const quality: QualityReport = {
    datasetType: spec.type,
    rowsTotal: opts.table.rows.length,
    rowsAccepted: 0,
    rowsRejected: 0,
    duplicates: 0,
    conflicts: [],
    warnings: [],
    warningItems: [],
    issueCounts: {},
    simulated: opts.simulated,
    missingColumns: spec.fields.filter((f) => f.required && !header.includes(f.name)).map((f) => f.name),
    unknownColumns: header.filter((h) => !known.has(h)),
  };
  if (quality.missingColumns.length) {
    quality.warnings.push(`Thiếu cột bắt buộc: ${quality.missingColumns.join(", ")}`);
    quality.warningItems.push({ code: "missing_columns", params: { columns: quality.missingColumns.join(", ") } });
  }

  const rows = opts.table.rows.map((r) => normalizeRow(spec, r.rowNo, r.cells));

  return tx(db, () => {
    const ins = db
      .prepare(
        `INSERT INTO imports (dataset_type, source, filename, sha256, idempotency_key, received_at, simulated, rows_total, workflow_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(spec.type, opts.source, opts.filename, opts.contentSha256, opts.idempotencyKey ?? null, receivedAt, opts.simulated ? 1 : 0, rows.length, opts.workflowId ?? null);
    const importId = num(ins.lastInsertRowid);

    const insertRow = db.prepare(
      `INSERT INTO data_rows (import_id, dataset_type, row_no, row_key, data_json, raw_json, status, issues_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const findActive = db.prepare(
      "SELECT id, data_json, updated_at, row_no, import_id FROM data_rows WHERE dataset_type = ? AND row_key = ? AND status = 'active'",
    );
    const setStatus = db.prepare("UPDATE data_rows SET status = ?, issues_json = ? WHERE id = ?");
    const ignoreForCompare = spec.updatedField ? [spec.updatedField, "notes"] : [];

    for (const row of rows) {
      for (const is of row.issues) quality.issueCounts[is.code] = (quality.issueCounts[is.code] ?? 0) + 1;
      if (row.rejected) {
        quality.rowsRejected++;
        insertRow.run(importId, spec.type, row.rowNo, row.key, JSON.stringify(row.data), JSON.stringify(row.raw), "rejected", JSON.stringify(row.issues), row.updatedAt);
        continue;
      }

      // Late update check (DPR): updated long after the report day ended
      if (spec.type === "dpr" && row.updatedAt) {
        const dayEnd = Date.parse(`${row.data.report_date}T23:59:59Z`);
        const lagH = (Date.parse(row.updatedAt) - dayEnd) / 3_600_000;
        if (lagH > cfg.dataQuality.lateUpdateHours) {
          row.issues.push({ severity: "warning", code: "late_update", params: { hours: Math.round(lagH) }, message: `Cập nhật muộn ${Math.round(lagH)}h sau ngày báo cáo` });
          quality.issueCounts.late_update = (quality.issueCounts.late_update ?? 0) + 1;
        }
      }

      const active = findActive.get(spec.type, row.key);
      if (active) {
        const activeData = JSON.parse(active.data_json as string);
        if (sameData(activeData, row.data, ignoreForCompare)) {
          quality.duplicates++;
          row.issues.push({ severity: "info", code: "duplicate", params: { rowId: num(active.id) }, message: `Trùng dòng đã có (#${active.id}) — bỏ qua` });
          insertRow.run(importId, spec.type, row.rowNo, row.key, JSON.stringify(row.data), JSON.stringify(row.raw), "duplicate", JSON.stringify(row.issues), row.updatedAt);
          continue;
        }
        // Conflict: newer updated_at wins; without timestamps the later import wins
        const activeTs = (active.updated_at as string | null) ?? "";
        const newer = !spec.updatedField || (row.updatedAt ?? "") >= activeTs;
        const resolution = newer
          ? `Giá trị mới (dòng ${row.rowNo}, cập nhật ${row.updatedAt ?? "?"}) thay thế bản cũ #${active.id} (cập nhật ${activeTs || "?"})`
          : `Giữ bản đang dùng #${active.id} (cập nhật ${activeTs}) — dòng ${row.rowNo} cũ hơn (${row.updatedAt})`;
        quality.conflicts.push({ key: row.key, resolution, rowNos: [row.rowNo] });
        row.issues.push({ severity: "warning", code: "conflict", message: resolution });
        quality.issueCounts.conflict = (quality.issueCounts.conflict ?? 0) + 1;
        if (newer) {
          const oldIssues = [{ severity: "warning", code: "superseded", params: { importId, rowNo: row.rowNo }, message: `Bị thay thế bởi import #${importId} dòng ${row.rowNo}` }];
          setStatus.run("superseded", JSON.stringify(oldIssues), num(active.id));
          insertRow.run(importId, spec.type, row.rowNo, row.key, JSON.stringify(row.data), JSON.stringify(row.raw), "active", JSON.stringify(row.issues), row.updatedAt);
          quality.rowsAccepted++;
        } else {
          insertRow.run(importId, spec.type, row.rowNo, row.key, JSON.stringify(row.data), JSON.stringify(row.raw), "superseded", JSON.stringify(row.issues), row.updatedAt);
        }
        continue;
      }
      insertRow.run(importId, spec.type, row.rowNo, row.key, JSON.stringify(row.data), JSON.stringify(row.raw), "active", JSON.stringify(row.issues), row.updatedAt);
      quality.rowsAccepted++;
    }

    // Import-level checks for DPR: coverage, gaps, staleness
    if (spec.type === "dpr") {
      const active = activeRows(db, "dpr");
      const dates = active.map((r) => r.data.report_date as string).sort();
      const wells = Array.from(new Set(active.map((r) => r.data.well as string))).sort();
      const gaps: Array<{ well: string; date: string }> = [];
      if (dates.length) {
        const from = dates[0];
        const to = dates[dates.length - 1];
        for (const w of wells) {
          const have = new Set(active.filter((r) => r.data.well === w).map((r) => r.data.report_date as string));
          for (let d = from; d <= to; d = addDays(d, 1)) if (!have.has(d)) gaps.push({ well: w, date: d });
        }
        quality.coverage = { from, to, wells, gaps };
        for (const g of gaps) {
          quality.warnings.push(`Không có báo cáo giếng ${g.well} ngày ${g.date}`);
          quality.warningItems.push({ code: "report_gap", params: { well: g.well, date: g.date } });
        }
        const ageH = (Date.parse(receivedAt) - Date.parse(`${to}T23:59:59Z`)) / 3_600_000;
        if (ageH > cfg.dataQuality.staleReportHours) {
          quality.warnings.push(`Báo cáo mới nhất (${to}) đã cũ ${Math.round(ageH)}h tại thời điểm nhập`);
          quality.warningItems.push({ code: "stale_report", params: { date: to, hours: Math.round(ageH) } });
        }
      }
    }

    db.prepare("UPDATE imports SET rows_accepted = ?, quality_json = ? WHERE id = ?").run(quality.rowsAccepted, JSON.stringify(quality), importId);
    return { importId, datasetType: spec.type, quality };
  });
}

export interface ActiveRow {
  id: number;
  importId: number;
  rowNo: number;
  data: Record<string, unknown>;
  issues: RowIssue[];
}

export function activeRows(db: Database, datasetType: string): ActiveRow[] {
  return db
    .prepare("SELECT id, import_id, row_no, data_json, issues_json FROM data_rows WHERE dataset_type = ? AND status = 'active' ORDER BY id")
    .all(datasetType)
    .map((r) => ({
      id: num(r.id),
      importId: num(r.import_id),
      rowNo: num(r.row_no),
      data: JSON.parse(r.data_json as string),
      issues: JSON.parse(r.issues_json as string),
    }));
}

/** Fingerprint of the active rows of the given dataset types (detects new data). */
export function datasetFingerprint(db: Database, types: string[]): string {
  const parts = types.map((t) => {
    const r = db
      .prepare("SELECT COUNT(*) c, COALESCE(MAX(id),0) m FROM data_rows WHERE dataset_type = ? AND status = 'active'")
      .get(t)!;
    return `${t}:${num(r.c)}:${num(r.m)}`;
  });
  return sha256(parts.join(";"));
}
