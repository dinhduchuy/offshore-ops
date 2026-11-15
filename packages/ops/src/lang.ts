import type { OpsConfig } from "./config";

/** Content language of generated text (config `content.language`). */
export type ContentLanguage = "vi" | "en";

/**
 * Pick the text for the configured content language. Every generated sentence is written in both
 * languages at the call site (`L(cfg)("…tiếng Việt…", "…English…")`), so numbers, units and ids are
 * the same values in both — no translation step, no guessing.
 */
export const contentLanguage = (cfg: Pick<OpsConfig, "content">): ContentLanguage => (cfg.content?.language === "en" ? "en" : "vi");
export const L = (cfg: Pick<OpsConfig, "content">) => {
  const en = contentLanguage(cfg) === "en";
  return (vi: string, english: string): string => (en ? english : vi);
};

/** English names used when content.language = en (codes and role ids themselves never change). */
export const STEP_TITLE_EN: Record<string, string> = {
  "ops.anomaly": "DPR intake, data checks & case triage",
  "eng.assessment": "Production engineering assessment (preliminary)",
  "mnt.review": "Maintenance, equipment & spares review",
  "hse.screening": "Preliminary HSE screening (planning)",
  "ops.proposal": "Choose the option & handling branch",
  "gate.technical": "Scope approval (technical)",
  "proc.prep": "Quotes & estimate (draft RFQ — no purchase commitment)",
  "log.plan": "Logistics needs & plan",
  "fin.check": "Budget & resource check",
  "ops.package": "Prepare the commitment approval package",
  "gate.asset": "Commitment approval (per delegation of authority)",
  "ops.release": "Draft PR / booking / work request",
  "hse.readiness": "Readiness check (HSE, crew, transport, data) on the execution date",
  "gate.readiness": "Mobilisation readiness confirmation (offshore focal point)",
  "ops.execution": "Record execution results (confirmed by the responsible person)",
  "eng.evaluation": "Evaluate results against acceptance criteria",
  "gate.close": "Close the case (conclusion & lessons)",
};
export const STEP_ACCEPT_EN: Record<string, string[]> = {
  "ops.anomaly": ["DPR for the right platform/well, with an evaluation window and a baseline", "oil_rate definition (rate_basis) when there are downtime days"],
  "eng.assessment": ["Anomaly dossier of the current revision", "Case classification = assessment needed"],
  "mnt.review": ["Anomaly dossier of the current revision"],
  "hse.screening": ["Anomaly dossier of the current revision"],
  "ops.proposal": ["Results of the 3 assessment branches (or the reason they were skipped)"],
  "gate.technical": ["Option and handling branch of the current revision"],
  "proc.prep": ["Approved scope (activity list, materials)"],
  "log.plan": ["Approved scope (crew, equipment, materials to transport)"],
  "fin.check": ["Procurement / service estimate (including unpriced items)", "Logistics cost"],
  "ops.package": ["Budget & resource-hold check result"],
  "gate.asset": ["Approval package and condition list of the current revision"],
  "ops.release": ["Commitment decision (or approved internal scope)"],
  "hse.readiness": ["Agreed scope", "Planned execution date"],
  "gate.readiness": ["Readiness condition list of the current revision"],
  "ops.execution": ["Readiness confirmation", "Execution record confirmed by a person"],
  "eng.evaluation": ["Confirmed execution results", "DPR after execution"],
  "gate.close": ["Results evaluation (or the approved monitoring / no-action conclusion)"],
};
export const ROLE_EN: Record<string, string> = {
  "Kỹ sư khai thác": "Production Engineer",
  "Trưởng phòng Kỹ thuật khai thác": "Head of Production Engineering",
  "Trưởng bộ phận HSE": "HSE Lead",
  "Giám sát giếng": "Well Supervisor",
  "Quản trị hệ thống": "System Administrator",
  "Tích hợp dữ liệu": "Data Integration",
  "Phó Tổng Giám đốc": "Deputy General Director",
  "Tổng Giám đốc": "General Director",
  "Người có thẩm quyền theo ma trận": "Authority holder per the delegation matrix",
  // step owners (departments / functions) from the workflow definition
  "Kỹ thuật khai thác": "Production Engineering",
  "Bảo dưỡng & Độ tin cậy": "Maintenance & Reliability",
  "Hợp đồng & Mua sắm": "Contracts & Procurement",
  "Hàng hải & Hậu cần": "Marine & Logistics",
  "Tài chính": "Finance",
  "OIM / đầu mối offshore": "OIM / offshore focal point",
  "Người phụ trách thực hiện": "Execution lead",
};
export const DATASET_LABEL_EN: Record<string, string> = {
  dpr: "Daily Production Report",
  well_master: "Well master",
  well_test: "Well test",
  maintenance_history: "Maintenance history / work orders",
  spare_parts: "Spare parts / materials stock",
  activity_catalog: "Technical activity catalog",
  hse_documents: "HSE document register",
  permit_matrix: "Permit-to-work matrix",
  contracts: "Contract register",
  rate_sheet: "Contract rate sheet",
  quotes: "Quotes received",
  cost_estimates: "Estimated unit costs (no supporting document)",
  equipment_catalog: "Job equipment (weight, deck area)",
  vessel_schedule: "Vessel schedule",
  flight_schedule: "Flight schedule",
  weather_forecast: "Weather forecast",
  logistics_limits: "Transport limits",
  budget: "Budget / cost / commitments",
  authority_matrix: "Delegation of authority matrix",
  psc_terms: "PSC terms (cost recovery)",
  work_execution: "Work execution records",
  document: "Document",
};
/** Display name of a role in the content language (the role id used for authorization is unchanged). */
export const roleText = (cfg: Pick<OpsConfig, "content">, role: string): string => (contentLanguage(cfg) === "en" ? (ROLE_EN[role] ?? role) : role);
export const stepText = (cfg: Pick<OpsConfig, "content">, key: string, vi: string): string => (contentLanguage(cfg) === "en" ? (STEP_TITLE_EN[key] ?? vi) : vi);
export const datasetText = (cfg: Pick<OpsConfig, "content">, type: string, vi: string): string => (contentLanguage(cfg) === "en" ? (DATASET_LABEL_EN[type] ?? vi) : vi);
