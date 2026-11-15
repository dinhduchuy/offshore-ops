import type { Database } from "./db";
import { nowIso, sha256, num } from "./db";
import type { OpsConfig } from "./config";
import { configVersion } from "./config";
import { activeRows, type ActiveRow } from "./datasets";
import type { WellDetection } from "./detection";
import { todayIso } from "./clock";
import type { WorkflowRow } from "./types";

/**
 * Case scope, scoped data fingerprints and input snapshots.
 *
 * A case is about ONE well identified as <platform>/<well> (well names repeat
 * across platforms). What a step read is fingerprinted only over the rows that
 * belong to the case scope, so data for another well/platform never re-runs
 * this case, while a change to this well's data always does.
 */

export interface CaseScope {
  workflowId: number;
  platform: string;
  well: string;
  wellKey: string;
  /** The well name exists on more than one platform → rows without a platform column cannot be attributed */
  ambiguousWell: boolean;
  /** Declared rule (config scope.rowsWithoutPlatform) resolved for this case: do rows WITHOUT a platform belong here? */
  platformlessApplies: boolean;
}

/** Datasets whose rows belong to one well/platform (everything else is shared/global). */
export const SCOPED_DATASETS = new Set(["dpr", "well_test", "well_master", "maintenance_history", "hse_documents", "weather_forecast", "vessel_schedule", "flight_schedule", "work_execution", "document"]);

/** Canonical form of an asset/well/equipment/activity code: trimmed, upper-case, inner spaces collapsed. */
export function normKey(v: unknown): string {
  return String(v ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

/** Values of a code field: arrays and ";"/"|"/","-separated lists become separate tokens (never substrings). */
export function keyTokens(v: unknown): string[] {
  const parts = Array.isArray(v) ? v : String(v ?? "").split(/[;|,]/);
  return parts.map(normKey).filter(Boolean);
}

export function caseScope(db: Database, wf: Pick<WorkflowRow, "id" | "well" | "platform">, cfg: Pick<OpsConfig, "scope">): CaseScope {
  const platforms = new Set<string>();
  const allPlatforms = new Set<string>([normKey(wf.platform)]);
  for (const t of ["well_master", "dpr"]) {
    for (const r of activeRows(db, t)) {
      if (!r.data.platform) continue;
      allPlatforms.add(normKey(r.data.platform));
      if (normKey(r.data.well) === normKey(wf.well)) platforms.add(normKey(r.data.platform));
    }
  }
  platforms.add(normKey(wf.platform));
  const rule = String(cfg.scope?.rowsWithoutPlatform ?? "single_platform").trim();
  const platformlessApplies =
    rule === "exclude" ? false : rule === "single_platform" ? allPlatforms.size === 1 : normKey(rule) === normKey(wf.platform);
  return { workflowId: wf.id, platform: wf.platform, well: wf.well, wellKey: `${wf.platform}/${wf.well}`, ambiguousWell: platforms.size > 1, platformlessApplies };
}

/**
 * Does a row of `type` belong to the case scope? Exact, normalized code equality only —
 * "A-03" never matches "A-030", "SIM-WHP-A" never matches "SIM-WHP-AB". Rows without a
 * platform belong to the case only through the declared rule; a well name that exists on
 * more than one platform is never attributed from a platform-less row.
 */
export function rowInScope(type: string, row: ActiveRow, s: CaseScope): boolean {
  const d = row.data;
  const P = normKey(s.platform);
  const W = normKey(s.well);
  const hasPlatform = normKey(d.platform) !== "";
  const platformOk = hasPlatform ? normKey(d.platform) === P : s.platformlessApplies;
  const wellOk = (v: unknown) => normKey(v) === W && (hasPlatform || !s.ambiguousWell);
  /** Location-like fields: exact platform code among the listed tokens */
  const atPlatform = (v: unknown) => keyTokens(v).includes(P);
  switch (type) {
    case "dpr":
    case "work_execution":
      return hasPlatform && normKey(d.platform) === P && normKey(d.well) === W;
    case "well_test":
    case "well_master":
      return platformOk && wellOk(d.well);
    case "maintenance_history":
      // equipment of this well, or facilities of this platform without a well (lift gas, allocation…)
      if (!platformOk) return false;
      return normKey(d.well) === "" || wellOk(d.well);
    case "hse_documents": {
      const tokens = keyTokens(d.scope);
      if (!tokens.length) return s.platformlessApplies; // a document without scope is field-wide only by declared rule
      return tokens.some((t) => t === P || t === `${P}/${W}` || (t === W && !s.ambiguousWell && s.platformlessApplies));
    }
    case "weather_forecast":
      return atPlatform(d.location);
    case "vessel_schedule":
    case "flight_schedule":
      return atPlatform(d.destination);
    default:
      return true;
  }
}

export function scopedRows(db: Database, type: string, s: CaseScope): ActiveRow[] {
  const rows = activeRows(db, type);
  return SCOPED_DATASETS.has(type) ? rows.filter((r) => rowInScope(type, r, s)) : rows;
}

/** Case documents: uploads attached to the case or global uploads. */
export function scopedDocIds(db: Database, workflowId: number): number[] {
  return db
    .prepare("SELECT id FROM documents WHERE source = 'upload' AND (workflow_id = ? OR workflow_id IS NULL) ORDER BY id")
    .all(workflowId)
    .map((r) => num(r.id));
}

/** Fingerprint of exactly the rows of `type` that belong to the case. */
export function scopedFingerprint(db: Database, type: string, s: CaseScope): string {
  if (type === "document") return sha256(`document:${scopedDocIds(db, s.workflowId).join(",")}`);
  const ids = scopedRows(db, type, s).map((r) => r.id);
  return sha256(`${type}:${ids.join(",")}`);
}

/** DPR rows of the case up to a date (the assessed period) — new days after it are monitoring data. */
export function scopedFingerprintUpTo(db: Database, s: CaseScope, date: string): string {
  const ids = scopedRows(db, "dpr", s).filter((r) => (r.data.report_date as string) <= date).map((r) => r.id);
  return sha256(`dpr<=${date}:${ids.join(",")}`);
}

/**
 * Keyed dependency on a SHARED dataset: only the rows whose code field equals one value
 * (e.g. quotes{part_no=SL-KIT}). A change to another code leaves the key's fingerprint unchanged.
 */
export function keyedDepKey(type: string, field: string, value: unknown): string {
  return `${type}{${field}=${encodeURIComponent(normKey(value))}}`;
}

export function keyedRows(db: Database, type: string, field: string, value: unknown): ActiveRow[] {
  const v = normKey(value);
  return activeRows(db, type).filter((r) => keyTokens(r.data[field]).includes(v));
}

export function keyedFingerprintOf(key: string, rows: ActiveRow[]): string {
  return sha256(`${key}:${rows.map((r) => r.id).join(",")}`);
}

/** Dataset a stored fingerprint key refers to ("quotes{part_no=X}" → "quotes"). */
export function datasetOfKey(key: string): string {
  return key.startsWith("dpr<=") ? "dpr" : key.replace(/\{.*$/, "");
}

/** Key under which a step records that it read this case's reservation ledger. */
export const LEDGER_KEY = "ledger:reservations";

/**
 * Fingerprint of the case's reservation ledger as a step saw it (status, quantities, external
 * references). A confirmation / cancellation changes it, so a package built on the old ledger
 * is detected both during the run (drift → re-run) and at decision time (→ 409, rebuilt).
 */
export function ledgerFingerprint(db: Database, workflowId: number): string {
  const rows = db.prepare("SELECT id, resource_type, resource_key, status, quantity, unit, external_ref, amendment_of FROM reservations WHERE workflow_id = ? ORDER BY id").all(workflowId);
  return sha256(`${LEDGER_KEY}:${JSON.stringify(rows.map((r) => [r.id, r.resource_type, r.resource_key, r.status, r.quantity, r.unit, r.external_ref ?? null, r.amendment_of ?? null]))}`);
}

/** Fingerprint for a stored key: "<dataset>", "dpr<=YYYY-MM-DD", "<dataset>{field=value}" or the ledger key. */
export function fingerprintForKey(db: Database, key: string, s: CaseScope): string {
  if (key === LEDGER_KEY) return ledgerFingerprint(db, s.workflowId);
  const m = key.match(/^dpr<=(\d{4}-\d{2}-\d{2})$/);
  if (m) return scopedFingerprintUpTo(db, s, m[1]);
  const k = key.match(/^([a-z_]+)\{([a-z_]+)=(.*)\}$/);
  if (k) return keyedFingerprintOf(key, keyedRows(db, k[1], k[2], decodeURIComponent(k[3])));
  return scopedFingerprint(db, key, s);
}

// ───────────────────────── snapshots ─────────────────────────

export interface CaseSnapshot {
  revision: number;
  reason: string;
  createdAt: string;
  asset: string | null;
  platform: string;
  well: string;
  wellKey: string;
  ambiguousWell: boolean;
  /** Reporting period of the case's DPR rows used */
  reportPeriod: { from: string | null; to: string | null };
  /** Date the assessment is "as of" (latest report date of the platform) */
  evaluationDate: string | null;
  /** Wall-clock time the snapshot was taken */
  evaluatedAt: string;
  /** Days between evaluation date and today */
  dataAgeDays: number | null;
  stale: boolean;
  rules: string;
  policy: { version: string; source: string };
  units: { oil: string; basis: string; meaning: string };
  simulated: boolean;
  /** Per scoped dataset: fingerprint, row count, source imports */
  data: Record<string, { fp: string; rows: number; importIds: number[]; simulated: boolean }>;
  /** Detection at case creation (never rewritten) */
  initialDetection: { asOf: string | null; minDropPct: number | null; baseline: number | null };
  /** Latest assessment of this revision */
  assessment: WellDetection | null;
}

const SNAPSHOT_DATASETS = ["dpr", "well_test", "well_master", "maintenance_history", "hse_documents", "work_execution"];

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

export function buildSnapshot(
  db: Database,
  cfg: OpsConfig,
  wf: WorkflowRow,
  revision: number,
  reason: string,
  assessment: WellDetection | null,
): CaseSnapshot {
  const scope = caseScope(db, wf, cfg);
  const data: CaseSnapshot["data"] = {};
  let simulated = !!wf.simulated;
  for (const t of SNAPSHOT_DATASETS) {
    const rows = scopedRows(db, t, scope);
    const importIds = [...new Set(rows.map((r) => r.importId))];
    const sim = importIds.length
      ? num(db.prepare(`SELECT COUNT(*) c FROM imports WHERE simulated = 1 AND id IN (${importIds.join(",")})`).get()!.c) > 0
      : false;
    simulated ||= sim;
    data[t] = { fp: scopedFingerprint(db, t, scope), rows: rows.length, importIds, simulated: sim };
  }
  const dpr = scopedRows(db, "dpr", scope).map((r) => r.data.report_date as string).sort();
  const initial = JSON.parse(wf.detection_json) as { asOf?: string; well?: { minDropPct?: number | null; baseline?: { value?: number } } };
  const evaluationDate = assessment?.asOf ?? dpr[dpr.length - 1] ?? null;
  const age = evaluationDate ? daysBetween(evaluationDate, todayIso()) : null;
  const master = scopedRows(db, "well_master", scope)[0];
  return {
    revision,
    reason,
    createdAt: nowIso(),
    asset: (master?.data.asset as string | undefined) ?? wf.asset ?? null,
    platform: wf.platform,
    well: wf.well,
    wellKey: scope.wellKey,
    ambiguousWell: scope.ambiguousWell,
    reportPeriod: { from: dpr[0] ?? null, to: dpr[dpr.length - 1] ?? null },
    evaluationDate,
    evaluatedAt: nowIso(),
    dataAgeDays: age,
    stale: age !== null && age * 24 > cfg.dataQuality.staleReportHours,
    rules: configVersion(cfg),
    policy: { version: cfg.policy.version, source: cfg.policy.source },
    units: { oil: "bbl/d", basis: assessment?.rateBasis ?? cfg.detection.rateBasis, meaning: assessment?.rateLabel ?? "" },
    simulated,
    data,
    initialDetection: { asOf: initial.asOf ?? null, minDropPct: initial.well?.minDropPct ?? null, baseline: initial.well?.baseline?.value ?? null },
    assessment,
  };
}

export function saveSnapshot(db: Database, workflowId: number, snap: CaseSnapshot, trigger: string): void {
  const json = JSON.stringify(snap);
  db.prepare("INSERT OR IGNORE INTO case_revisions (workflow_id, revision, created_at, reason, trigger, snapshot_json, snapshot_sha) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    workflowId,
    snap.revision,
    snap.createdAt,
    snap.reason,
    trigger,
    json,
    sha256(json),
  );
}

export function latestSnapshot(db: Database, workflowId: number): CaseSnapshot | null {
  const r = db.prepare("SELECT snapshot_json FROM case_revisions WHERE workflow_id = ? ORDER BY revision DESC LIMIT 1").get(workflowId);
  return r ? (JSON.parse(r.snapshot_json as string) as CaseSnapshot) : null;
}

export function revisions(db: Database, workflowId: number): Array<{ revision: number; created_at: string; reason: string; trigger: string | null; snapshot_sha: string }> {
  return db
    .prepare("SELECT revision, created_at, reason, trigger, snapshot_sha FROM case_revisions WHERE workflow_id = ? ORDER BY revision")
    .all(workflowId) as unknown as Array<{ revision: number; created_at: string; reason: string; trigger: string | null; snapshot_sha: string }>;
}

/** Priority from estimated lost oil (baseline × drop%). */
export function priorityFor(cfg: OpsConfig, det: WellDetection): string {
  const loss = det.baseline && det.minDropPct !== null ? (det.baseline.value * det.minDropPct) / 100 : 0;
  if (loss >= cfg.priority.p1LossBbl) return "P1";
  if (loss >= cfg.priority.p2LossBbl) return "P2";
  return "P3";
}
