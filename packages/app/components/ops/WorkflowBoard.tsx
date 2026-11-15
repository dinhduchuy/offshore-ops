"use client";

import { StatusBadge, Badge, card } from "./ui";
import type { OpsState, View, WorkflowSummary } from "./types";
import { useLang, stepTitle, roleName, phaseName, statusText } from "./i18n";
import { translateDynamic } from "@/lib/i18n/core";

function levels(wf: WorkflowSummary): WorkflowSummary["tasks"][] {
  const depth = new Map<string, number>();
  const byKey = new Map(wf.tasks.map((t) => [t.key, t]));
  const d = (k: string): number => {
    if (depth.has(k)) return depth.get(k)!;
    const t = byKey.get(k);
    const v = t && t.deps.length ? 1 + Math.max(...t.deps.map(d)) : 0;
    depth.set(k, v);
    return v;
  };
  wf.tasks.forEach((t) => d(t.key));
  const out: WorkflowSummary["tasks"][] = [];
  for (const t of wf.tasks) (out[depth.get(t.key)!] ??= []).push(t);
  return out;
}

export function WorkflowBoard({
  state,
  selected,
  onSelect,
  open,
}: {
  state: OpsState;
  selected: number | null;
  onSelect: (id: number) => void;
  open: (v: View) => void;
}) {
  const { t: tr, lang, fmt, i18n } = useLang();
  if (!state.workflows.length) {
    return (
      <div style={{ color: "var(--ink-2)", fontSize: 12, padding: 12 }}>
        {tr("Chưa có case nào. Vào tab ", "No case yet. Go to the ")}<b>{tr("Dữ liệu", "Data")}</b>
        {tr(
          " để nạp báo cáo DPR (bộ GIẢ LẬP hoặc dữ liệu thực). Case chỉ được tạo khi phát hiện bất thường vượt ngưỡng.",
          " tab to load DPR reports (SIMULATED set or real data). A case is only created when an anomaly above threshold is detected.",
        )}
      </div>
    );
  }
  const wf = state.workflows.find((w) => w.id === selected) ?? state.workflows[0];
  const agentShort = new Map(state.agents.map((a) => [a.id, a.short]));
  const stepInfo = new Map(state.steps.map((s) => [s.key, s]));
  const pct = Math.round((wf.progress.done / wf.progress.total) * 100);

  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        {state.workflows.map((w) => (
          <button
            key={w.id}
            onClick={() => onSelect(w.id)}
            style={{
              ...card,
              padding: "4px 8px",
              cursor: "pointer",
              fontSize: 11,
              borderColor: w.id === wf.id ? "var(--accent)" : "var(--border)",
              color: "var(--ink)",
            }}
          >
            {w.priority && <Badge color={w.priority === "P1" ? "#ef4444" : w.priority === "P2" ? "#f59e0b" : "#94a3b8"}>{w.priority}</Badge>} {w.caseNo} <StatusBadge status={w.status} />
          </button>
        ))}
      </div>

      <div style={{ ...card, marginBottom: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
          <div style={{ fontWeight: 650, fontSize: 13 }}>{wf.caseNo}</div>
          <div style={{ display: "flex", gap: 4 }}>
            {wf.simulated && <Badge color="#f59e0b">{tr("DỮ LIỆU GIẢ LẬP", "SIMULATED DATA")}</Badge>}
            {wf.priority && <Badge color={wf.priority === "P1" ? "#ef4444" : wf.priority === "P2" ? "#f59e0b" : "#94a3b8"}>{wf.priority}</Badge>}
            <Badge color="#94a3b8" title={tr("Mỗi revision có snapshot đầu vào riêng", "Each revision has its own input snapshot")}>case rev {wf.version}</Badge>
            <StatusBadge status={wf.status} />
          </div>
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-2)", margin: "4px 0 2px" }} lang={i18n.sourceLang()}>{wf.title}</div>
        <div style={{ fontSize: 11.5, margin: "2px 0 6px", display: "grid", gridTemplateColumns: "90px 1fr", rowGap: 2 }}>
          <span style={{ color: "var(--ink-3)" }}>{tr("Giếng", "Well")}</span>
          <span style={{ fontFamily: "var(--font-mono)" }}>{wf.wellKey ?? `${wf.platform}/${wf.well}`}</span>
          <span style={{ color: "var(--ink-3)" }}>{tr("Nhánh", "Branch")}</span>
          <span>{(wf.branch && translateDynamic(lang, `branch.${wf.branch}`)) || wf.branchLabel || tr("— (chưa chọn phương án)", "— (no option chosen yet)")}</span>
          <span style={{ color: "var(--ink-3)" }}>{tr("Giai đoạn", "Stage")}</span>
          <span>{wf.stageKey && ["closed", "rejected", "cancelled", "none"].includes(wf.stageKey) ? i18n.t(`stage.${wf.stageKey}` as "stage.closed") : phaseName(wf.stageKey, wf.stage, lang)}</span>
          {wf.holder && (
            <>
              <span style={{ color: "var(--ink-3)" }}>{tr("Đang giữ việc", "Holder")}</span>
              <span>
                {roleName(wf.holder, lang)} — {wf.stageKey ? stepTitle(wf.stageKey, wf.nextStep ?? "", lang) : wf.nextStep}
              </span>
            </>
          )}
          {wf.closure && (
            <>
              <span style={{ color: "var(--ink-3)" }}>{tr("Kết luận", "Conclusion")}</span>
              <span>
                <span lang={i18n.sourceLang()}>{wf.closure.conclusion}</span> — {wf.closure.closedBy}, {fmt.dateTime(wf.closure.closedAt)}
              </span>
            </>
          )}
        </div>
        {wf.status === "approved" && <div style={{ fontSize: 11, color: "#a3e635", marginBottom: 4 }}>{tr("Đã duyệt cam kết — chưa hoàn thành: còn kiểm tra sẵn sàng, thực hiện, đánh giá hiệu quả và đóng case.", "Commitment approved — not finished: readiness, execution, evaluation and closure remain.")}</div>}
        <div style={{ height: 6, background: "var(--surface-3)", borderRadius: 3, overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: "#22c55e", transition: "width 300ms" }} />
        </div>
        <div style={{ fontSize: 11, color: "var(--ink-2)", marginTop: 4 }}>
          {wf.progress.done}/{wf.progress.total} {tr("bước xong hoặc bỏ qua có lý do", "steps done or skipped with a reason")} · {tr("tạo", "created")} {fmt.dateTime(wf.createdAt)} · {tr("cập nhật", "updated")} {fmt.dateTime(wf.updatedAt)}
        </div>
      </div>

      {levels(wf).map((row, li) => (
        <div key={li}>
          {li > 0 && <div style={{ textAlign: "center", color: "var(--ink-3)", fontSize: 11, lineHeight: "16px" }}>↓</div>}
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${row.length}, 1fr)`, gap: 6 }}>
            {row.map((t) => {
              const info = stepInfo.get(t.key);
              const highlight = t.overdue ? "#ef4444" : t.status === "awaiting_approval" ? "#c084fc" : t.status === "error" ? "#ef4444" : t.status === "missing_data" ? "#f59e0b" : t.status === "waiting" ? "#38bdf8" : undefined;
              return (
                <button
                  key={t.id}
                  onClick={() => open({ kind: "task", workflowId: wf.id, taskId: t.id })}
                  style={{
                    ...card,
                    textAlign: "left",
                    cursor: "pointer",
                    color: "var(--ink)",
                    borderColor: highlight ?? "var(--border)",
                    boxShadow: highlight ? `0 0 0 1px ${highlight}55` : undefined,
                    opacity: t.status === "skipped" ? 0.55 : 1,
                  }}
                  title={t.status === "skipped" ? `${tr("Bỏ qua", "Skipped")}: ${t.note ?? ""}` : t.owner ? `${tr("Người giữ việc", "Holder")}: ${roleName(t.owner, lang)}` : undefined}
                >
                  <div style={{ fontSize: 11, color: "var(--ink-2)", display: "flex", justifyContent: "space-between", gap: 4 }}>
                    <span>{agentShort.get(t.agentId) ?? t.agentId}</span>
                    {t.attempts > 1 && <span title={tr("Số lần chạy", "Runs")}>×{t.attempts}</span>}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, margin: "2px 0 4px", overflowWrap: "anywhere" }}>{stepTitle(t.key, t.title, lang)}</div>
                  <StatusBadge status={t.status} />
                  {(t.status === "pending" || t.status === "skipped" || t.status === "waiting") && t.note && (() => {
                    // Pending: the server note names the first unfinished dependency → rebuild it from codes
                    const dep = t.status === "pending" && lang !== "vi" ? t.deps.map((k) => wf.tasks.find((x) => x.key === k)).find((x) => x && !["done", "skipped"].includes(x.status)) : undefined;
                    return (
                      <div style={{ fontSize: 10.5, color: t.status === "waiting" ? "#38bdf8" : "var(--ink-3)", marginTop: 3 }} lang={dep ? undefined : i18n.sourceLang()}>
                        {dep ? `${tr("Chờ", "Waiting for")} "${stepTitle(dep.key, dep.title, lang)}" (${statusText(dep.status, lang)})` : t.note.slice(0, 120)}
                      </div>
                    );
                  })()}
                  {t.dueAt && !["done", "skipped", "pending"].includes(t.status) && <div style={{ fontSize: 10, color: t.overdue ? "#ef4444" : "var(--ink-3)", marginTop: 2 }}>{tr("hạn", "due")} {fmt.dateTime(t.dueAt)}{t.overdue ? tr(" — QUÁ HẠN", " — OVERDUE") : ""}</div>}
                  {t.status === "missing_data" && <div style={{ fontSize: 10.5, color: "#f59e0b", marginTop: 3 }}>{t.blocking.length} {tr("mục bắt buộc còn thiếu", "required items missing")}</div>}
                  {t.status === "awaiting_approval" && <div style={{ fontSize: 10.5, color: "#c084fc", marginTop: 3 }}>{tr("Cần", "Needs")}: {roleName(String(t.gateFacts?.role ?? ""), lang)}</div>}
                  {t.status === "error" && <div style={{ fontSize: 10.5, color: "#ef4444", marginTop: 3 }} lang={i18n.sourceLang()}>{(t.note ?? "").slice(0, 80)}</div>}
                  {info?.hasCondition && t.status === "pending" && <div style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 3 }}>{tr("Có điều kiện áp dụng theo nhánh", "Applies depending on the branch")}</div>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 10 }}>
        {tr(
          'Mũi tên là quan hệ phụ thuộc; các ô cùng hàng chạy song song. Bước không áp dụng cho nhánh đã duyệt được bỏ qua kèm lý do (mờ) — không tính là "đã làm". Thiếu dữ liệu, chờ nguồn lực/đơn vị khác, chờ ngày, lỗi hệ thống và chờ duyệt được hiển thị riêng.',
          'Arrows are dependencies; boxes on the same row run in parallel. Steps that do not apply to the approved branch are skipped with a reason (dimmed) — not counted as "done". Missing data, waiting for resources/another unit, waiting for a date, system errors and pending approvals are shown separately.',
        )}
      </div>
    </div>
  );
}
