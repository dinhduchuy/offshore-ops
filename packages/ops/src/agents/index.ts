import type { AgentDef } from "./kit";
import type { AgentId } from "../types";
import { operationsAgent } from "./operations";
import { engineeringAgent } from "./engineering";
import { maintenanceAgent } from "./maintenance";
import { hseAgent } from "./hse";
import { contractsAgent } from "./contracts";
import { logisticsAgent } from "./logistics";
import { financeAgent } from "./finance";

export const AGENT_IMPLS: Partial<Record<AgentId, AgentDef>> = {
  ops_agent: operationsAgent,
  prodeng_agent: engineeringAgent,
  maint_agent: maintenanceAgent,
  hse_agent: hseAgent,
  contracts_agent: contractsAgent,
  logistics_agent: logisticsAgent,
  finance_agent: financeAgent,
};

export interface AgentInfo {
  id: AgentId;
  name: string;
  short: string;
  room: string; // zone id
  kind: "ai" | "human";
  color: string;
}

/** Directory used by the UI and the 3D layout (rooms are zone ids). */
export const AGENT_DIRECTORY: AgentInfo[] = [
  { id: "ops_agent", name: "Operations AI — Điều hành khai thác", short: "Operations", room: "zone_ops", kind: "ai", color: "#22c55e" },
  { id: "prodeng_agent", name: "Production/Subsurface AI — Kỹ thuật khai thác", short: "Prod. Eng", room: "zone_prod_eng", kind: "ai", color: "#38bdf8" },
  { id: "maint_agent", name: "Maintenance & Reliability AI", short: "Maintenance", room: "zone_maint", kind: "ai", color: "#f97316" },
  { id: "hse_agent", name: "HSE AI — An toàn, sức khỏe, môi trường", short: "HSE", room: "zone_hse", kind: "ai", color: "#eab308" },
  { id: "contracts_agent", name: "Contracts & Procurement AI", short: "Contracts", room: "zone_contracts", kind: "ai", color: "#a78bfa" },
  { id: "logistics_agent", name: "Marine & Logistics AI", short: "Logistics", room: "zone_logistics", kind: "ai", color: "#2dd4bf" },
  { id: "finance_agent", name: "Finance / Cost Control AI", short: "Finance", room: "zone_finance", kind: "ai", color: "#fb7185" },
  { id: "eng_lead", name: "Trưởng phòng Kỹ thuật khai thác (người duyệt)", short: "👤 Eng Lead", room: "zone_prod_eng", kind: "human", color: "#e2e8f0" },
  { id: "asset_manager", name: "Asset Manager (người duyệt)", short: "👤 Asset Mgr", room: "zone_asset", kind: "human", color: "#fde68a" },
  { id: "oim", name: "OIM / đầu mối offshore (xác nhận sẵn sàng)", short: "👤 OIM", room: "zone_ops", kind: "human", color: "#cbd5e1" },
];

export const AGENT_INFO = new Map(AGENT_DIRECTORY.map((a) => [a.id, a]));

/** Which agent "receives" a dataset at import (for the 3D intake animation). */
export const DATASET_OWNER: Record<string, AgentId> = {
  dpr: "ops_agent",
  well_master: "prodeng_agent",
  well_test: "prodeng_agent",
  activity_catalog: "prodeng_agent",
  maintenance_history: "maint_agent",
  spare_parts: "maint_agent",
  hse_documents: "hse_agent",
  permit_matrix: "hse_agent",
  contracts: "contracts_agent",
  rate_sheet: "contracts_agent",
  quotes: "contracts_agent",
  cost_estimates: "contracts_agent",
  equipment_catalog: "logistics_agent",
  vessel_schedule: "logistics_agent",
  flight_schedule: "logistics_agent",
  weather_forecast: "logistics_agent",
  logistics_limits: "logistics_agent",
  budget: "finance_agent",
  authority_matrix: "finance_agent",
  psc_terms: "finance_agent",
  work_execution: "ops_agent",
  document: "ops_agent",
};
