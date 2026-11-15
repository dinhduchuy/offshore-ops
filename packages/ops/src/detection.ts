import { L } from "./lang";
import type { Database } from "./db";
import type { OpsConfig } from "./config";
import { activeRows, type ActiveRow } from "./datasets";
import { recordCalc, mean, r1 } from "./calc";

/**
 * Production-drop detection, per (platform, well) — well names are only
 * unique within a platform.
 *
 * What oil_rate means is a data definition, not an assumption:
 *   - rate_basis = daily_volume   → calendar-day volume; converted to an operating
 *                                   rate (× 24 / uptime_h) when normalizeByUptime
 *   - rate_basis = operating_rate → already a rate while flowing; used as is
 *   - unknown                     → used as is; a day with downtime cannot be
 *                                   evaluated (the two meanings disagree there)
 * The row's rate_basis column wins over config detection.rateBasis.
 *
 *   baseline = mean(rate over the baseline window)  | fixed per-well value
 *   drop%    = (baseline − rate) / baseline × 100   for each evaluation day
 *   anomaly  ⇔ drop% ≥ threshold on every one of the latest N consecutive days
 *   suspect  ⇔ not evaluable, but the raw figures available would exceed the threshold
 *              (a case is opened only to collect data — no intervention)
 * Every number is stored as a calc with its input rows (traceable).
 */

export interface DayEval {
  date: string;
  rowId: number;
  oilRaw: number;
  uptime: number;
  oilNorm: number | null;
  dropPct: number | null;
  rawDropPct: number | null;
  calcId: string | null;
  basis: RateBasis;
}

export type RateBasis = "daily_volume" | "operating_rate" | "unspecified";

export interface WellDetection {
  well: string;
  platform: string;
  /** Namespaced identity used for cases: "<platform>/<well>" */
  wellKey: string;
  /** Latest report date for this platform (evaluation date) */
  asOf: string | null;
  evaluated: boolean;
  reason?: string;
  /** What is missing for a valid evaluation (drives the data-gap branch) */
  gaps: Array<{ description: string; datasetType: string }>;
  baseline?: { value: number; calcId: string; rowIds: number[]; mode: string; from?: string; to?: string };
  days: DayEval[];
  anomaly: boolean;
  suspect: boolean;
  /** raw rate fell past the threshold but the operating rate did not */
  explainedByDowntime: boolean;
  minDropPct: number | null;
  summaryCalcId?: string;
  rateBasis: RateBasis;
  rateLabel: string;
}

export interface DetectionResult {
  asOf: string | null;
  thresholdPct: number;
  consecutiveDays: number;
  wells: WellDetection[];
}

function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function wellKey(platform: string, well: string): string {
  return `${platform}/${well}`;
}

export function rowBasis(cfg: OpsConfig, row: ActiveRow): RateBasis {
  const rb = row.data.rate_basis as string | null | undefined;
  if (rb === "daily_volume" || rb === "operating_rate") return rb;
  return cfg.detection.rateBasis;
}

/**
 * Comparable oil rate for a day, or null when the day cannot be evaluated.
 * Never changes what the number means without a data definition.
 */
export function normRate(cfg: OpsConfig, row: ActiveRow): number | null {
  const oil = row.data.oil_rate as number | null;
  const up = row.data.uptime_h as number | null;
  if (oil === null || up === null) return null;
  if (up < cfg.detection.minUptimeHours) return null;
  const basis = rowBasis(cfg, row);
  if (basis === "daily_volume") return cfg.detection.normalizeByUptime ? (oil * 24) / up : oil;
  if (basis === "operating_rate") return oil;
  // unspecified: identical under both meanings only when the well ran all day
  return up >= 24 ? oil : null;
}

export function rateLabel(cfg: OpsConfig, basis: RateBasis): string {
  const T = L(cfg);
  if (basis === "daily_volume") return cfg.detection.normalizeByUptime ? T("lưu lượng khi vận hành, quy đổi từ sản lượng ngày (× 24 / uptime)", "operating rate, converted from the daily volume (× 24 / uptime)") : T("sản lượng ngày (bbl/d theo ngày lịch)", "daily volume (bbl/d per calendar day)");
  if (basis === "operating_rate") return T("lưu lượng khi vận hành (theo dữ liệu, không quy đổi)", "operating rate (as reported, not converted)");
  return T("oil_rate chưa rõ định nghĩa — chỉ dùng ngày chạy đủ 24h, không quy đổi", "oil_rate definition unknown — only full 24 h days are used, no conversion");
}

export function runDetection(db: Database, cfg: OpsConfig): DetectionResult {
  const det = cfg.detection;
  const T = L(cfg);
  const rows = activeRows(db, "dpr");
  const result: DetectionResult = { asOf: rows.map((r) => r.data.report_date as string).sort().pop() ?? null, thresholdPct: det.dropThresholdPct, consecutiveDays: det.consecutiveDays, wells: [] };
  if (!result.asOf) return result;

  // Evaluation date per platform: its latest report date (a lagging platform is not judged on another's calendar)
  const platformAsOf = new Map<string, string>();
  const byWell = new Map<string, ActiveRow[]>();
  for (const r of rows) {
    const p = r.data.platform as string;
    const d = r.data.report_date as string;
    if (!platformAsOf.has(p) || platformAsOf.get(p)! < d) platformAsOf.set(p, d);
    const k = wellKey(p, r.data.well as string);
    if (!byWell.has(k)) byWell.set(k, []);
    byWell.get(k)!.push(r);
  }

  for (const [key, wellRows] of [...byWell.entries()].sort()) {
    const byDate = new Map(wellRows.map((r) => [r.data.report_date as string, r]));
    const platform = wellRows[0].data.platform as string;
    const well = wellRows[0].data.well as string;
    const asOf = platformAsOf.get(platform)!;
    const bases = new Set(wellRows.map((r) => rowBasis(cfg, r)));
    const basis: RateBasis = bases.size === 1 ? [...bases][0] : "unspecified";
    const wd: WellDetection = {
      well,
      platform,
      wellKey: key,
      asOf,
      evaluated: false,
      gaps: [],
      days: [],
      anomaly: false,
      suspect: false,
      explainedByDowntime: false,
      minDropPct: null,
      rateBasis: basis,
      rateLabel: rateLabel(cfg, basis),
    };
    result.wells.push(wd);
    if (bases.size > 1) wd.gaps.push({ description: T(`DPR của ${key} trộn nhiều định nghĩa oil_rate (${[...bases].join(", ")})`, `DPR for ${key} mixes several oil_rate definitions (${[...bases].join(", ")})`), datasetType: "dpr" });

    // Evaluation window: the latest N calendar days up to the platform's asOf, all must be reported
    const evalDates = Array.from({ length: det.consecutiveDays }, (_, i) => addDays(asOf, -(det.consecutiveDays - 1 - i)));
    const missing = evalDates.filter((d) => !byDate.has(d));
    if (missing.length) {
      wd.reason = T(`Thiếu báo cáo ngày ${missing.join(", ")} trong cửa sổ đánh giá`, `No report for ${missing.join(", ")} in the evaluation window`);
      wd.gaps.push({ description: T(`DPR ${key} thiếu ngày ${missing.join(", ")} (cửa sổ đánh giá đến ${asOf})`, `DPR ${key} is missing ${missing.join(", ")} (evaluation window to ${asOf})`), datasetType: "dpr" });
      continue;
    }

    // Baseline
    let baselineValue: number | null = null;
    let baselineCalc: string | null = null;
    const baselineRows: ActiveRow[] = [];
    const end = addDays(evalDates[0], -(det.baseline.offsetDays + 1));
    const start = addDays(end, -(det.baseline.windowDays - 1));
    if (det.baseline.mode === "fixed") {
      const fixed = det.baseline.fixed[key] ?? det.baseline.fixed[well];
      if (!fixed) {
        wd.reason = T("Chưa cấu hình baseline cố định cho giếng", "No fixed baseline configured for the well");
        wd.gaps.push({ description: T(`Chưa cấu hình baseline cố định cho ${key}`, `No fixed baseline configured for ${key}`), datasetType: "config" });
      } else {
        baselineValue = fixed;
        baselineCalc = recordCalc(db, { label: T(`Baseline cố định ${key}`, `Fixed baseline ${key}`), formula: T("baseline = giá trị cấu hình detection.baseline.fixed", "baseline = configured value detection.baseline.fixed"), inputs: [{ name: "baseline", value: fixed, unit: "bbl/d" }], result: fixed, unit: "bbl/d" });
        wd.baseline = { value: r1(fixed), calcId: baselineCalc, rowIds: [], mode: "fixed" };
      }
    } else {
      for (let d = start; d <= end; d = addDays(d, 1)) {
        const r = byDate.get(d);
        if (r && normRate(cfg, r) !== null) baselineRows.push(r);
      }
      const needed = Math.ceil(det.baseline.windowDays / 2);
      if (baselineRows.length < needed) {
        wd.reason = T(`Không đủ ngày đại diện cho baseline (${baselineRows.length}/${det.baseline.windowDays}, ${start}→${end})`, `Not enough representative days for the baseline (${baselineRows.length}/${det.baseline.windowDays}, ${start}→${end})`);
        wd.gaps.push({ description: T(`Baseline ${key}: chỉ có ${baselineRows.length}/${det.baseline.windowDays} ngày đại diện (${start}→${end}), cần ≥ ${needed}`, `Baseline ${key}: only ${baselineRows.length}/${det.baseline.windowDays} representative days (${start}→${end}), need ≥ ${needed}`), datasetType: "dpr" });
      } else {
        const vals = baselineRows.map((r) => normRate(cfg, r)!);
        baselineValue = mean(vals);
        baselineCalc = recordCalc(db, {
          label: `Baseline ${key} (TB ${baselineRows.length} ngày ${start}→${end})`,
          formula: T(`baseline = Σ rate / n; rate = ${rateLabel(cfg, basis)}; chỉ lấy ngày uptime ≥ ${det.minUptimeHours}h`, `baseline = Σ rate / n; rate = ${rateLabel(cfg, basis)}; only days with uptime ≥ ${det.minUptimeHours} h`),
          inputs: baselineRows.map((r) => ({ name: `${r.data.report_date}`, value: r1(normRate(cfg, r)!), unit: "bbl/d", ref: { kind: "data_row" as const, id: r.id } })),
          result: r1(baselineValue),
          unit: "bbl/d",
        });
        wd.baseline = { value: r1(baselineValue), calcId: baselineCalc, rowIds: baselineRows.map((r) => r.id), mode: "rolling", from: start, to: end };
      }
    }

    // Evaluation days (computed even without a baseline, to judge "suspect")
    const rawBaseRows = [...byDate.values()].filter((r) => (r.data.report_date as string) >= start && (r.data.report_date as string) <= end);
    const rawBase = rawBaseRows.length ? mean(rawBaseRows.map((r) => r.data.oil_rate as number)) : null;
    for (const d of evalDates) {
      const r = byDate.get(d)!;
      const oilRaw = r.data.oil_rate as number;
      const uptime = r.data.uptime_h as number;
      const oilNorm = normRate(cfg, r);
      const ref = baselineValue ?? rawBase;
      const rawDrop = ref ? ((ref - oilRaw) / ref) * 100 : null;
      const drop = oilNorm === null || baselineValue === null ? null : ((baselineValue - oilNorm) / baselineValue) * 100;
      const calcId =
        drop === null
          ? null
          : recordCalc(db, {
              label: T(`Mức giảm ${key} ngày ${d}`, `Drop ${key} on ${d}`),
              formula: `drop% = (baseline − rate) / baseline × 100; rate = ${rateLabel(cfg, rowBasis(cfg, r))}`,
              inputs: [
                { name: "baseline", value: r1(baselineValue!), unit: "bbl/d", ref: { kind: "calc", id: baselineCalc! } },
                { name: "oil_rate", value: oilRaw, unit: "bbl/d", ref: { kind: "data_row", id: r.id } },
                { name: "uptime_h", value: uptime, unit: "h", ref: { kind: "data_row", id: r.id } },
                { name: "rate_basis", value: rowBasis(cfg, r), ref: { kind: "data_row", id: r.id } },
              ],
              result: r1(drop),
              unit: "%",
            });
      wd.days.push({ date: d, rowId: r.id, oilRaw, uptime, oilNorm: oilNorm === null ? null : r1(oilNorm), dropPct: drop === null ? null : r1(drop), rawDropPct: rawDrop === null ? null : r1(rawDrop), calcId, basis: rowBasis(cfg, r) });
    }
    const undeterminable = wd.days.filter((x) => x.oilNorm === null);
    if (undeterminable.length && baselineValue !== null) {
      const ambiguous = undeterminable.filter((x) => x.basis === "unspecified" && x.uptime < 24 && x.uptime >= det.minUptimeHours);
      if (ambiguous.length) {
        wd.gaps.push({
          description: T(`DPR ${key}: ${ambiguous.map((x) => `${x.date} (uptime ${x.uptime}h)`).join(", ")} có downtime nhưng chưa rõ oil_rate là sản lượng ngày hay lưu lượng khi vận hành — cần cột rate_basis hoặc định nghĩa dữ liệu`, `DPR ${key}: ${ambiguous.map((x) => `${x.date} (uptime ${x.uptime}h)`).join(", ")} had downtime but it is unclear whether oil_rate is a daily volume or an operating rate — a rate_basis column or data definition is needed`),
          datasetType: "dpr",
        });
      } else {
        wd.gaps.push({ description: T(`DPR ${key}: ${undeterminable.map((x) => x.date).join(", ")} uptime dưới ${det.minUptimeHours}h — không đại diện để đánh giá`, `DPR ${key}: ${undeterminable.map((x) => x.date).join(", ")} uptime below ${det.minUptimeHours} h — not representative`), datasetType: "dpr" });
      }
    }

    const drops = wd.days.map((x) => x.dropPct);
    wd.evaluated = baselineValue !== null && drops.every((x) => x !== null) && !wd.gaps.length;
    if (wd.evaluated) {
      wd.anomaly = drops.every((x) => x! >= det.dropThresholdPct);
      wd.minDropPct = Math.min(...(drops as number[]));
      wd.explainedByDowntime = !wd.anomaly && wd.days.some((x) => (x.rawDropPct ?? 0) >= det.dropThresholdPct && (x.dropPct ?? 0) < det.dropThresholdPct);
    } else {
      if (!wd.reason) wd.reason = wd.gaps.map((g) => g.description).join("; ");
      // Not evaluable: the raw figures available still exceed the threshold on every day → suspect
      wd.suspect = wd.days.length === det.consecutiveDays && wd.days.every((x) => x.rawDropPct !== null && x.rawDropPct >= det.dropThresholdPct);
      const known = wd.days.map((x) => x.dropPct ?? x.rawDropPct).filter((x): x is number => x !== null);
      wd.minDropPct = known.length ? r1(Math.min(...known)) : null;
    }
    wd.summaryCalcId = recordCalc(db, {
      label: T(`Kết luận ngưỡng ${key}`, `Threshold result ${key}`),
      formula: wd.evaluated
        ? T(`anomaly = drop% ≥ ${det.dropThresholdPct}% trong cả ${det.consecutiveDays} ngày gần nhất (đến ${asOf})`, `anomaly = drop% ≥ ${det.dropThresholdPct}% on all of the last ${det.consecutiveDays} days (to ${asOf})`)
        : T(`chưa đánh giá được (${wd.reason}); suspect = mức giảm thô ≥ ${det.dropThresholdPct}% trong cả ${det.consecutiveDays} ngày`, `cannot be evaluated (${wd.reason}); suspect = raw drop ≥ ${det.dropThresholdPct}% on all ${det.consecutiveDays} days`),
      inputs: wd.days.map((x) => ({ name: x.date, value: x.dropPct ?? x.rawDropPct, unit: "%", ...(x.calcId ? { ref: { kind: "calc" as const, id: x.calcId } } : { ref: { kind: "data_row" as const, id: x.rowId } }) })),
      result: wd.anomaly ? 1 : wd.suspect ? 0.5 : 0,
      unit: wd.evaluated ? "bool" : "suspect",
    });
  }
  return result;
}
