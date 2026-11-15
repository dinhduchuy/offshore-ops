import type { Database } from "./db";
import { nowIso, sha256 } from "./db";
import type { TraceRef } from "./types";

export interface CalcInput {
  name: string;
  value: number | string | null;
  unit?: string;
  ref?: TraceRef;
}

/**
 * Persist a calculation (formula + every input with its source reference)
 * and return its id. Content-addressed: the same calculation on the same
 * inputs yields the same id, so re-runs don't duplicate records.
 */
export function recordCalc(
  db: Database,
  c: { label: string; formula: string; inputs: CalcInput[]; result: number | null; unit?: string },
): string {
  const body = JSON.stringify({ l: c.label, f: c.formula, i: c.inputs, r: c.result, u: c.unit ?? null });
  const id = "C" + sha256(body).slice(0, 16);
  db.prepare(
    "INSERT OR IGNORE INTO calcs (id, label, formula, inputs_json, result, unit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, c.label, c.formula, JSON.stringify(c.inputs), c.result, c.unit ?? null, nowIso());
  return id;
}

export const r1 = (n: number) => Math.round(n * 10) / 10;
export const r0 = (n: number) => Math.round(n);

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Pearson correlation; null when undefined (n<3 or zero variance). */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

export function fmt(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function usd(n: number): string {
  return "$" + fmt(n, 0);
}
