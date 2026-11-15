import type { AgentContext, AgentDef } from "./kit";
import { todayIso } from "../clock";
import { mdTable, docFooter, rowRef } from "./kit";
import { checkMaterials } from "./materials";
import { recordCalc, usd } from "../calc";
import { nowIso } from "../db";

const NAME = "Contracts & Procurement AI (Hợp đồng & mua sắm)";

export interface PricedLine {
  activity: string;
  item: string;
  qty: number;
  unit: string;
  unitPrice: number;
  amount: number;
  basis: string; // "Đơn giá HĐ …" | "Báo giá …" | "Ước tính …"
  documented: boolean;
  costCode: string | null;
  evId?: string;
}

function qtyFor(unit: string, crew: number, days: number): number {
  const u = unit.toLowerCase();
  if (u.includes("person") || u.includes("người")) return crew * days;
  if (u.includes("day") || u.includes("ngày")) return days;
  return 1;
}

function run(ctx: AgentContext): void {
  const o = ctx.o;
  const T = ctx.L;
  const UNIT = T("đv", "unit");
  const today = todayIso();
  const minQuotes = ctx.cfg.procurement.minQuotes;
  if (ctx.feedback) o.warn(T(`Phản hồi của người duyệt (${ctx.feedback.actor}): "${ctx.feedback.comment}" — đã xem xét khi chạy lại.`, `Approver feedback (${ctx.feedback.actor}): "${ctx.feedback.comment}" — considered in this re-run.`));
  ctx.noteUntrustedDocs();

  const proposalRun = ctx.up("ops.proposal")!;
  o.ev(T(`Phương án đã duyệt kỹ thuật: ${proposalRun.output.summary}`, `Technically approved option: ${proposalRun.output.summary}`), { kind: "task_run", id: proposalRun.runId });
  const activities = ((proposalRun.output.facts.activities as Array<{ type: string; name: string }>) ?? []);
  const catalog = ctx.index("activity_catalog", "activity_type");
  const contracts = ctx.index("contracts", "scope_categories");
  const rates = ctx.index("rate_sheet", "contract_no");
  const quotes = ctx.index("quotes", "part_no");
  const estimates = ctx.index("cost_estimates", "item");
  const lines: PricedLine[] = [];
  const rfqs: Array<{ subject: string; reason: string; vendor: string }> = [];
  /** Items without any price: kept visible — never counted as 0 */
  const unpriced: Array<{ activity: string; item: string; qty: number; reason: string }> = [];
  const quoteStatus: Array<{ part: string; quotes: number; min: number; met: boolean }> = [];
  const ceilingIssues: string[] = [];

  const estimateLine = (activity: string, item: string, qty: number, costCode: string | null): void => {
    const est = estimates.get(item);
    if (!est) {
      unpriced.push({ activity, item, qty, reason: T("chưa có đơn giá hợp đồng, báo giá hay ước tính", "no contract rate, quote or estimate") });
      o.need({ description: T(`Chưa có giá cho "${item}" (${activity}) — tổng chi phí CHƯA ĐẦY ĐỦ; RFQ có thể gửi để lấy giá`, `No price for "${item}" (${activity}) — total cost INCOMPLETE; an RFQ can be sent for a price`), datasetType: "cost_estimates", blocking: false, owner: T("Hợp đồng & Mua sắm", "Contracts & Procurement") });
      return;
    }
    const unitPrice = est.data.estimate_usd as number;
    const evId = o.ev(T(`Ước tính ${item}: ${usd(unitPrice)}/${est.data.unit ?? "đv"} — cơ sở: ${est.data.basis}`, `Estimate ${item}: ${usd(unitPrice)}/${est.data.unit ?? UNIT} — basis: ${est.data.basis}`), rowRef(est));
    lines.push({ activity, item, qty, unit: (est.data.unit as string) ?? UNIT, unitPrice, amount: unitPrice * qty, basis: T(`Ước tính (${est.data.basis})`, `Estimate (${est.data.basis})`), documented: false, costCode, evId });
  };

  // ── Services: contract coverage and rate sheet ──
  for (const a of activities) {
    const c = catalog.get(a.type);
    if (!c) continue;
    const category = c.data.contract_category as string | null;
    const crew = (c.data.crew_size as number | null) ?? 0;
    const days = (c.data.duration_days as number | null) ?? 0;
    const costCode = (c.data.cost_code as string | null) ?? null;
    if (!category) {
      o.conclude(T(`${a.name}: thực hiện bằng nguồn lực nội bộ, không phát sinh hợp đồng dịch vụ.`, `${a.name}: done with internal resources, no service contract needed.`), "check", [o.ev(T(`Danh mục: ${a.name} không có hạng mục hợp đồng`, `Catalog: ${a.name} has no contract category`), rowRef(c))]);
      continue;
    }
    const covering = contracts.all(category);
    const valid = covering.filter((k) => (!k.data.valid_from || (k.data.valid_from as string) <= today) && (!k.data.valid_to || (k.data.valid_to as string) >= today));
    const expired = covering.filter((k) => !valid.includes(k));
    if (!valid.length) {
      const evs = expired.map((k) => o.ev(T(`${k.data.contract_no} (${k.data.vendor}) phạm vi ${category} — hiệu lực đến ${k.data.valid_to}`, `${k.data.contract_no} (${k.data.vendor}) scope ${category} — valid to ${k.data.valid_to}`), rowRef(k)));
      o.conclude(T(`${a.name}: không có hợp đồng còn hiệu lực cho "${category}" — cần RFQ.`, `${a.name}: no valid contract for "${category}" — RFQ needed.`), "check", evs);
      rfqs.push({ subject: T(`Dịch vụ ${a.name}`, `Service ${a.name}`), reason: T(`Không có hợp đồng hiệu lực cho ${category}`, `No valid contract for ${category}`), vendor: T("Nhà thầu đủ năng lực (Mua sắm chỉ định)", "Qualified contractor (to be named by Procurement)") });
      estimateLine(a.name, a.type, 1, costCode);
      continue;
    }
    const k = valid[0];
    const evK = o.ev(T(`Hợp đồng ${k.data.contract_no} — ${k.data.vendor}, phạm vi ${(k.data.scope_categories as string[]).join(", ")}, hiệu lực đến ${k.data.valid_to}`, `Contract ${k.data.contract_no} — ${k.data.vendor}, scope ${(k.data.scope_categories as string[]).join(", ")}, valid to ${k.data.valid_to}`), rowRef(k));
    const items = rates.all(k.data.contract_no).filter((r) => r.data.applies_to === a.type || !r.data.applies_to);
    if (!items.length) {
      o.conclude(T(`${a.name}: hợp đồng ${k.data.contract_no} không có đơn giá phù hợp trong rate sheet.`, `${a.name}: contract ${k.data.contract_no} has no matching rate in the rate sheet.`), "check", [evK]);
      estimateLine(a.name, a.type, 1, costCode);
      continue;
    }
    let subtotal = 0;
    for (const r of items) {
      const qty = qtyFor(r.data.unit as string, crew, days);
      const price = r.data.rate_usd as number;
      const evR = o.ev(`${r.data.item_code} ${r.data.description}: ${usd(price)}/${r.data.unit} (rate sheet ${k.data.contract_no})`, rowRef(r));
      lines.push({ activity: a.name, item: `${r.data.item_code} ${r.data.description}`, qty, unit: r.data.unit as string, unitPrice: price, amount: price * qty, basis: T(`Đơn giá HĐ ${k.data.contract_no}`, `Contract rate ${k.data.contract_no}`), documented: true, costCode, evId: evR });
      subtotal += price * qty;
    }
    o.conclude(T(`${a.name}: thuộc phạm vi hợp đồng ${k.data.contract_no}; ${items.length} đơn giá có chứng từ, tạm tính ${usd(subtotal)}${days ? ` (SL theo danh mục: ${crew ? `${crew} người, ` : ""}${days} ngày)` : ""}.`, `${a.name}: within contract ${k.data.contract_no}; ${items.length} documented rate(s), provisional ${usd(subtotal)}${days ? ` (quantities per catalog: ${crew ? `${crew} persons, ` : ""}${days} days)` : ""}.`), "calculated", [evK, ...lines.filter((l) => l.activity === a.name).map((l) => l.evId!)]);
    const ceiling = k.data.ceiling_usd as number | null;
    const committed = (k.data.committed_usd as number | null) ?? 0;
    if (ceiling !== null) {
      const remaining = ceiling - committed;
      const cid = recordCalc(ctx.db, {
        label: T(`Giá trị còn lại HĐ ${k.data.contract_no}`, `Remaining value, contract ${k.data.contract_no}`),
        formula: T("còn lại = trần hợp đồng − đã cam kết; so với giá trị đề xuất", "remaining = contract ceiling − committed; compared with the proposed value"),
        inputs: [
          { name: T("trần", "ceiling"), value: ceiling, unit: "USD", ref: rowRef(k) },
          { name: T("đã cam kết", "committed"), value: committed, unit: "USD", ref: rowRef(k) },
          { name: T("đề xuất", "proposed"), value: subtotal, unit: "USD" },
        ],
        result: remaining - subtotal,
        unit: "USD",
      });
      const ev = o.ev(T(`HĐ ${k.data.contract_no}: còn ${usd(remaining)} trước đề xuất, ${usd(remaining - subtotal)} sau đề xuất`, `Contract ${k.data.contract_no}: ${usd(remaining)} remaining before, ${usd(remaining - subtotal)} after the proposal`), { kind: "calc", id: cid });
      if (remaining < subtotal) {
        o.conclude(T(`Giá trị đề xuất vượt phần còn lại của trần hợp đồng ${k.data.contract_no}.`, `The proposed value exceeds the remaining ceiling of contract ${k.data.contract_no}.`), "calculated", [ev]);
        ceilingIssues.push(T(`HĐ ${k.data.contract_no}: còn ${usd(remaining)}, đề xuất ${usd(subtotal)}`, `Contract ${k.data.contract_no}: ${usd(remaining)} remaining, ${usd(subtotal)} proposed`));
        o.need({ description: T(`Cần điều chỉnh trần hợp đồng ${k.data.contract_no} hoặc phương án mua sắm khác`, `Contract ${k.data.contract_no} ceiling must be raised, or another procurement route used`), blocking: false, owner: T("Hợp đồng", "Contracts") });
      }
    }
  }

  // ── Materials: stock vs purchase, quotes vs estimates ──
  const materials = checkMaterials(ctx, activities.map((a) => a.type));
  const comparisons: Array<{ part: string; rows: Array<[string, string, string, string, string]> }> = [];
  for (const m of materials.filter((x) => x.needsPurchase)) {
    const costCode = (catalog.get(m.activity)?.data.cost_code as string | null) ?? null;
    const qs = quotes.all(m.part_no).filter((q) => !q.data.valid_to || (q.data.valid_to as string) >= today);
    const qtyBuy = m.qty - (m.qtyOffshore ?? 0) - (m.qtyOnshore ?? 0);
    const evQs = qs.map((q) => {
      const linked = ctx.caseDocs.find((d) => q.data.document_ref && d.title.includes(String(q.data.document_ref)));
      const ev = o.ev(T(`Báo giá ${q.data.vendor} (${q.data.rfq_ref}): ${usd(q.data.unit_price_usd as number)}/đv, lead time ${q.data.lead_time_days ?? "?"} ngày`, `Quote ${q.data.vendor} (${q.data.rfq_ref}): ${usd(q.data.unit_price_usd as number)}/unit, lead time ${q.data.lead_time_days ?? "?"} days`), rowRef(q));
      if (linked) o.ev(T(`Chứng từ báo giá: ${linked.title}`, `Quote document: ${linked.title}`), { kind: "document", id: linked.id });
      return ev;
    });
    if (qs.length) {
      const best = [...qs].sort((a, b) => (a.data.unit_price_usd as number) - (b.data.unit_price_usd as number))[0];
      lines.push({ activity: m.activity, item: `${m.part_no} ${m.description}`, qty: qtyBuy, unit: UNIT, unitPrice: best.data.unit_price_usd as number, amount: (best.data.unit_price_usd as number) * qtyBuy, basis: T(`Báo giá ${best.data.vendor} ${best.data.rfq_ref}`, `Quote ${best.data.vendor} ${best.data.rfq_ref}`), documented: true, costCode, evId: evQs[qs.indexOf(best)] });
      comparisons.push({ part: m.part_no, rows: qs.map((q) => [String(q.data.vendor), usd(q.data.unit_price_usd as number), String(q.data.lead_time_days ?? "—"), String(q.data.valid_to ?? "—"), q === best ? T("Thấp nhất", "Lowest") : ""]) });
      o.conclude(T(`${m.part_no}: ${qs.length} chào giá hợp lệ; thấp nhất ${usd(best.data.unit_price_usd as number)} (${best.data.vendor}) — giá thấp nhất dùng để dự toán, KHÔNG tự đồng nghĩa nhà cung cấp được chọn (cần so phạm vi, lead time, hiệu lực, điều kiện thương mại).`, `${m.part_no}: ${qs.length} valid quote(s); lowest ${usd(best.data.unit_price_usd as number)} (${best.data.vendor}) — the lowest price is used for the estimate and does NOT by itself select the supplier (scope, lead time, validity and commercial terms must be compared).`), "check", evQs);
      quoteStatus.push({ part: m.part_no, quotes: qs.length, min: minQuotes, met: qs.length >= minQuotes });
      if (qs.length < minQuotes) {
        o.conclude(T(`${m.part_no}: chưa đủ số chào giá theo quy định (${qs.length}/${minQuotes}).`, `${m.part_no}: not enough quotes per policy (${qs.length}/${minQuotes}).`), "check", evQs);
        o.need({ description: T(`${m.part_no}: cần thêm ${minQuotes - qs.length} chào giá (chính sách ${ctx.cfg.policy.version}: tối thiểu ${minQuotes}) — chặn bước cam kết trừ khi có ngoại lệ đúng thẩm quyền`, `${m.part_no}: ${minQuotes - qs.length} more quote(s) needed (policy ${ctx.cfg.policy.version}: minimum ${minQuotes}) — blocks the commitment step unless a properly authorised waiver is recorded`), datasetType: "quotes", blocking: false, owner: T("Mua sắm", "Procurement") });
        rfqs.push({ subject: `${m.part_no} ${m.description} ×${qtyBuy}`, reason: T(`Bổ sung chào giá (${qs.length}/${minQuotes})`, `Additional quote (${qs.length}/${minQuotes})`), vendor: T("Nhà cung cấp bổ sung (Mua sắm chỉ định)", "Additional supplier (to be named by Procurement)") });
      }
    } else {
      o.conclude(T(`${m.part_no}: chưa có chào giá — dùng giá ước tính (nếu có), cần RFQ.`, `${m.part_no}: no quote yet — estimated price used (if any), RFQ needed.`), "check", [m.evId]);
      quoteStatus.push({ part: m.part_no, quotes: 0, min: minQuotes, met: false });
      rfqs.push({ subject: `${m.part_no} ${m.description} ×${qtyBuy}`, reason: T("Chưa có chào giá", "No quote yet"), vendor: T("Nhà cung cấp (Mua sắm chỉ định)", "Supplier (to be named by Procurement)") });
      estimateLine(m.activity, m.part_no, qtyBuy, costCode);
    }
  }
  const fromStock = materials.filter((x) => !x.needsPurchase);
  if (fromStock.length) o.assume(T(`Vật tư xuất từ tồn kho (${fromStock.map((x) => x.part_no).join(", ")}) không tính chi phí mua mới.`, `Materials issued from stock (${fromStock.map((x) => x.part_no).join(", ")}) carry no purchase cost.`));

  const documented = lines.filter((l) => l.documented).reduce((s, l) => s + l.amount, 0);
  const estimated = lines.filter((l) => !l.documented).reduce((s, l) => s + l.amount, 0);
  const total = documented + estimated;
  const totalCalc = recordCalc(ctx.db, {
    label: T("Tổng chi phí mua sắm/dịch vụ", "Total procurement / services cost"),
    formula: T("tổng = Σ (SL × đơn giá); tách phần có chứng từ (HĐ/báo giá) và phần ước tính", "total = Σ (qty × unit price); documented (contract/quote) and estimated parts kept apart"),
    inputs: lines.map((l) => ({ name: `${l.item} (${l.documented ? T("chứng từ", "documented") : T("ước tính", "estimated")})`, value: l.amount, unit: "USD" })),
    result: total,
    unit: "USD",
  });
  const evTotal = o.ev(T(`Tổng đã định giá ${usd(total)} = chứng từ ${usd(documented)} + ước tính ${usd(estimated)}${unpriced.length ? ` — CHƯA ĐẦY ĐỦ, ${unpriced.length} hạng mục chưa có giá` : ""}`, `Total priced ${usd(total)} = documented ${usd(documented)} + estimated ${usd(estimated)}${unpriced.length ? ` — INCOMPLETE, ${unpriced.length} item(s) unpriced` : ""}`), { kind: "calc", id: totalCalc });
  o.conclude(
    unpriced.length
      ? T(`Dự toán sơ bộ CHƯA ĐẦY ĐỦ: đã định giá ${usd(total)} (chứng từ ${usd(documented)}, ước tính ${usd(estimated)}); chưa có giá: ${unpriced.map((u) => u.item).join(", ")}.`, `Preliminary estimate INCOMPLETE: ${usd(total)} priced (documented ${usd(documented)}, estimated ${usd(estimated)}); unpriced: ${unpriced.map((u) => u.item).join(", ")}.`)
      : T(`Dự toán ${usd(total)}: có chứng từ ${usd(documented)}, ước tính ${usd(estimated)}.`, `Estimate ${usd(total)}: documented ${usd(documented)}, estimated ${usd(estimated)}.`),
    "calculated",
    [evTotal],
  );

  const rfqDocs = rfqs.map((r, i) => {
    const d = ctx.saveDoc(
      `rfq-${i + 1}`,
      T(`RFQ nháp: ${r.subject}`, `Draft RFQ: ${r.subject}`),
      "rfq_draft",
      T(
        `# BẢN NHÁP Yêu cầu báo giá (RFQ) — ${ctx.workflow.case_no}\n\n**Gửi:** ${r.vendor}\n**Nội dung:** ${r.subject}\n**Lý do:** ${r.reason}\n\nYêu cầu: đơn giá, thời gian giao hàng, hiệu lực chào giá, điều kiện giao hàng ra căn cứ.\n\n> Bản nháp — chỉ được gửi sau khi người có thẩm quyền phê duyệt gửi trong Outbox.${docFooter(ctx, NAME)}`,
        `# DRAFT request for quotation (RFQ) — ${ctx.workflow.case_no}\n\n**To:** ${r.vendor}\n**Subject:** ${r.subject}\n**Reason:** ${r.reason}\n\nRequested: unit price, delivery time, quote validity, delivery terms to the supply base.\n\n> Draft — may be sent only after an authorised person approves sending it in the Outbox.${docFooter(ctx, "Contracts & Procurement AI")}`,
      ),
    );
    return { docId: d.docId, title: d.title, vendor: r.vendor };
  });
  // RFQ = request for prices, not a purchase commitment: available once the scope is approved
  const insRfq = ctx.db.prepare(
    "INSERT OR IGNORE INTO outbox (workflow_id, kind, title, recipient, doc_id, doc_sha256, status, created_at, case_revision, required_gate) VALUES (?, 'rfq', ?, ?, ?, ?, 'draft', ?, ?, 'gate.technical')",
  );
  for (const r of rfqDocs) {
    const sha = ctx.db.prepare("SELECT sha256 FROM documents WHERE id = ?").get(r.docId)?.sha256 as string;
    insRfq.run(ctx.workflow.id, `${r.title} · rev ${ctx.revision}`, r.vendor, r.docId, sha, nowIso(), ctx.revision);
  }
  if (rfqDocs.length) o.conclude(T(`Lập ${rfqDocs.length} RFQ nháp trong Outbox — chỉ cần phạm vi đã duyệt để gửi xin giá; RFQ không phải cam kết mua.`, `${rfqDocs.length} draft RFQ(s) placed in the Outbox — sending one needs only the approved scope; an RFQ is not a purchase commitment.`), "check", rfqDocs.map((r) => o.ev(T(`RFQ nháp: ${r.title}`, `Draft RFQ: ${r.title}`), { kind: "document", id: r.docId })));
  if (comparisons.length) {
    ctx.saveDoc(
      "quote-comparison",
      T(`Bảng so sánh chào giá — ${ctx.workflow.case_no}`, `Quote comparison — ${ctx.workflow.case_no}`),
      "quote_comparison",
      `${T("# Bảng so sánh chào giá", "# Quote comparison")}\n\n${comparisons.map((c) => `## ${c.part}\n\n${mdTable([...T("Nhà cung cấp|Đơn giá|Lead time (ngày)|Hiệu lực", "Supplier|Unit price|Lead time (days)|Valid to").split("|"), ""], c.rows)}`).join("\n\n")}${docFooter(ctx, T(NAME, "Contracts & Procurement AI"))}`,
    );
  }
  const pr = ctx.saveDoc(
    "procurement-proposal",
    T(`Đề xuất mua sắm (PR nháp) — ${ctx.workflow.case_no}`, `Purchase requisition (draft PR) — ${ctx.workflow.case_no}`),
    "procurement_proposal",
    `${T("# Đề xuất mua sắm (bản nháp)", "# Purchase requisition (draft)")} — ${ctx.workflow.case_no}\n\n${mdTable(
      T("Hoạt động|Hạng mục|SL|ĐVT|Đơn giá|Thành tiền|Cơ sở giá|Mã chi phí", "Activity|Item|Qty|Unit|Unit price|Amount|Price basis|Cost code").split("|"),
      lines.map((l) => [l.activity, l.item, l.qty, l.unit, usd(l.unitPrice), usd(l.amount), l.basis, l.costCode ?? "—"]),
    )}\n\n${T(`- **Có chứng từ:** ${usd(documented)}\n- **Ước tính (chưa có chứng từ):** ${usd(estimated)}\n- **Tổng đã định giá:** ${usd(total)}${unpriced.length ? `\n- **CHƯA ĐẦY ĐỦ — chưa có giá:** ${unpriced.map((u) => `${u.item} ×${u.qty} (${u.activity})`).join("; ")}` : ""}\n\n> PR là đề nghị mua, chỉ lập bản nháp gửi sau khi **duyệt cam kết**. Không phát hành PO. RFQ đã có trong Outbox (cần phạm vi đã duyệt).`, `- **Documented:** ${usd(documented)}\n- **Estimated (no document):** ${usd(estimated)}\n- **Total priced:** ${usd(total)}${unpriced.length ? `\n- **INCOMPLETE — unpriced:** ${unpriced.map((u) => `${u.item} ×${u.qty} (${u.activity})`).join("; ")}` : ""}\n\n> A PR is a request to buy; the draft may be sent only after **commitment approval**. No PO is issued. The RFQ is already in the Outbox (needs the approved scope).`)}${docFooter(ctx, T(NAME, "Contracts & Procurement AI"))}`,
  );
  o.next(T("Chuyển đề xuất mua sắm sang Tài chính kiểm tra ngân sách", "Pass the purchase requisition to Finance for the budget check"));
  o.summary = T(`Đối chiếu ${activities.length} hoạt động với hợp đồng/rate sheet; tổng đã định giá ${usd(total)}${unpriced.length ? ` (CHƯA ĐẦY ĐỦ: ${unpriced.length} hạng mục chưa có giá)` : ""}; ${rfqs.length} RFQ nháp; chào giá ${quoteStatus.filter((q) => q.met).length}/${quoteStatus.length} hạng mục đạt tối thiểu.`, `Checked ${activities.length} activities against contracts / rate sheets; total priced ${usd(total)}${unpriced.length ? ` (INCOMPLETE: ${unpriced.length} item(s) unpriced)` : ""}; ${rfqs.length} draft RFQ(s); quotes meet the minimum for ${quoteStatus.filter((q) => q.met).length}/${quoteStatus.length} item(s).`);
  o.facts = {
    lines: lines.map(({ evId: _e, ...l }) => l),
    documented,
    estimated,
    total,
    rfqDocs,
    prDocId: pr.docId,
    unpriced,
    quoteStatus,
    ceilingIssues,
    costComplete: !unpriced.length,
    materials: materials.map(({ evId: _e, ...m }) => m),
  };
}

export const contractsAgent: AgentDef = { id: "contracts_agent", name: NAME, room: "zone_contracts", run };
