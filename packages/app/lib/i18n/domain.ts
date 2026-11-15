import type { Locale } from "./locale";
import type { MessageKey } from "./messages";

/**
 * English names of business vocabularies identified by stable codes (step keys, condition codes,
 * agent ids) or by data values (role names from the identity directory). Vietnamese comes from
 * the server as produced. Translating a role is display only: the role value sent back to the
 * server for authorization is always the original.
 */
export const CONDITION_EN: Record<string, string> = {
  scope_current: "Scope approved and still valid at the current revision",
  cost_complete: "Total cost complete (no item missing a price or quantity)",
  quotes_min: "Enough quotes per procurement policy",
  contract_ceiling: "Value within the current contract ceiling",
  over_budget: "Available budget sufficient (after other cases' holds)",
  afe: "AFE present for cost codes that require it",
  logistics_feasible: "A feasible transport plan exists (if transport is needed)",
  resources_no_conflict: "Vessel/flight holds do not conflict with other cases",
  hse_valid_at_execution: "HSE documents required by the permit matrix valid on the execution date",
  ptw_by_authority: "Permit to work (PTW) issued by the competent authority per platform procedure — the system does NOT issue permits",
  crew_competence: "Crew list & competence checked (no certificate data in the system)",
  transport_holds_valid: "Vessel/flight resources of the plan in force still stand (not cancelled/expired/missing)",
  transport_booked: "Vessel/flight places of the plan in force confirmed by the operator",
  weather_in_limits: "Weather forecast for the execution date available and within transport limits",
  weather_reviewed: "Offshore focal point reviewed the latest forecast close to mobilisation",
  data_fresh: "Production data recent enough",
  execution_confirmed: "Execution records confirmed by the responsible person for every activity",
  evaluation_met: "Result meets the agreed acceptance criteria",
  attribution_reviewed: "Engineer reviewed the effect attributed to the work (vs. observed indicators)",
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

export const DATASET_EN: Record<string, string> = {
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

export const STEP_EN: Record<string, string> = {
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

export const AGENT_EN: Record<string, string> = {
  ops_agent: "Operations AI",
  prodeng_agent: "Production/Subsurface AI",
  maint_agent: "Maintenance & Reliability AI",
  hse_agent: "HSE AI (health, safety, environment)",
  contracts_agent: "Contracts & Procurement AI",
  logistics_agent: "Marine & Logistics AI",
  finance_agent: "Finance / Cost Control AI",
  eng_lead: "Head of Production Engineering (approver)",
  asset_manager: "Asset Manager (approver)",
  oim: "OIM / offshore focal point (readiness)",
};

/** Phase of each workflow step (catalog key). */
export const STEP_PHASE: Record<string, MessageKey> = {
  "ops.anomaly": "phase.intake",
  "eng.assessment": "phase.assessment",
  "mnt.review": "phase.assessment",
  "hse.screening": "phase.assessment",
  "ops.proposal": "phase.option",
  "gate.technical": "phase.scope",
  "proc.prep": "phase.planning",
  "log.plan": "phase.planning",
  "fin.check": "phase.budget",
  "ops.package": "phase.commitment",
  "gate.asset": "phase.commitment",
  "ops.release": "phase.preparation",
  "hse.readiness": "phase.readiness",
  "gate.readiness": "phase.readiness",
  "ops.execution": "phase.execution",
  "eng.evaluation": "phase.evaluation",
  "gate.close": "phase.closure",
};

/** Text produced in Vietnamese by the server, shown in English when a mapping exists. */
const pick = (map: Record<string, string>, code: string, vi: string, locale: Locale) => (locale === "en" ? (map[code] ?? vi) : vi);
export const stepTitle = (key: string, vi: string, locale: Locale) => pick(STEP_EN, key, vi, locale);
export const agentName = (id: string, vi: string, locale: Locale) => pick(AGENT_EN, id, vi, locale);
export const datasetName = (type: string, vi: string, locale: Locale) => pick(DATASET_EN, type, vi, locale);
export const roleLabel = (role: string, locale: Locale) => pick(ROLE_EN, role, role, locale);
export function conditionTitle(c: { code: string; label: string }, locale: Locale): string {
  if (locale !== "en") return c.label;
  return CONDITION_EN[c.code] ?? c.label;
}
/** True when the English rendering is still the server's Vietnamese text (mark lang="vi"). */
export const isUntranslated = (map: Record<string, string>, code: string, locale: Locale) => locale === "en" && !map[code];
