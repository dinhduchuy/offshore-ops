"use client";

import { useEffect, useMemo, useState } from "react";
import { StatusBadge, ModeBadge, Badge, Section, RefChip, BASIS, basisLabel, btn, btnPrimary, input, card, api, postJson, type Ref } from "./ui";
import { IdentityBar, useOpsSession } from "./Identity";
import type { OpsState, View, WorkflowDetail, AgentOutput } from "./types";
import { useLang, stepTitle, conditionLabel, roleName, waitText } from "./i18n";
import { ErrorMessage } from "@/components/I18nProvider";
import { CONDITION_EN } from "@/lib/i18n/domain";

export function OutputView({ out, open }: { out: AgentOutput; open: (v: View) => void }) {
  const { t, lang, i18n } = useLang();
  // Rule-produced content (summary, conclusions, evidence labels, assumptions, missing data) is Vietnamese
  const src = i18n.sourceLang();
  const ev = new Map(out.evidence.map((e) => [e.id, e]));
  const openRef = (r: Ref) => open({ kind: "trace", ref: r });
  return (
    <div>
      <div style={{ ...card, fontSize: 12.5, lineHeight: 1.5 }} lang={src}>{out.summary}</div>

      {out.warnings.length > 0 && (
        <Section title={t("Cảnh báo", "Warnings")}>
          {out.warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 11.5, color: "#f59e0b", marginBottom: 3 }} lang={src}>⚠ {w}</div>
          ))}
        </Section>
      )}
      <Section title={`${t("Kết luận từ quy tắc & số liệu đã tính", "Conclusions from rules & computed figures")} (${out.conclusions.length})`}>
        {out.conclusions.map((c) => (
          <div key={c.id} style={{ fontSize: 12, marginBottom: 6, lineHeight: 1.45 }}>
            <Badge color={BASIS[c.basis]?.color ?? "#94a3b8"}>{basisLabel(c.basis, lang)}</Badge> <span lang={src}>{c.text}</span>{" "}
            {c.evidence.map((id) => {
              const e = ev.get(id);
              return e ? <RefChip key={id} label={id} refv={e.ref} onOpen={openRef} /> : null;
            })}
            {c.evidence.length === 0 && <span style={{ fontSize: 10.5, color: "var(--ink-3)" }}>{t("(nêu rõ: không có dữ liệu)", "(stated: no data)")}</span>}
          </div>
        ))}
      </Section>
      <Section title={`${t("Bằng chứng", "Evidence")} (${out.evidence.length})`}>
        {out.evidence.map((e) => (
          <div key={e.id} style={{ fontSize: 11.5, marginBottom: 3, display: "flex", gap: 6 }}>
            <RefChip label={e.id} refv={e.ref} onOpen={openRef} />
            <span style={{ color: "var(--ink-2)" }}>
              <span lang={src}>{e.label}</span> <span style={{ color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>[{e.ref.kind}]</span>
            </span>
          </div>
        ))}
      </Section>
      {out.llm && <LlmBlock llm={out.llm} ev={ev} openRef={openRef} />}
      {out.assumptions.length > 0 && (
        <Section title={t("Giả định", "Assumptions")}>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }} lang={src}>{out.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </Section>
      )}
      <Section title={`${t("Dữ liệu còn thiếu", "Missing data")} (${out.missingData.length})`}>
        {out.missingData.length === 0 && <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{t("Không có", "None")}</div>}
        {out.missingData.map((m) => (
          <div key={m.id} style={{ fontSize: 12, marginBottom: 4 }}>
            {m.blocking ? <Badge color="#ef4444">{t("Bắt buộc", "Required")}</Badge> : <Badge color="#94a3b8">{t("Cần xác nhận", "To confirm")}</Badge>} <span lang={src}>{m.description}</span>
            {m.owner && <span style={{ color: "var(--ink-3)" }}> — {m.owner}</span>}
            {m.datasetType && <span style={{ color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}> [{m.datasetType}]</span>}
          </div>
        ))}
      </Section>
      {out.documents.length > 0 && (
        <Section title={t("Tài liệu tạo ra", "Documents produced")}>
          {out.documents.map((d) => (
            <div key={d.docId} style={{ marginBottom: 3 }}>
              <RefChip label={`📄 ${d.title} v${d.version}`} refv={{ kind: "document", id: d.docId }} onOpen={openRef} color="#c4b5fd" />
            </div>
          ))}
        </Section>
      )}
      {out.nextSteps.length > 0 && (
        <Section title={t("Bước tiếp theo", "Next steps")}>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }} lang={src}>{out.nextSteps.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </Section>
      )}
    </div>
  );
}

function LlmBlock({ llm, ev, openRef }: { llm: NonNullable<AgentOutput["llm"]>; ev: Map<string, AgentOutput["evidence"][number]>; openRef: (r: Ref) => void }) {
  const { t, lang } = useLang();
  // Language the narrative was written in (run snapshot); older runs were always Vietnamese
  const written = (llm as { language?: string }).language ?? "vi";
  const llmLang = written !== lang ? written : undefined;
  return (
    <div style={{ ...card, borderColor: "#38bdf8", marginTop: 14 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <b style={{ fontSize: 12 }}>{t("Nội dung do LLM viết", "Written by the LLM")}</b>
        <Badge color="#f59e0b">{t("CHƯA XÁC MINH NGỮ NGHĨA", "MEANING NOT VERIFIED")}</Badge>
        <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{llm.provider}{llm.model ? ` / ${llm.model}` : ""} · {t("ngôn ngữ đầu ra", "output language")}: {written.toUpperCase()}</span>
      </div>
      <div style={{ fontSize: 10.5, color: "var(--ink-3)", margin: "4px 0 8px" }} lang={lang !== "vi" ? "vi" : undefined}>{lang === "vi" ? llm.validationNote : "Automatic checks: (1) every finding cites an existing evidence id; (2) every figure/date in a finding appears in the cited evidence; (3) no claim of approval, permit or sending; (4) no affirming a hypothesis the rules found unsupported, no denying required missing data. These checks only show linkage and no surface contradiction — they do NOT prove the finding is right. Readers must check before use."}</div>
      {llm.narrative && <div style={{ fontSize: 12, color: "var(--ink-2)", whiteSpace: "pre-wrap", marginBottom: 6 }} lang={llmLang}>{llm.narrative}</div>}
      {llm.claims.map((c, i) => (
        <div key={i} style={{ fontSize: 12, marginBottom: 4 }}>
          <Badge color="#38bdf8">LLM · {basisLabel(c.basis, lang)}</Badge> <span lang={llmLang}>{c.text}</span>{" "}
          {c.evidence.map((id) => (ev.get(id) ? <RefChip key={id} label={id} refv={ev.get(id)!.ref} onOpen={openRef} /> : null))}
          <span style={{ fontSize: 10.5, color: "var(--ink-3)" }}> · {t("có liên kết bằng chứng", "linked to evidence")}{c.numbersChecked ? `, ${c.numbersChecked} ${t("số liệu khớp bằng chứng", "figures match the evidence")}` : ""}</span>
        </div>
      ))}
      {llm.nextSteps.length > 0 && <div style={{ fontSize: 11.5, color: "var(--ink-2)", marginTop: 4 }}>{t("Gợi ý (chưa xác minh)", "Suggestions (unverified)")}: <span lang={llmLang}>{llm.nextSteps.join(" · ")}</span></div>}
      {(llm.rejected.length > 0 || llm.narrativeRedactions.length > 0) && (
        <details style={{ marginTop: 6, fontSize: 11.5 }}>
          <summary style={{ cursor: "pointer", color: "#f59e0b" }}>{t(`Đã loại ${llm.rejected.length + llm.narrativeRedactions.length} nội dung LLM không đạt kiểm tra`, `${llm.rejected.length + llm.narrativeRedactions.length} LLM statements removed (failed checks)`)}</summary>
          {[...llm.narrativeRedactions, ...llm.rejected].map((r, i) => (
            <div key={i} style={{ marginTop: 3 }}>✗ “{r.text}” — <span style={{ color: "var(--ink-3)" }}>{r.reason}</span></div>
          ))}
        </details>
      )}
    </div>
  );
}

function DecisionForm({ task, onDone, titles }: { task: WorkflowDetail["tasks"][number]; onDone: () => void; titles: Record<string, string> }) {
  const f = task.gateFacts!;
  const { session } = useOpsSession();
  const { t, lang, i18n } = useLang();
  const [decision, setDecision] = useState<"approve" | "reject" | "request_changes">("approve");
  const [returnTo, setReturnTo] = useState(f.returnOptions[f.returnOptions.length - 1]);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  // Same payload → same idempotency key (safe retry); changed payload → new key
  const [attempt, setAttempt] = useState<{ payload: string; key: string } | null>(null);
  const conditions = f.conditions ?? [];
  const [waivers, setWaivers] = useState<string[]>([]);
  const [confirms, setConfirms] = useState<string[]>([]);
  const toggle = (list: string[], set: (v: string[]) => void, code: string) => set(list.includes(code) ? list.filter((x) => x !== code) : [...list, code]);
  const myRoles = (session?.identity?.roles ?? []).map((r) => r.toLowerCase());

  const submit = async () => {
    setBusy(true);
    setErr(null);
    const body = {
      taskId: task.id,
      decision,
      comment,
      returnTo: decision === "request_changes" ? returnTo : undefined,
      packageSha: f.packageSha,
      packageVersion: f.packageVersion,
      ...(decision === "approve" ? { waivers: [...waivers].sort(), confirmations: [...confirms].sort() } : {}),
    };
    const payload = JSON.stringify(body);
    const key = attempt?.payload === payload ? attempt.key : crypto.randomUUID();
    setAttempt({ payload, key });
    try {
      await postJson("/api/ops/decisions", { ...body, idempotencyKey: key });
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ ...card, borderColor: "#c084fc", marginTop: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 650, marginBottom: 6 }}>{t("Quyết định — cần vai trò", "Decision — role required")}: {roleName(f.role, lang)}</div>
      <div style={{ fontSize: 11, color: "var(--ink-2)", marginBottom: 8 }}>
        {t("Hồ sơ", "Package")} v{f.packageVersion} · sha256 <span style={{ fontFamily: "var(--font-mono)" }}>{f.packageSha.slice(0, 16)}…</span> · case rev {f.workflowVersion}.{" "}
        {t("Quyết định chỉ được nhận cho đúng phiên bản hồ sơ và revision này; nếu hồ sơ hoặc đầu vào đổi, server từ chối.", "A decision is accepted only for this exact package version and revision; if the package or its inputs change, the server refuses.")}
      </div>
      <IdentityBar requiredRole={f.role} />
      {conditions.length > 0 && (
        <div style={{ margin: "8px 0", fontSize: 11.5 }}>
          <div style={{ fontWeight: 650, marginBottom: 4 }}>{t("Điều kiện", "Conditions")} ({f.policyVersion ?? t("chính sách", "policy")})</div>
          {conditions.map((c) => (
            <div key={c.code} style={{ display: "flex", gap: 6, alignItems: "flex-start", padding: "3px 0", borderBottom: "1px solid var(--border)" }}>
              <span style={{ width: 16, color: c.kind === "confirm" ? "#38bdf8" : c.met ? "#22c55e" : c.waivable ? "#f59e0b" : "#ef4444" }}>{c.kind === "confirm" ? "☐" : c.met ? "✓" : c.waivable ? "!" : "✗"}</span>
              <span style={{ flex: 1 }}>
                {conditionLabel(c, lang)}
                {c.kind === "check" && <span style={{ color: "var(--ink-3)", fontSize: 10.5 }}> [{t("kiểm tra dữ liệu", "data check")}]</span>}
                {c.detail && <span style={{ color: "var(--ink-3)" }} lang={i18n.sourceLang()}> — {c.detail}</span>}
                {c.kind === "check" && !c.met && !c.waivable && <div style={{ color: "#ef4444", fontSize: 10.5 }}>{t("Không thể miễn trừ — phải trả lại để bổ sung", "Not waivable — return the case to fix it")}</div>}
                {c.kind === "check" && !c.met && c.waivable && decision === "approve" && (
                  <label style={{ display: "flex", gap: 4, fontSize: 10.5, color: "#f59e0b", cursor: "pointer" }}>
                    <input type="checkbox" checked={waivers.includes(c.code)} onChange={() => toggle(waivers, setWaivers, c.code)} />
                    {t("Ghi ngoại lệ (cần vai trò", "Record an exception (role required")}: {c.waiverRoles.map((r) => roleName(r, lang)).join(" / ")}){!c.waiverRoles.some((r) => myRoles.includes(r.toLowerCase())) ? t(" — danh tính hiện tại KHÔNG có thẩm quyền", " — the current identity is NOT authorised") : ""}
                  </label>
                )}
                {c.kind === "confirm" && decision === "approve" && (
                  <label style={{ display: "flex", gap: 4, fontSize: 10.5, color: "#38bdf8", cursor: "pointer" }}>
                    <input type="checkbox" checked={confirms.includes(c.code)} onChange={() => toggle(confirms, setConfirms, c.code)} />
                    {t("Tôi đã kiểm tra và xác nhận mục này (hệ thống không tự xác nhận)", "I checked and confirm this item (the system never confirms it by itself)")}
                  </label>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 10, margin: "8px 0", fontSize: 12 }}>
        {([["approve", t("Duyệt", "Approve")], ["request_changes", t("Yêu cầu bổ sung", "Request changes")], ["reject", t("Từ chối", "Reject")]] as const).map(([v, l]) => (
          <label key={v} style={{ display: "flex", gap: 4, alignItems: "center", cursor: "pointer" }}>
            <input type="radio" checked={decision === v} onChange={() => setDecision(v)} /> {l}
          </label>
        ))}
      </div>
      {decision === "request_changes" && (
        <select style={{ ...input, marginBottom: 6 }} value={returnTo} onChange={(e) => setReturnTo(e.target.value)}>
          {f.returnOptions.map((o) => (
            <option key={o} value={o}>{t("Trả về bước", "Return to step")}: {stepTitle(o, titles[o] ?? o, lang)}</option>
          ))}
        </select>
      )}
      <textarea style={{ ...input, minHeight: 54 }} placeholder={decision === "approve" ? t("Ghi chú (tùy chọn)", "Note (optional)") : t("Lý do / nội dung cần bổ sung (bắt buộc)", "Reason / what must be fixed (required)")} value={comment} onChange={(e) => setComment(e.target.value)} />
      {!!err && <ErrorMessage error={err} style={{ marginTop: 6 }} />}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
        <button style={btnPrimary} disabled={busy || !session?.identity} onClick={submit}>
          {busy ? t("Đang ghi…", "Saving…") : session?.identity ? t("Ghi quyết định", "Record decision") : t("Chọn danh tính trước", "Choose an identity first")}
        </button>
      </div>
    </div>
  );
}

/** The responsible person records an approved activity's execution (identity from the server session). */
function ExecutionForm({ workflowId, activities, onDone }: { workflowId: number; activities: Array<{ type: string; name: string }>; onDone: () => void }) {
  const { session } = useOpsSession();
  const { t, i18n } = useLang();
  const [activity, setActivity] = useState(activities[0]?.type ?? "");
  const [status, setStatus] = useState<"done" | "partial" | "not_done">("done");
  // Business date in the business time zone (not UTC, not the viewer's language); sent as ISO YYYY-MM-DD
  const [date, setDate] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: i18n.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()));
  const [findings, setFindings] = useState("");
  const [resultRef, setResultRef] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      await postJson("/api/ops/execution", { workflowId, activityType: activity, status, completedDate: date, findings, resultRef });
      setMsg(t("Đã ghi nhận — bước Ghi nhận thực hiện sẽ chạy lại.", "Recorded — the execution step will re-run."));
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ ...card, borderColor: "#38bdf8", marginTop: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 650, marginBottom: 4 }}>{t("Ghi nhận thực hiện (người phụ trách xác nhận)", "Record execution (confirmed by the responsible person)")}</div>
      <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6 }}>{t("Agent và LLM không bao giờ tự báo đã thực hiện. Bản ghi lưu danh tính phía server của bạn làm người xác nhận.", "Agents and the LLM never report work as done. The record stores your server-side identity as the confirmer.")}</div>
      <IdentityBar />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 6 }}>
        <select style={input} value={activity} onChange={(e) => setActivity(e.target.value)}>
          {activities.map((a) => (
            <option key={a.type} value={a.type}>{a.name}</option>
          ))}
        </select>
        <select style={input} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="done">{t("Hoàn tất", "Done")}</option>
          <option value="partial">{t("Một phần", "Partial")}</option>
          <option value="not_done">{t("Không thực hiện", "Not done")}</option>
        </select>
        <input style={input} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <input style={input} placeholder={t("Mã báo cáo/tài liệu kết quả", "Result report / document reference")} value={resultRef} onChange={(e) => setResultRef(e.target.value)} />
      </div>
      <textarea style={{ ...input, minHeight: 44, marginTop: 6 }} placeholder={t("Kết quả / phát hiện (bắt buộc nếu hoàn tất, trừ khi có mã tài liệu)", "Result / findings (required when done, unless a document reference is given)")} value={findings} onChange={(e) => setFindings(e.target.value)} />
      {msg && <div role="status" style={{ fontSize: 12, marginTop: 4, color: "#22c55e" }}>{msg}</div>}
      {!!err && <ErrorMessage error={err} style={{ marginTop: 4 }} />}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
        <button style={btnPrimary} disabled={busy || !session?.identity || !activity} onClick={submit}>{session?.identity ? t("Ghi nhận", "Record") : t("Chọn danh tính trước", "Choose an identity first")}</button>
      </div>
    </div>
  );
}

export function TaskInspector({ workflowId, taskId, open, refreshKey, state }: { workflowId: number; taskId: number; open: (v: View) => void; refreshKey: string; state: OpsState }) {
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [local, setLocal] = useState(0);
  const { t, lang, fmt, i18n } = useLang();
  const titles = useMemo(() => Object.fromEntries(state.steps.map((s) => [s.key, s.title])), [state.steps]);
  const st = (k: string) => stepTitle(k, titles[k] ?? k, lang);

  useEffect(() => {
    api<WorkflowDetail>(`/api/ops/workflows/${workflowId}`).then(setDetail).catch((e) => setErr(e));
  }, [workflowId, refreshKey, local]);

  if (err) return <ErrorMessage error={err} />;
  if (!detail) return <div style={{ color: "var(--ink-2)" }}>{t("Đang tải…", "Loading…")}</div>;
  const task = detail.tasks.find((x) => x.id === taskId);
  if (!task) return <div>{t("Không tìm thấy task", "Task not found")}</div>;
  const current = task.runs.find((r) => !r.superseded) ?? task.runs[0];
  const agent = state.agents.find((a) => a.id === task.agentId);
  const decisions = detail.decisions.filter((d) => d.task_id === task.id);
  const feedback = task.feedback ? (JSON.parse(task.feedback) as { comment: string; actor: string; role: string; decisionId: number }) : null;

  const retry = async () => {
    try {
      await postJson(`/api/ops/tasks/${task.id}/retry`, {});
      setLocal((x) => x + 1);
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--ink-2)" }}>{detail.workflow.case_no} · <span style={{ fontFamily: "var(--font-mono)" }}>{task.key}</span></div>
      <div style={{ fontSize: 15, fontWeight: 650, margin: "2px 0 6px" }}>{stepTitle(task.key, task.title, lang)}</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <StatusBadge status={task.status} />
        <ModeBadge mode={current?.mode ?? null} />
        <button style={{ ...btn, padding: "1px 7px", fontSize: 11 }} onClick={() => open({ kind: "agent", id: task.agentId })}>
          {agent?.kind === "human" ? "" : "🤖 "}{agent?.short ?? task.agentId}
        </button>
        <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{t("lần chạy", "runs")} {task.attempts} · {t("cập nhật", "updated")} {fmt.dateTime(task.updatedAt)}</span>
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>{t("Phụ thuộc", "Depends on")}: {task.deps.length ? task.deps.map(st).join(", ") : "—"}</div>
      {task.note && task.status !== "done" && (
        <div style={{ fontSize: 12, color: task.status === "skipped" ? "var(--ink-3)" : "var(--ink-2)", marginTop: 6 }}>
          {task.status === "skipped" ? t("Bỏ qua — ", "Skipped — ") : task.waitKind || task.waitLabel ? `${waitText(task.waitKind, task.waitLabel, lang)}: ` : ""}
          {/* Awaiting approval: the note only names the approver role → render it from the role, not the server text */}
          {task.status === "awaiting_approval" && task.owner ? roleName(task.owner, lang) : <span lang={i18n.sourceLang()}>{task.note}</span>}
        </div>
      )}
      {(task.owner || task.dueAt) && !["done", "skipped"].includes(task.status) && (
        <div style={{ fontSize: 11.5, color: task.overdue ? "#ef4444" : "var(--ink-3)", marginTop: 3 }}>
          {t("Người giữ việc", "Holder")}: {task.owner ? roleName(task.owner, lang) : "—"}
          {task.dueAt ? ` · ${t("hạn", "due")} ${fmt.dateTime(task.dueAt)}${task.overdue ? t(" — QUÁ HẠN", " — OVERDUE") : ""}` : ""}
          {task.caseRevision ? ` · case rev ${task.caseRevision}` : ""}
        </div>
      )}

      {feedback && (
        <div style={{ ...card, borderColor: "#f59e0b", marginTop: 8, fontSize: 12 }}>
          ↩ {t("Hồ sơ bị trả lại bởi", "Returned by")} <b>{feedback.actor}</b> ({roleName(feedback.role, lang)}): “<span lang={i18n.sourceLang()}>{feedback.comment}</span>”{" "}
          <RefChip label={t("quyết định", "decision")} refv={{ kind: "decision", id: feedback.decisionId }} onOpen={(r) => open({ kind: "trace", ref: r })} />
        </div>
      )}
      {(task.status === "error" || task.status === "missing_data" || task.status === "waiting") && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
          <button style={btn} onClick={retry}>{t("↻ Chạy lại", "↻ Retry")}</button>
          <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
            {task.status === "missing_data"
              ? t("Hoặc nhập dữ liệu ở tab Dữ liệu — task tự chạy lại khi đúng loại dữ liệu được bổ sung.", "Or import data in the Data tab — the task re-runs when the right data type arrives.")
              : t("Lỗi được ghi nhận; chạy lại tạo lần chạy mới, giữ lịch sử.", "The error is recorded; a retry creates a new run and keeps history.")}
          </span>
        </div>
      )}
      {task.gate && task.status === "awaiting_approval" && task.gateFacts && <DecisionForm task={task} onDone={() => setLocal((x) => x + 1)} titles={titles} />}
      {task.key === "ops.execution" && task.status === "waiting" && (() => {
        const prop = detail.tasks.find((t) => t.key === "ops.proposal");
        const acts = ((prop?.runs.find((r) => !r.superseded)?.output?.facts.activities as Array<{ type: string; name: string }> | undefined) ?? []);
        return <ExecutionForm workflowId={workflowId} activities={acts} onDone={() => setLocal((x) => x + 1)} />;
      })()}
      {(() => {
        const ho = (detail.handoffs ?? []).filter((h) => h.to_key === task.key || h.from_key === task.key).slice(0, 8);
        if (!ho.length) return null;
        return (
          <Section title={t("Bàn giao", "Hand-offs")}>
            {ho.map((h) => (
              <div key={h.id} style={{ fontSize: 11.5, padding: "3px 0", borderBottom: "1px solid var(--border)" }}>
                {h.from_key === task.key ? t("→ giao cho", "→ handed to") : t("← nhận từ", "← received from")} <b>{st(h.from_key === task.key ? h.to_key : h.from_key)}</b> · rev {h.case_revision} · <StatusBadge status={h.status === "accepted" ? "done" : h.status === "offered" ? "pending" : h.status} />
                {h.artifact_doc_id && (
                  <>
                    {" "}
                    <RefChip label={`${t("hồ sơ", "package")} v${h.artifact_version}`} refv={{ kind: "document", id: h.artifact_doc_id }} onOpen={(r) => open({ kind: "trace", ref: r })} />
                  </>
                )}
                <div style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                  {t("Yêu cầu", "Request")}: {h.request} · {t("tiêu chí", "criteria")}: {(JSON.parse(h.acceptance_json || "[]") as string[]).join("; ") || "—"}
                  {h.due_at ? ` · ${t("hạn", "due")} ${fmt.dateTime(h.due_at)}` : ""}
                  {h.response ? ` · ${t("phản hồi", "response")}: ${h.response}` : ""}
                  {h.return_reason ? ` · ${t("lý do trả lại", "return reason")}: ${h.return_reason}` : ""}
                </div>
              </div>
            ))}
          </Section>
        );
      })()}

      {current?.error && (
        <div style={{ ...card, borderColor: "#ef4444", color: "#ef4444", fontSize: 12, marginTop: 10 }}>{t("Lỗi", "Error")}: {current.error}</div>
      )}
      {current?.output && (
        <Section title={t("Đầu ra", "Output")}>
          <OutputView out={current.output} open={open} />
        </Section>
      )}
      {current && current.inputs.length > 0 && (
        <Section title={t("Đầu vào đã dùng", "Inputs used")}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {current.inputs.map((r, i) => (
              <RefChip key={i} label={`${r.kind} #${r.id}`} refv={r} onOpen={(x) => open({ kind: "trace", ref: x })} />
            ))}
          </div>
        </Section>
      )}
      {detail.snapshot && task.key === "ops.anomaly" && (
        <Section title={`${t("Snapshot đầu vào", "Input snapshot")} — case rev ${detail.snapshot.revision}`}>
          <div style={{ fontSize: 11.5, display: "grid", gridTemplateColumns: "120px 1fr", rowGap: 2 }}>
            <span style={{ color: "var(--ink-3)" }}>{t("Giếng", "Well")}</span><span style={{ fontFamily: "var(--font-mono)" }}>{detail.snapshot.wellKey}</span>
            <span style={{ color: "var(--ink-3)" }}>{t("Kỳ dữ liệu", "Data period")}</span><span>{fmt.date(detail.snapshot.reportPeriod.from)} → {fmt.date(detail.snapshot.reportPeriod.to)}</span>
            <span style={{ color: "var(--ink-3)" }}>{t("Mốc đánh giá", "Evaluation date")}</span><span>{fmt.date(detail.snapshot.evaluationDate)} · {t("tuổi", "age")} {detail.snapshot.dataAgeDays ?? "?"} {t("ngày", "days")}{detail.snapshot.stale ? t(" (CŨ)", " (STALE)") : ""}</span>
            <span style={{ color: "var(--ink-3)" }}>{t("Đại lượng", "Quantity")}</span><span>{detail.snapshot.units.meaning || detail.snapshot.units.basis}</span>
            <span style={{ color: "var(--ink-3)" }}>{t("Quy tắc", "Rules")}</span><span style={{ fontFamily: "var(--font-mono)" }}>{detail.snapshot.rules}</span>
            <span style={{ color: "var(--ink-3)" }}>{t("Nguồn dữ liệu", "Data source")}</span><span>{detail.snapshot.simulated ? t("GIẢ LẬP", "SIMULATED") : t("thực", "real")} · {Object.entries(detail.snapshot.data).map(([k, v]) => `${k}: ${v.rows}`).join(", ")}</span>
            <span style={{ color: "var(--ink-3)" }}>{t("Phát hiện ban đầu", "Initial detection")}</span><span>{t("đến", "to")} {fmt.date(detail.snapshot.initialDetection.asOf)}: {t("giảm tối thiểu", "minimum drop")} {detail.snapshot.initialDetection.minDropPct === null || detail.snapshot.initialDetection.minDropPct === undefined ? "—" : fmt.percent(Number(detail.snapshot.initialDetection.minDropPct) / 100)}</span>
          </div>
          {(detail.revisions ?? []).length > 1 && (
            <div style={{ marginTop: 6 }}>
              {(detail.revisions ?? []).map((r) => (
                <div key={r.revision} style={{ fontSize: 11, color: "var(--ink-2)" }}>
                  rev {r.revision} · {fmt.dateTime(r.created_at)} — <span lang={i18n.sourceLang()}>{r.reason}</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}
      {decisions.length > 0 && (
        <Section title={t("Quyết định", "Decisions")}>
          {decisions.map((d) => (
            <div key={d.id} style={{ fontSize: 12, marginBottom: 4 }}>
              <RefChip label={`#${d.id}`} refv={{ kind: "decision", id: d.id }} onOpen={(r) => open({ kind: "trace", ref: r })} /> {i18n.t(`decision.${d.decision}` as "decision.approve")} — {d.actor_name} ({roleName(d.actor_role, lang)}){d.identity_source ? <span style={{ color: "var(--ink-3)" }} title={t("Nguồn danh tính lưu cùng quyết định — mở #id để xem chi tiết", "Identity source stored with the decision — open #id for details")}> [{d.identity_source === "demo" ? t("danh tính DEMO", "DEMO identity") : d.identity_source === "enterprise" ? t("danh tính doanh nghiệp", "enterprise identity") : d.identity_source}]</span> : null} {fmt.dateTime(d.decided_at)} · {t("hồ sơ", "package")} v{d.package_version}
              {d.case_revision ? ` · rev ${d.case_revision}` : ""}
              {d.waivers_json && d.waivers_json !== "[]" && <span style={{ color: "#f59e0b" }}> · {t("ngoại lệ", "waivers")}: {(JSON.parse(d.waivers_json) as string[]).map((c) => (lang === "en" && CONDITION_EN[c] ? `${CONDITION_EN[c]} (${c})` : c)).join(", ")}</span>}
              {d.comment && <span style={{ color: "var(--ink-2)" }}>: “<span lang={i18n.sourceLang()}>{d.comment}</span>”</span>}
            </div>
          ))}
        </Section>
      )}
      <Section title={`${t("Lịch sử chạy", "Run history")} (${task.runs.length})`}>
        {task.runs.map((r) => (
          <div key={r.id} style={{ fontSize: 11.5, display: "flex", gap: 6, alignItems: "center", marginBottom: 3, opacity: r.superseded ? 0.55 : 1 }}>
            <RefChip label={`run #${r.id}`} refv={{ kind: "task_run", id: r.id }} onOpen={(x) => open({ kind: "trace", ref: x })} />
            <StatusBadge status={r.status} />
            <span style={{ color: "var(--ink-3)" }}>{t("lần", "attempt")} {r.attempt} · {fmt.dateTime(r.startedAt)}{r.superseded ? t(" · đã bị thay thế", " · superseded") : ""}</span>
          </div>
        ))}
      </Section>
    </div>
  );
}
