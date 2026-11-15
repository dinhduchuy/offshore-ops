"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Section, btn, btnPrimary, input, card, api, postJson } from "./ui";
import { IdentityBar, useOpsSession } from "./Identity";
import type { LlmInfo, LlmTestResult, ModeState } from "./types";
import { useLang, modeDescription, type Lang } from "./i18n";
import { ErrorMessage } from "@/components/I18nProvider";
import { translateDynamic } from "@/lib/i18n/core";

/**
 * Claude API settings for the ops workflow. The key is typed here, sent once
 * to the server and never read back: the server only returns "configured" +
 * a masked value. Nothing is stored in the browser.
 */

const CUSTOM = "__custom__";

export function processingLabel(m: ModeState, lang: Lang = "vi"): string {
  const en = lang === "en";
  if (m.effective === "blocked") return en ? "LLM requested but misconfigured — agents paused" : "LLM được yêu cầu nhưng lỗi cấu hình — agent tạm dừng";
  if (m.effective === "rules") return en ? "Deterministic rules (no LLM call)" : "Quy tắc xác định (không gọi LLM)";
  return en ? "Rules + Claude API interpretation" : `Quy tắc + Claude API hỗ trợ diễn giải`;
}

const STATUS_TEXT: Record<string, [string, string]> = {
  not_applicable: ["không áp dụng", "not applicable"],
  missing_credentials: ["thiếu API key", "missing API key"],
  invalid_config: ["cấu hình lỗi", "invalid configuration"],
  configured_unverified: ["chưa có lần gọi thành công", "no successful call yet"],
  verified: ["lần gọi gần nhất thành công", "last call succeeded"],
  last_call_failed: ["lần gọi gần nhất LỖI", "last call FAILED"],
};

export function ClaudeApiPanel({ onChanged }: { onChanged?: () => void }) {
  const { session } = useOpsSession();
  const { t, lang, fmt } = useLang();
  const [info, setInfo] = useState<LlmInfo | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<LlmTestResult | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // form
  const [enabled, setEnabled] = useState(false);
  const [modelSel, setModelSel] = useState("claude-opus-5-5");
  const [customModel, setCustomModel] = useState("");
  const [effort, setEffort] = useState<"low" | "medium" | "high">("medium");
  const [fallback, setFallback] = useState(true);
  const [key, setKey] = useState("");

  const load = useCallback(() => {
    return api<LlmInfo & { ok: boolean }>("/api/ops/llm")
      .then((d) => {
        setInfo(d);
        setErr(null);
        return d;
      })
      .catch((e) => {
        setErr(e);
        return null;
      });
  }, []);

  useEffect(() => {
    load().then((d) => {
      if (!d) return;
      const s = d.settings;
      setEnabled(s.enabled);
      setEffort(s.effort);
      setFallback(s.refusalFallback);
      if (d.models.some((m) => m.id === s.model)) setModelSel(s.model);
      else {
        setModelSel(CUSTOM);
        setCustomModel(s.model);
      }
    });
  }, [load]);

  const model = modelSel === CUSTOM ? customModel.trim() : modelSel;
  const canEdit = !!session?.identity && info?.operatingMode !== "production";

  const save = async (extra: Record<string, unknown> = {}) => {
    setBusy("save");
    setSaved(null);
    setErr(null);
    try {
      await postJson("/api/ops/llm", { enabled, model, effort, refusalFallback: fallback, ...(key.trim() ? { apiKey: key.trim() } : {}), ...extra });
      setKey(""); // never keep the key in the page after it is sent
      setSaved(t("Đã lưu — áp dụng cho task bắt đầu từ bây giờ; task đang chạy giữ cấu hình cũ.", "Saved — applies to tasks starting from now; running tasks keep their configuration."));
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  const test = async (kind: "models" | "message") => {
    if (kind === "message" && !window.confirm(t(`Gọi thử 1 yêu cầu Messages API tới ${model}.\nYêu cầu này CÓ TÍNH PHÍ (vài trăm token). Tiếp tục?`, `Send 1 test Messages API request to ${model}.\nThis request IS BILLED (a few hundred tokens). Continue?`))) return;
    setBusy(kind);
    setResult(null);
    setErr(null);
    try {
      const d = await postJson<{ result: LlmTestResult }>("/api/ops/llm/test", {
        kind,
        confirmPaid: kind === "message",
        model,
        ...(key.trim() ? { apiKey: key.trim() } : {}),
      });
      setResult(d.result);
      await load();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  if (!info) return err ? <ErrorMessage error={err} /> : <div style={{ color: "var(--ink-2)", fontSize: 12 }}>{t("Đang tải cấu hình Claude API…", "Loading Claude API settings…")}</div>;
  const m = info.mode;
  const s = info.settings;

  return (
    <div style={{ fontSize: 12 }}>
      <div style={{ fontWeight: 700, fontSize: 14 }}>{t("Claude API cho Offshore Ops", "Claude API for Offshore Ops")}</div>
      <div style={{ color: "var(--ink-2)", marginTop: 2 }}>
        {t(
          "Claude chỉ diễn giải và phân tích trên dữ liệu, bằng chứng đã cung cấp. Phép tính, điều kiện workflow và quyền phê duyệt vẫn do backend quyết định.",
          "Claude only interprets and analyses the data and evidence provided. Calculations, workflow conditions and approval rights stay with the backend.",
        )}
      </div>

      <Section title={t("Trạng thái hiện tại", "Current status")}>
        <div style={{ ...card, display: "grid", gridTemplateColumns: "130px 1fr", rowGap: 4, columnGap: 8 }}>
          <span style={{ color: "var(--ink-3)" }}>{t("Chế độ xử lý", "Processing mode")}</span>
          <span>
            <Badge color={m.effective === "blocked" ? "#ef4444" : m.effective === "llm" ? "#38bdf8" : "#94a3b8"}>{processingLabel(m, lang)}</Badge>
          </span>
          <span style={{ color: "var(--ink-3)" }}>{t("Model sử dụng", "Model in use")}</span>
          <span style={{ fontFamily: "var(--font-mono)" }}>{m.effective === "rules" ? t("— (không gọi LLM)", "— (no LLM call)") : `${m.provider ?? "anthropic"} / ${m.model ?? s.model}${m.effort ? ` · effort ${m.effort}` : ""}`}</span>
          <span style={{ color: "var(--ink-3)" }}>{t("Trạng thái kết nối", "Connection status")}</span>
          <span style={{ color: m.configurationStatus === "last_call_failed" || m.effective === "blocked" ? "#ef4444" : undefined }}>
            {STATUS_TEXT[m.configurationStatus]?.[lang === "en" ? 1 : 0] ?? m.configurationStatus}
            {m.lastLlmOkAt ? ` · OK ${t("lúc", "at")} ${fmt.dateTime(m.lastLlmOkAt)}` : ""}
          </span>
          <span style={{ color: "var(--ink-3)" }}>API key</span>
          <span style={{ fontFamily: "var(--font-mono)" }}>{s.keyConfigured ? `${t("đã cấu hình", "configured")} (${s.keyMasked})` : t("chưa cấu hình", "not configured")}</span>
          <span style={{ color: "var(--ink-3)" }}>{t("Nguồn cấu hình", "Configuration source")}</span>
          <span>
            {m.source === "ui" ? `${t("giao diện /ops", "/ops interface")} · rev ${m.configRevision ?? s.revision}` : m.source === "env" ? t("biến môi trường OPS_LLM=1 (copilot) — đổi cần khởi động lại", "environment OPS_LLM=1 (copilot) — restart needed to change") : "ops-config.json"}
            {s.updatedAt ? ` · ${t("cập nhật", "updated")} ${fmt.dateTime(s.updatedAt)}${s.updatedBy ? ` ${t("bởi", "by")} ${s.updatedBy}` : ""}` : ""}
          </span>
        </div>
        {m.effective === "blocked" && (
          <div style={{ color: "#fca5a5", marginTop: 6 }}>
            ⛔ {modeDescription(m, t)} <span style={{ color: "var(--ink-3)" }} lang={lang !== "vi" ? "vi" : undefined}>({m.detail})</span>
          </div>
        )}
        {m.lastLlmError && (
          <div style={{ color: "#fca5a5", marginTop: 6, wordBreak: "break-word" }}>
            {t("Lỗi gần nhất", "Last error")}: {(m.lastLlmErrorCategory && translateDynamic(lang, `llm.result.cat_${m.lastLlmErrorCategory}`)) || ""}{" "}
            <span style={{ color: "var(--ink-3)" }}>({m.lastLlmError})</span>
          </div>
        )}
        {info.settingsError && <div style={{ color: "#ef4444", marginTop: 6 }} lang={lang !== "vi" ? "vi" : undefined}>{info.settingsError}</div>}
      </Section>

      <Section title={t("Cấu hình", "Settings")}>
        {info.operatingMode === "production" ? (
          <div style={{ color: "#ef4444" }}>{t("Chế độ production chưa có danh tính doanh nghiệp (SSO): không sửa cấu hình qua giao diện.", "Production mode has no enterprise identity (SSO): settings cannot be edited from the interface.")}</div>
        ) : (
          <IdentityBar />
        )}
        <fieldset disabled={!canEdit || !!busy} style={{ border: 0, padding: 0, margin: "8px 0 0", display: "grid", gap: 8 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 650 }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {t("Bật xử lý bằng Claude API", "Enable processing with Claude API")}
          </label>
          <div style={{ color: "var(--ink-3)", fontSize: 11, marginTop: -4 }}>
            {t(
              "Tắt = chỉ dùng quy tắc xác định. Bật mà thiếu key hoặc gọi API lỗi → agent tạm dừng và báo lỗi, không tự chuyển sang chế độ khác.",
              "Off = deterministic rules only. On without a key, or with a failing API call → agents pause and report the error; no silent switch to another mode.",
            )}
          </div>

          <label>
            <div style={{ color: "var(--ink-2)", marginBottom: 2 }}>Anthropic API key</div>
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              style={{ ...input, fontFamily: "var(--font-mono)" }}
              placeholder={s.keyConfigured ? t(`Đã lưu ${s.keyMasked} — để trống để giữ nguyên`, `Saved ${s.keyMasked} — leave empty to keep`) : "sk-ant-…"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <div style={{ color: "var(--ink-3)", fontSize: 11, marginTop: 2 }}>
              {t("Key chỉ lưu phía server (file 0600 trong thư mục ~/.diorama), không trả về trình duyệt, không ghi log.", "The key is stored on the server only (file 0600 in ~/.diorama), never returned to the browser, never logged.")}
              {s.keyConfigured && (
                <>
                  {" "}
                  <button type="button" style={{ ...btn, padding: "1px 6px", fontSize: 11 }} onClick={() => window.confirm(t("Xóa API key đã lưu?", "Delete the saved API key?")) && save({ clearKey: true })}>
                    {t("Xóa key", "Delete key")}
                  </button>
                </>
              )}
            </div>
          </label>

          <div style={{ display: "flex", gap: 8 }}>
            <label style={{ flex: 2 }}>
              <div style={{ color: "var(--ink-2)", marginBottom: 2 }}>Model</div>
              <select style={input} value={modelSel} onChange={(e) => setModelSel(e.target.value)}>
                {info.models.map((x) => (
                  <option key={x.id} value={x.id}>{x.label} — {x.id}</option>
                ))}
                <option value={CUSTOM}>{t("Model khác…", "Other model…")}</option>
              </select>
              {modelSel === CUSTOM && (
                <input style={{ ...input, marginTop: 4, fontFamily: "var(--font-mono)" }} placeholder="model id" value={customModel} onChange={(e) => setCustomModel(e.target.value)} />
              )}
            </label>
            <label style={{ flex: 1 }}>
              <div style={{ color: "var(--ink-2)", marginBottom: 2 }}>Effort</div>
              <select style={input} value={effort} onChange={(e) => setEffort(e.target.value as typeof effort)}>
                <option value="low">{t("low (nhanh, ít token)", "low (fast, fewer tokens)")}</option>
                <option value="medium">{t("medium (mặc định)", "medium (default)")}</option>
                <option value="high">{t("high (kỹ hơn)", "high (more thorough)")}</option>
              </select>
            </label>
          </div>

          <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" checked={fallback} onChange={(e) => setFallback(e.target.checked)} style={{ marginTop: 2 }} />
            <span>
              {t("Cho phép model dự phòng khi Claude từ chối (refusal fallback phía server)", "Allow a fallback model when Claude refuses (server-side refusal fallback)")}
              <div style={{ color: "var(--ink-3)", fontSize: 11 }}>{t("Nếu xảy ra, lịch sử ghi rõ model thực sự đã trả lời. Chỉ áp dụng cho model hỗ trợ.", "If it happens, the history records which model actually answered. Only for supporting models.")}</div>
            </span>
          </label>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button type="button" style={btnPrimary} onClick={() => save()} disabled={!model}>
              {busy === "save" ? t("Đang lưu…", "Saving…") : t("Lưu cấu hình", "Save settings")}
            </button>
            <button type="button" style={btn} onClick={() => test("models")} title={t("GET /v1/models/{model} — không tính phí", "GET /v1/models/{model} — not billed")}>
              {busy === "models" ? t("Đang kiểm tra…", "Checking…") : t("Kiểm tra kết nối (miễn phí)", "Check connection (free)")}
            </button>
            <button type="button" style={btn} onClick={() => test("message")} title={t("1 yêu cầu Messages API — có tính phí", "1 Messages API request — billed")}>
              {busy === "message" ? t("Đang gọi…", "Calling…") : t("Gọi thử 1 lần (có phí)", "Test call once (billed)")}
            </button>
          </div>
        </fieldset>
        {!session?.identity && info.operatingMode !== "production" && <div style={{ color: "#f59e0b", marginTop: 6 }}>{t("Chọn danh tính demo để sửa và kiểm tra cấu hình (được ghi vào lịch sử).", "Choose a demo identity to edit and test the settings (recorded in the history).")}</div>}
        {saved && <div style={{ color: "#22c55e", marginTop: 6 }}>{saved}</div>}
        {!!err && <ErrorMessage error={err} style={{ marginTop: 6 }} />}
        {result && (
          <div style={{ ...card, marginTop: 8, borderColor: result.success ? "#22c55e66" : "#ef444466" }}>
            <div style={{ fontWeight: 650, color: result.success ? "#22c55e" : "#ef4444" }}>
              {result.success ? "✓" : "✗"} {(result.code && translateDynamic(lang, `llm.result.${result.code}`, result.params)) || result.label}
            </div>
            {/* Provider/server detail kept as produced (support information) */}
            <div style={{ color: "var(--ink-2)", wordBreak: "break-word" }} lang={lang !== "vi" ? "vi" : undefined}>{result.message}</div>
            <div style={{ color: "var(--ink-3)", fontSize: 11, marginTop: 2 }}>
              {result.status ? `HTTP ${result.status} · ` : ""}
              {result.durationMs !== undefined ? `${result.durationMs} ms` : ""}
              {result.requestId ? ` · request-id ${result.requestId}` : ""}
              {result.retryAfter ? ` · ${t("thử lại sau", "retry after")} ${result.retryAfter}s` : ""}
            </div>
          </div>
        )}
      </Section>

      <Section title={t(`Lịch sử gọi LLM (${info.history.totals.calls} lần · token vào/ra ${info.history.totals.input_tokens}/${info.history.totals.output_tokens})`, `LLM call history (${info.history.totals.calls} calls · tokens in/out ${info.history.totals.input_tokens}/${info.history.totals.output_tokens})`)}>
        {info.history.calls.length === 0 ? (
          <div style={{ color: "var(--ink-3)" }}>{t("Chưa có lần gọi nào.", "No calls yet.")}</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 11, width: "100%" }}>
              <thead>
                <tr style={{ color: "var(--ink-2)", textAlign: "left" }}>
                  <th style={th}>{t("Thời gian", "Time")}</th>
                  <th style={th}>Task</th>
                  <th style={th}>Model</th>
                  <th style={th}>{t("Trạng thái", "Status")}</th>
                  <th style={th}>{t("Token vào/ra", "Tokens in/out")}</th>
                  <th style={th}>ms</th>
                </tr>
              </thead>
              <tbody>
                {info.history.calls.map((c) => (
                  <tr key={c.id} title={c.error ?? c.request_id ?? ""}>
                    <td style={td}>{fmt.dateTime(c.created_at)}</td>
                    <td style={td}>{c.case_no ? `${c.case_no} · ` : ""}{c.task_title ?? `run ${c.task_run_id}`}</td>
                    <td style={{ ...td, fontFamily: "var(--font-mono)" }}>
                      {c.served_model && c.served_model !== c.model ? `${c.model} → ${c.served_model}` : c.model}
                      {c.fallback_used ? t(" (dự phòng)", " (fallback)") : ""}
                      {c.config_revision !== null ? ` · rev ${c.config_revision}` : ""}
                    </td>
                    <td style={{ ...td, color: c.status === "ok" ? "#22c55e" : c.status === "running" ? "#60a5fa" : "#ef4444" }}>
                      {c.status ?? "?"}
                      {c.error_category ? ` · ${c.error_category}` : ""}
                      {c.http_status ? ` · HTTP ${c.http_status}` : ""}
                    </td>
                    <td style={td}>{c.input_tokens ?? "—"}/{c.output_tokens ?? "—"}</td>
                    <td style={td}>{c.duration_ms ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title={t("Lịch sử cấu hình & kiểm tra kết nối", "Settings & connection-check history")}>
        {info.history.events.length === 0 ? (
          <div style={{ color: "var(--ink-3)" }}>{t("Chưa có thay đổi.", "No changes yet.")}</div>
        ) : (
          <div style={{ display: "grid", gap: 4 }}>
            {info.history.events.map((e) => (
              <div key={e.id} style={{ ...card, padding: "4px 8px" }}>
                <span style={{ color: "var(--ink-3)" }}>{fmt.dateTime(e.created_at)}</span>{" "}
                <b>{e.kind === "config" ? t("Lưu cấu hình", "Settings saved") : e.kind === "check" ? t("Kiểm tra kết nối", "Connection check") : t("Gọi thử (có phí)", "Test call (billed)")}</b>{" "}
                <span style={{ color: e.status === "error" ? "#ef4444" : "#22c55e" }}>{e.status}{e.error_category ? ` · ${e.error_category}` : ""}{e.http_status ? ` · HTTP ${e.http_status}` : ""}</span>
                <span style={{ color: "var(--ink-2)" }}>
                  {" "}· {e.model ?? "?"}
                  {e.kind === "config" ? ` · ${e.enabled ? t("BẬT", "ON") : t("TẮT", "OFF")} · key ${e.key_configured ? t("có", "yes") : t("không", "no")}${e.key_changed ? t(" (đổi key)", " (key changed)") : ""} · rev ${e.revision}` : ""}
                  {e.input_tokens !== null ? ` · token ${e.input_tokens}/${e.output_tokens}` : ""}
                  {e.actor ? ` · ${e.actor}` : ""}
                </span>
                {e.detail && <div style={{ color: "var(--ink-3)", fontSize: 11, wordBreak: "break-word" }}>{e.detail}</div>}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

const th: React.CSSProperties = { borderBottom: "1px solid var(--border-strong)", padding: "3px 6px", whiteSpace: "nowrap" };
const td: React.CSSProperties = { borderBottom: "1px solid var(--border)", padding: "3px 6px", verticalAlign: "top" };
