import type { ActiveRow } from "../datasets";
import { recordCalc, mean, r1 } from "../calc";
import type { AgentContext } from "./kit";

export type Metric = "water_cut" | "gl_inj" | "thp" | "gas_rate" | "oil_norm";

const LABEL_EN: Record<Metric, { name: string; unit: string; formula: string }> = {
  water_cut: { name: "Water cut", unit: "%", formula: "WC = water_rate / (oil_rate + water_rate) × 100" },
  gl_inj: { name: "Gas-lift injection", unit: "MMscf/d", formula: "gl_inj (from DPR)" },
  thp: { name: "Tubing head pressure (THP)", unit: "bar", formula: "thp (from DPR)" },
  gas_rate: { name: "Gas rate", unit: "MMscf/d", formula: "gas_rate (from DPR)" },
  oil_norm: { name: "Uptime-normalized oil", unit: "bbl/d", formula: "oil_rate × 24 / uptime_h" },
};
const LABEL: Record<Metric, { name: string; unit: string; formula: string }> = {
  water_cut: { name: "Water cut", unit: "%", formula: "WC = water_rate / (oil_rate + water_rate) × 100" },
  gl_inj: { name: "Lưu lượng khí gas lift", unit: "MMscf/d", formula: "gl_inj (theo DPR)" },
  thp: { name: "Áp suất đầu giếng THP", unit: "bar", formula: "thp (theo DPR)" },
  gas_rate: { name: "Sản lượng khí", unit: "MMscf/d", formula: "gas_rate (theo DPR)" },
  oil_norm: { name: "Dầu chuẩn hóa uptime", unit: "bbl/d", formula: "oil_rate × 24 / uptime_h" },
};

export function metricValue(row: ActiveRow, m: Metric): number | null {
  const d = row.data;
  switch (m) {
    case "water_cut": {
      const o = d.oil_rate as number | null;
      const w = d.water_rate as number | null;
      if (o === null || w === null || o + w === 0) return null;
      return (w / (o + w)) * 100;
    }
    case "oil_norm": {
      const o = d.oil_rate as number | null;
      const up = d.uptime_h as number | null;
      if (o === null || !up) return null;
      return (o * 24) / up;
    }
    case "gl_inj":
      return (d.gl_inj as number | null) ?? null;
    case "thp":
      return (d.thp as number | null) ?? null;
    case "gas_rate":
      return (d.gas_rate as number | null) ?? null;
  }
}

export interface WindowCompare {
  metric: Metric;
  name: string;
  unit: string;
  base: number;
  now: number;
  changePct: number;
  changeAbs: number;
  calcId: string;
  evId: string;
  nBase: number;
  nNow: number;
}

/**
 * Compare a metric between the baseline window and the evaluation window.
 * Rows lacking the metric are skipped (and counted) — never imputed.
 */
export function compareWindows(
  ctx: AgentContext,
  well: string,
  rows: ActiveRow[],
  baseDates: Set<string>,
  evalDates: Set<string>,
  m: Metric,
): WindowCompare | null {
  const T = ctx.L;
  const spec = (T("vi", "en") === "en" ? LABEL_EN : LABEL)[m];
  const base = rows.filter((r) => baseDates.has(r.data.report_date as string)).map((r) => ({ r, v: metricValue(r, m) }));
  const now = rows.filter((r) => evalDates.has(r.data.report_date as string)).map((r) => ({ r, v: metricValue(r, m) }));
  const b = base.filter((x) => x.v !== null);
  const n = now.filter((x) => x.v !== null);
  if (b.length === 0 || n.length === 0) return null;
  const baseMean = mean(b.map((x) => x.v!));
  const nowMean = mean(n.map((x) => x.v!));
  const changeAbs = nowMean - baseMean;
  const changePct = baseMean === 0 ? 0 : (changeAbs / baseMean) * 100;
  const skipped = base.length + now.length - b.length - n.length;
  const calcId = recordCalc(ctx.db, {
    label: T(`${spec.name} ${well}: baseline vs hiện tại`, `${spec.name} ${well}: baseline vs current`),
    formula: T(`${spec.formula}; Δ = TB(hiện tại) − TB(baseline); Δ% = Δ / TB(baseline) × 100${skipped ? ` (bỏ qua ${skipped} ngày thiếu dữ liệu)` : ""}`, `${spec.formula}; Δ = mean(current) − mean(baseline); Δ% = Δ / mean(baseline) × 100${skipped ? ` (${skipped} day(s) without data skipped)` : ""}`),
    inputs: [
      ...b.map((x) => ({ name: `baseline ${x.r.data.report_date}`, value: r1(x.v!), unit: spec.unit, ref: { kind: "data_row" as const, id: x.r.id } })),
      ...n.map((x) => ({ name: `${T("hiện tại", "current")} ${x.r.data.report_date}`, value: r1(x.v!), unit: spec.unit, ref: { kind: "data_row" as const, id: x.r.id } })),
    ],
    result: r1(changePct),
    unit: "%",
  });
  const evId = ctx.o.ev(
    `${spec.name} ${well}: ${r1(baseMean)} → ${r1(nowMean)} ${spec.unit} (${changeAbs >= 0 ? "+" : ""}${r1(m === "water_cut" ? changeAbs : changePct)}${m === "water_cut" ? T(" điểm %", " pp") : "%"})`,
    { kind: "calc", id: calcId },
  );
  return { metric: m, name: spec.name, unit: spec.unit, base: r1(baseMean), now: r1(nowMean), changePct: r1(changePct), changeAbs: r1(changeAbs), calcId, evId, nBase: b.length, nNow: n.length };
}

export interface DetectionFacts {
  asOf: string;
  thresholdPct: number;
  consecutiveDays: number;
  well: {
    well: string;
    platform: string;
    baseline: { value: number; calcId: string; rowIds: number[]; mode: string; from?: string; to?: string };
    days: Array<{ date: string; rowId: number; oilRaw: number; uptime: number; oilNorm: number | null; dropPct: number | null; rawDropPct?: number | null; calcId: string | null }>;
    minDropPct: number;
    summaryCalcId: string;
  };
  dprImportId: number;
}

export function windowDates(det: DetectionFacts): { base: Set<string>; evalD: Set<string> } {
  const base = new Set<string>();
  if (det.well.baseline.from && det.well.baseline.to) {
    for (let d = det.well.baseline.from; d <= det.well.baseline.to; ) {
      base.add(d);
      const x = new Date(d + "T00:00:00Z");
      x.setUTCDate(x.getUTCDate() + 1);
      d = x.toISOString().slice(0, 10);
    }
  }
  return { base, evalD: new Set(det.well.days.map((x) => x.date)) };
}
