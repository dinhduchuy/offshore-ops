import fs from "fs";
import crypto from "crypto";
import { z } from "zod";

/** Operational configuration — thresholds and rules live here, not in code. */
export const OpsConfigSchema = z.object({
  /**
   * Language of the text the rule agents and the workflow WRITE (summaries, conclusions, evidence
   * labels, notes, hand-off requests, document titles). A server setting recorded in every run
   * output (`language`), independent of the language a viewer picks for the interface. Content
   * produced in one language is never rewritten in place; other languages use traceable translations.
   */
  content: z.object({ language: z.enum(["vi", "en"]).default("vi") }).default({}),
  detection: z
    .object({
      /** % drop (uptime-normalized oil rate vs baseline) that counts as an anomaly */
      dropThresholdPct: z.number().positive().default(15),
      /** The drop must persist for this many consecutive latest report days */
      consecutiveDays: z.number().int().positive().default(3),
      baseline: z
        .object({
          mode: z.enum(["rolling", "fixed"]).default("rolling"),
          /** rolling: number of days averaged */
          windowDays: z.number().int().positive().default(7),
          /** rolling: days skipped between the baseline window and the evaluation window */
          offsetDays: z.number().int().min(0).default(4),
          /** fixed: per-well baseline oil rate (bbl/d) */
          fixed: z.record(z.string(), z.number().positive()).default({}),
        })
        .default({}),
      /**
       * Meaning of oil_rate when a DPR row does not say (column rate_basis):
       *  - daily_volume: volume produced in the calendar day (bbl/d calendar-day average)
       *  - operating_rate: rate while flowing (bbl per operating day)
       *  - unspecified: unknown → never normalized; days with downtime cannot be evaluated
       */
      rateBasis: z.enum(["daily_volume", "operating_rate", "unspecified"]).default("unspecified"),
      /** Convert daily_volume rows to an operating rate (× 24 / uptime) before comparing. Ignored for other bases. */
      normalizeByUptime: z.boolean().default(true),
      /** Days with less uptime than this are excluded as non-representative */
      minUptimeHours: z.number().min(0).max(24).default(12),
    })
    .default({}),
  dataQuality: z
    .object({
      /** A report row updated later than this after its report date is flagged as a late revision */
      lateUpdateHours: z.number().positive().default(36),
      /** Warn when the newest report is older than this at import time */
      staleReportHours: z.number().positive().default(48),
    })
    .default({}),
  engineering: z
    .object({
      /** A well test older than this (vs latest DPR date) is not a sufficient basis for a SOW */
      wellTestMaxAgeDays: z.number().int().positive().default(30),
      waterCutRisePp: z.number().positive().default(5),
      gasLiftDropPct: z.number().positive().default(10),
      correlationMin: z.number().min(0).max(1).default(0.6),
    })
    .default({}),
  procurement: z
    .object({
      /** Minimum independent quotes for an item not covered by a contract rate */
      minQuotes: z.number().int().positive().default(2),
    })
    .default({}),
  logistics: z
    .object({
      /** Earliest mobilization = gate approval date + this many days */
      leadDays: z.number().int().min(0).default(3),
    })
    .default({}),
  approvals: z
    .object({
      technicalRole: z.string().default("Trưởng phòng Kỹ thuật khai thác"),
      assetRole: z.string().default("Asset Manager"),
      /** Roles allowed to approve sending an outbound draft (plus the case's final approver role) */
      outboxRoles: z.array(z.string()).default(["Asset Manager"]),
      /** Offshore focal point confirming readiness before mobilization (does not issue PTW in the system) */
      readinessRole: z.string().default("OIM"),
      /** Who closes a case after results are evaluated */
      closeRole: z.string().default("Trưởng phòng Kỹ thuật khai thác"),
    })
    .default({}),
  /**
   * Versioned policy rules. The bundled values are a SAMPLE for the simulated
   * dataset — they are NOT an enterprise policy or standard.
   */
  policy: z
    .object({
      version: z.string().default("SAMPLE-0"),
      source: z.string().default("Cấu hình MẪU — không phải chính sách doanh nghiệp"),
      /** Who may approve an exception, per waivable condition code */
      waiverRoles: z.record(z.string(), z.array(z.string())).default({ quotes_min: ["Asset Manager"], over_budget: ["Phó Tổng Giám đốc", "Tổng Giám đốc"] }),
      /** Condition codes that no exception can override */
      nonWaivable: z
        .array(z.string())
        .default(["scope_current", "cost_complete", "afe", "logistics_feasible", "resources_no_conflict", "hse_valid_at_execution", "ptw_by_authority", "execution_confirmed", "evaluation_met", "transport_holds_valid", "transport_booked", "weather_in_limits"]),
      /** Internal holds on budget / deck / seats expire after this many days unless re-confirmed */
      holdDays: z.number().int().positive().default(7),
    })
    .default({}),
  /**
   * Who may perform each mutation (role names). SAMPLE values for the simulated
   * dataset; the enterprise must define its own matrix.
   */
  permissions: z
    .object({
      /** Reset / fault injection: only these roles, and never in operatingMode=production */
      admin: z.array(z.string()).default(["Quản trị hệ thống"]),
      /** Change the Claude API configuration */
      llmConfigure: z.array(z.string()).default(["Quản trị hệ thống", "Asset Manager"]),
      /** Re-run a failed / waiting task */
      retry: z.array(z.string()).default(["Kỹ sư khai thác", "Trưởng phòng Kỹ thuật khai thác", "OIM", "Asset Manager", "Trưởng bộ phận HSE", "Marine coordinator", "Quản trị hệ thống", "Tích hợp dữ liệu"]),
      /** Record execution results */
      execution: z.array(z.string()).default(["OIM", "Kỹ sư khai thác", "Trưởng phòng Kỹ thuật khai thác", "Giám sát giếng"]),
      /** Record the external confirmation / cancellation of a booking, per resource type */
      reservation: z
        .record(z.string(), z.array(z.string()))
        .default({ vessel_deck: ["Marine coordinator", "OIM"], flight_seats: ["Marine coordinator", "OIM"], budget: ["Asset Manager"] }),
      /** Import: default roles, and per-dataset overrides (finance/HSE registers are restricted) */
      importDefault: z.array(z.string()).default(["Kỹ sư khai thác", "Trưởng phòng Kỹ thuật khai thác", "OIM", "Asset Manager", "Trưởng bộ phận HSE", "Marine coordinator", "Tích hợp dữ liệu"]),
      importByDataset: z.record(z.string(), z.array(z.string())).default({
        budget: ["Asset Manager"],
        authority_matrix: ["Asset Manager"],
        psc_terms: ["Asset Manager"],
        hse_documents: ["Trưởng bộ phận HSE", "OIM", "Tích hợp dữ liệu"],
        permit_matrix: ["Trưởng bộ phận HSE"],
        work_execution: ["OIM", "Kỹ sư khai thác", "Trưởng phòng Kỹ thuật khai thác", "Giám sát giếng"],
      }),
      /** Loading the bundled SIMULATED sample set (never in production) */
      sample: z.array(z.string()).default(["Kỹ sư khai thác", "Trưởng phòng Kỹ thuật khai thác", "OIM", "Asset Manager", "Quản trị hệ thống", "Tích hợp dữ liệu"]),
      /** Request an on-demand translation of a document/run summary (a billed Claude API call) */
      translate: z.array(z.string()).default(["Kỹ sư khai thác", "Trưởng phòng Kỹ thuật khai thác", "OIM", "Asset Manager", "Trưởng bộ phận HSE", "Marine coordinator", "Quản trị hệ thống"]),
      /** Mark a translation as reviewed by a specialist (does not touch the original or its approvals) */
      translationReview: z.array(z.string()).default(["Trưởng phòng Kỹ thuật khai thác", "Trưởng bộ phận HSE", "Asset Manager", "OIM"]),
    })
    .default({}),
  limits: z
    .object({
      importMaxBytes: z.number().int().positive().default(10 * 1024 * 1024),
      importMaxRows: z.number().int().positive().default(50_000),
    })
    .default({}),
  /** Declared scope rules (no guessing from substrings) */
  scope: z
    .object({
      /**
       * Rows without a platform column/value (shared facilities, well tests…):
       *  - "single_platform": apply only when exactly one platform is known (for that well / overall)
       *  - "exclude": never apply
       *  - any other string: the platform code these rows belong to
       */
      rowsWithoutPlatform: z.string().default("single_platform"),
    })
    .default({}),
  closure: z
    .object({
      /** Post-work DPR days needed before judging production recovery */
      observationDays: z.number().int().positive().default(3),
      /** Share of the lost rate that must be recovered for a maintenance activity to meet its criterion */
      recoveryShareMin: z.number().min(0).max(1).default(0.5),
    })
    .default({}),
  priority: z
    .object({
      /** Estimated lost oil (bbl/d) for P1 / P2; below → P3 */
      p1LossBbl: z.number().positive().default(300),
      p2LossBbl: z.number().positive().default(100),
    })
    .default({}),
  /** Hours from when a step becomes actionable to its due time */
  sla: z
    .object({
      agentHours: z.number().positive().default(4),
      approvalHours: z.number().positive().default(48),
      dataHours: z.number().positive().default(72),
      executionHours: z.number().positive().default(240),
    })
    .default({}),
  /** Business calendar: "today", decision dates and document validity days use this IANA time zone */
  calendar: z
    .object({
      timeZone: z.string().default("UTC"),
    })
    .default({}),
  runtime: z
    .object({
      /** Demo pacing so progress is visible; does not depend on animations */
      demoTaskDelayMs: z.number().int().min(0).default(2500),
      /** Max tasks running at the same time for one agent (queue order: case priority, then age) */
      maxConcurrentPerAgent: z.number().int().positive().default(2),
      llm: z
        .object({
          enabled: z.boolean().default(false),
          /** Max concurrent calls to the LLM provider */
          maxConcurrent: z.number().int().positive().default(2),
          /** Includes thinking tokens on current Claude models (adaptive thinking is always on for Opus 5.5) */
          maxTokens: z.number().int().positive().default(16000),
          /**
           * Language of LLM-written narrative. A server setting snapshotted into each run
           * (task_runs.llm_config_json) — never taken from the language a viewer has chosen.
           */
          outputLanguage: z.enum(["vi", "en"]).default("vi"),
          /** Max tokens of one on-demand translation call */
          translationMaxTokens: z.number().int().positive().default(8000),
        })
        .default({}),
    })
    .default({}),
});

export type OpsConfig = z.infer<typeof OpsConfigSchema>;

/** Short hash identifying the rule/policy configuration in force (recorded in every case revision). */
export function configVersion(cfg: OpsConfig): string {
  return `${cfg.policy.version}#${crypto.createHash("sha256").update(JSON.stringify(cfg)).digest("hex").slice(0, 10)}`;
}

export function loadOpsConfig(file?: string): OpsConfig {
  if (file && fs.existsSync(file)) {
    return OpsConfigSchema.parse(JSON.parse(fs.readFileSync(file, "utf-8")));
  }
  return OpsConfigSchema.parse({});
}
