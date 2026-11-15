import type { AgentContext } from "./kit";
import { rowRef } from "./kit";

export interface MaterialNeed {
  part_no: string;
  description: string;
  activity: string;
  qty: number;
  qtyOffshore: number | null;
  qtyOnshore: number | null;
  needsTransport: boolean;
  needsPurchase: boolean;
  leadTimeDays: number | null;
  weightT: number | null;
  deckM2: number | null;
  rowId: number | null;
  evId: string;
}

/** Parse "PART-NO:2" (qty defaults to 1). */
export function parseMaterial(s: string): { part: string; qty: number } {
  const [part, q] = s.split(":");
  return { part: part.trim(), qty: q ? Number(q) || 1 : 1 };
}

/** Stock check for the materials listed by catalog activities. */
export function checkMaterials(ctx: AgentContext, activityTypes: string[]): MaterialNeed[] {
  const o = ctx.o;
  const catalog = ctx.index("activity_catalog", "activity_type");
  const parts = ctx.index("spare_parts", "part_no");
  const out: MaterialNeed[] = [];
  for (const t of activityTypes) {
    const act = catalog.get(t);
    if (!act) continue;
    for (const m of ((act.data.materials as string[] | null) ?? []).map(parseMaterial)) {
      const p = parts.get(m.part);
      if (!p) {
        const ev = o.ev(ctx.L(`Hoạt động ${act.data.name} cần ${m.part} ×${m.qty}`, `Activity ${act.data.name} needs ${m.part} ×${m.qty}`), rowRef(act));
        o.need({ description: ctx.L(`Vật tư ${m.part} (cho ${act.data.name}) không có trong danh mục tồn kho — cần xác nhận mã và nguồn`, `Material ${m.part} (for ${act.data.name}) is not in the stock list — confirm the code and source`), datasetType: "spare_parts", blocking: false, owner: ctx.L("Kho / Bảo dưỡng", "Stores / Maintenance") });
        out.push({ part_no: m.part, description: m.part, activity: t, qty: m.qty, qtyOffshore: null, qtyOnshore: null, needsTransport: false, needsPurchase: true, leadTimeDays: null, weightT: null, deckM2: null, rowId: null, evId: ev });
        continue;
      }
      const off = (p.data.qty_offshore as number | null) ?? 0;
      const on = (p.data.qty_onshore as number | null) ?? 0;
      const needsTransport = off < m.qty && on + off >= m.qty;
      const needsPurchase = on + off < m.qty;
      const where = !needsTransport && !needsPurchase ? ctx.L("có sẵn ngoài giàn", "available offshore") : needsTransport ? ctx.L("có ở kho bờ — cần vận chuyển", "in onshore stores — transport needed") : ctx.L("không đủ tồn kho — cần mua", "not enough stock — purchase needed");
      const ev = o.ev(ctx.L(`${m.part} (${p.data.description}): cần ${m.qty}, ngoài giàn ${off}, kho bờ ${on} → ${where}`, `${m.part} (${p.data.description}): need ${m.qty}, offshore ${off}, onshore ${on} → ${where}`), rowRef(p));
      out.push({
        part_no: m.part,
        description: p.data.description as string,
        activity: t,
        qty: m.qty,
        qtyOffshore: off,
        qtyOnshore: on,
        needsTransport,
        needsPurchase,
        leadTimeDays: (p.data.lead_time_days as number | null) ?? null,
        weightT: (p.data.weight_t as number | null) ?? null,
        deckM2: (p.data.deck_m2 as number | null) ?? null,
        rowId: p.id,
        evId: ev,
      });
    }
  }
  return out;
}
