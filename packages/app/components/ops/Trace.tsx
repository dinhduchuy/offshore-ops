"use client";

import { useEffect, useState } from "react";
import { Section, RefChip, Markdown, card, btn, api, postJson, type Ref } from "./ui";
import type { View } from "./types";
import { useLang, statusText, stepTitle, roleName, agentName, datasetName } from "./i18n";
import { ErrorMessage } from "@/components/I18nProvider";
import { translateDynamic } from "@/lib/i18n/core";
import type { Locale } from "@/lib/i18n/locale";
import { useOpsSession } from "./Identity";

type Msg = { key: string; params?: Record<string, string | number> };
type FieldKind = "text" | "status" | "datetime" | "code" | "identity" | "decision";
type IssueMsg = { code?: string; severity?: string; params?: Record<string, string | number>; message: string };

interface TraceView {
  title: string;
  titleMsg?: Msg;
  subtitle?: string;
  subtitleMsgs?: Msg[];
  simulated?: boolean;
  fields: Array<{ label: string; value: string; key?: string; kind?: FieldKind; valueMsg?: Msg }>;
  table?: { header: string[]; headerKeys?: string[]; rows: string[][]; refs?: Array<Ref | null>; statusColumn?: number; rowIssues?: IssueMsg[][] };
  body?: string;
  bodyKind?: "markdown" | "text" | "json";
  bodyLang?: string;
  warnings?: string[];
  warningMsgs?: Array<Msg | null>;
  links: Array<{ label: string; ref: Ref; key?: string; params?: Record<string, string | number> }>;
}

/** Params that carry business codes rendered in the interface language (step keys, decisions, issue variants). */
function localParams(m: Msg, lang: Locale): Record<string, string | number> | undefined {
  if (!m.params) return m.params;
  const p: Record<string, string | number> = { ...m.params };
  if (typeof p.step === "string") p.step = stepTitle(p.step, p.step, lang);
  if (typeof p.decision === "string") p.decision = translateDynamic(lang, `decision.${p.decision}`) ?? p.decision;
  if (typeof p.role === "string") p.role = roleName(p.role, lang);
  if (typeof p.dataset === "string") p.dataset = datasetName(p.dataset, p.dataset, lang);
  return p;
}

/** Render a server message key; unknown key or missing params → the original text (no guessing). */
export function msgText(m: Msg | null | undefined, original: string, lang: Locale): string {
  if (!m) return original;
  let key = m.key;
  if (key === "dq.out_of_range") key = m.params?.min !== undefined ? "dq.below_min" : "dq.above_max";
  return translateDynamic(lang, key, localParams(m, lang)) ?? original;
}

export function issueText(i: IssueMsg, lang: Locale): { text: string; translated: boolean } {
  if (lang === "vi" || !i.code || !i.params) return { text: i.message, translated: lang === "vi" };
  const s = msgText({ key: `dq.${i.code}`, params: i.params }, i.message, lang);
  return { text: s, translated: s !== i.message };
}

export function TraceViewer({ refv, open }: { refv: Ref; open: (v: View) => void }) {
  const [v, setV] = useState<TraceView | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const { t, lang, fmt, i18n } = useLang();
  useEffect(() => {
    setV(null);
    setErr(null);
    api<TraceView>(`/api/ops/trace?kind=${refv.kind}&id=${encodeURIComponent(String(refv.id))}`).then(setV).catch((e) => setErr(e));
  }, [refv.kind, refv.id]);
  if (err) return <ErrorMessage error={err} />;
  if (!v) return <div style={{ color: "var(--ink-2)" }}>{i18n.t("common.loading")}</div>;
  const go = (r: Ref) => open({ kind: "trace", ref: r });
  const vi = lang === "vi";
  // System labels: Vietnamese = the server's own wording; other languages = catalog keys (else original, marked lang="vi")
  const label = (key: string | undefined, original: string) => (vi || !key ? original : (translateDynamic(lang, key) ?? original));
  const srcLang = (translated: boolean) => (translated ? undefined : i18n.sourceLang());
  const value = (f: TraceView["fields"][number]) => {
    if (!vi && f.valueMsg) return msgText(f.valueMsg, f.value, lang);
    switch (f.kind) {
      case "datetime":
        return f.value && f.value !== "—" ? fmt.dateTime(f.value, { year: true }) : "—";
      case "status":
        return statusText(f.value, lang);
      case "identity":
        return translateDynamic(lang, `trace.identity.${f.value || "unknown"}`) ?? f.value;
      default:
        return f.value;
    }
  };
  const title = vi ? v.title : msgText(v.titleMsg, v.title, lang);
  // "agent" is not a catalog key: it names the agent by id (unknown id → the server's subtitle)
  const subMsg = (m: Msg) => (m.key === "agent" ? agentName(String(m.params?.id ?? ""), "", lang) : msgText(m, "", lang));
  const subtitle = vi || !v.subtitleMsgs?.length ? v.subtitle : v.subtitleMsgs.every((m) => subMsg(m)) ? v.subtitleMsgs.map(subMsg).join(" · ") : v.subtitle;
  return (
    <div>
      <div style={{ fontSize: 10.5, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>{refv.kind} · {String(refv.id)}</div>
      <div style={{ fontSize: 15, fontWeight: 650, margin: "2px 0", overflowWrap: "anywhere" }} lang={srcLang(vi || !!v.titleMsg)}>{title}</div>
      {v.simulated && <div style={{ fontSize: 12, color: "#f59e0b", fontWeight: 650 }}>{i18n.t("trace.sub.simulated")}</div>}
      {subtitle && <div style={{ fontSize: 12, color: v.subtitleMsgs?.some((m) => m.key === "trace.sub.upload") ? "#f59e0b" : "var(--ink-2)" }}>{subtitle}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 10px", fontSize: 12, marginTop: 8 }}>
        {v.fields.map((f, i) => (
          <div key={i} style={{ display: "contents" }}>
            <span style={{ color: "var(--ink-2)" }} lang={srcLang(vi || !!f.key)}>{label(f.key, f.label)}</span>
            <span style={{ wordBreak: "break-word", fontFamily: f.kind === "code" ? "var(--font-mono)" : undefined }} lang={f.kind === "text" || !f.kind ? i18n.sourceLang() : undefined}>{value(f)}</span>
          </div>
        ))}
      </div>
      {v.warnings && v.warnings.length > 0 && (
        <Section title={t("Ghi nhận", "Notes")}>
          {v.warnings.map((w, i) => {
            const m = v.warningMsgs?.[i];
            const text = vi ? w : m ? `${m.params?.severity ? `[${translateDynamic(lang, `dq.severity.${m.params.severity}`) ?? m.params.severity}] ` : ""}${msgText(m, w, lang)}` : w;
            return <div key={i} style={{ fontSize: 11.5, color: "#f59e0b" }} lang={srcLang(vi || !!m)}>⚠ {text}</div>;
          })}
        </Section>
      )}
      {v.table && (
        <Section title={t("Chi tiết", "Details")}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 11, width: "100%" }}>
              <thead>
                <tr>
                  {v.table.header.map((h, i) => <th key={i} scope="col" style={{ textAlign: "left", padding: "3px 6px", borderBottom: "1px solid var(--border-strong)", color: "var(--ink-2)" }}>{label(v.table!.headerKeys?.[i], h)}</th>)}
                  {v.table.refs && <th scope="col"><span style={{ position: "absolute", left: -9999 }}>{i18n.t("common.open")}</span></th>}
                </tr>
              </thead>
              <tbody>
                {v.table.rows.map((r, ri) => (
                  <tr key={ri}>
                    {r.map((c, ci) => {
                      let cell = c;
                      let cellLang: string | undefined;
                      if (ci === v.table!.statusColumn) cell = statusText(c, lang);
                      else if (ci === v.table!.header.length - 1 && v.table!.rowIssues?.[ri]) {
                        const parts = v.table!.rowIssues[ri].map((x) => issueText(x, lang));
                        cell = parts.map((p) => p.text).join("; ");
                        cellLang = parts.every((p) => p.translated) ? undefined : i18n.sourceLang();
                      }
                      return <td key={ci} lang={cellLang} style={{ padding: "3px 6px", borderBottom: "1px solid var(--border)", verticalAlign: "top", fontFamily: ci === 1 ? "var(--font-mono)" : undefined }}>{cell}</td>;
                    })}
                    {v.table!.refs && <td style={{ padding: "3px 6px", borderBottom: "1px solid var(--border)" }}>{v.table!.refs[ri] && <RefChip label={t("mở →", "open →")} refv={v.table!.refs[ri]!} onOpen={go} />}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
      {v.body && (
        <Section title={v.bodyKind === "text" ? t("Nội dung (dữ liệu không tin cậy — chỉ hiển thị)", "Content (untrusted data — display only)") : t("Nội dung", "Content")}>
          {(refv.kind === "document" || refv.kind === "task_run") && v.bodyLang === "vi" && !vi ? (
            <BilingualBody refv={refv} body={v.body} bodyKind={v.bodyKind} />
          ) : (
            <div style={{ ...card, maxHeight: 420, overflow: "auto" }} lang={v.bodyLang && v.bodyLang !== lang ? v.bodyLang : undefined}>
              {v.bodyKind === "markdown" ? <Markdown text={v.body} /> : <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11.5 }}>{v.body}</pre>}
            </div>
          )}
        </Section>
      )}
      {v.links.length > 0 && (
        <Section title={t("Liên kết truy vết", "Trace links")}>
          {v.links.map((l, i) => (
            <div key={i} style={{ marginBottom: 3 }}>
              <RefChip label={vi || !l.key ? l.label : msgText({ key: l.key, params: l.params }, l.label, lang)} refv={l.ref} onOpen={go} />
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

// ───────────────── Original / translation of business content ─────────────────

interface TranslationRow {
  id: number;
  sourceSha: string;
  sourceVersion: string;
  sourceLang: string;
  targetLang: string;
  content: string;
  translator: string;
  createdAt: string;
  createdBy: string;
  status: "machine_unreviewed" | "check_failed" | "reviewed" | "rejected";
  checks: { numbers: { ok: boolean; missing: string[]; extra: string[] }; ids: { ok: boolean; missing: string[] } };
  reviewedBy: string | null;
  reviewedAt: string | null;
}
interface TranslationView {
  source: { kind: string; id: number; sha: string; version: string; lang: string; supersededBy: { version: string; id: number } | null };
  translation: TranslationRow | null;
  stale: boolean;
}

/**
 * The original always stays available. A translation is shown only when one exists or the person
 * explicitly asks for it (a billed Claude API call) — never automatically on a language switch.
 */
function BilingualBody({ refv, body, bodyKind }: { refv: Ref; body: string; bodyKind?: string }) {
  const { lang, fmt, i18n } = useLang();
  const { session } = useOpsSession();
  const [view, setView] = useState<TranslationView | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [showTr, setShowTr] = useState(true);
  const target = lang === "vi" ? "vi" : "en";
  useEffect(() => {
    setView(null);
    setErr(null);
    api<TranslationView>(`/api/ops/translations?kind=${refv.kind}&id=${encodeURIComponent(String(refv.id))}&lang=${target}`).then(setView).catch(setErr);
  }, [refv.kind, refv.id, target]);
  const request = async (force = false) => {
    setBusy(true);
    setErr(null);
    try {
      setView(await postJson<TranslationView>("/api/ops/translations", { kind: refv.kind, id: refv.id, targetLang: target, force }));
      setShowTr(true);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const review = async (id: number) => {
    setErr(null);
    try {
      await postJson(`/api/ops/translations/${id}/review`, { verdict: "reviewed" });
      setView(await api<TranslationView>(`/api/ops/translations?kind=${refv.kind}&id=${encodeURIComponent(String(refv.id))}&lang=${target}`));
    } catch (e) {
      setErr(e);
    }
  };
  const tr = view?.translation ?? null;
  const showingTr = !!tr && showTr;
  const original = (
    <div style={{ ...card, maxHeight: 420, overflow: "auto" }} lang="vi">
      {bodyKind === "markdown" ? <Markdown text={body} /> : <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11.5 }}>{body}</pre>}
    </div>
  );
  const issues = tr
    ? [
        ...(!tr.checks.numbers.ok ? [i18n.t("tr.check.numbers", { missing: [...tr.checks.numbers.missing, ...tr.checks.numbers.extra.map((x) => `+${x}`)].join(", ") })] : []),
        ...(!tr.checks.ids.ok ? [i18n.t("tr.check.ids", { missing: tr.checks.ids.missing.join(", ") })] : []),
      ]
    : [];
  return (
    <div data-testid="bilingual-body">
      <div role="tablist" aria-label={i18n.t("tr.label")} style={{ display: "flex", gap: 4, marginBottom: 6, alignItems: "center", flexWrap: "wrap" }}>
        <button role="tab" aria-selected={!showingTr} style={{ ...btn, fontWeight: !showingTr ? 700 : 450 }} onClick={() => setShowTr(false)}>
          {i18n.t("tr.original")} (VI)
        </button>
        {tr && (
          <button role="tab" aria-selected={showingTr} style={{ ...btn, fontWeight: showingTr ? 700 : 450 }} onClick={() => setShowTr(true)}>
            {i18n.t("tr.label")} ({target.toUpperCase()})
          </button>
        )}
        {(!tr || view?.stale) && (
          <button style={btn} disabled={busy || !session?.identity} onClick={() => void request(!!tr)} title={i18n.t("tr.translate")}>
            {busy ? i18n.t("tr.translating") : tr ? i18n.t("tr.retranslate") : i18n.t("tr.translate")}
          </button>
        )}
      </div>
      {!!err && <ErrorMessage error={err} style={{ marginBottom: 6 }} />}
      {!tr && !err && view && <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6 }}>{i18n.t("tr.noneYet")}</div>}
      {showingTr && tr ? (
        <div>
          <div style={{ fontSize: 11, marginBottom: 4, padding: "4px 6px", borderRadius: 4, background: tr.status === "reviewed" ? "#22c55e1a" : "#f59e0b1a", color: tr.status === "reviewed" ? "#22c55e" : "#f59e0b" }} data-testid="translation-status">
            <b>{i18n.t("tr.label")}</b> — {tr.status === "reviewed" ? i18n.t("tr.reviewed", { by: tr.reviewedBy ?? "?", at: fmt.dateTime(tr.reviewedAt, { year: true }) }) : i18n.t("tr.machine")}
            {issues.length > 0 && <div style={{ color: "#ef4444" }}>⚠ {i18n.t("tr.checkFailed", { issues: issues.join("; ") })}</div>}
            {view?.stale && <div style={{ color: "#ef4444" }}>⚠ {i18n.t("tr.stale", { sha: tr.sourceSha.slice(0, 12) })}</div>}
            {view?.source.supersededBy && <div>⚠ {i18n.t("tr.sourceSuperseded", { version: view.source.supersededBy.version })}</div>}
            <div style={{ color: "var(--ink-3)" }}>
              {i18n.t("tr.meta", { kind: String(refv.kind), id: String(refv.id), sha: tr.sourceSha.slice(0, 12), sourceLang: tr.sourceLang, targetLang: tr.targetLang, translator: tr.translator, at: fmt.dateTime(tr.createdAt, { year: true }) })}
            </div>
            <div style={{ color: "var(--ink-3)" }}>{i18n.t("tr.notApproval", { sha: (view?.source.sha ?? tr.sourceSha).slice(0, 12) })}</div>
            {tr.status !== "reviewed" && !view?.stale && (
              <button style={{ ...btn, padding: "1px 6px", fontSize: 11, marginTop: 3 }} disabled={!session?.identity} onClick={() => void review(tr.id)}>
                {i18n.t("tr.markReviewed")}
              </button>
            )}
          </div>
          <div style={{ ...card, maxHeight: 420, overflow: "auto" }} lang={tr.targetLang}>
            {bodyKind === "markdown" ? <Markdown text={tr.content} /> : <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11.5 }}>{tr.content}</pre>}
          </div>
        </div>
      ) : (
        original
      )}
    </div>
  );
}
