"use client";

import { useEffect, useState } from "react";
import { StatusBadge, Badge, Section, RefChip, btn, btnPrimary, input, card, api, postJson } from "./ui";
import type { OpsState, View, TaskSummary, ActionItem, Reservation } from "./types";
import { IdentityBar, useOpsSession } from "./Identity";
import { useLang, stepTitle, roleName, waitText, agentName, statusText, datasetName, type Lang } from "./i18n";
import { ErrorMessage } from "@/components/I18nProvider";
import { eventText, type EventMsg } from "@/lib/i18n/events";

/** Event line: Vietnamese = original label; other languages = message key when the event has one. */
function EventText({ e }: { e: OpsState["events"][number] }) {
  const { lang, i18n } = useLang();
  let msg: EventMsg | undefined;
  try {
    msg = e.payload_json ? (JSON.parse(e.payload_json) as { msg?: EventMsg }).msg : undefined;
  } catch {
    msg = undefined;
  }
  const s = lang !== "vi" ? eventText(msg, lang) : undefined;
  return s ? <span>{s}</span> : <span lang={i18n.sourceLang()}>{e.label}</span>;
}

export { TraceViewer } from "./Trace";

// ───────────────── Agent & room ─────────────────

function TaskRow({ t, open }: { t: TaskSummary; open: (v: View) => void }) {
  const { t: tr, lang, fmt, i18n } = useLang();
  return (
    <button onClick={() => open({ kind: "task", workflowId: t.workflowId!, taskId: t.id })} style={{ ...card, width: "100%", textAlign: "left", cursor: "pointer", color: "var(--ink)", marginBottom: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{stepTitle(t.key, t.title, lang)}</span>
        <StatusBadge status={t.status} />
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{t.caseNo} · {fmt.dateTime(t.updatedAt)}</div>
      {t.summary && <div style={{ fontSize: 11.5, color: "var(--ink-2)", marginTop: 2 }} lang={i18n.sourceLang()}>{t.summary.slice(0, 180)}</div>}
      {t.status !== "done" && t.note && (
        <div style={{ fontSize: 11, color: t.status === "skipped" ? "var(--ink-3)" : "var(--ink-2)" }}>
          {t.waitKind || t.waitLabel ? `${waitText(t.waitKind, t.waitLabel, lang)}: ` : ""}
          {t.status === "awaiting_approval" && t.owner ? roleName(t.owner, lang) : <span lang={i18n.sourceLang()}>{t.note.slice(0, 200)}</span>}
        </div>
      )}
      {(t.owner || t.dueAt) && t.status !== "done" && t.status !== "skipped" && (
        <div style={{ fontSize: 10.5, color: t.overdue ? "#ef4444" : "var(--ink-3)" }}>
          {t.owner ? `${tr("Người giữ việc", "Holder")}: ${roleName(t.owner, lang)}` : ""}
          {t.dueAt ? ` · ${tr("hạn", "due")} ${fmt.dateTime(t.dueAt)}${t.overdue ? tr(" — QUÁ HẠN", " — OVERDUE") : ""}` : ""}
        </div>
      )}
    </button>
  );
}

const STEP_TITLE = (state: OpsState, key: string, lang: Lang = "vi") => stepTitle(key, state.steps.find((s) => s.key === key)?.title ?? key, lang);

/** Everything a person or unit must act on — priority and overdue first (from the database, not the log). */
export function ActionListPanel({ state, open }: { state: OpsState; open: (v: View) => void }) {
  const { t, lang, fmt, i18n } = useLang();
  const items: ActionItem[] = state.actionList ?? [];
  if (!items.length) return <div style={{ color: "var(--ink-2)", fontSize: 12 }}>{t("Không có việc nào đang chờ người/đơn vị xử lý.", "Nothing is waiting for a person or unit.")}</div>;
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6 }}>
        {t("Xếp theo: quá hạn → ưu tiên case (P1–P3) → hạn gần nhất. Không gửi thông báo ra ngoài (chưa cấu hình kênh).", "Sorted by: overdue → case priority (P1–P3) → nearest due date. No external notifications (no channel configured).")}
      </div>
      {items.map((a) => (
        <button
          key={a.taskId}
          onClick={() => open({ kind: "task", workflowId: a.workflowId, taskId: a.taskId })}
          style={{ ...card, width: "100%", textAlign: "left", cursor: "pointer", color: "var(--ink)", marginBottom: 5, borderColor: a.overdue ? "#ef4444" : "var(--border)" }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 12, fontWeight: 650 }}>
              <Badge color={a.priority === "P1" ? "#ef4444" : a.priority === "P2" ? "#f59e0b" : "#94a3b8"}>{a.priority}</Badge> {a.caseNo} · {stepTitle(a.key, a.title, lang)}
            </span>
            <Badge color={a.status === "awaiting_approval" ? "#c084fc" : a.status === "error" ? "#ef4444" : a.status === "waiting" ? "#38bdf8" : "#f59e0b"}>{waitText(a.waitKind, a.waitLabel, lang)}</Badge>
          </div>
          <div style={{ fontSize: 11, color: "var(--ink-2)", marginTop: 2 }} lang={i18n.sourceLang()}>{(a.note ?? "").slice(0, 220)}</div>
          <div style={{ fontSize: 10.5, color: a.overdue ? "#ef4444" : "var(--ink-3)", marginTop: 2 }}>
            {t("Người giữ việc", "Holder")}: {a.owner ? roleName(a.owner, lang) : "—"}
            {a.dueAt ? ` · ${t("hạn", "due")} ${fmt.dateTime(a.dueAt)}` : ""}
            {a.overdue ? t(" — QUÁ HẠN", " — OVERDUE") : ""}
          </div>
        </button>
      ))}
    </div>
  );
}

/** Shared-resource ledger: internal holds vs bookings confirmed by the external owner. */
export function ReservationsPanel({ state, onChange }: { state: OpsState; onChange: () => void }) {
  const { session } = useOpsSession();
  const { t, lang, fmt, i18n } = useLang();
  const [err, setErr] = useState<unknown>(null);
  const rows = state.reservations ?? [];
  // Display only: the payload always sends the raw number (r.quantity), never the formatted text
  const num = (x: number) => fmt.number(x);
  const run = async (url: string, body: Record<string, unknown>) => {
    setErr(null);
    try {
      await postJson(url, body);
      onChange();
    } catch (e) {
      setErr(e);
    }
  };
  // The confirmation is bound to what the person sees: quantity + the CURRENT case revision.
  // A hold placed at an earlier revision is carried forward by the server only if the plan in force
  // still needs exactly this content; otherwise the server answers 409 with the reason.
  const key = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
  const confirm = (r: Reservation) => {
    const rev = r.wf_version ?? r.case_revision;
    const carry = rev !== r.case_revision ? t(` — giữ chỗ lập ở rev ${r.case_revision}, server sẽ đối chiếu với kế hoạch rev ${rev}`, ` — hold placed at rev ${r.case_revision}; the server checks it against the rev ${rev} plan`) : "";
    const ref = window.prompt(t(`Mã xác nhận của bên ngoài cho ${r.resource_key}: ${num(r.quantity)} ${r.unit} (case rev ${rev}${carry}) — ví dụ số booking:`, `External confirmation reference for ${r.resource_key}: ${num(r.quantity)} ${r.unit} (case rev ${rev}${carry}) — e.g. booking number:`));
    if (ref) void run(`/api/ops/reservations/${r.id}/confirm`, { externalRef: ref, quantity: r.quantity, caseRevision: rev, idempotencyKey: key() });
  };
  const cancelled = (r: Reservation) => {
    const ref = window.prompt(t(`Mã hủy của bên ngoài cho booking ${r.external_ref ?? ""} (${r.resource_key}). Nếu kế hoạch hiện hành còn cần chỗ này, kế hoạch sẽ được lập lại:`, `External cancellation reference for booking ${r.external_ref ?? ""} (${r.resource_key}). If the plan in force still needs it, the plan is redone:`));
    if (ref) void run(`/api/ops/reservations/${r.id}/cancel`, { externalRef: ref, idempotencyKey: key() });
  };
  const label: Record<string, string> = lang === "en" ? { budget: "Budget", vessel_deck: "Vessel deck", flight_seats: "Flight seats" } : { budget: "Ngân sách", vessel_deck: "Boong tàu", flight_seats: "Ghế bay" };
  const occupying = rows.filter((r) => ["held", "confirmed", "cancel_requested"].includes(r.status)).length;
  return (
    <Section title={t(`Giữ chỗ nguồn lực dùng chung (${occupying} đang chiếm chỗ)`, `Shared-resource holds (${occupying} occupying)`)}>
      <div style={{ fontSize: 10.5, color: "var(--ink-3)", marginBottom: 4 }}>
        {t(
          '"Giữ chỗ nội bộ" chỉ chặn case khác dùng trùng — KHÔNG phải đặt chỗ/cam kết. "Đã xác nhận" gắn với đúng số lượng và revision đã xác nhận; kế hoạch đổi số lượng tạo yêu cầu điều chỉnh cần xác nhận mới. Bỏ một booking đã xác nhận chỉ tạo yêu cầu hủy — vẫn chiếm chỗ đến khi ghi nhận mã hủy.',
          '"Internal hold" only stops other cases from double-using a resource — it is NOT a booking or commitment. "Confirmed" is bound to the exact quantity and revision confirmed; a plan change in quantity creates an amendment that needs a new confirmation. Dropping a confirmed booking only requests cancellation — it keeps occupying until the cancellation reference is recorded.',
        )}
      </div>
      {!!err && <ErrorMessage error={err} />}
      {rows.length === 0 && <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{t("Chưa có.", "None yet.")}</div>}
      {rows.map((r) => (
        <div key={r.id} style={{ fontSize: 11.5, padding: "3px 0", borderBottom: "1px solid var(--border)", display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ flex: 1 }}>
            {r.case_no} · {label[r.resource_type] ?? r.resource_type} <b>{r.resource_key}</b>: {num(r.quantity)} {r.unit}
            {r.capacity !== null ? ` / ${num(r.capacity)}` : ""}
            <span style={{ color: "var(--ink-3)" }}> · rev {r.case_revision}{r.wf_version !== undefined && r.wf_version !== r.case_revision ? ` (case rev ${r.wf_version})` : ""}</span>
            {r.external_ref ? ` · ref ${r.external_ref} (${r.confirmed_by})` : ""}
            {r.amendment_of ? <span style={{ color: "#f59e0b" }}> · {t(`điều chỉnh của #${r.amendment_of} — cần xác nhận mới`, `amendment of #${r.amendment_of} — needs a new confirmation`)}</span> : null}
            {r.change_note ? <span style={{ color: "#f59e0b" }} lang={i18n.sourceLang()}> · {r.change_note}</span> : null}
            {r.cancel_ref ? ` · ${t("mã hủy", "cancellation ref")} ${r.cancel_ref}` : ""}
            {r.release_reason ? <span style={{ color: "var(--ink-3)" }} lang={i18n.sourceLang()}> · {r.release_reason}</span> : null}
            {r.status === "held" && r.expires_at ? <span style={{ color: "var(--ink-3)" }}> · {t("hết hạn", "expires")} {fmt.dateTime(r.expires_at)}</span> : null}
          </span>
          <StatusBadge status={r.status} />
          {r.status === "held" && r.resource_type !== "budget" && (
            <button style={{ ...btn, padding: "1px 6px", fontSize: 11 }} disabled={!session?.identity} onClick={() => confirm(r)} title={t("Ghi nhận bên vận hành đã xác nhận đặt chỗ (đúng số lượng & revision đang hiển thị)", "Record that the operator confirmed the booking (exact quantity & current revision)")}>
              {t("Ghi xác nhận", "Record confirmation")}
            </button>
          )}
          {(r.status === "cancel_requested" || r.status === "confirmed") && r.resource_type !== "budget" && (
            <button style={{ ...btn, padding: "1px 6px", fontSize: 11 }} disabled={!session?.identity} onClick={() => cancelled(r)} title={t("Ghi nhận bên ngoài đã hủy booking (cần mã hủy) — nhả chỗ", "Record that the external party cancelled the booking (reference required) — frees the place")}>
              {t("Ghi đã hủy", "Record cancellation")}
            </button>
          )}
        </div>
      ))}
    </Section>
  );
}

function allTasks(state: OpsState): TaskSummary[] {
  return state.workflows.flatMap((w) => w.tasks.map((t) => ({ ...t, workflowId: w.id, caseNo: w.caseNo })));
}

export function AgentPanel({ id, state, open, roomName }: { id: string; state: OpsState; open: (v: View) => void; roomName?: (zone: string) => string }) {
  const { t, lang, fmt, i18n } = useLang();
  const a = state.agents.find((x) => x.id === id);
  if (!a) return <div>{t("Không có agent", "No agent")} {id}</div>;
  const tasks = allTasks(state).filter((t) => t.agentId === id);
  const active = tasks.filter((t) => !["done", "cancelled", "skipped"].includes(t.status));
  const doneT = tasks.filter((t) => t.status === "done");
  const events = state.events.filter((e) => e.agent_id === id).slice(0, 12);
  const keyOf = new Map(tasks.map((x) => [x.id, x.key]));
  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 650 }}>{a.kind === "human" ? "👤" : "🤖"} {agentName(a.id, a.name, lang)}</div>
      <div style={{ fontSize: 12, color: "var(--ink-2)", margin: "4px 0" }}>
        {t("Phòng", "Room")}: <span title={a.room}>{roomName ? roomName(a.room) : a.room}</span> · {t("đang ở", "now at")} <span title={a.location}>{roomName ? roomName(a.location) : a.location}</span>
      </div>
      {a.kind === "human" && <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{t("Người phê duyệt — chỉ quyết định qua giao diện; không có agent nào quyết định thay.", "Approver — decides only through the interface; no agent decides on their behalf.")}</div>}
      {a.attention && <div style={{ ...card, borderColor: "#f59e0b", color: "#f59e0b", fontSize: 12, marginTop: 6 }}>✋ {a.attention.items.length} · {a.attention.items.map((x) => `${statusText(x.status, lang)} ${x.caseNo}${x.key ? ` (${stepTitle(x.key, x.key, lang)})` : ""}`).join("; ")}</div>}
      <Section title={t("Đang làm", "Working on")}>{a.current ? <TaskRow t={{ ...a.current, workflowId: a.current.workflowId, caseNo: a.current.caseNo }} open={open} /> : <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{t("Không có task đang chạy", "No running task")}</div>}</Section>
      <Section title={`${t("Đang giữ việc", "Holding")} (${a.holding?.length ?? 0})`}>
        {(a.holding ?? []).length ? (
          a.holding!.map((h) => (
            <button key={h.taskId} onClick={() => open({ kind: "task", workflowId: h.workflowId, taskId: h.taskId })} style={{ ...card, width: "100%", textAlign: "left", cursor: "pointer", color: "var(--ink)", marginBottom: 4, borderColor: h.overdue ? "#ef4444" : "var(--border)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{h.caseNo} · {stepTitle(h.key ?? keyOf.get(h.taskId) ?? "", h.title, lang)}</span>
                <StatusBadge status={h.status} />
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-2)" }}>{h.waitKind || h.waitLabel ? `${waitText(h.waitKind, h.waitLabel, lang)}: ` : ""}<span lang={i18n.sourceLang()}>{(h.note ?? "").slice(0, 160)}</span></div>
              {h.dueAt && <div style={{ fontSize: 10.5, color: h.overdue ? "#ef4444" : "var(--ink-3)" }}>{t("Hạn", "Due")} {fmt.dateTime(h.dueAt)}{h.overdue ? t(" — QUÁ HẠN", " — OVERDUE") : ""}</div>}
            </button>
          ))
        ) : (
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{t("Không có việc đang chờ ở agent/người này", "Nothing is waiting on this agent/person")}</div>
        )}
      </Section>
      <Section title={t("Bàn giao (nhận / gửi)", "Hand-offs (in / out)")}>
        {(a.handoffs ?? []).length ? (
          a.handoffs!.map((h) => (
            <div key={h.id} style={{ fontSize: 11.5, padding: "3px 0", borderBottom: "1px solid var(--border)" }}>
              <b>{h.direction === "in" ? t("← nhận", "← in") : t("→ giao", "→ out")}</b> {h.caseNo}: {h.from} → {h.to} ({STEP_TITLE(state, h.to, lang)}) · <StatusBadge status={h.status === "accepted" ? "done" : h.status === "offered" ? "pending" : h.status} />
              <div style={{ color: "var(--ink-3)", fontSize: 10.5 }}>
                {h.artifactVersion ? `${t("hồ sơ", "package")} v${h.artifactVersion} · ` : ""}
                {h.dueAt ? `${t("hạn", "due")} ${fmt.dateTime(h.dueAt)}` : ""}
              </div>
            </div>
          ))
        ) : (
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{t("Không có bàn giao đang mở", "No open hand-offs")}</div>
        )}
      </Section>
      <Section title={`${t("Hàng đợi / cần xử lý", "Queue / to handle")} (${active.length})`}>{active.map((x) => <TaskRow key={x.id} t={x} open={open} />)}</Section>
      <Section title={`${t("Đã hoàn tất", "Done")} (${doneT.length})`}>{doneT.map((x) => <TaskRow key={x.id} t={x} open={open} />)}</Section>
      <Section title={t("Sự kiện gần đây", "Recent events")}>
        {events.map((e) => (
          <div key={e.event_id} style={{ fontSize: 11.5, marginBottom: 3 }}>
            <RefChip label={fmt.dateTime(e.ts)} refv={{ kind: "event", id: e.event_id }} onOpen={(r) => open({ kind: "trace", ref: r })} /> <EventText e={e} />
          </div>
        ))}
      </Section>
    </div>
  );
}

export function RoomPanel({ zone, label, state, open }: { zone: string; label: string; state: OpsState; open: (v: View) => void }) {
  const residents = state.agents.filter((a) => a.room === zone);
  const present = state.agents.filter((a) => a.location === zone && a.room !== zone);
  const tasks = allTasks(state).filter((t) => residents.some((a) => a.id === t.agentId));
  const queue = tasks.filter((t) => ["pending", "running", "missing_data", "error", "awaiting_approval"].includes(t.status));
  const dossiers = queue.filter((t) => t.status === "awaiting_approval" || t.status === "missing_data");
  const { t: tr } = useLang();
  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 650, overflowWrap: "anywhere" }} title={label} data-testid="room-panel-title">{label}</div>
      <div style={{ fontSize: 12, color: "var(--ink-2)", margin: "4px 0" }}>
        {tr("Thuộc phòng", "Based here")}: {residents.map((a) => a.short).join(", ") || "—"}
        {present.length > 0 && <> · {tr("đang ghé", "visiting")}: {present.map((a) => a.short).join(", ")}</>}
      </div>
      <Section title={`${tr("Hồ sơ chờ xử lý", "Packages waiting")} (${dossiers.length})`}>
        {dossiers.length === 0 && <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{tr("Không có", "None")}</div>}
        {dossiers.map((t) => <TaskRow key={t.id} t={t} open={open} />)}
      </Section>
      <Section title={`${tr("Hàng đợi công việc", "Work queue")} (${queue.length})`}>
        {queue.length === 0 && <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{tr("Trống", "Empty")}</div>}
        {queue.filter((t) => !dossiers.includes(t)).map((t) => <TaskRow key={t.id} t={t} open={open} />)}
      </Section>
      <Section title={tr("Đã hoàn tất", "Done")}>{tasks.filter((t) => t.status === "done").map((t) => <TaskRow key={t.id} t={t} open={open} />)}</Section>
    </div>
  );
}

// ───────────────── Approvals, outbox, events ─────────────────

export function ApprovalsPanel({ state, open }: { state: OpsState; open: (v: View) => void }) {
  const { t: tr, lang, i18n } = useLang();
  if (!state.approvals.length) return <div style={{ fontSize: 12, color: "var(--ink-2)", padding: 8 }}>{tr("Không có hồ sơ chờ duyệt. Trạng thái chờ duyệt chỉ kết thúc khi có quyết định tương ứng.", "No package awaiting approval. An approval stays pending until the matching decision is recorded.")}</div>;
  return (
    <div>
      {state.approvals.map((t) => (
        <button key={t.id} onClick={() => open({ kind: "task", workflowId: t.workflowId!, taskId: t.id })} style={{ ...card, borderColor: "#c084fc", width: "100%", textAlign: "left", cursor: "pointer", color: "var(--ink)", marginBottom: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <b style={{ fontSize: 12.5 }}>{stepTitle(t.key, t.title, lang)}</b>
            <StatusBadge status={t.status} />
          </div>
          <div style={{ fontSize: 11.5, color: "var(--ink-2)", marginTop: 3 }}>{t.caseNo} · {tr("cần", "needs")}: <b>{roleName(String(t.gateFacts?.role ?? ""), lang)}</b> · {tr("hồ sơ", "package")} v{t.gateFacts?.packageVersion}</div>
          <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }} lang={i18n.sourceLang()}>{t.summary}</div>
        </button>
      ))}
    </div>
  );
}

export function OutboxPanel({ state, open, onChange }: { state: OpsState; open: (v: View) => void; onChange: () => void }) {
  const { session } = useOpsSession();
  const { t, lang, fmt, i18n } = useLang();
  const [err, setErr] = useState<unknown>(null);
  const approve = async (o: OpsState["outbox"][number]) => {
    try {
      setErr(null);
      await postJson(`/api/ops/outbox/${o.id}/approve`, { docId: o.doc_id, docSha256: o.doc_sha256 });
      onChange();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div>
      <div style={{ fontSize: 11.5, color: "var(--ink-2)", marginBottom: 8 }}>
        {lang === "en" ? (
          <>
            Everything going outside stays a draft until each item is approved to send, for that exact draft version and case revision. Each kind needs its own approval level: <b>RFQ</b> needs the approved scope; <b>PR / booking</b> needs the approved commitment. The system never issues a PO. <b>No outbound adapter exists</b> — approving to send only records the approval.
          </>
        ) : (
          <>
            Mọi thông tin gửi ra ngoài chỉ là bản nháp cho tới khi được duyệt gửi từng mục, đúng phiên bản bản nháp và đúng revision của case. Mỗi loại cần một mức phê duyệt: <b>RFQ</b> (xin giá) cần phạm vi đã duyệt; <b>PR / đặt chỗ</b> cần cam kết chi đã duyệt. Hệ thống không phát hành PO. <b>Chưa có adapter gửi ra ngoài</b> — duyệt gửi chỉ ghi nhận phê duyệt.
          </>
        )}
      </div>
      <div style={{ marginBottom: 8 }}><IdentityBar /></div>
      {!!err && <ErrorMessage error={err} style={{ marginBottom: 6 }} />}
      {state.outbox.length === 0 && <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{t("Chưa có mục nào (RFQ phát sinh sau khi duyệt phạm vi; PR/đặt chỗ sau khi duyệt cam kết).", "No items yet (RFQs appear after scope approval; PR/bookings after commitment approval).")}</div>}
      {state.outbox.map((o) => (
        <div key={o.id} style={{ ...card, marginBottom: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
            <b style={{ fontSize: 12 }} lang={i18n.sourceLang()}>{o.title}</b>
            <StatusBadge status={o.status} />
          </div>
          <div style={{ fontSize: 11.5, color: "var(--ink-2)" }}>
            → {o.recipient} · <RefChip label={t("📄 bản nháp", "📄 draft")} refv={{ kind: "document", id: o.doc_id }} onOpen={(r) => open({ kind: "trace", ref: r })} />{" "}
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--ink-3)" }}>sha {String(o.doc_sha256 ?? "").slice(0, 10)}…</span>
          </div>
          <div style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
            {o.case_revision ? `case rev ${o.case_revision} · ` : ""}
            {t("cần", "needs")}: {o.required_gate === "gate.technical" ? t("phạm vi đã duyệt", "approved scope") : t("cam kết chi đã duyệt", "approved commitment")}
          </div>
          {o.status_note && <div style={{ fontSize: 11, color: o.status === "superseded" || o.status_note.startsWith("⚠") ? "#f59e0b" : "var(--ink-3)" }} lang={i18n.sourceLang()}>{o.status_note}</div>}
          {o.status === "draft" ? (
            <button style={{ ...btnPrimary, marginTop: 6 }} disabled={!session?.identity} onClick={() => approve(o)}>
              {session?.identity ? t("Duyệt gửi mục này", "Approve sending this item") : t("Chọn danh tính trước", "Choose an identity first")}
            </button>
          ) : o.status === "approved_to_send" ? (
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>
              {t("Duyệt bởi", "Approved by")} {o.approved_by} ({roleName(String(o.approved_role ?? ""), lang)}){o.identity_source === "demo" ? t(" — danh tính từ danh mục nội bộ", " — identity from the internal directory") : ""} {fmt.dateTime(o.approved_at)} — {t("chưa gửi: hệ thống không có adapter gửi ra ngoài", "not sent: the system has no outbound adapter")} <span lang={i18n.sourceLang()} style={{ color: "var(--ink-3)" }}>({o.dispatch_note})</span>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function EventLog({ state, open }: { state: OpsState; open: (v: View) => void }) {
  const { fmt } = useLang();
  const short = new Map(state.agents.map((a) => [a.id, a.short]));
  return (
    <div>
      {state.events.map((e) => (
        <div key={e.event_id} style={{ fontSize: 11.5, padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <RefChip label={fmt.dateTime(e.ts)} refv={{ kind: "event", id: e.event_id }} onOpen={(r) => open({ kind: "trace", ref: r })} />
            <Badge color="#94a3b8">{e.source}</Badge>
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--ink-3)" }}>{e.type}</span>
            {e.agent_id && <span style={{ color: "var(--ink-2)" }}>{short.get(e.agent_id) ?? e.agent_id}</span>}
            {e.workflow_id && <span style={{ color: "var(--ink-3)" }}>wf#{e.workflow_id}{e.task_id ? ` · task#${e.task_id}` : ""}</span>}
          </div>
          <div style={{ color: "var(--ink-2)", marginTop: 2 }}><EventText e={e} /></div>
        </div>
      ))}
    </div>
  );
}

// ───────────────── Data intake ─────────────────

export function DataPanel({ state, open, onChange }: { state: OpsState; open: (v: View) => void; onChange: () => void }) {
  const [manifest, setManifest] = useState<{ base: string[]; supplements: string[]; description?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [runErr, setRunErr] = useState<unknown>(null);
  const [file, setFile] = useState<File | null>(null);
  const [wfId, setWfId] = useState<string>("");
  const [faultAgent, setFaultAgent] = useState("maint_agent");
  const { t, lang, fmt } = useLang();
  useEffect(() => {
    api<{ base: string[]; supplements: string[]; description?: string }>("/api/ops/sample").then(setManifest).catch(() => setManifest(null));
  }, []);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setMsg(null);
    setRunErr(null);
    try {
      const r = await fn();
      setMsg(summarize(r, lang));
      onChange();
    } catch (e) {
      setRunErr(e);
    } finally {
      setBusy(null);
    }
  };
  const loadSample = (set: string, f?: string) => run(f ?? set, () => postJson("/api/ops/sample", { set, file: f }));
  const upload = () =>
    run("upload", async () => {
      const fd = new FormData();
      fd.append("file", file!);
      if (wfId) fd.append("workflowId", wfId);
      return api("/api/ops/import", { method: "POST", body: fd });
    });

  return (
    <div>
      <Section title={t("Bộ dữ liệu GIẢ LẬP", "SIMULATED data set")}>
        <div style={{ fontSize: 11.5, color: "#f59e0b", marginBottom: 6 }}>⚠ {lang === "en" ? "Illustrative SIMULATED data (well A-03 decline scenario, SIM-WHP-A) — not real figures." : (manifest?.description ?? "Dữ liệu minh họa, không phải số liệu thực.")}</div>
        <button style={btnPrimary} disabled={!!busy || !manifest} onClick={() => loadSample("base")}>{busy === "base" ? t("Đang nạp…", "Loading…") : t(`Nạp bộ cơ sở (${manifest?.base.length ?? 0} file)`, `Load base set (${manifest?.base.length ?? 0} files)`)}</button>
        <div style={{ fontSize: 11.5, color: "var(--ink-2)", margin: "8px 0 4px" }}>{t("Dữ liệu bổ sung (dùng để kiểm thử thiếu dữ liệu / trả hồ sơ / xung đột):", "Supplements (to test missing data / returns / conflicts):")}</div>
        {manifest?.supplements.map((f) => (
          <div key={f} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11.5, marginBottom: 3 }}>
            <span style={{ fontFamily: "var(--font-mono)" }}>{f.replace("supplements/", "")}</span>
            <button style={{ ...btn, padding: "2px 8px" }} disabled={!!busy} onClick={() => loadSample("supplements", f)}>{busy === f ? "…" : t("Nạp", "Load")}</button>
          </div>
        ))}
      </Section>

      <Section title={t("Nhập dữ liệu thực (CSV · XLSX · JSON · PDF · TXT)", "Import real data (CSV · XLSX · JSON · PDF · TXT)")}>
        {/* the native file input's button/empty-state text follows the BROWSER locale, not the app language → app-rendered label */}
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, cursor: "pointer" }}>
          <span style={{ ...btn, padding: "3px 10px" }}>{t("Chọn tệp", "Choose file")}</span>
          <span style={{ color: file ? "var(--ink)" : "var(--ink-3)", fontFamily: file ? "var(--font-mono)" : undefined, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file ? file.name : t("Chưa chọn tệp", "No file chosen")}</span>
          <input type="file" accept=".csv,.xlsx,.json,.pdf,.txt,.md" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden" }} />
        </label>
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <select style={input} value={wfId} onChange={(e) => setWfId(e.target.value)}>
            <option value="">{t("Dữ liệu chung (không gắn case)", "Shared data (no case)")}</option>
            {state.workflows.map((w) => <option key={w.id} value={w.id}>{t("Gắn vào", "Attach to")} {w.caseNo}</option>)}
          </select>
          <button style={btnPrimary} disabled={!file || !!busy} onClick={upload}>{busy === "upload" ? "…" : t("Nhập", "Import")}</button>
        </div>
        <div style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 4 }}>
          {t(
            "Loại dữ liệu nhận diện theo tên cột. Tài liệu (PDF/TXT) được lưu nguyên văn và xử lý như dữ liệu — không làm thay đổi quy trình hay quyền hạn. API: POST /api/ops/import (JSON).",
            "The dataset type is detected from column names. Documents (PDF/TXT) are stored verbatim and treated as data — they never change the workflow or permissions. API: POST /api/ops/import (JSON).",
          )}
        </div>
      </Section>
      {msg && <div style={{ ...card, fontSize: 11.5, whiteSpace: "pre-wrap", marginTop: 8 }}>{msg}</div>}
      {!!runErr && <ErrorMessage error={runErr} style={{ ...card, marginTop: 8 }} />}

      <Section title={`${t("Lịch sử nhập", "Import history")} (${state.imports.length})`}>
        {state.imports.map((i) => (
          <div key={i.id} style={{ fontSize: 11.5, padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <RefChip label={`#${i.id}`} refv={{ kind: "import", id: i.id }} onOpen={(r) => open({ kind: "trace", ref: r })} />
              <span style={{ fontFamily: "var(--font-mono)" }}>{i.filename}</span>
              {i.simulated && <Badge color="#f59e0b">{t("GIẢ LẬP", "SIMULATED")}</Badge>}
            </div>
            <div style={{ color: "var(--ink-3)" }}>
              {datasetName(i.datasetType, i.label, lang)} · {i.datasetType === "document" ? t("tài liệu", "document") : `${i.rowsAccepted}/${i.rowsTotal} ${t("dòng", "rows")}`} · {fmt.dateTime(i.receivedAt)}
              {(i.quality.warnings?.length ?? 0) > 0 && <span style={{ color: "#f59e0b" }}> · {i.quality.warnings!.length} {t("cảnh báo", "warnings")}</span>}
              {(i.quality.conflicts?.length ?? 0) > 0 && <span style={{ color: "#f59e0b" }}> · {i.quality.conflicts!.length} {t("xung đột", "conflicts")}</span>}
              {(i.quality.duplicates ?? 0) > 0 && <span> · {i.quality.duplicates} {t("trùng", "duplicates")}</span>}
              {(i.quality.flags?.length ?? 0) > 0 && <span style={{ color: "#ef4444" }}> · {t("có câu dạng mệnh lệnh", "contains instruction-like text")}</span>}
            </div>
          </div>
        ))}
      </Section>

      <Section title={t("Công cụ kiểm thử", "Test tools")}>
        <div style={{ fontSize: 10.5, color: "var(--ink-3)", marginBottom: 4 }}>
          {t(
            'Chỉ có ở chế độ demo, cần danh tính có vai trò "Quản trị hệ thống" (kiểm tra phía server, ghi nhật ký kiểm toán). Môi trường vận hành không có thao tác này.',
            'Demo mode only; needs an identity with the "System Administrator" role (checked on the server, written to the audit log). Production has no such action.',
          )}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <select style={input} value={faultAgent} onChange={(e) => setFaultAgent(e.target.value)}>
            {state.agents.filter((a) => a.kind === "ai").map((a) => <option key={a.id} value={a.id}>{a.short}</option>)}
          </select>
          <button style={btn} onClick={() => run("fault", () => postJson("/api/ops/admin", { action: "fault", agentId: faultAgent, count: 1 }))}>{t("Gây lỗi 1 lần", "Inject 1 failure")}</button>
        </div>
        <button
          style={{ ...btn, marginTop: 6, color: "#ef4444", borderColor: "#ef444477" }}
          onClick={() => {
            if (confirm(t("Xóa TOÀN BỘ dữ liệu, case, quyết định trong ops.db? Không hoàn tác được.", "Delete ALL data, cases and decisions in ops.db? This cannot be undone."))) run("reset", () => postJson("/api/ops/admin", { action: "reset" }));
          }}
        >
          {t("Xóa toàn bộ dữ liệu ops", "Delete all ops data")}
        </button>
      </Section>
    </div>
  );
}

function summarize(r: unknown, lang: Lang): string {
  const t = (vi: string, en: string) => (lang === "en" ? en : vi);
  const x = r as { results?: Array<{ file: string; outcome?: { duplicate: boolean; quality?: { rowsAccepted: number; rowsTotal: number; warnings: string[]; conflicts: unknown[] }; casesCreated: number[]; requeued: number; flags?: string[] }; error?: string }> } & Record<string, unknown>;
  const lines = (x.results ?? [{ file: String(x.datasetType ?? "file"), outcome: x as never }]).map((it) => {
    if (it.error) return `✗ ${it.file}: ${it.error}`;
    const o = it.outcome!;
    if (!o) return `✓ ${it.file}`;
    if (o.duplicate) return `= ${it.file}: ${t("trùng nội dung đã nhập — bỏ qua", "same content already imported — skipped")}`;
    const parts = [o.quality ? `${o.quality.rowsAccepted}/${o.quality.rowsTotal} ${t("dòng", "rows")}` : t("tài liệu", "document")];
    if (o.quality?.warnings?.length) parts.push(`${o.quality.warnings.length} ${t("cảnh báo", "warnings")}`);
    if (o.quality?.conflicts?.length) parts.push(`${o.quality.conflicts.length} ${t("xung đột", "conflicts")}`);
    if (o.casesCreated?.length) parts.push(`${t("tạo", "created")} ${o.casesCreated.length} case`);
    if (o.requeued) parts.push(`${o.requeued} ${t("task chạy lại", "tasks re-run")}`);
    if (o.flags?.length) parts.push(`⚠ ${o.flags.join(", ")}`);
    return `✓ ${it.file}: ${parts.join(" · ")}`;
  });
  return lines.join("\n") || t("Xong", "Done");
}
