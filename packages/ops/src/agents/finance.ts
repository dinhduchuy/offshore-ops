import { roleText } from "../lang";
import type { AgentContext, AgentDef } from "./kit";
import { todayIso } from "../clock";
import { mdTable, docFooter, rowRef } from "./kit";
import { recordCalc, usd, fmt } from "../calc";
import type { PricedLine } from "./contracts";
import { heldByOthers, hold, releaseOtherKeys } from "../resources";

const NAME = "Finance / Cost Control AI (Tài chính & kiểm soát chi phí)";

function run(ctx: AgentContext): void {
  const o = ctx.o;
  const T = ctx.L;
  const FIN = T("Tài chính", "Finance");
  const UNASSIGNED = T("(chưa gán)", "(unassigned)");
  if (ctx.feedback) o.warn(T(`Phản hồi của người duyệt (${ctx.feedback.actor}): "${ctx.feedback.comment}" — đã xem xét khi chạy lại.`, `Approver feedback (${ctx.feedback.actor}): "${ctx.feedback.comment}" — considered in this re-run.`));
  const procRun = ctx.up("proc.prep");
  const logRun = ctx.up("log.plan");
  const evProc = procRun ? o.ev(T(`Dự toán mua sắm: ${procRun.output.summary}`, `Procurement estimate: ${procRun.output.summary}`), { kind: "task_run", id: procRun.runId }) : null;
  const evLog = logRun ? o.ev(T(`Kế hoạch hậu cần: ${logRun.output.summary}`, `Logistics plan: ${logRun.output.summary}`), { kind: "task_run", id: logRun.runId }) : null;
  // Either input may be a skipped step (no purchase / no transport): its output is then a skip record without lines
  const lines: PricedLine[] = [...((procRun?.output.facts.lines as PricedLine[]) ?? []), ...((logRun?.output.facts.costLines as PricedLine[]) ?? [])];
  type Unpriced = { activity: string; item: string; qty: number; reason: string };
  const unpricedItems: Unpriced[] = [...((procRun?.output.facts.unpriced as Unpriced[]) ?? []), ...((logRun?.output.facts.unpriced as Unpriced[]) ?? [])];
  const unpriced = unpricedItems.map((u) => `${u.item} ×${u.qty} (${u.activity}: ${u.reason})`);
  const costComplete = unpriced.length === 0;

  const documented = lines.filter((l) => l.documented).reduce((s, l) => s + l.amount, 0);
  const estimated = lines.filter((l) => !l.documented).reduce((s, l) => s + l.amount, 0);
  const total = documented + estimated;
  const totalCalc = recordCalc(ctx.db, {
    label: T("Tổng giá trị đề xuất (mua sắm + hậu cần)", "Total proposed value (procurement + logistics)"),
    formula: T("Σ thành tiền các hạng mục; tách có chứng từ / ước tính", "Σ item amounts; documented / estimated kept apart"),
    inputs: lines.map((l) => ({ name: `${l.activity}: ${l.item}`, value: l.amount, unit: "USD" })),
    result: total,
    unit: "USD",
  });
  const evTotal = o.ev(T(`Tổng đã định giá ${usd(total)} (chứng từ ${usd(documented)}, ước tính ${usd(estimated)})${costComplete ? "" : ` — CHƯA ĐẦY ĐỦ (${unpriced.length} hạng mục chưa có giá)`}`, `Total priced ${usd(total)} (documented ${usd(documented)}, estimated ${usd(estimated)})${costComplete ? "" : ` — INCOMPLETE (${unpriced.length} item(s) unpriced)`}`), { kind: "calc", id: totalCalc });
  const evIn = [evTotal, evProc, evLog].filter((x): x is string => !!x);
  o.conclude(
    costComplete
      ? T(`Tổng giá trị đề xuất ${usd(total)} (đầy đủ); phần ước tính chưa có chứng từ chiếm ${total ? fmt((estimated / total) * 100, 1) : "0"}%.`, `Total proposed value ${usd(total)} (complete); the estimated, undocumented part is ${total ? fmt((estimated / total) * 100, 1) : "0"}%.`)
      : T(`Tổng chi phí CHƯA ĐẦY ĐỦ: đã định giá ${usd(total)}; chưa có giá: ${unpriced.join("; ")}. Phần thiếu KHÔNG được tính bằng 0 — chưa thể kết luận trong/ngoài ngân sách cho toàn bộ phạm vi.`, `Total cost INCOMPLETE: ${usd(total)} priced; unpriced: ${unpriced.join("; ")}. Missing items are NOT counted as 0 — within/over budget cannot be concluded for the whole scope.`),
    "calculated",
    evIn,
  );

  // Budget per cost code
  const budget = ctx.index("budget", "cost_code");
  if (!budget.size) o.need({ description: T("Chưa có dữ liệu ngân sách/chi phí/cam kết (budget)", "No budget / cost / commitment data (budget)"), datasetType: "budget", blocking: true, owner: FIN });
  const year = todayIso().slice(0, 4);
  const byCode = new Map<string, PricedLine[]>();
  for (const l of lines) {
    const k = l.costCode ?? UNASSIGNED;
    if (!byCode.has(k)) byCode.set(k, []);
    byCode.get(k)!.push(l);
  }
  const perCostCode: Array<{ costCode: string; period: string; budget: number; actual: number; committed: number; available: number; heldByOthers: number; request: number; after: number; afe: string | null; hold: string }> = [];
  let overBudget = false;
  const shortfalls: string[] = [];
  const afeMissing: string[] = [];
  const keptHolds: string[] = [];
  /** Budget the plan in force needs (checked against the ledger at decision time) */
  const budgetHolds: Array<{ type: string; key: string; qty: number; unit: string }> = [];
  for (const [code, ls] of byCode) {
    const request = ls.reduce((s, l) => s + l.amount, 0);
    if (code === UNASSIGNED) {
      o.need({ description: T(`${ls.length} hạng mục (${usd(request)}) chưa có mã chi phí`, `${ls.length} item(s) (${usd(request)}) have no cost code`), datasetType: "activity_catalog", blocking: false, owner: FIN });
      continue;
    }
    const rows = budget.all(code);
    const row = rows.find((b) => String(b.data.period).includes(year)) ?? rows.sort((a, b) => String(b.data.period).localeCompare(String(a.data.period)))[0];
    if (!row) {
      o.need({ description: T(`Không có ngân sách cho mã chi phí ${code}`, `No budget for cost code ${code}`), datasetType: "budget", blocking: true, owner: FIN });
      continue;
    }
    const b = row.data.budget_usd as number;
    const a = row.data.actual_usd as number;
    const c = row.data.committed_usd as number;
    const available = b - a - c;
    const resKey = `${code}/${row.data.period}`;
    const others = heldByOthers(ctx.db, "budget", resKey, ctx.workflow.id);
    const after = available - others.qty - request;
    const cid = recordCalc(ctx.db, {
      label: T(`Ngân sách khả dụng ${code} (${row.data.period})`, `Available budget ${code} (${row.data.period})`),
      formula: T("khả dụng = ngân sách − thực chi − cam kết; sau đề xuất = khả dụng − phần case khác đang giữ − giá trị đề xuất", "available = budget − actual − committed; after proposal = available − held by other cases − proposed value"),
      inputs: [
        { name: T("ngân sách", "budget"), value: b, unit: "USD", ref: rowRef(row) },
        { name: T("thực chi", "actual"), value: a, unit: "USD", ref: rowRef(row) },
        { name: T("cam kết", "committed"), value: c, unit: "USD", ref: rowRef(row) },
        { name: T("case khác đang giữ", "held by other cases"), value: others.qty, unit: "USD" },
        { name: T("đề xuất", "proposed"), value: request, unit: "USD", ref: { kind: "calc", id: totalCalc } },
      ],
      result: after,
      unit: "USD",
    });
    const ev = o.ev(
      T(`${code}: ${usd(b)} − ${usd(a)} − ${usd(c)} = ${usd(available)} khả dụng${others.qty ? `; ${others.conflicts.map((x) => `${x.caseNo} giữ ${usd(x.quantity)}`).join(", ")}` : ""}; sau đề xuất ${usd(after)}`, `${code}: ${usd(b)} − ${usd(a)} − ${usd(c)} = ${usd(available)} available${others.qty ? `; ${others.conflicts.map((x) => `${x.caseNo} holds ${usd(x.quantity)}`).join(", ")}` : ""}; after proposal ${usd(after)}`),
      { kind: "calc", id: cid },
    );
    o.conclude(
      after >= 0
        ? T(`${code} (${row.data.description ?? ""}): khả dụng ${usd(available)}${others.qty ? ` (case khác giữ ${usd(others.qty)})` : ""}, đề xuất ${usd(request)} → còn ${usd(after)} (${fmt((after / b) * 100, 1)}% ngân sách năm).`, `${code} (${row.data.description ?? ""}): ${usd(available)} available${others.qty ? ` (other cases hold ${usd(others.qty)})` : ""}, proposed ${usd(request)} → ${usd(after)} left (${fmt((after / b) * 100, 1)}% of the annual budget).`)
        : T(`${code}: đề xuất ${usd(request)} VƯỢT phần khả dụng ${usd(available - others.qty)}${others.qty ? ` (sau ${usd(others.qty)} do ${others.conflicts.map((x) => x.caseNo).join(", ")} giữ)` : ""} — thiếu ${usd(-after)}.`, `${code}: proposed ${usd(request)} EXCEEDS the available ${usd(available - others.qty)}${others.qty ? ` (after ${usd(others.qty)} held by ${others.conflicts.map((x) => x.caseNo).join(", ")})` : ""} — short by ${usd(-after)}.`),
      "calculated",
      [ev],
    );
    let holdStatus = "—";
    if (after < 0) {
      overBudget = true;
      shortfalls.push(T(`${code}: thiếu ${usd(-after)}${others.qty ? ` (xung đột giữ chỗ với ${others.conflicts.map((x) => x.caseNo).join(", ")})` : ""}`, `${code}: short by ${usd(-after)}${others.qty ? ` (hold conflict with ${others.conflicts.map((x) => x.caseNo).join(", ")})` : ""}`));
      o.need({ description: T(`Mã ${code} thiếu ${usd(-after)} — cần điều chỉnh ngân sách hoặc ngoại lệ đúng thẩm quyền; duyệt giá trị chi KHÔNG tự bổ sung ngân sách`, `Code ${code} is short by ${usd(-after)} — a budget change or a properly authorised waiver is needed; approving the spend does NOT add budget`), blocking: false, owner: T("Tài chính / người có thẩm quyền", "Finance / authority holder") });
      holdStatus = T("không giữ được (thiếu)", "not held (shortfall)");
    } else {
      const h = hold(ctx.db, { workflowId: ctx.workflow.id, revision: ctx.revision, type: "budget", key: resKey, quantity: request, unit: "USD", capacity: available, taskId: ctx.task.id, holdDays: ctx.cfg.policy.holdDays });
      if (h.status === "held") {
        keptHolds.push(resKey);
        budgetHolds.push({ type: "budget", key: resKey, qty: request, unit: "USD" });
        holdStatus = T(`đã giữ ${usd(request)} (nội bộ)`, `${usd(request)} held (internal)`);
      } else {
        overBudget = true;
        shortfalls.push(T(`${code}: case khác vừa giữ phần khả dụng (${h.conflicts.map((x) => x.caseNo).join(", ")})`, `${code}: another case just held the available amount (${h.conflicts.map((x) => x.caseNo).join(", ")})`));
        holdStatus = T("xung đột giữ chỗ", "hold conflict");
      }
    }
    const afeReq = row.data.afe_required === true;
    const afe = (row.data.afe_no as string | null) ?? null;
    if (afeReq && !afe) {
      afeMissing.push(T(`${code}: yêu cầu AFE nhưng chưa có số AFE`, `${code}: AFE required but no AFE number`));
      o.need({ description: T(`Mã ${code} yêu cầu AFE nhưng chưa có số AFE — chặn cam kết`, `Code ${code} requires an AFE but has no AFE number — blocks the commitment`), datasetType: "budget", blocking: false, owner: FIN });
    }
    else if (afeReq) o.conclude(T(`${code} áp dụng AFE ${afe}.`, `${code} is covered by AFE ${afe}.`), "check", [o.ev(T(`AFE ${afe} cho ${code}`, `AFE ${afe} for ${code}`), rowRef(row))]);
    else o.conclude(T(`${code}: không áp dụng AFE theo dữ liệu ngân sách.`, `${code}: no AFE required per the budget data.`), "check", [o.ev(T(`${code}: afe_required = không`, `${code}: afe_required = no`), rowRef(row))]);
    perCostCode.push({ costCode: code, period: String(row.data.period), budget: b, actual: a, committed: c, available, heldByOthers: others.qty, request, after, afe, hold: holdStatus });
  }

  // Delegation of authority
  const doa = ctx.rows("authority_matrix").sort((a, b) => (a.data.max_usd as number) - (b.data.max_usd as number));
  let requiredApproverRole: string | null = null;
  if (!doa.length) o.need({ description: T("Chưa có ma trận thẩm quyền phê duyệt", "No delegation of authority matrix"), datasetType: "authority_matrix", blocking: true, owner: FIN });
  else {
    const hit = doa.find((d) => (d.data.max_usd as number) >= total);
    if (!hit) o.need({ description: T(`Tổng ${usd(total)} vượt mọi hạn mức trong ma trận thẩm quyền`, `Total ${usd(total)} exceeds every limit in the authority matrix`), blocking: true, owner: FIN });
    else {
      requiredApproverRole = hit.data.role as string;
      const cid = recordCalc(ctx.db, {
        label: T("Xác định cấp phê duyệt", "Approval level"),
        formula: T("cấp thấp nhất có hạn mức ≥ tổng giá trị", "lowest level whose limit ≥ the total value"),
        inputs: [{ name: T("tổng", "total"), value: total, unit: "USD", ref: { kind: "calc", id: totalCalc } }, ...doa.map((d) => ({ name: roleText(ctx.cfg, d.data.role as string), value: d.data.max_usd as number, unit: "USD", ref: rowRef(d) }))],
        result: hit.data.max_usd as number,
        unit: "USD",
      });
      o.conclude(
        T(`Theo ma trận thẩm quyền, giá trị ${usd(total)} thuộc thẩm quyền: ${requiredApproverRole} (hạn mức ${usd(hit.data.max_usd as number)})${costComplete ? "" : " — xác định trên phần ĐÃ định giá; có thể đổi khi đủ giá"}.`, `Per the authority matrix, ${usd(total)} falls under: ${roleText(ctx.cfg, requiredApproverRole ?? "")} (limit ${usd(hit.data.max_usd as number)})${costComplete ? "" : " — based on the priced part only; may change once fully priced"}.`),
        "check",
        [o.ev(T(`Ma trận thẩm quyền → ${requiredApproverRole}`, `Authority matrix → ${roleText(ctx.cfg, requiredApproverRole ?? "")}`), { kind: "calc", id: cid })],
      );
    }
  }

  // PSC cost recovery — only with terms AND confirmation
  const psc = ctx.rows("psc_terms");
  let pscConclusion: string;
  const clause = psc.find((p) => /opex|operating|well/i.test(String(p.data.cost_category)));
  if (!clause) {
    pscConclusion = T("Không kết luận khả năng thu hồi chi phí theo PSC: đầu vào không có điều khoản PSC áp dụng.", "No conclusion on PSC cost recovery: no applicable PSC clause in the inputs.");
    o.need({ description: T("Thiếu điều khoản PSC về thu hồi chi phí cho loại chi phí này và xác nhận của bộ phận PSC/Pháp chế", "The PSC cost-recovery clause for this cost type and the PSC/Legal confirmation are missing"), datasetType: "psc_terms", blocking: false, owner: T("Phòng Hợp đồng PSC / Pháp chế", "PSC contracts / Legal") });
    o.conclude(pscConclusion, "check", []);
  } else if (!clause.data.confirmed_by) {
    pscConclusion = T(`Có điều khoản ${clause.data.clause} nhưng chưa có xác nhận áp dụng — không kết luận khả năng thu hồi.`, `Clause ${clause.data.clause} exists but its applicability is not confirmed — no recovery conclusion.`);
    o.need({ description: T(`Điều khoản ${clause.data.clause} cần xác nhận áp dụng của bộ phận PSC`, `Clause ${clause.data.clause} needs PSC confirmation of applicability`), blocking: false, owner: T("Phòng Hợp đồng PSC", "PSC contracts") });
    o.conclude(pscConclusion, "check", [o.ev(T(`Điều khoản ${clause.data.clause}`, `Clause ${clause.data.clause}`), rowRef(clause))]);
  } else {
    pscConclusion = T(`Theo điều khoản ${clause.data.clause} (xác nhận bởi ${clause.data.confirmed_by}): ${clause.data.recoverable ? "thuộc chi phí được thu hồi" : "không thuộc chi phí được thu hồi"}.`, `Per clause ${clause.data.clause} (confirmed by ${clause.data.confirmed_by}): ${clause.data.recoverable ? "recoverable cost" : "not a recoverable cost"}.`);
    o.conclude(pscConclusion, "check", [o.ev(T(`Điều khoản ${clause.data.clause}`, `Clause ${clause.data.clause}`), rowRef(clause))]);
  }

  releaseOtherKeys(ctx.db, ctx.workflow.id, "budget", keptHolds, T("Dự toán đổi mã chi phí/kỳ", "Estimate changed cost code / period"));
  ctx.saveDoc(
    "budget-check",
    T(`Kiểm tra ngân sách & nguồn lực — ${ctx.workflow.case_no}`, `Budget & resource check — ${ctx.workflow.case_no}`),
    "budget_check",
    T("vi", "en") === "en"
      ? `# Budget & resource check — ${ctx.workflow.case_no} (rev ${ctx.revision})\n\n- Total priced: **${usd(total)}** (documented ${usd(documented)} · estimated ${usd(estimated)})${costComplete ? " — complete" : `\n- **INCOMPLETE** — unpriced: ${unpriced.join("; ")}`}\n- Approval level per the matrix: **${requiredApproverRole ? roleText(ctx.cfg, requiredApproverRole) : "not determined"}**\n\n${perCostCode.length ? mdTable(["Cost code", "Period", "Budget", "Actual", "Committed", "Available", "Held by other cases", "Proposed", "After proposal", "Hold", "AFE"], perCostCode.map((c) => [c.costCode, c.period, usd(c.budget), usd(c.actual), usd(c.committed), usd(c.available), usd(c.heldByOthers), usd(c.request), usd(c.after), c.hold, c.afe ?? "—"])) : "_None_"}\n\n**PSC:** ${pscConclusion}\n\n> A budget hold is internal, not a spending commitment. Approving the spend does not mean budget has been added.${docFooter(ctx, "Finance / Cost Control AI")}`
      : `# Kiểm tra ngân sách & nguồn lực — ${ctx.workflow.case_no} (rev ${ctx.revision})\n\n- Tổng đã định giá: **${usd(total)}** (chứng từ ${usd(documented)} · ước tính ${usd(estimated)})${costComplete ? " — đầy đủ" : `\n- **CHƯA ĐẦY ĐỦ** — chưa có giá: ${unpriced.join("; ")}`}\n- Cấp phê duyệt theo ma trận: **${requiredApproverRole ?? "chưa xác định"}**\n\n${perCostCode.length ? mdTable(["Mã chi phí", "Kỳ", "Ngân sách", "Thực chi", "Cam kết", "Khả dụng", "Case khác giữ", "Đề xuất", "Sau đề xuất", "Giữ chỗ", "AFE"], perCostCode.map((c) => [c.costCode, c.period, usd(c.budget), usd(c.actual), usd(c.committed), usd(c.available), usd(c.heldByOthers), usd(c.request), usd(c.after), c.hold, c.afe ?? "—"])) : "_Không có_"}\n\n**PSC:** ${pscConclusion}\n\n> Giữ chỗ ngân sách là nội bộ, không phải cam kết chi. Duyệt giá trị chi không có nghĩa ngân sách đã được bổ sung.${docFooter(ctx, NAME)}`,
  );
  o.summary = T("vi", "en") === "en"
    ? `Total ${usd(total)}${costComplete ? "" : " (INCOMPLETE)"}; ${overBudget ? `EXCEEDS the available budget: ${shortfalls.join("; ")}` : "within the available budget (internal hold placed)"}; approval level: ${requiredApproverRole ? roleText(ctx.cfg, requiredApproverRole) : "not determined"}${afeMissing.length ? "; AFE missing" : ""}. ${clause?.data.confirmed_by ? "" : "No PSC cost-recovery conclusion yet."}`
    : `Tổng ${usd(total)}${costComplete ? "" : " (CHƯA ĐẦY ĐỦ)"}; ${overBudget ? `VƯỢT phần khả dụng: ${shortfalls.join("; ")}` : "trong phần ngân sách khả dụng (đã giữ chỗ nội bộ)"}; cấp duyệt: ${requiredApproverRole ?? "chưa xác định"}${afeMissing.length ? `; thiếu AFE` : ""}. ${clause?.data.confirmed_by ? "" : "Chưa kết luận thu hồi chi phí PSC."}`;
  o.next(T("Chuyển kết quả kiểm tra ngân sách để lập hồ sơ trình duyệt cam kết", "Pass the budget check to prepare the commitment approval package"));
  o.facts = { total, documented, estimated, costComplete, unpriced, perCostCode, requiredApproverRole, overBudget, shortfalls, afeMissing, pscConclusion, holds: budgetHolds };
}

export const financeAgent: AgentDef = { id: "finance_agent", name: NAME, room: "zone_finance", run };
