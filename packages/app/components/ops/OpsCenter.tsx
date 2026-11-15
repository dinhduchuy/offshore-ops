"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DioramaConfig } from "@diorama/engine";
import { TopBar } from "@/components/TopBar";
import { Badge, btn, api } from "./ui";
import type { OpsState, View } from "./types";
import { WorkflowBoard } from "./WorkflowBoard";
import { TaskInspector } from "./TaskInspector";
import { TraceViewer, AgentPanel, RoomPanel, ApprovalsPanel, OutboxPanel, EventLog, DataPanel, ActionListPanel, ReservationsPanel } from "./Panels";
import { SessionProvider, useOpsSession, detailText } from "./Identity";
import { ClaudeApiPanel } from "./ClaudeApiPanel";
import { useLang, stepTitle, waitText, statusText, modeDescription } from "./i18n";
import { ErrorMessage, useI18n } from "@/components/I18nProvider";
import { localizedRoomName } from "@/lib/i18n/rooms";
import type { Locale } from "@/lib/i18n/locale";

const LiveView = dynamic(() => import("@/components/LiveView").then((m) => ({ default: m.LiveView })), {
  ssr: false,
  loading: () => <LoadingOffice />,
});

type Tab = "actions" | "workflow" | "approvals" | "data" | "outbox" | "events";
type Conn = "connecting" | "live" | "lost";

function LoadingOffice() {
  const { t } = useI18n();
  return <div style={{ padding: 20, color: "var(--ink-2)" }}>{t("shell.loadingOffice")}</div>;
}

/** 3D attention pill text, built from codes (step key, wait kind) — notes stay as produced. */
function attentionText(a: NonNullable<OpsState["agents"][number]["attention"]>, lang: Locale, t: ReturnType<typeof useI18n>["t"]): string {
  if (a.items.length > 1) return t("attn.many", { count: a.items.length, cases: a.items.map((i) => i.caseNo).join(", ") });
  const i = a.items[0];
  if (!i) return a.label;
  if (i.status === "awaiting_approval") return t("attn.awaiting", { step: stepTitle(i.key ?? "", i.key ?? "", lang), caseNo: i.caseNo });
  if (i.status === "waiting") return t("attn.waiting", { wait: waitText(i.waitKind, t("wait.generic"), lang), caseNo: i.caseNo });
  return `${statusText(i.status, lang)} ${i.caseNo}`;
}

/** Axis 1 — where the data comes from. */
function DataAxis({ s }: { s: OpsState }) {
  const { t } = useLang();
  const k = s.dataSource.kind;
  const map = {
    none: ["#94a3b8", t("Dữ liệu: chưa có", "Data: none")],
    simulated: ["#f59e0b", t("Dữ liệu: GIẢ LẬP", "Data: SIMULATED")],
    real: ["#22c55e", t("Dữ liệu: thực", "Data: real")],
    mixed: ["#ef4444", t("Dữ liệu: HỖN HỢP giả lập + thực", "Data: MIXED simulated + real")],
  } as const;
  const [color, label] = map[k];
  return <Badge color={color} title={t(`${s.dataSource.simulatedRows} dòng giả lập · ${s.dataSource.realRows} dòng thực (đang dùng)`, `${s.dataSource.simulatedRows} simulated rows · ${s.dataSource.realRows} real rows (in use)`)}>{label}</Badge>;
}

/** Axis 2 — how outputs are produced (requested vs effective vs configuration) + the model in use. */
function ProcessingAxis({ s, onOpen }: { s: OpsState; onOpen: () => void }) {
  const { t } = useLang();
  const m = s.mode;
  const restart = m.reloadRequiresRestart ? t("Thay cấu hình cần khởi động lại server (nguồn: biến môi trường).", "Changing the configuration needs a server restart (source: environment).") : t("Cấu hình từ /ops — áp dụng ngay cho task tiếp theo.", "Configured from /ops — applies to the next task.");
  const title = `${t("Yêu cầu", "Requested")}: ${m.requested} · ${t("Hiệu lực", "Effective")}: ${m.effective} · ${t("Cấu hình", "Configuration")}: ${m.configurationStatus}${m.lastLlmErrorCategory ? ` · ${t("Lỗi gần nhất", "Last error")}: ${m.lastLlmErrorCategory}` : ""}\n${modeDescription(m, t)}\n${restart}\n${t("Click để mở cấu hình Claude API.", "Click to open the Claude API settings.")}`;
  const wrap = (color: string, text: string) => (
    <button onClick={onOpen} style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}>
      <Badge color={color} title={title}>{text}</Badge>
    </button>
  );
  if (m.effective === "blocked") return wrap("#ef4444", t("Xử lý: ⛔ yêu cầu LLM nhưng lỗi cấu hình — agent tạm dừng", "Processing: ⛔ LLM requested but misconfigured — agents paused"));
  if (m.effective === "rules") return wrap("#94a3b8", t("Xử lý: quy tắc xác định (không LLM)", "Processing: deterministic rules (no LLM)"));
  return wrap("#38bdf8", `${t("Xử lý: quy tắc + Claude API", "Processing: rules + Claude API")} · model ${m.model ?? "?"}`);
}

/** Separate fact: is the LLM provider reachable / did the last call succeed. */
function LlmConnectionAxis({ s }: { s: OpsState }) {
  const { t, fmt } = useLang();
  const m = s.mode;
  if (m.requested === "rules") return null;
  const st = {
    missing_credentials: ["#ef4444", t("Claude API: thiếu API key", "Claude API: missing API key")],
    invalid_config: ["#ef4444", t("Claude API: cấu hình lỗi", "Claude API: invalid configuration")],
    configured_unverified: ["#94a3b8", t("Claude API: chưa gọi lần nào", "Claude API: not called yet")],
    verified: ["#22c55e", `Claude API: OK ${fmt.dateTime(m.lastLlmOkAt)}`],
    last_call_failed: ["#ef4444", `${t("Claude API: LỖI", "Claude API: ERROR")}${m.lastLlmErrorCategory ? ` (${m.lastLlmErrorCategory})` : ""}`],
  } as Record<string, [string, string]>;
  const [color, label] = st[m.configurationStatus] ?? ["#94a3b8", `Claude API: ${m.configurationStatus}`];
  return <Badge color={color} title={modeDescription(m, t)}>{label}</Badge>;
}

/** Axis 3 — are we receiving events right now. */
function ConnectionAxis({ conn, lastPoll }: { conn: Conn; lastPoll: string | null }) {
  const { t, fmt } = useLang();
  if (conn === "live") return <Badge color="#22c55e" title={`${t("Poll gần nhất", "Last poll")}: ${fmt.dateTime(lastPoll)}`}>{t("Kết nối: đang nhận sự kiện", "Connection: receiving events")}</Badge>;
  if (conn === "connecting") return <Badge color="#94a3b8">{t("Kết nối: đang kết nối…", "Connection: connecting…")}</Badge>;
  return <Badge color="#ef4444" title={`${t("Dữ liệu hiển thị có thể cũ. Poll gần nhất", "Displayed data may be stale. Last poll")}: ${fmt.dateTime(lastPoll)}`}>{t("Kết nối: MẤT — đang thử lại", "Connection: LOST — retrying")}</Badge>;
}

function ApprovalAxis() {
  const { session } = useOpsSession();
  const { t, lang } = useLang();
  if (!session) return null;
  return session.identityProvider === "none" ? (
    <Badge color="#ef4444" title={detailText(session, lang)}>{t("Phê duyệt: bị chặn (chưa có SSO)", "Approvals: blocked (no SSO)")}</Badge>
  ) : (
    <Badge color="#f59e0b" title={detailText(session, lang)}>{t("Người duyệt", "Approver")}: {session.identity ? <span lang={lang !== "vi" ? "vi" : undefined} data-person-name>{session.identity.name}</span> : t("chưa chọn", "not chosen")}</Badge>
  );
}

export function OpsCenter() {
  return (
    <SessionProvider>
      <OpsCenterInner />
    </SessionProvider>
  );
}

function OpsCenterInner() {
  const { t, lang, i18n } = useLang();
  const [layout, setLayout] = useState<DioramaConfig | null>(null);
  const [state, setState] = useState<OpsState | null>(null);
  const [error, setError] = useState<unknown>(null);
  const setTimeZone = i18n.setTimeZone;
  const businessTz = state?.businessTimeZone;
  useEffect(() => {
    if (businessTz) setTimeZone(businessTz);
  }, [businessTz, setTimeZone]);
  const [tab, setTab] = useState<Tab>("workflow");
  const [stack, setStack] = useState<View[]>([]);
  const [selectedWf, setSelectedWf] = useState<number | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [conn, setConn] = useState<Conn>("connecting");
  const [lastPoll, setLastPoll] = useState<string | null>(null);
  const [placementVersion, setPlacementVersion] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hadError = useRef(false);

  const refresh = useCallback(() => {
    return api<OpsState>("/api/ops/state")
      .then((s) => {
        setState(s);
        setError(null);
        setLastPoll(new Date().toISOString());
      })
      .catch((e) => {
        setError(e);
        setConn("lost");
      });
  }, []);

  useEffect(() => {
    api<DioramaConfig>("/api/ops/layout").then(setLayout).catch((e) => setError(e));
    refresh();
    const poll = setInterval(refresh, 4000);
    const es = new EventSource("/api/ingest/stream");
    es.onopen = () => {
      setConn("live");
      if (hadError.current) {
        // Reconnected: events may have been missed → reload state and re-sync the 3D view
        hadError.current = false;
        refresh().then(() => setPlacementVersion((v) => v + 1));
      }
    };
    es.onerror = () => {
      hadError.current = true;
      setConn("lost");
    };
    es.onmessage = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(refresh, 250);
    };
    return () => {
      clearInterval(poll);
      es.close();
    };
  }, [refresh]);

  const open = useCallback((v: View) => setStack((s) => [...s, v]), []);
  const back = () => setStack((s) => s.slice(0, -1));
  const top = stack[stack.length - 1];

  // Initial positions captured once; attention follows EVERY poll (database is the source of truth)
  const restoreRef = useRef<{ placement: Record<string, string> } | null>(null);
  if (state && !restoreRef.current) restoreRef.current = { placement: Object.fromEntries(state.agents.map((a) => [a.id, a.location])) };
  const labels = useMemo(() => (state ? Object.fromEntries(state.agents.map((a) => [a.id, a.short])) : {}), [state]);
  const attentionState = useMemo(
    () => (state ? Object.fromEntries(state.agents.filter((a) => a.attention).map((a) => [a.id, attentionText(a.attention!, lang, i18n.t)])) : {}),
    [state, lang, i18n.t],
  );
  const placement = useMemo(() => (state ? Object.fromEntries(state.agents.map((a) => [a.id, a.location])) : undefined), [state]);

  const onSelectRoom = (label: string | null) => {
    setSelectedRoom(label);
    if (!label) return;
    const zone = label.match(/zone_[a-z_]+/)?.[0];
    // Only the technical key goes into the view stack; the name is resolved at render (follows VI/EN)
    if (zone) open({ kind: "room", zone, roomLabel: label });
  };
  const zoneName = (zone: string) => {
    const room = layout?.rooms.find((r) => r.label.includes(zone));
    return room ? localizedRoomName(room, lang) : zone;
  };
  const roomTitle = (v: { zone: string; roomLabel: string }) => {
    const room = layout?.rooms.find((r) => r.label === v.roomLabel);
    return room ? localizedRoomName(room, lang) : v.zone;
  };

  const refreshKey = state?.events[0]?.event_id ?? "";
  const awaiting = state?.approvals.length ?? 0;
  const actions = state?.actionList?.length ?? 0;
  const overdue = state?.actionList?.filter((a) => a.overdue).length ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <TopBar
        center={
          state && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <DataAxis s={state} />
              <ProcessingAxis s={state} onOpen={() => setStack([{ kind: "llm" }])} />
              <LlmConnectionAxis s={state} />
              <ConnectionAxis conn={conn} lastPoll={lastPoll} />
              <ApprovalAxis />
            </div>
          )
        }
        actions={
          <div style={{ display: "flex", gap: 6 }}>
            <button style={{ ...btn, fontSize: 11, whiteSpace: "nowrap" }} onClick={() => setStack([{ kind: "llm" }])}>⚙ Claude API</button>
            <a href="/" style={{ ...btn, textDecoration: "none", fontSize: 11, whiteSpace: "nowrap" }}>{t("Văn phòng chung", "Shared office")}</a>
          </div>
        }
      />
      {state?.mode.effective === "blocked" && (
        <div style={{ background: "#ef444422", color: "#fca5a5", fontSize: 12, padding: "6px 12px" }}>
          ⛔ {modeDescription(state.mode, t)}{" "}
          {state.mode.detail && <details style={{ display: "inline-block" }}><summary style={{ cursor: "pointer", display: "inline" }}>{i18n.t("common.details")}</summary><span lang="vi">{state.mode.detail}</span></details>}{" "}
          <button style={{ ...btn, padding: "1px 6px", fontSize: 11 }} onClick={() => setStack([{ kind: "llm" }])}>{t("Mở cấu hình Claude API", "Open Claude API settings")}</button>
        </div>
      )}
      {state?.mode.effective === "llm" && state.mode.configurationStatus === "last_call_failed" && (
        <div style={{ background: "#ef444422", color: "#fca5a5", fontSize: 12, padding: "6px 12px" }}>
          ⛔ {t("Lần gọi Claude API gần nhất bị lỗi — task liên quan chuyển trạng thái Lỗi, không tự chuyển sang chế độ khác.", "The last Claude API call failed — the related task is in Error; no silent switch to another mode.")}{state.mode.lastLlmErrorCategory ? ` (${state.mode.lastLlmErrorCategory})` : ""}{" "}
          {state.mode.lastLlmError && <details style={{ display: "inline-block" }}><summary style={{ cursor: "pointer", display: "inline" }}>{i18n.t("common.details")}</summary>{state.mode.lastLlmError}</details>}{" "}
          <button style={{ ...btn, padding: "1px 6px", fontSize: 11 }} onClick={() => setStack([{ kind: "llm" }])}>{t("Mở cấu hình", "Open settings")}</button>
        </div>
      )}
      {state?.dataSource.kind === "mixed" && (
        <div style={{ background: "#ef444422", color: "#fca5a5", fontSize: 12, padding: "4px 12px" }}>
          {t(
            `Cơ sở dữ liệu đang trộn dữ liệu GIẢ LẬP và dữ liệu thực (${state.dataSource.simulatedRows} / ${state.dataSource.realRows} dòng). Kết quả không được dùng như số liệu thực.`,
            `The database mixes SIMULATED and real data (${state.dataSource.simulatedRows} / ${state.dataSource.realRows} rows). Results must not be used as real figures.`,
          )}
        </div>
      )}
      {!!error && <ErrorMessage error={error} style={{ background: "#ef444422", padding: "4px 12px" }} />}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
          {layout && restoreRef.current ? (
            <LiveView
              config={layout}
              selectedRoom={selectedRoom}
              onSelectRoom={onSelectRoom}
              onSelectAgent={(id) => open({ kind: "agent", id })}
              agentLabels={labels}
              initialPlacement={restoreRef.current.placement}
              attentionState={attentionState}
              placement={placement}
              placementVersion={placementVersion}
              hideStatusBadge
            />
          ) : (
            <div style={{ padding: 20, color: "var(--ink-2)" }}>{t("Đang tải…", "Loading…")}</div>
          )}
          <div style={{ position: "absolute", right: 12, bottom: 12, fontSize: 11, color: "var(--ink-3)", background: "rgba(0,0,0,0.5)", padding: "4px 8px", borderRadius: 4, maxWidth: 560 }}>
            {t(
              "Click agent: việc đang làm · click phòng: hàng đợi. Di chuyển chỉ là hiển thị; huy hiệu ✋ phản ánh việc còn chờ trong cơ sở dữ liệu.",
              "Click an agent: current work · click a room: its queue. Movement is display only; the ✋ badge reflects work still pending in the database.",
            )}
          </div>
        </div>

        <aside style={{ width: 500, flexShrink: 0, borderLeft: "1px solid var(--border)", background: "var(--surface)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          {top ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
                <button style={btn} onClick={back}>{i18n.t("common.back")}</button>
                <button style={btn} onClick={() => setStack([])}>{i18n.t("common.close")}</button>
                <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{t("Truy vết", "Trace")}: {stack.length} {t("bước", stack.length === 1 ? "step" : "steps")}</span>
                {lang !== "vi" && (state?.contentLanguage ?? "vi") === "vi" && <span style={{ fontSize: 10.5, color: "var(--ink-3)", marginLeft: "auto" }} title={i18n.t("lang.untranslatedNote")}>ⓘ {i18n.t("lang.sourceVi")}</span>}
              </div>
              <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
                {state && top.kind === "task" && <TaskInspector workflowId={top.workflowId} taskId={top.taskId} open={open} refreshKey={refreshKey} state={state} />}
                {top.kind === "trace" && <TraceViewer refv={top.ref} open={open} />}
                {state && top.kind === "agent" && <AgentPanel id={top.id} state={state} open={open} roomName={zoneName} />}
                {state && top.kind === "room" && <RoomPanel zone={top.zone} label={roomTitle(top)} state={state} open={open} />}
                {top.kind === "llm" && <ClaudeApiPanel onChanged={refresh} />}
              </div>
            </>
          ) : (
            <>
              <div style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
                {([
                  ["actions", `${t("Việc cần làm", "To do")}${actions ? ` (${actions}${overdue ? ` · ${overdue} ${t("quá hạn", "overdue")}` : ""})` : ""}`],
                  ["workflow", t("Quy trình", "Workflow")],
                  ["approvals", `${t("Phê duyệt", "Approvals")}${awaiting ? ` (${awaiting})` : ""}`],
                  ["data", t("Dữ liệu", "Data")],
                  ["outbox", "Outbox"],
                  ["events", t("Nhật ký", "Log")],
                ] as Array<[Tab, string]>).map(([k, l]) => (
                  <button
                    key={k}
                    onClick={() => setTab(k)}
                    style={{
                      flex: 1,
                      padding: "9px 4px",
                      fontSize: 12,
                      background: "transparent",
                      border: "none",
                      borderBottom: tab === k ? "2px solid var(--accent)" : "2px solid transparent",
                      color: tab === k ? "var(--ink)" : "var(--ink-2)",
                      fontWeight: (k === "approvals" && awaiting) || (k === "actions" && overdue) ? 700 : 550,
                      cursor: "pointer",
                    }}
                  >
                    {l}
                  </button>
                ))}
              </div>
              <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
                {!state && <div style={{ color: "var(--ink-2)" }}>{t("Đang tải…", "Loading…")}</div>}
                {state && lang !== "vi" && <div style={{ fontSize: 10.5, color: "var(--ink-3)", marginBottom: 6 }}>ⓘ {i18n.t("lang.untranslatedNote")}</div>}
                {state && tab === "workflow" && <WorkflowBoard state={state} selected={selectedWf} onSelect={setSelectedWf} open={open} />}
                {state && tab === "approvals" && <ApprovalsPanel state={state} open={open} />}
                {state && tab === "data" && <DataPanel state={state} open={open} onChange={refresh} />}
                {state && tab === "actions" && <ActionListPanel state={state} open={open} />}
                {state && tab === "outbox" && (
                  <>
                    <OutboxPanel state={state} open={open} onChange={refresh} />
                    <ReservationsPanel state={state} onChange={refresh} />
                  </>
                )}
                {state && tab === "events" && <EventLog state={state} open={open} />}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
